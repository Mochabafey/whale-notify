import { randomUUID } from "node:crypto";
import { decisionTag, pollReplies } from "./imap.js";

/**
 * @module dsh-whale-notify/ask
 *
 * The "ask the user by email" decision loop. `askUserEmail` sends an email
 * whose subject carries a decision id and records the pending decision
 * (id → { agent, question, sentAt }); `pollPending` then polls the inbox and,
 * for every matched reply, pushes a user-role message into the owning agent's
 * inbox via `agent.followup` so the agent resumes with the reply as input.
 */

/** How long a decision stays eligible for replies (default, ms). */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** In-memory pending decisions keyed by decision id. */
const pending = new Map();

/**
 * Record a pending decision awaiting an email reply.
 * @param agent - the agent that asked (has followup()).
 * @param question - the question that was emailed.
 * @param to - recipients.
 * @param id - optional explicit decision id (defaults to a fresh random id).
 * @param kind - "ask" (question, the default) or "command" (notification reply
 *   used to steer the agent toward new work).
 * @returns the decision id.
 */
export function registerPending(agent, question, to, id = randomUUID().slice(0, 12), kind = "ask") {
  pending.set(id, {
    agent,
    question,
    to,
    kind,
    sentAt: Date.now(),
  });
  return id;
}

/** Resolve the decision subject for an id (shared with imap.js). */
export { decisionTag };

/** All currently pending decision ids. */
export function pendingIds() {
  return [...pending.keys()];
}

/** Expire stale decisions so old replies are not injected. */
export function expireStale(ttlMs = DEFAULT_TTL_MS) {
  const cutoff = Date.now() - ttlMs;
  for (const [id, entry] of pending) {
    if (entry.sentAt < cutoff) pending.delete(id);
  }
}

/**
 * Poll the inbox once and inject replies for matched pending decisions.
 * @param imapConfig - IMAP connection config (host/user/pass/port/secure).
 * @returns number of injected replies.
 */
export async function pollAndInject(imapConfig) {
  expireStale();
  const ids = pendingIds();
  if (ids.length === 0) return 0;

  const replies = await pollReplies(imapConfig, ids);
  let injected = 0;
  for (const reply of replies) {
    const entry = pending.get(reply.id);
    if (!entry) continue;
    pending.delete(reply.id); // one reply per decision
    const agent = entry.agent;
    if (!agent || typeof agent.followup !== "function") continue;
    const text = reply.text.trim();
    const fromLabel = reply.from || "用户";
    if (text.length === 0) {
      // Empty reply: re-ask with the original question.
      agent.followup({
        id: randomUUID(),
        role: "user",
        content: [{
          type: "text",
          text: `（邮件回复为空，原内容：${entry.question}）请重新说明你的指令或选择。`,
        }],
        source: { kind: "user" },
      });
    } else if (entry.kind === "command") {
      agent.followup({
        id: randomUUID(),
        role: "user",
        content: [{
          type: "text",
          text: `用户通过邮件下达新指令（来自 ${fromLabel}）：${text}`,
        }],
        source: { kind: "user" },
      });
    } else {
      agent.followup({
        id: randomUUID(),
        role: "user",
        content: [{
          type: "text",
          text: `邮件回复（来自 ${fromLabel}）：${text}`,
        }],
        source: { kind: "user" },
      });
    }
    injected++;
  }
  return injected;
}
