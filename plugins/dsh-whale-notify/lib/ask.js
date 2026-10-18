import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decisionTag, pollReplies } from "./imap.js";

/**
 * @module dsh-whale-notify/ask
 *
 * 「用邮件问用户」的决策闭环：
 *   1. `registerPending` 记录决策（id → 会话/问题/收件人），并**落盘**；
 *   2. `pollAndInject` 定期读收件箱，把匹配的回复注入回原会话。
 *
 * 落盘的动机：pending 之前只在内存里，DSH 一重启（或插件热重载）就全丢了，
 * 用户回信后毫无反应，也没人知道为什么。现在启动时会从
 * `$DSH_HOME/logs/notify-pending.json` 恢复，并按 sessionId 重新绑定存活会话。
 */

/** How long a decision stays eligible for replies (default, ms). */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** In-memory pending decisions keyed by decision id. */
const pending = new Map();

/** Where pending decisions are persisted. */
function pendingFile() {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? ".", ".dsh");
  return join(home, "logs", "notify-pending.json");
}

/** Persist the current pending table (best-effort: failure never breaks a send). */
async function savePending() {
  try {
    const file = pendingFile();
    await mkdir(join(file, ".."), { recursive: true });
    const rows = {};
    for (const [id, entry] of pending) {
      rows[id] = {
        sessionId: entry.agent?.id ?? entry.sessionId,
        question: entry.question,
        to: entry.to,
        kind: entry.kind,
        sentAt: entry.sentAt,
      };
    }
    await writeFile(file, JSON.stringify({ pending: rows, savedAt: new Date().toISOString() }, null, 2), "utf8");
  } catch {
    // 落盘失败只影响重启后的恢复，不影响本次发送
  }
}

/**
 * Load persisted decisions and rebind them to live agents.
 * @param resolveAgent - (sessionId) => Agent | undefined.
 * @returns number of rebindable decisions restored.
 */
export async function restorePending(resolveAgent) {
  let restored = 0;
  try {
    const raw = JSON.parse(await readFile(pendingFile(), "utf8"));
    const cutoff = Date.now() - DEFAULT_TTL_MS;
    for (const [id, row] of Object.entries(raw?.pending ?? {})) {
      if (!row || typeof row !== "object") continue;
      if (Number(row.sentAt ?? 0) < cutoff) continue;
      const agent = row.sessionId ? resolveAgent(row.sessionId) : undefined;
      pending.set(id, {
        agent,
        sessionId: row.sessionId,
        question: row.question ?? "",
        to: Array.isArray(row.to) ? row.to : [],
        kind: row.kind === "command" ? "command" : "ask",
        sentAt: Number(row.sentAt) || Date.now(),
      });
      if (agent) restored += 1;
    }
  } catch {
    // 没有文件或格式损坏：当作没有待回复决策
  }
  return restored;
}

/**
 * Record a pending decision awaiting an email reply.
 * @param agent - the agent that asked (has followup()).
 * @param question - the emailed question.
 * @param to - recipients.
 * @param id - optional explicit decision id.
 * @param kind - "ask" (question) or "command" (notification reply steering the agent).
 * @returns the decision id.
 */
export function registerPending(agent, question, to, id = randomUUID().slice(0, 12), kind = "ask") {
  pending.set(id, {
    agent,
    sessionId: agent?.id,
    question,
    to,
    kind,
    sentAt: Date.now(),
  });
  savePending();
  return id;
}

/** Resolve the decision subject tag for an id (shared with imap.js). */
export { decisionTag };

/** All currently pending decision ids. */
export function pendingIds() {
  return [...pending.keys()];
}

/** Whether a decision is still awaiting a reply. */
export function hasPending(id) {
  return pending.has(id);
}

/** Expire stale decisions so old replies are not injected. */
export function expireStale(ttlMs = DEFAULT_TTL_MS) {
  const cutoff = Date.now() - ttlMs;
  let removed = 0;
  for (const [id, entry] of pending) {
    if (entry.sentAt < cutoff) {
      pending.delete(id);
      removed += 1;
    }
  }
  if (removed > 0) savePending();
  return removed;
}

/**
 * Build one user-role message for injection.
 *
 * ⚠️ v4 会话格式只接受 **producer-owned** 的 `source.kind`：
 * `{ kind: "plugin" }` 这种 v3 写法会抛
 * `format v4 message requires a producer-owned source kind`。插件用
 * `plugin:<插件名>`，普通用户消息用 `user`。
 */
export function buildUserMessage(text, pluginName = "tool-notify", sourceKind) {
  const kind = sourceKind ?? (pluginName ? `plugin:${pluginName}` : "user");
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind },
  };
}

/**
 * Poll the inbox once and inject replies for matched pending decisions.
 * @param imapConfig - IMAP connection config.
 * @param opts - { resolveAgent?, log? }.
 * @returns { injected, matched, skipped } counts.
 */
export async function pollAndInject(imapConfig, opts = {}) {
  expireStale();
  const ids = pendingIds();
  if (ids.length === 0) return { injected: 0, matched: 0, skipped: 0 };

  const replies = await pollReplies(imapConfig, ids);
  let injected = 0;
  let skipped = 0;

  for (const reply of replies) {
    const entry = pending.get(reply.id);
    if (!entry) continue;
    pending.delete(reply.id); // one reply per decision
    savePending();

    const agent = entry.agent ?? (entry.sessionId ? opts.resolveAgent?.(entry.sessionId) : undefined);
    if (!agent || typeof agent.followup !== "function") {
      skipped += 1;
      opts.log?.({ kind: "ask_reply_orphaned", decisionId: reply.id, session: entry.sessionId });
      continue;
    }

    const text = String(reply.text ?? "").trim();
    const from = reply.from || "用户";
    let body;
    if (text.length === 0) {
      body = `（邮件回复为空，原问题：${entry.question}）请重新说明你的指令或选择。`;
    } else if (entry.kind === "command") {
      body = `用户通过邮件下达新指令（来自 ${from}）：${text}`;
    } else {
      body = `邮件回复（来自 ${from}）：${text}`;
    }
    try {
      agent.followup(buildUserMessage(body, undefined, "user"));
      injected += 1;
    } catch (error) {
      skipped += 1;
      opts.log?.({
        kind: "ask_reply_inject_failed",
        decisionId: reply.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { injected, matched: replies.length, skipped };
}
