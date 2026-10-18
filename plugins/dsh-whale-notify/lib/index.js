import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  CHANNELS, CHANNEL_LABELS, clearEnvCache, configuredChannels, describeEnvRefs,
  isConfigError, resolveAccessControl, resolveChannel, resolveImap,
} from "./config.js";
import { formatTitle, targetChannels, trySend } from "./channels.js";
import { sendEmail } from "./smtp.js";
import { registerPending, restorePending, pollAndInject, pendingIds, decisionTag } from "./ask.js";
import { startLongConnection, extractMessageEvent } from "./feishu.js";
import { startQQReceiver } from "./qq.js";
import { saveSkill, searchSkills, knowledgeDir } from "./knowledge.js";
import {
  readFriendConfig, writeFriendConfig, readFriendPrompts, appendFriendMemory,
  isBlacklisted, buildFriendPrompt, friendModeDir, DEFAULT_PROMPTS,
} from "./friendmode.js";
import {
  saveMemoryDoc, searchMemoryDocs, readMemoryDoc, memoryDir, migrateLegacyFriendMemory,
} from "./memory.js";
import { createReportScheduler } from "./scheduler.js";
import { buildInventory, callTool, summarizeInventory, parseStepArguments, MAX_BATCH } from "./registry.js";

/**
 * @module dsh-whale-notify
 *
 * 鲸鱼通知：任务通知 + 飞书/QQ 双向聊天 + 邮件问答 + 统一记忆库/知识库。
 *
 * 结构约定：
 *  - `./config.js`   —— 配置解析（`$ENV:` 展开、渠道规范化、访问控制名单）
 *  - `./channels.js` —— 各渠道的最后一步发送与文本切分
 *  - `./scheduler.js`—— 定时汇报的到点判定
 *  - 本文件          —— 工具注册、外部消息注入、定时任务编排
 */

/** Plugin name registered with the Loader. */
const name = "tool-notify";

// 构建标记：改过插件后 +1，`whale_check` 会打印出来，用来判断运行中的实例是不是这一版。
// v5 = 移除飞书轮询，收信只走长连接
// v6 = 访问控制名单展开 + SMTP/IMAP 注册表回退 + QQ wsPort 修复 + settings 改走 configEditor
const BUILD_TAG = "dsh-whale-notify v0.3.0 (v6-config-rewrite)";

/** Host services this plugin consumes. `timer` backs every interval/timeout. */
const inject = ["tools", "timer"];

/** Resolve `$DSH_HOME` (falls back to `%USERPROFILE%\.dsh`). */
function dshHome() {
  return process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? ".", ".dsh");
}

/** Append one JSONL record to `$DSH_HOME/logs/notify.log`. */
async function appendLog(record) {
  try {
    const dir = join(dshHome(), "logs");
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, "notify.log"), `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, "utf8");
  } catch {
    // 日志写不进去不影响功能
  }
}

/** Extract plain text from a message's content blocks. */
function textOfMessage(message) {
  if (!message?.content || !Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * Build a kernel-valid v4 user message.
 *
 * ⚠️ v4 会话格式只接受 **producer-owned** 的 source.kind：`{ kind: "plugin" }`
 * 是已退役的 v3 包装，写进去会抛
 * `format v4 message requires a producer-owned source kind`。插件的写法是
 * `plugin:<插件名>`，普通用户消息是 `user`。
 */
function buildUserMessage(text, pluginName = name) {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: pluginName ? `plugin:${pluginName}` : "user" },
  };
}

/** Read one JSON file, returning undefined when it is absent or malformed. */
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * 飞书已处理消息表（跨重启去重）。
 * 长连接重连时飞书会重投事件，没有这张表就会把同一条指令执行两遍。
 */
class SeenStore {
  constructor() {
    this.file = join(dshHome(), "logs", "feishu-seen.json");
    this.map = new Map();
    this.saveTimer = undefined;
  }

  async load() {
    const raw = await readJson(this.file);
    for (const [id, time] of Object.entries(raw?.seen ?? {})) this.map.set(id, Number(time) || 0);
    this.prune();
    return this.map.size;
  }

  has(id) {
    return this.map.has(id);
  }

  add(id, time) {
    if (!id) return;
    this.map.set(id, Number(time) || Date.now());
    this.prune();
    this.scheduleSave();
  }

  /** Keep the newest 500 entries; older ones are unlikely to be redelivered. */
  prune() {
    if (this.map.size <= 500) return;
    const entries = [...this.map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 500);
    this.map = new Map(entries);
  }

  scheduleSave() {
    if (this.saveTimer !== undefined) return;
    this.saveTimer = setTimeout(async () => {
      this.saveTimer = undefined;
      try {
        const { mkdir: mkdirFs, writeFile } = await import("node:fs/promises");
        await mkdirFs(dirname(this.file), { recursive: true });
        await writeFile(this.file, JSON.stringify({
          seen: Object.fromEntries([...this.map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 500)),
          savedAt: new Date().toISOString(),
        }), "utf8");
      } catch {
        // 落盘失败只影响跨重启去重
      }
    }, 400);
    this.saveTimer.unref?.();
  }
}

/** Plugin config schema. Every field is optional; defaults fill the gaps. */
const Config = z.object({
  defaultChannel: z.string().default(""),

  serverchan: z.object({ sendKey: z.string(), baseUrl: z.string() }),
  feishu: z.object({ webhook: z.string(), secret: z.string() }),
  feishuBot: z.object({
    appId: z.string(),
    appSecret: z.string(),
    receiveId: z.string(),
    receiveIdType: z.string(),
    targetSession: z.string().default(""),
    /** 是否允许机器人回复来源会话（私聊/群）。 */
    replyToSource: z.boolean(),
    /** 接受哪些会话类型：p2p,group。 */
    chatTypes: z.string(),
  }),
  wecom: z.object({ webhook: z.string() }),
  dingtalk: z.object({ webhook: z.string(), secret: z.string() }),

  qq: z.object({
    httpBase: z.string(),
    accessToken: z.string(),
    qq: z.string(),
    groupId: z.string(),
    wsHost: z.string(),
    wsPort: z.number(),
    port: z.number(),
    targetSession: z.string().default(""),
  }),

  smtp: z.object({
    host: z.string(),
    port: z.number(),
    secure: z.boolean(),
    rejectUnauthorized: z.boolean(),
    user: z.string(),
    pass: z.string(),
    from: z.string(),
    fromName: z.string(),
    to: z.union([z.string(), z.array(z.string())]),
  }),

  imap: z.object({
    host: z.string(),
    port: z.number(),
    secure: z.boolean(),
    user: z.string(),
    pass: z.string(),
    mailbox: z.string(),
    rejectUnauthorized: z.boolean(),
    maxMessages: z.number(),
  }),
  pollIntervalMs: z.number(),

  /** 定时汇报总开关（默认关闭）。 */
  enableReports: z.boolean().default(false),
  /** [{ name, channel, schedule: "daily:HH:MM" | "every:N" | "at:HH:MM,HH:MM", text }] */
  reports: z.array(z.object({
    name: z.string(),
    channel: z.string(),
    schedule: z.string(),
    text: z.string(),
  })),

  /** 访问控制：mode=whitelist 时仅 allowedUsers 可注入；readOnlyUsers 只读。 */
  accessControl: z.object({
    mode: z.string(),
    allowedUsers: z.object({ feishu: z.array(z.string()), qq: z.array(z.string()) }),
    readOnlyUsers: z.object({ feishu: z.array(z.string()), qq: z.array(z.string()) }),
  }),

  /** 外部消息注入时是否附带「回执到原渠道」的提示（默认开）。 */
  replyHint: z.boolean().default(true),
  /** 单条外部消息注入前的最大字符数（超出截断，避免撑爆上下文）。 */
  maxInboundChars: z.number().default(4000),
});

/** Tool parameters of `notify`. */
const NOTIFY_PARAMETERS = {
  title: { type: "string", required: true, description: "通知标题，例如「任务完成」或「构建失败」。" },
  message: { type: "string", required: true, description: "通知正文（纯文本）。过长时按渠道上限自动分条发送。" },
  channel: {
    type: "string",
    description:
      "发送渠道：feishu_bot（飞书开放平台，推荐）、qq（QQ/NapCat）、smtp（邮箱）、serverchan（微信）、"
      + "feishu（飞书群 webhook）、wecom（企业微信）、dingtalk（钉钉）。"
      + "不填用默认渠道；填 all 发到所有已配置渠道。未配置的渠道会被跳过。",
    enum: ["all", "serverchan", "feishu", "feishu_bot", "qq", "wecom", "dingtalk", "smtp"],
  },
  level: {
    type: "string",
    description: "可选级别，会在标题前加标签：[信息]/[完成]/[警告]/[错误]。",
    enum: ["info", "success", "warning", "error"],
  },
  awaitReply: {
    type: "boolean",
    description: "设为 true 时邮件通知带决策编号，用户直接回信即可给 agent 下达下一步指令（需配置 imap）。",
  },
  groupId: { type: "string", description: "仅 QQ：要发往的群号；群友模式回原群时填被 @ 的群号。" },
  to: {
    type: "string",
    description:
      "可选目标 id，覆盖配置里的默认接收方。飞书填 chat_id（oc_…）或 open_id（ou_…）；QQ 填号码；邮件填地址。"
      + "用于把结果发回消息来源会话。",
  },
};

/** Tool parameters of `ask_user_email`. */
const ASK_PARAMETERS = {
  question: { type: "string", required: true, description: "要问用户的问题。" },
  context: { type: "string", description: "可选背景，帮助用户决策。" },
  options: { type: "array", description: "可选建议项，用户可直接回复其中一个。", items: { type: "string" } },
};

/** Common `{ ok, detail }` output used by the config/mode tools. */
const OK_OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { ok: { type: "boolean", required: true }, detail: { type: "string", required: true } },
  },
  render: (_args, value) => [{ type: "text", text: value.detail }],
};

/** Resolve a dotted path against an object. */
function getByPath(object, path) {
  return String(path).split(".").reduce((value, key) => (value === undefined || value === null ? undefined : value[key]), object);
}

/** Set a dotted path on a mutable object, creating intermediate objects. */
function setByPath(object, path, value) {
  const keys = String(path).split(".");
  let cursor = object;
  for (const key of keys.slice(0, -1)) {
    if (cursor[key] === undefined || cursor[key] === null || typeof cursor[key] !== "object") cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keys[keys.length - 1]] = value;
  return object;
}

/** Delete a dotted path (used by `unset`). */
function deleteByPath(object, path) {
  const keys = String(path).split(".");
  const parent = keys.slice(0, -1).reduce((value, key) => (value === undefined || value === null ? undefined : value[key]), object);
  if (parent && typeof parent === "object") delete parent[keys[keys.length - 1]];
  return object;
}

/**
 * Parse a string argument into a typed value.
 * Accepts booleans, numbers, quoted strings, JSON arrays/objects, and comma lists.
 */
function parseValue(raw) {
  const text = String(raw ?? "").trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (/^["'].*["']$/.test(text)) return text.slice(1, -1);
  if (/^[[{]/.test(text)) {
    try {
      return JSON.parse(text.replace(/'/g, '"'));
    } catch {
      // fall through to string
    }
  }
  return text;
}

/** Whether a resolved value is a ready-to-use channel entry. */
function usable(entry) {
  return entry !== undefined && !isConfigError(entry);
}

/**
 * Attach the plugin.
 * @param ctx - Cordis context owning `tools` and `timer`.
 * @param config - raw plugin config from the loader.
 */
function apply(ctx, config) {
  const resolved = config ?? {};
  const env = process.env;

  // ────────────────────────── 配置快照 ──────────────────────────
  const imapEntry = resolveImap(resolved, env);
  const imapConfig = usable(imapEntry) ? imapEntry : undefined;
  const imapProblem = isConfigError(imapEntry) ? imapEntry.error : undefined;
  const feishuBotEntry = resolveChannel(resolved, "feishu_bot", env);
  const feishuBotConfig = usable(feishuBotEntry) ? feishuBotEntry : undefined;
  const qqEntry = resolveChannel(resolved, "qq", env);
  const qqConfig = usable(qqEntry) ? qqEntry : undefined;
  const acl = resolveAccessControl(resolved, env);
  const pollIntervalMs = Number(resolved.pollIntervalMs ?? 60000);
  const replyHint = resolved.replyHint !== false;
  const maxInboundChars = Number(resolved.maxInboundChars ?? 4000);

  /** Runtime state surfaced by `whale_check`. */
  const state = {
    feishu: { status: "off", since: undefined, lastError: undefined, events: 0, restarts: 0, lastEventAt: undefined },
    qq: { status: "off", lastError: undefined, connections: 0, lastEventAt: undefined },
    injected: 0,
    denied: 0,
    lastInjection: undefined,
  };

  ctx.effect(() => () => {
    // 停插件时把环境缓存清掉，热重载后能读到最新变量
    clearEnvCache();
  }, "dsh-whale-notify cleanup");

  // 迁移旧的群友记忆（friendmode/memory.jsonl → memory/friend/）
  migrateLegacyFriendMemory().then((count) => {
    if (count > 0) console.log(`[dsh-whale-notify] 已迁移 ${count} 个群友记忆文件到统一记忆库`);
  }).catch(() => {});

  // ────────────────────────── 会话定位 ──────────────────────────
  /**
   * 选一个最可能是「用户正在看」的会话。
   *
   * 优先级：显式 targetSession → 上次注入的会话（连续对话不被打断）→
   * sessionQuery 的 newest-first 语料 → agent 活跃时间 → 首个根会话。
   *
   * 子会话（subagent）不参与自动选择：把外部指令灌进子代理会毁掉它的任务；
   * 但显式 targetSession 指向子会话时仍然照办。
   */
  let lastInjectedSession;
  const sessionOrderCache = { at: 0, ids: [] };

  const isSubagent = (agent) => agent?.session?.header?.origin === "subagent";

  const preferredSessionIds = async () => {
    const now = Date.now();
    if (now - sessionOrderCache.at < 10_000) return sessionOrderCache.ids;
    const query = ctx.get("sessionQuery");
    if (!query || typeof query.listSessions !== "function") return sessionOrderCache.ids;
    try {
      const records = await query.listSessions();
      sessionOrderCache.ids = (records ?? [])
        .filter((record) => record?.live === true)
        .map((record) => record?.header?.id)
        .filter((id) => typeof id === "string");
      sessionOrderCache.at = now;
    } catch {
      // 查询失败沿用上一次的顺序
    }
    return sessionOrderCache.ids;
  };

  /** 一个 agent 的「最后活跃时间」，兼容不同版本的 session 结构。 */
  const agentLastActive = (agent) => {
    const stamp = agent?.session?.header?.updatedAt ?? agent?.session?.header?.createdAt;
    if (typeof stamp === "number") return stamp;
    if (typeof stamp === "string") {
      const parsed = Date.parse(stamp);
      if (!Number.isNaN(parsed)) return parsed;
    }
    if (typeof agent?.lastActivity === "number") return agent.lastActivity;
    return 0;
  };

  /** 把 handle / agent 两种形态统一成能收消息的 Agent。 */
  const unwrapAgent = (value) => {
    if (!value) return undefined;
    if (typeof value.followup === "function") return value;
    if (value.agent && typeof value.agent.followup === "function") return value.agent;
    return undefined;
  };

  /** All live agents with a usable followup(), subagents flagged. */
  const liveAgents = () => {
    const agents = ctx.get("agents");
    if (!agents || typeof agents.list !== "function") return [];
    return agents.list()
      .map((entry) => {
        const agent = unwrapAgent(entry);
        return agent ? { agent, id: agent.id ?? entry?.session?.header?.id } : undefined;
      })
      .filter(Boolean);
  };

  /**
   * Pick the target agent for an external message.
   * @returns { agent, id } or undefined.
   */
  const pickTarget = async (targetSession) => {
    const live = liveAgents();
    if (live.length === 0) return undefined;
    const byId = (id) => live.find((row) => row.id === id);

    if (targetSession) {
      const explicit = byId(targetSession);
      if (explicit) return explicit;
      // 配置的会话不在线：继续走自动选择，但日志里记一笔
      appendLog({ kind: "inject_target_missing", targetSession }).catch(() => {});
    }
    const sticky = lastInjectedSession ? byId(lastInjectedSession) : undefined;
    if (sticky) return sticky;

    const order = await preferredSessionIds();
    for (const id of order) {
      const hit = byId(id);
      if (hit && !isSubagent(hit.agent)) return hit;
    }
    const roots = live.filter((row) => !isSubagent(row.agent));
    const pool = roots.length > 0 ? roots : live;
    pool.sort((a, b) => agentLastActive(b.agent) - agentLastActive(a.agent));
    return pool[0];
  };

  /**
   * Inject one user message into the chosen session.
   * @returns { ok, sessionId?, reason? }
   */
  const injectToAgent = async (text, { targetSession, kind, from, readOnly = false, meta = {} } = {}) => {
    const target = await pickTarget(targetSession);
    if (!target) {
      await appendLog({ kind: `${kind}_failed`, from, reason: "当前没有任何存活的 agent 会话", ...meta });
      return { ok: false, reason: "当前没有任何存活的 agent 会话（客户端里要开着一个会话）" };
    }
    const body = readOnly
      ? `[只读消息] ${text}\n\n（此消息来自只读用户，仅作参考，不要执行任何修改性操作。）`
      : text;
    try {
      target.agent.followup(buildUserMessage(body));
      lastInjectedSession = target.id;
      state.injected += 1;
      state.lastInjection = { at: new Date().toISOString(), session: target.id, kind, from };
      await appendLog({
        kind, from, session: target.id, chars: body.length,
        ...(readOnly ? { readOnly: true } : {}),
        ...meta,
        text: body.slice(0, 500),
      });
      return { ok: true, sessionId: target.id };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await appendLog({ kind: `${kind}_failed`, from, session: target.id, reason, ...meta });
      return { ok: false, reason };
    }
  };

  /** Truncate an inbound message so one long paste cannot flood the context. */
  const clampInbound = (text) => (text.length > maxInboundChars
    ? `${text.slice(0, maxInboundChars)}\n…（消息过长，已截断 ${text.length - maxInboundChars} 字）`
    : text);

  /** Whether the sender is allowed to drive this session at all. */
  const checkAccess = async (channel, from, kind, text) => {
    const verdict = acl.check(channel, from);
    if (!verdict.allowed) {
      state.denied += 1;
      await appendLog({ kind: `${kind}_denied`, from, text: text.slice(0, 200), mode: acl.mode });
    }
    return verdict;
  };

  // ────────────────────────── 邮件回复轮询 ──────────────────────────
  // 只有存在待回复决策时才真正连 IMAP（pollAndInject 内部先判空）。
  if (imapConfig) {
    restorePending((sessionId) => liveAgents().find((row) => row.id === sessionId)?.agent)
      .then((count) => {
        if (count > 0) appendLog({ kind: "ask_pending_restored", count }).catch(() => {});
      })
      .catch(() => {});

    ctx.interval(async () => {
      if (pendingIds().length === 0) return;
      try {
        const result = await pollAndInject(imapConfig, {
          resolveAgent: (sessionId) => liveAgents().find((row) => row.id === sessionId)?.agent,
          log: (record) => appendLog(record).catch(() => {}),
        });
        if (result.injected > 0 || result.skipped > 0) {
          appendLog({ kind: "imap_poll", ...result }).catch(() => {});
        }
      } catch (error) {
        console.error("[dsh-whale-notify] imap 轮询失败:", error instanceof Error ? error.message : String(error));
      }
    }, Math.max(15_000, pollIntervalMs));
  }

  // ────────────────────────── 飞书收信（长连接） ──────────────────────────
  const seen = new SeenStore();
  seen.load().catch(() => {});

  if (feishuBotConfig) {
    /** 处理一条飞书来消息：去重 → 过滤 → 访问控制 → 注入。 */
    const handleFeishuMessage = async (msg) => {
      if (!msg?.text) return;
      const postedAt = msg.createTime ?? Date.now();

      // 去重：长连接重连时飞书会重投事件
      if (msg.messageId) {
        if (seen.has(msg.messageId)) {
          await appendLog({ kind: "feishu_duplicate", messageId: msg.messageId });
          return;
        }
        seen.add(msg.messageId, postedAt);
      }
      state.feishu.events += 1;
      state.feishu.lastEventAt = new Date(postedAt).toISOString();

      // 机器人自己的消息不处理（事件通常只推别人的，这里防御一下）
      if (msg.senderType === "app" || msg.senderId === feishuBotConfig.appId) return;

      const chatType = msg.chatType ?? (msg.chatId?.startsWith("oc_") ? "group" : "p2p");
      if (!feishuBotConfig.chatTypes.includes(chatType)) {
        await appendLog({ kind: "feishu_ignored", reason: `不接受的会话类型 ${chatType}`, chatId: msg.chatId });
        return;
      }
      // 群聊只在配置的目标会话里响应；私聊（p2p）始终响应 —— 用户可能只是换了入口。
      if (chatType === "group" && feishuBotConfig.receiveIdType === "chat_id" && msg.chatId !== feishuBotConfig.receiveId) {
        await appendLog({ kind: "feishu_ignored", reason: "群 chat_id 不在配置范围", chatId: msg.chatId });
        return;
      }

      const verdict = await checkAccess("feishu", msg.senderId, "feishu_in", msg.text);
      if (!verdict.allowed) return;

      const hint = replyHint
        ? `\n\n（本条指令来自飞书${chatType === "group" ? "群" : "私聊"}渠道，会话 ${msg.chatId}。`
          + `任务完成后请用 notify(channel: "feishu_bot", to: "${msg.chatId}") 把结果发回这里。`
          + `纯文本，不要 markdown。）`
        : "";
      await injectToAgent(
        clampInbound(`飞书消息（来自 ${msg.senderId ?? "用户"}）：${msg.text}${hint}`),
        {
          targetSession: feishuBotConfig.targetSession,
          kind: "feishu_in",
          from: msg.senderId,
          readOnly: verdict.readOnly,
          meta: { chatId: msg.chatId, chatType },
        },
      );
    };

    /** 建立长连接；失败时按指数退避重试（SDK 只在连上之后才会自己重连）。 */
    let stopConnection;
    let retryTimer;
    let attempt = 0;

    const start = () => {
      state.feishu.status = "connecting";
      appendLog({ kind: "feishu_link_start", attempt }).catch(() => {});
      startLongConnection(feishuBotConfig.appId, feishuBotConfig.appSecret, (payload) => {
        const msg = extractMessageEvent(payload);
        if (msg) handleFeishuMessage(msg).catch(() => {});
      }, {
        log: (...args) => appendLog({ kind: "feishu_link", detail: args.map(String).join(" ") }).catch(() => {}),
        onState: (status, error) => {
          state.feishu.status = status;
          if (status === "up") {
            state.feishu.since = new Date().toISOString();
            state.feishu.lastError = undefined;
            attempt = 0;
            appendLog({ kind: "feishu_link_up" }).catch(() => {});
          } else if (status === "failed") {
            state.feishu.lastError = error instanceof Error ? error.message : String(error ?? "未知错误");
            appendLog({ kind: "feishu_link_failed", error: state.feishu.lastError }).catch(() => {});
            scheduleRetry();
          }
        },
      }).then((stop) => {
        stopConnection = stop;
        state.feishu.status = "up";
        state.feishu.since = new Date().toISOString();
      }).catch((error) => {
        state.feishu.status = "failed";
        state.feishu.lastError = error instanceof Error ? error.message : String(error);
        appendLog({ kind: "feishu_link_failed", error: state.feishu.lastError }).catch(() => {});
        console.error("[dsh-whale-notify] 飞书长连接启动失败:", state.feishu.lastError);
        scheduleRetry();
      });
    };

    const scheduleRetry = () => {
      if (retryTimer !== undefined) return;
      attempt += 1;
      if (attempt > 6) {
        state.feishu.lastError = `${state.feishu.lastError ?? "连接失败"}（已重试 ${attempt - 1} 次，停止重连）`;
        return;
      }
      const delay = Math.min(5_000 * 2 ** (attempt - 1), 300_000);
      state.feishu.restarts += 1;
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        try { stopConnection?.(); } catch { /* ignore */ }
        start();
      }, delay);
      retryTimer.unref?.();
    };

    start();
    // 注意：这里的 disposer 必须读「最新」的 stopConnection，
    // 否则插件卸载时拿到的是启动前那个空函数，长连接不会被关掉。
    ctx.effect(() => () => {
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      try { stopConnection?.(); } catch { /* ignore */ }
    }, "dsh-whale-notify feishu link");
  }

  // ────────────────────────── QQ 收信 ──────────────────────────
  if (qqConfig) {
    try {
      const stopQQ = startQQReceiver(qqConfig, (msg) => {
        state.qq.lastEventAt = new Date().toISOString();
        state.qq.connections += 1;
        handleQQMessage(msg).catch(() => {});
      }, {
        log: (...args) => appendLog({ kind: "qq", detail: args.map(String).join(" ") }).catch(() => {}),
        onState: (status, error) => {
          state.qq.status = status;
          state.qq.lastError = error;
        },
      });
      state.qq.status = "up";
      ctx.effect(() => stopQQ, "dsh-whale-notify qq receiver");
    } catch (error) {
      state.qq.status = "failed";
      state.qq.lastError = error instanceof Error ? error.message : String(error);
      console.error("[dsh-whale-notify] QQ 接收端启动失败:", state.qq.lastError);
    }
  }

  /** Route one incoming QQ message: friend mode for groups, ACL for everything else. */
  async function handleQQMessage(msg) {
    const label = msg.type === "group" ? `群 ${msg.groupId}` : `QQ ${msg.userId}`;

    if (msg.type === "group") {
      const friend = await readFriendConfig().catch(() => ({ enabled: false }));
      if (!friend.enabled) {
        const verdict = await checkAccess("qq", String(msg.userId), "qq_in", msg.text);
        if (!verdict.allowed) return;
        const hint = replyHint
          ? `\n\n（本条指令来自 QQ 群 ${msg.groupId}。完成后请用 notify(channel: "qq", groupId: "${msg.groupId}") 把结果发回该群，纯文本。）`
          : "";
        await injectToAgent(clampInbound(`QQ 消息（来自 ${label}）：${msg.text}${hint}`), {
          targetSession: qqConfig.targetSession, kind: "qq_in", from: msg.userId,
          readOnly: verdict.readOnly, meta: { groupId: msg.groupId },
        });
        return;
      }

      if (isBlacklisted(friend, msg.groupId, msg.userId)) {
        await appendLog({ kind: "friend_blacklisted", group: msg.groupId, from: msg.userId });
        return;
      }

      const nickname = String(friend.nickname ?? "");
      const mentioned = msg.atMe || msg.isReply || (nickname !== "" && msg.text.includes(nickname));

      // 记忆要记「所有群消息」，而不只是被 @ 的那几条 —— 没记忆就没法接话。
      await appendFriendMemory({
        userId: msg.userId, groupId: msg.groupId, text: msg.text,
        name: msg.senderName, at: msg.atMe === true,
      }).catch(() => {});

      if (!mentioned) {
        await appendLog({ kind: "friend_pass", group: msg.groupId, from: msg.userId });
        return;
      }

      const prompt = await buildFriendPrompt(friend, { groupId: msg.groupId }).catch(() => "");
      const header = `【群友模式·群 ${msg.groupId}】来自 ${msg.userId}${msg.senderName ? `（${msg.senderName}）` : ""}：${msg.text}`;
      const hint = `（回复请通过 notify(channel: "qq", groupId: "${msg.groupId}") 发回这个群，1-2 句纯文本。）`;
      await injectToAgent(clampInbound(`${header}\n\n${hint}${prompt ? `\n\n${prompt}` : ""}`), {
        targetSession: qqConfig.targetSession, kind: "friend_in", from: msg.userId,
        readOnly: friend.readOnly === true, meta: { groupId: msg.groupId },
      });
      return;
    }

    // 私聊
    const verdict = await checkAccess("qq", String(msg.userId), "qq_in", msg.text);
    if (!verdict.allowed) return;
    const hint = replyHint
      ? `\n\n（本条指令来自 QQ 私聊。完成后请用 notify(channel: "qq", to: "${msg.userId}") 把结果发回，纯文本。）`
      : "";
    await injectToAgent(clampInbound(`QQ 消息（来自 ${label}）：${msg.text}${hint}`), {
      targetSession: qqConfig.targetSession, kind: "qq_in", from: msg.userId,
      readOnly: verdict.readOnly, meta: { qq: msg.userId },
    });
  }

  // ────────────────────────── 定时汇报 ──────────────────────────
  const reports = Array.isArray(resolved.reports) ? resolved.reports : [];
  const reportsEnabled = resolved.enableReports === true;
  const scheduler = createReportScheduler(reports, async (report) => {
    const result = await trySend(report.channel, resolved, `【定时汇报】${report.name}`, report.text, process.env);
    await appendLog({ kind: "report", name: report.name, channel: report.channel, ok: result.ok, detail: result.detail });
    if (!result.ok) throw new Error(result.detail);
  }, { log: (record) => appendLog(record).catch(() => {}) });

  if (reportsEnabled && reports.length > 0) {
    // 20 秒一跳 + 分钟级去重：既不会漏掉某一分钟，也不会在一分钟内重复发。
    ctx.interval(() => {
      scheduler.tick().catch((error) => {
        console.error("[dsh-whale-notify] 定时汇报异常:", error instanceof Error ? error.message : String(error));
      });
    }, 20_000);
  } else if (reports.length > 0) {
    appendLog({ kind: "report_disabled", count: reports.length }).catch(() => {});
  }

  // ────────────────────────── 工具：whale_check ──────────────────────────
  ctx.tools.register(defineTool({
    name: "whale_check",
    description:
      "鲸鱼通知自检：报告渠道配置（含 $ENV: 变量是否解析成功）、访问控制生效名单、飞书长连接与 QQ 接收端状态、"
      + "可注入的会话、定时汇报计划与最近触发、待回复的邮件决策，以及日志尾部。"
      + "当用户说「飞书/QQ 发消息没反应」「通知发不出去」「插件是不是没生效」时先跑它。",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { report: { type: "string", required: true } },
      },
      render: (_args, value) => [{ type: "text", text: value.report }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      const lines = [];
      const mark = (ok) => (ok ? "✅" : "❌");
      lines.push(`## 自检 ${new Date().toLocaleString("zh-CN", { hour12: false })}（pid ${process.pid}）`);
      lines.push(`## 构建标记 ${BUILD_TAG}`);
      lines.push("");

      // 渠道
      lines.push("## 渠道");
      lines.push(`- 默认渠道: ${resolved.defaultChannel || "(未设，发往全部已配置渠道)"}`);
      for (const channel of CHANNELS) {
        const entry = resolveChannel(resolved, channel, env);
        const label = CHANNEL_LABELS[channel] ?? channel;
        if (entry === undefined) {
          lines.push(`- ${mark(false)} ${label}（${channel}）: 未配置`);
        } else if (isConfigError(entry)) {
          lines.push(`- ${mark(false)} ${label}（${channel}）: ${entry.error}`);
        } else {
          let extra = "";
          if (channel === "feishu_bot") extra = ` — receiveId=${entry.receiveId} / 类型=${entry.receiveIdType} / targetSession=${entry.targetSession || "(自动)"}`;
          if (channel === "smtp") extra = ` — ${entry.user} → ${entry.to.join(", ")}`;
          if (channel === "qq") extra = ` — 私聊=${entry.qq || "(无)"} 群=${entry.groupId || "(无)"} ws=${entry.wsHost}:${entry.wsPort}`;
          lines.push(`- ${mark(true)} ${label}（${channel}）: 已配置${extra}`);
        }
      }

      // 环境变量
      const envRefs = describeEnvRefs(resolved, env);
      lines.push("");
      lines.push("## $ENV: 变量");
      if (envRefs.length === 0) {
        lines.push("- 配置里没有 `$ENV:` 引用");
      } else {
        for (const row of envRefs) {
          const where = row.from === "env" ? "进程环境" : row.from === "registry" ? "用户环境变量(注册表)" : "未设置";
          lines.push(`- ${mark(row.ok)} ${row.name}（${row.path}）: ${where}`);
        }
      }

      // 访问控制
      lines.push("");
      lines.push("## 访问控制");
      lines.push(`- 模式: ${acl.mode}${acl.mode === "whitelist" ? "（仅名单内可指挥）" : "（所有人可指挥）"}`);
      if (acl.mode === "whitelist") {
        lines.push(`- 飞书白名单: ${acl.allowed.feishu.join(", ") || "(空)"}`);
        lines.push(`- QQ 白名单: ${acl.allowed.qq.join(", ") || "(空)"}`);
        if (acl.emptyWhitelist()) {
          lines.push("  ⚠️ 白名单解析后为空 —— 谁发的消息都会被丢弃。检查 allowedUsers 里的 `$ENV:` 变量是否真的存在。");
        }
        const readOnlyCount = acl.readOnly.feishu.length + acl.readOnly.qq.length;
        if (readOnlyCount > 0) lines.push(`- 只读名单: ${readOnlyCount} 个`);
      }

      // 飞书长连接
      lines.push("");
      lines.push("## 飞书长连接（收信）");
      lines.push(`- 状态: ${state.feishu.status}${state.feishu.since ? `（自 ${new Date(state.feishu.since).toLocaleString("zh-CN", { hour12: false })}）` : ""}`);
      if (state.feishu.lastError) lines.push(`- 最近错误: ${state.feishu.lastError}`);
      lines.push(`- 已收到事件: ${state.feishu.events}${state.feishu.lastEventAt ? `（最后一条 ${new Date(state.feishu.lastEventAt).toLocaleString("zh-CN", { hour12: false })}）` : ""}`);
      if (state.feishu.restarts > 0) lines.push(`- 重连次数: ${state.feishu.restarts}`);
      if (state.feishu.status === "up" && state.feishu.events === 0) {
        lines.push("  ⚠️ 连接正常但还没收到任何事件。若刚在飞书发过消息仍为 0：");
        lines.push("     开发者后台 → 事件与回调 → 订阅方式必须是「使用长连接接收事件」，");
        lines.push("     并确认已订阅 im.message.receive_v1、权限含 im:message、且版本已发布。");
      }
      if (state.feishu.status === "failed") {
        lines.push("  ⚠️ 长连接未建立：收信不可用（发信不受影响）。看上面的错误。");
      }
      lines.push(`- 已去重消息: ${seen.map.size} 条（logs/feishu-seen.json）`);

      // QQ
      lines.push("");
      lines.push("## QQ 接收端");
      lines.push(`- 状态: ${state.qq.status}${state.qq.lastError ? `（${state.qq.lastError}）` : ""}`);
      lines.push(`- 端口: ${qqConfig?.wsPort ?? "(未配置)"}${state.qq.connections > 0 ? ` / 收到连接 ${state.qq.connections} 次` : ""}`);
      if (state.qq.lastEventAt) lines.push(`- 最后一条消息: ${new Date(state.qq.lastEventAt).toLocaleString("zh-CN", { hour12: false })}`);
      if (qqConfig && state.qq.connections === 0) {
        lines.push("  ℹ️ 还没有 NapCat 连上来 —— 在 NapCat 里把反向 WS 指向本端口。");
      }

      // 会话
      lines.push("");
      lines.push("## 可注入的会话");
      const live = liveAgents();
      lines.push(`- 存活 agent: ${live.length}（其中子代理 ${live.filter((row) => isSubagent(row.agent)).length}）`);
      for (const row of live.slice(0, 12)) {
        const active = agentLastActive(row.agent);
        const flag = isSubagent(row.agent) ? " [subagent]" : "";
        const last = lastInjectedSession === row.id ? " ← 上次注入" : "";
        lines.push(`  - ${row.id}${flag} 最后活跃=${active ? new Date(active).toLocaleString("zh-CN", { hour12: false }) : "未知"}${last}`);
      }
      if (live.length === 0) lines.push("  ⚠️ 一个都没有 —— 外部消息必定注入失败，客户端里要开着一个会话。");
      lines.push(`- 已注入 ${state.injected} 条 / 被拒绝 ${state.denied} 条`);

      // 邮件决策
      lines.push("");
      lines.push("## 邮件");
      lines.push(`- SMTP: ${usable(resolveChannel(resolved, "smtp", env)) ? "已配置" : "未配置"}`);
      lines.push(`- IMAP: ${imapConfig ? `已配置（每 ${Math.round(pollIntervalMs / 1000)}s 轮询）` : imapProblem ?? "未配置"}`);
      lines.push(`- 待回复决策: ${pendingIds().length} 个`);

      // 定时汇报
      lines.push("");
      lines.push("## 定时汇报");
      lines.push(`- 总开关: ${reportsEnabled ? "开" : "关（enableReports=false）"} / 计划 ${reports.length} 条`);
      if (reports.length > 0) {
        for (const row of scheduler.describe()) {
          lines.push(`  - ${row.name} → ${row.channel} / ${row.schedule}${row.valid ? "" : " ⚠️ 格式无法识别"}${row.lastFired ? ` / 上次 ${row.lastFired}` : ""}`);
        }
      }
      if (!reportsEnabled && reports.length > 0) lines.push("  ℹ️ 计划存在但总开关是关的；用 settings set enableReports true 打开。");

      // 日志
      lines.push("");
      lines.push("## 最近日志");
      try {
        const raw = await readFile(join(dshHome(), "logs", "notify.log"), "utf8");
        for (const line of raw.trim().split("\n").slice(-10)) lines.push(`  ${line.slice(0, 240)}`);
      } catch (error) {
        lines.push(`  （读取失败：${error instanceof Error ? error.message : String(error)}）`);
      }
      return { report: lines.join("\n") };
    },
    presentCall: () => ({ card: "generic", title: "Whale check", kind: "other" }),
  }));

  // ────────────────────────── 工具：notify ──────────────────────────
  ctx.tools.register(defineTool({
    name: "notify",
    description:
      "给用户发一条通知。渠道：feishu_bot（飞书开放平台，推荐）、qq（QQ/NapCat）、smtp（邮箱）、serverchan（微信）、"
      + "feishu（飞书群 webhook）、wecom（企业微信）、dingtalk（钉钉）。"
      + "耗时任务完成、失败、或需要用户离开聊天也能看到时使用。"
      + "从飞书/QQ 收到指令后，用 to/groupId 把结果发回原会话。未配置的渠道会被跳过。",
    parameters: NOTIFY_PARAMETERS,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          delivered: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                channel: { type: "string", required: true },
                ok: { type: "boolean", required: true },
                detail: { type: "string", required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: value.delivered.map((row) => `${row.channel}: ${row.ok ? "OK" : `FAILED — ${row.detail}`}`).join("\n"),
      }],
    },
    async execute(args, exec) {
      const title = formatTitle(args.title, args.level);
      let channels;
      try {
        channels = targetChannels(args.channel, resolved, process.env);
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error));
      }
      if (channels.length === 0) {
        if (args.channel && args.channel !== "all") {
          const entry = resolveChannel(resolved, args.channel, process.env);
          const why = isConfigError(entry) ? `：${entry.error}` : "：该渠道未配置";
          throw new Error(`notify：渠道 ${args.channel} 不可用${why}`);
        }
        throw new Error("notify：没有任何可用的通知渠道 —— 检查插件配置（whale_check 能列出缺什么）");
      }

      // awaitReply=true：邮件通知带决策编号，回复即指令（需要 IMAP 收信）。
      let reply;
      if (args.awaitReply === true) {
        if (!imapConfig) throw new Error(`notify(awaitReply:true)：需要先配置可用的 imap（收信）${imapProblem ? ` —— ${imapProblem}` : ""}`);
        const smtp = resolveChannel(resolved, "smtp", env);
        if (!usable(smtp)) throw new Error("notify(awaitReply:true)：需要先配置可用的 smtp（发信）");
        reply = { id: registerPending(exec.agent, title, smtp.to, undefined, "command") };
      }

      const delivered = [];
      for (const channel of channels) {
        const result = await trySend(channel, resolved, title, args.message, process.env, reply, {
          groupId: args.groupId,
          to: args.to,
        });
        // 输出 schema 只声明 channel/ok/detail；trySend 里的 parts 等内部字段不能透传，
        // 否则内核会以 `additionalProperties: false` 拒收整个工具结果。
        delivered.push({ channel: result.channel, ok: result.ok, detail: result.detail });
      }

      await appendLog({
        kind: "notify",
        title,
        channels: delivered,
        allOk: delivered.every((row) => row.ok),
        ...(reply ? { decisionId: reply.id } : {}),
      });

      if (!delivered.some((row) => row.ok)) {
        throw new Error(`notify：所有渠道都发送失败 —— ${delivered.map((row) => `${row.channel}（${row.detail}）`).join("；")}`);
      }
      return { delivered };
    },
    presentCall: (args) => ({ card: "generic", title: "Notify user", kind: "other", rawInput: args.title }),
  }));

  // ────────────────────────── 工具：ask_user_email ──────────────────────────
  ctx.tools.register(defineTool({
    name: "ask_user_email",
    description:
      "通过邮件向用户提问并等待回复。适合需要用户决策/审批、但用户不在电脑前时：邮件发出后本工具立即返回，"
      + "插件在后台轮询收件箱；用户回复后，回复内容作为一条用户消息注入本会话，agent 据此继续。需配置 smtp + imap。",
    parameters: ASK_PARAMETERS,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          decisionId: { type: "string", required: true },
          sentTo: { type: "string", required: true },
          note: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: `已通过邮件询问用户（${value.sentTo}），决策编号 ${value.decisionId}。${value.note}`,
      }],
    },
    async execute(args, exec) {
      const smtp = resolveChannel(resolved, "smtp", env);
      if (!usable(smtp)) throw new Error(`ask_user_email：smtp（发信）不可用${isConfigError(smtp) ? ` —— ${smtp.error}` : "（未配置）"}`);
      if (!imapConfig) throw new Error(`ask_user_email：imap（收信）不可用${imapProblem ? ` —— ${imapProblem}` : "（未配置）"}`);

      const recipients = smtp.to.length > 0 ? smtp.to : ["no-reply@localhost"];
      const id = registerPending(exec.agent, args.question, recipients);

      const optionsText = Array.isArray(args.options) && args.options.length > 0
        ? `\n\n可选项：${args.options.map((option) => `「${option}」`).join("、")}（直接回复其中一个即可）`
        : "";
      const contextText = args.context ? `\n\n背景：${args.context}` : "";
      const body = `你好，agent 需要你做一个决定：\n\n${args.question}${optionsText}${contextText}\n\n`
        + "请直接回复这封邮件告知你的选择（例如：继续 / 取消 / 具体指示）。回复会自动回到会话中。";

      await sendEmail(smtp, `${decisionTag(id)} 需要你的决定：${args.question.slice(0, 40)}`, body);
      await appendLog({ kind: "ask_user_email", decisionId: id, question: args.question, sentTo: recipients });

      return {
        decisionId: id,
        sentTo: recipients.join(", "),
        note: "用户回复后会自动回到本会话，请等待（不要重复询问）。",
      };
    },
    presentCall: (args) => ({ card: "generic", title: "Ask user by email", kind: "other", rawInput: args.question }),
  }));

  // ────────────────────────── 工具：recall_memory ──────────────────────────
  const sessionQuery = ctx.get("sessionQuery");
  if (sessionQuery && typeof sessionQuery.listSessions === "function") {
    ctx.tools.register(defineTool({
      name: "recall_memory",
      description:
        "从记忆库或历史会话恢复上下文。先搜统一记忆库文档（快且准），没有命中再按关键词找历史会话并注入其要点。"
        + "新会话需要延续之前的工作（项目进展、用户偏好、上次结论）时使用。",
      parameters: {
        query: {
          type: "string",
          required: true,
          description: "关键词：标题、工作目录或会话 ID 的一部分，多个词用空格分隔（全部命中）。",
        },
        sessionId: { type: "string", description: "可选：直接指定会话 ID，跳过搜索确认。" },
        includeTranscript: {
          type: "boolean",
          description: "为 true 时把历史会话最近 30 条对话原文也注入（默认只注入记忆文档）。",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            injected: { type: "boolean", required: true },
            detail: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.detail }],
      },
      async execute(args, exec) {
        if (!exec.agent) throw new Error("recall_memory 需要 agent 会话上下文");

        const docs = await searchMemoryDocs(args.query, 5);
        if (docs.length > 0 && !args.sessionId) {
          const doc = docs[0];
          const content = await readMemoryDoc(doc.path);
          exec.agent.followup(buildUserMessage(
            `## 从记忆库恢复的记忆（${doc.title}）\n\n${content}\n\n（来自统一记忆库 ${doc.category}，作为背景参考。）`,
          ));
          const others = docs.slice(1).map((row) => `「${row.title}」`).join("、");
          return {
            injected: true,
            detail: `已从记忆库恢复「${doc.title}」（${doc.category}）。${others ? `另有相关文档：${others}。` : ""}`,
          };
        }

        const currentId = exec.agent.id;
        let sessionId = args.sessionId;
        if (!sessionId) {
          const records = await sessionQuery.listSessions();
          const terms = String(args.query).toLowerCase().split(/\s+/).filter(Boolean);
          const matches = (records ?? [])
            .filter((record) => record?.header?.id !== currentId && record?.header?.origin !== "subagent")
            .map((record) => {
              const haystack = `${record.header?.id ?? ""} ${record.header?.cwd ?? ""} ${record.header?.title ?? ""}`.toLowerCase();
              const hits = terms.filter((term) => haystack.includes(term)).length;
              return { record, hits };
            })
            .filter((row) => row.hits === terms.length && row.hits > 0)
            .slice(0, 5);
          if (matches.length === 0) {
            return { injected: false, detail: `记忆库和历史会话里都没有匹配「${args.query}」的内容。` };
          }
          return {
            injected: false,
            detail: `找到 ${matches.length} 个候选会话：\n${matches.map((row, index) => `${index + 1}. ${row.record.header.id}（${row.record.header.cwd ?? ""}）`).join("\n")}\n`
              + `调用 recall_memory 并传 sessionId 选择其一。`,
          };
        }

        if (args.includeTranscript !== true) {
          return { injected: false, detail: `已定位会话 ${sessionId}；如需注入其对话原文，请传 includeTranscript: true。` };
        }

        const surface = await sessionQuery.readSurface(sessionId);
        if (!surface?.events || surface.events.length === 0) {
          return { injected: false, detail: `会话「${sessionId}」没有可读取的对话内容。` };
        }
        const lines = [];
        for (const event of surface.events) {
          if (event.type === "user/message") {
            const text = textOfMessage(event.data);
            if (text && !text.startsWith("[只读消息]")) lines.push(`用户: ${text}`);
          } else if (event.type === "assistant/message") {
            const text = textOfMessage(event.data.message);
            if (text) lines.push(`助手: ${text}`);
          }
        }
        if (lines.length === 0) return { injected: false, detail: `会话「${sessionId}」无有效对话内容。` };

        exec.agent.followup(buildUserMessage(
          `## 历史会话摘要（${sessionId}）\n\n（只作背景参考，勿视为当前指令）\n\n${lines.slice(-30).join("\n")}`,
        ));
        return { injected: true, detail: `已从会话「${sessionId}」恢复 ${Math.min(lines.length, 30)} 条对话。` };
      },
      presentCall: (args) => ({ card: "generic", title: "Recall memory", kind: "other", rawInput: args.query }),
    }));
  } else {
    console.warn("[dsh-whale-notify] sessionQuery 不可用 —— recall_memory 未注册");
  }

  // ────────────────────────── 工具：settings ──────────────────────────
  // 配置真实来源 = profile 里 `tool-notify` 这一行（由本 bundle 的 cordis.patch.yml 插入，
  // profile 的 cordis.patch.yml 可覆盖）。用 `configEditor` 写入：它会校验 schema 并
  // **立即热重载**，不用重启客户端 —— 旧实现改的是已废弃的 preset 目录，永远不生效。
  const configEditor = ctx.get("configEditor");
  const findEntry = () => {
    if (!configEditor) return undefined;
    const entries = configEditor.entries();
    return entries.find((entry) => entry.options.id === "tool-notify" && entry.options.name === "dsh-whale-notify")
      ?? entries.find((entry) => entry.options.id === "tool-notify");
  };
  /** Current effective config (falls back to the applied snapshot). */
  const currentConfig = () => {
    const entry = findEntry();
    return entry?.options?.config ?? resolved;
  };

  /** Modules shown by `settings get`. */
  const moduleList = () => [
    {
      key: "notify", name: "📢 通知", desc: "任务通知渠道",
      options: [
        { path: "defaultChannel", label: "默认渠道", type: "enum", values: CHANNELS },
      ],
    },
    {
      key: "report", name: "📅 定时汇报", desc: "每日/定期推送（默认关闭）",
      options: [{ path: "enableReports", label: "开关", type: "bool" }],
    },
    {
      key: "friend", name: "👥 群友模式", desc: "QQ 群里像网友互动（独立文件）",
      options: [
        { path: "friend.enabled", label: "开关", type: "bool" },
        { path: "friend.nickname", label: "称呼", type: "string" },
        { path: "friend.readOnly", label: "只读", type: "bool" },
        { path: "friend.blacklist.groups", label: "屏蔽群", type: "array" },
        { path: "friend.blacklist.users", label: "屏蔽用户", type: "array" },
      ],
    },
    {
      key: "acl", name: "🔐 访问控制", desc: "谁可指挥（白名单/开放）",
      options: [
        { path: "accessControl.mode", label: "模式", type: "enum", values: ["whitelist", "open"] },
        { path: "accessControl.allowedUsers.feishu", label: "飞书白名单", type: "array" },
        { path: "accessControl.allowedUsers.qq", label: "QQ 白名单", type: "array" },
      ],
    },
    {
      key: "memory", name: "🧠 记忆模式", desc: `统一记忆库 ${memoryDir()}`,
      options: [],
    },
    {
      key: "learn", name: "🎓 学习模式", desc: `知识库 ${knowledgeDir()}`,
      options: [],
    },
  ];

  ctx.tools.register(defineTool({
    name: "settings",
    description:
      "查看/修改鲸鱼通知插件配置。用户提到「配置」「功能」「设置」「开关」「渠道」「白名单」时使用。"
      + "get 列模块与当前值；set <路径> <值> 修改（数组用 +=/ -= 增删）；unset <路径> 删回默认。"
      + "改动通过 configEditor 校验并**立即热生效**（不需要重启）。群友模式走独立文件。",
    parameters: {
      action: {
        type: "string",
        required: true,
        enum: ["get", "set", "unset"],
        description: "get=查看；set=修改；unset=恢复默认。",
      },
      path: {
        type: "string",
        description: "点分配置路径，如 enableReports、defaultChannel、accessControl.mode、accessControl.allowedUsers.qq。",
      },
      value: {
        type: "string",
        description: "set 的值。数组追加/删除写 +=值 或 -=值（多项用逗号分隔）。",
      },
    },
    output: OK_OUTPUT,
    async execute(args) {
      const friendPath = typeof args.path === "string" && args.path.startsWith("friend.");

      // ── get ──
      if (args.action === "get") {
        if (!args.path) {
          const live = currentConfig();
          const lines = ["📋 鲸鱼通知配置", ""];
          for (const mod of moduleList()) {
            lines.push(`${mod.name} — ${mod.desc}`);
            for (const option of mod.options) {
              let value;
              if (option.path.startsWith("friend.")) {
                const friend = await readFriendConfig().catch(() => ({}));
                value = getByPath(friend, option.path.slice("friend.".length));
              } else {
                value = getByPath(live, option.path);
              }
              lines.push(`  · ${option.label} (${option.path}): ${JSON.stringify(value ?? "(未设置)")}`);
            }
            lines.push("");
          }
          lines.push(`配置来源：${configEditor ? "profile 的 tool-notify 行（可热改）" : "只读快照（configEditor 不可用）"}`);
          lines.push("用法：settings set enableReports true / settings set accessControl.allowedUsers.qq+=123456");
          return { ok: true, detail: lines.join("\n") };
        }

        const value = friendPath
          ? getByPath(await readFriendConfig().catch(() => ({})), args.path.slice("friend.".length))
          : getByPath(currentConfig(), args.path);
        return { ok: true, detail: `${args.path} = ${JSON.stringify(value ?? "(未设置)")}` };
      }

      // ── unset ──
      if (args.action === "unset") {
        if (!args.path) return { ok: false, detail: "unset 需要 path。" };
        if (friendPath) {
          const friend = await readFriendConfig();
          deleteByPath(friend, args.path.slice("friend.".length));
          await writeFriendConfig(friend);
          return { ok: true, detail: `已清除 ${args.path}` };
        }
        if (!configEditor) return { ok: false, detail: "configEditor 不可用，无法修改插件配置。" };
        const entry = findEntry();
        if (!entry) return { ok: false, detail: "找不到 tool-notify 配置行（插件是否作为 bundle 安装？）" };
        try {
          await configEditor.edit(entry, (current, inherited) => {
            const next = structuredClone(current ?? {});
            deleteByPath(next, args.path);
            // unset == 回到 bundle 默认值
            const merged = structuredClone(inherited ?? {});
            for (const key of Object.keys(next)) {
              if (!(key in merged) && next[key] !== undefined) merged[key] = next[key];
            }
            return merged;
          });
          return { ok: true, detail: `已把 ${args.path} 恢复为默认值，已生效。` };
        } catch (error) {
          return { ok: false, detail: `修改失败：${error instanceof Error ? error.message : String(error)}` };
        }
      }

      // ── set ──
      if (args.action === "set") {
        if (!args.path || args.value === undefined) {
          return { ok: false, detail: "set 需要 path 和 value。例：settings set enableReports true" };
        }
        const raw = String(args.value);
        const append = raw.startsWith("+=");
        const remove = raw.startsWith("-=");
        const literal = append || remove ? raw.slice(2) : raw;

        // 群友模式：独立 JSON 文件
        if (friendPath) {
          const friend = await readFriendConfig();
          const sub = args.path.slice("friend.".length);
          const items = () => literal.split(/[,，]/).map((item) => item.trim().replace(/^["']|["']$/g, "")).filter(Boolean);

          if (sub === "blacklist.groups" || sub === "blacklist.users") {
            const key = sub.endsWith("groups") ? "groups" : "users";
            friend.blacklist ??= { groups: [], users: [] };
            const list = friend.blacklist[key] ?? [];
            for (const item of items()) {
              if (append) { if (!list.includes(item)) list.push(item); }
              else if (remove) { const index = list.indexOf(item); if (index >= 0) list.splice(index, 1); }
              else if (!list.includes(item)) { list.push(item); }
            }
            friend.blacklist[key] = list;
            await writeFriendConfig(friend);
            await appendFriendMemory({ kind: "system", text: `黑名单 ${key} → ${list.join(",") || "空"}` }).catch(() => {});
            return { ok: true, detail: `群友黑名单 ${key}: ${list.join(", ") || "（空）"}` };
          }

          const value = parseValue(literal);
          if (sub === "enabled") {
            if (value === true && !friend.nickname) {
              return { ok: false, detail: "首次开启群友模式要先设称呼：settings set friend.nickname <称呼>" };
            }
            friend.enabled = value === true;
            await writeFriendConfig(friend);
            return { ok: true, detail: `群友模式已${friend.enabled ? "开启" : "关闭"}${friend.enabled && friend.readOnly ? "（只读）" : ""}。` };
          }
          if (sub === "nickname") {
            friend.nickname = String(value);
            await writeFriendConfig(friend);
            return { ok: true, detail: `群友称呼已设为「${friend.nickname}」。` };
          }
          if (sub === "readOnly") {
            friend.readOnly = value === true;
            await writeFriendConfig(friend);
            return { ok: true, detail: `群友只读模式已${friend.readOnly ? "开启" : "关闭"}。` };
          }
          setByPath(friend, sub, value);
          await writeFriendConfig(friend);
          return { ok: true, detail: `已设置 friend.${sub} = ${JSON.stringify(value)}` };
        }

        // 主配置
        if (!configEditor) {
          return { ok: false, detail: "configEditor 不可用，无法写入插件配置。请直接编辑插件包的 cordis.patch.yml。" };
        }
        const entry = findEntry();
        if (!entry) {
          return { ok: false, detail: "找不到 tool-notify 配置行。请确认 dsh-whale-notify 以 profile bundle 形式安装。" };
        }
        try {
          let applied;
          await configEditor.edit(entry, (current) => {
            const next = structuredClone(current ?? {});
            const existing = getByPath(next, args.path);
            let value;
            if (append || remove) {
              const list = Array.isArray(existing) ? [...existing] : [];
              const items = literal.split(/[,，]/).map((item) => item.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
              for (const item of items) {
                if (append) { if (!list.includes(item)) list.push(item); }
                else { const index = list.indexOf(item); if (index >= 0) list.splice(index, 1); }
              }
              value = list;
            } else {
              value = parseValue(literal);
            }
            setByPath(next, args.path, value);
            applied = value;
            return next;
          });
          await appendLog({ kind: "settings_set", path: args.path, value: applied });
          return { ok: true, detail: `已设置 ${args.path} = ${JSON.stringify(applied)}，配置已热生效。` };
        } catch (error) {
          return { ok: false, detail: `修改失败：${error instanceof Error ? error.message : String(error)}` };
        }
      }

      return { ok: false, detail: `未知操作 ${args.action}` };
    },
    presentCall: (args) => ({ card: "generic", title: "Settings", kind: "other", rawInput: `${args.action} ${args.path ?? ""}`.trim() }),
  }));

  // ────────────────────────── 工具：知识库 ──────────────────────────
  ctx.tools.register(defineTool({
    name: "learn_skill",
    description:
      "把一条技能/经验记进知识库（$DSH_HOME/knowledge/，markdown）。用户确认「记下来/以后照着做」时使用，"
      + "之后可用 recall_skill 搜回。",
    parameters: {
      title: { type: "string", required: true, description: "技能名称，例如「部署 DSH 插件包」。" },
      content: { type: "string", required: true, description: "详细内容：步骤、命令、坑点，markdown。" },
      tags: { type: "array", description: "可选标签，便于检索。", items: { type: "string" } },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { saved: { type: "boolean", required: true }, path: { type: "string", required: true } },
      },
      render: (_args, value) => [{ type: "text", text: value.saved ? `已存入知识库：${value.path}` : "保存失败" }],
    },
    async execute(args) {
      const path = await saveSkill(args.title, args.content, args.tags ?? []);
      await appendLog({ kind: "learn_skill", title: args.title, path });
      return { saved: true, path };
    },
    presentCall: (args) => ({ card: "generic", title: "Learn skill", kind: "other", rawInput: args.title }),
  }));

  ctx.tools.register(defineTool({
    name: "recall_skill",
    description:
      "从知识库搜索之前记录的技能/经验（learn_skill 保存的内容）。用户说「上次是怎么做的」「我记得学过」时使用。",
    parameters: {
      query: { type: "string", required: true, description: "关键词；留空列出全部。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          found: { type: "boolean", required: true },
          results: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string", required: true },
                path: { type: "string", required: true },
                snippet: { type: "string", required: true },
              },
            },
          },
          detail: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: value.found
          ? value.results.map((row) => `📄 ${row.title}\n   ${row.snippet}\n   ${row.path}`).join("\n\n")
          : value.detail,
      }],
    },
    async execute(args) {
      const results = await searchSkills(args.query, 8);
      if (results.length === 0) {
        return { found: false, results: [], detail: `知识库中未找到「${args.query}」（目录：${knowledgeDir()}）` };
      }
      return { found: true, results, detail: `找到 ${results.length} 条：${results.map((row) => row.title).join("、")}` };
    },
    presentCall: (args) => ({ card: "generic", title: "Recall skill", kind: "other", rawInput: args.query }),
  }));

  // ────────────────────────── 工具：save_memory ──────────────────────────
  ctx.tools.register(defineTool({
    name: "save_memory",
    description:
      "把当前会话/任务的要点存进统一记忆库（markdown，$DSH_HOME/memory/）。"
      + "用户说「保存记忆」「记住这个」「总结一下存起来」，或一段工作收尾时使用。"
      + "先压缩成要点（结论/步骤/偏好），不要贴原文。",
    parameters: {
      title: { type: "string", required: true, description: "记忆标题，如「插件包安装踩坑-2026-10-18」。" },
      content: { type: "string", required: true, description: "要点（markdown）。" },
      category: {
        type: "string",
        description: "conversations（跨会话记忆，默认）或 summaries（手动总结）。",
        enum: ["conversations", "summaries"],
      },
      tags: { type: "array", description: "可选标签。", items: { type: "string" } },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { saved: { type: "boolean", required: true }, path: { type: "string", required: true } },
      },
      render: (_args, value) => [{ type: "text", text: value.saved ? `✅ 已存入记忆库：${value.path}` : "保存失败" }],
    },
    async execute(args) {
      const path = await saveMemoryDoc(args.category ?? "conversations", args.title, args.content, args.tags ?? []);
      await appendLog({ kind: "save_memory", title: args.title, path });
      return { saved: true, path };
    },
    presentCall: (args) => ({ card: "generic", title: "Save memory", kind: "other", rawInput: args.title }),
  }));

  // ────────────────────────── 工具：friend_mode ──────────────────────────
  ctx.tools.register(defineTool({
    name: "friend_mode",
    description:
      "管理「群友模式」：QQ 群里像真实网友一样互动。可开关、设称呼、管理屏蔽群/用户。"
      + "独立记忆与回复风格（$DSH_HOME/friendmode/prompts.md）。首次开启必须先设称呼。",
    parameters: {
      action: {
        type: "string",
        required: true,
        enum: ["on", "off", "set_nickname", "block_group", "unblock_group", "block_user", "unblock_user", "set_readonly", "status", "prompt"],
        description: "on/off=开关；set_nickname=设称呼；block_*/unblock_*=黑名单；set_readonly=只读；status=状态；prompt=看/改提示词。",
      },
      value: { type: "string", description: "set_nickname 填称呼；block_* 填群号/QQ号；set_readonly 填 true/false；prompt 填新提示词（留空=查看）。" },
    },
    output: OK_OUTPUT,
    async execute(args) {
      const config = await readFriendConfig();
      switch (args.action) {
        case "on": {
          if (!config.nickname) {
            return { ok: false, detail: "首次开启群友模式需要先设置称呼：先问用户想让大家怎么称呼，再 friend_mode(set_nickname, 称呼)，然后重新开启。" };
          }
          if (config.readOnly === undefined) config.readOnly = false;
          config.enabled = true;
          await writeFriendConfig(config);
          await appendFriendMemory({ kind: "system", text: "群友模式已开启" }).catch(() => {});
          return { ok: true, detail: `群友模式已开启（称呼「${config.nickname}」，只读：${config.readOnly ? "是" : "否"}）。配置目录 ${friendModeDir()}` };
        }
        case "off": {
          config.enabled = false;
          await writeFriendConfig(config);
          await appendFriendMemory({ kind: "system", text: "群友模式已关闭" }).catch(() => {});
          return { ok: true, detail: "群友模式已关闭。" };
        }
        case "set_nickname": {
          if (!args.value) return { ok: false, detail: "请提供称呼（value）。" };
          config.nickname = String(args.value).trim();
          await writeFriendConfig(config);
          return { ok: true, detail: `称呼已设为「${config.nickname}」。群里提到该称呼时会回应。` };
        }
        case "set_readonly": {
          config.readOnly = String(args.value ?? "true") !== "false";
          await writeFriendConfig(config);
          return { ok: true, detail: `群友只读模式已${config.readOnly ? "开启" : "关闭"}。` };
        }
        case "block_group":
        case "unblock_group":
        case "block_user":
        case "unblock_user": {
          if (!args.value) return { ok: false, detail: `请提供${args.action.includes("group") ? "群号" : "QQ 号"}。` };
          const key = args.action.includes("group") ? "groups" : "users";
          config.blacklist ??= { groups: [], users: [] };
          const list = config.blacklist[key] ?? [];
          const target = String(args.value);
          if (args.action.startsWith("block")) {
            if (!list.includes(target)) list.push(target);
            config.blacklist[key] = list;
            await writeFriendConfig(config);
            return { ok: true, detail: `已屏蔽${key === "groups" ? "群" : "用户"} ${target}。` };
          }
          config.blacklist[key] = list.filter((item) => item !== target);
          await writeFriendConfig(config);
          return { ok: true, detail: `已取消屏蔽${key === "groups" ? "群" : "用户"} ${target}。` };
        }
        case "prompt": {
          if (args.value) {
            const { mkdir: mkdirFs, writeFile: writeFs } = await import("node:fs/promises");
            await mkdirFs(friendModeDir(), { recursive: true });
            await writeFs(join(friendModeDir(), "prompts.md"), String(args.value), "utf8");
            return { ok: true, detail: "群友回复提示词已更新。" };
          }
          const prompt = await readFriendPrompts();
          return { ok: true, detail: `当前提示词（${join(friendModeDir(), "prompts.md")}）：\n\n${prompt || DEFAULT_PROMPTS}` };
        }
        case "status": {
          return {
            ok: true,
            detail: [
              `群友模式：${config.enabled ? "已开启" : "已关闭"}`,
              `称呼：${config.nickname || "未设置"}`,
              `只读：${config.readOnly ? "是" : "否"}`,
              `屏蔽群：${(config.blacklist?.groups ?? []).join(", ") || "无"}`,
              `屏蔽用户：${(config.blacklist?.users ?? []).join(", ") || "无"}`,
              `配置：${join(friendModeDir(), "config.json")}`,
            ].join("\n"),
          };
        }
        default:
          return { ok: false, detail: `未知操作 ${args.action}` };
      }
    },
    presentCall: (args) => ({ card: "generic", title: "Friend mode", kind: "other", rawInput: args.action }),
  }));

  // ────────────────────────── 工具：plugin_tools ──────────────────────────
  // 让模型能「看见并调用」宿主上其它插件的工具。
  // 为什么需要：模型默认只看到工具名 + 参数，看不到工具属于哪个插件、要不要前置条件
  // （比如 db_query 必须先 db_connect），也不知道某个工具是被 preset 的 restrict 挡掉的。
  // 这里给它一张带注释的清单，以及一个能在同一轮里连续调多个工具的入口。
  ctx.tools.register(defineTool({
    name: "plugin_tools",
    description:
      "查看并调用宿主上其他插件的工具。list 按插件/能力分类列出本会话可用的工具（含所属插件、前置条件、典型用法）；"
      + "call 以当前会话身份连续调用 1-8 个工具（走完整审批与策略管线，等价于你自己直接调，但省掉多轮往返）。"
      + "当用户提到某个能力（数据库、SSH、Office、单位换算…）而你不确定用哪个工具时，先 list；"
      + "当一步操作需要「先准备再执行」（例如 db_connect → db_query）时，用 call 把两步一次做完。",
    parameters: {
      action: {
        type: "string",
        required: true,
        enum: ["list", "call"],
        description: "list=查看可用工具清单；call=调用工具。",
      },
      group: {
        type: "string",
        description: "list 用：只看某一类，例如 SSH / 数据库 / 文件 / 通知 / 文档。",
      },
      keyword: {
        type: "string",
        description: "list 用：按关键词过滤（工具名、插件名、用途都能匹配）。",
      },
      include_unavailable: {
        type: "boolean",
        description: "list 用：连本会话看不到的工具也列出来（用来解释「为什么没有这个工具」）。",
      },
      steps: {
        type: "array",
        description:
          "call 用：按顺序执行的步骤。前一步的返回值可以用 $0.field / $1.field 引用到后一步的参数里"
          + "（例如第 0 步 db_connect 返回 db_connection_id，第 1 步传 \"$0.db_connection_id\"）。",
        items: {
          type: "object",
          additionalProperties: false,
          // 注意：这里只能用属性级 required（`required: true`），
          // 不能写 items 级的 required 数组 —— 旧版 dsh-tools 的 schema DSL 不认它。
          properties: {
            tool: { type: "string", required: true, description: "工具名，例如 db_query。" },
            arguments: { type: "string", description: "参数：JSON 对象字符串，例如 {\"sql\":\"select 1\"}。" },
          },
        },
      },
      stop_on_error: {
        type: "boolean",
        description: "call 用：某一步失败就停下（默认 true）。设 false 会继续跑完剩余步骤。",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          detail: { type: "string", required: true },
          results: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                tool: { type: "string", required: true },
                ok: { type: "boolean", required: true },
                isError: { type: "boolean", required: true },
                output: { type: "string", required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.detail }],
    },
    async execute(args, exec) {
      const tools = ctx.get("tools") ?? ctx.tools;

      // ── list ──
      if (args.action === "list") {
        const inventory = buildInventory(tools, exec.agent);
        if (inventory.entries.length === 0) {
          return { detail: "宿主注册表里没有任何工具（tools 服务不可用？）", results: [] };
        }
        const hidden = inventory.entries.filter((entry) => !entry.visible);
        const sections = summarizeInventory(inventory.entries, {
          group: args.group,
          keyword: args.keyword,
          onlyVisible: args.include_unavailable !== true,
        });

        const lines = [
          `## 本会话可用的工具：${inventory.visibleCount} / 注册总数 ${inventory.entries.length}`,
          "",
        ];
        for (const section of sections) {
          lines.push(`### ${section.group}`);
          for (const entry of section.entries) {
            const params = entry.requiredParams.length > 0 ? ` 必需参数：${entry.requiredParams.join(", ")}` : "";
            const owner = entry.owner ? `〔${entry.owner}〕` : "";
            lines.push(`- ${entry.name} ${owner}${entry.hint ? ` — ${entry.hint}` : ""}${params}`);
            if (entry.prereq) lines.push(`    前置：${entry.prereq}`);
            if (!entry.visible) lines.push("    ⚠️ 当前会话看不到它（被 restrict 挡掉或插件未启用）");
          }
          lines.push("");
        }
        if (hidden.length > 0 && args.include_unavailable !== true) {
          lines.push(`另有 ${hidden.length} 个工具对本会话不可见（加 include_unavailable: true 查看）。`);
        }
        lines.push("要连续调用多步，用 plugin_tools(action: \"call\", steps: [{tool, arguments}, …])。");
        return { detail: lines.join("\n"), results: [] };
      }

      // ── call ──
      if (args.action === "call") {
        const steps = Array.isArray(args.steps) ? args.steps : [];
        if (steps.length === 0) {
          return { detail: "call 需要至少一个 step（{tool, arguments}）。", results: [] };
        }
        if (steps.length > MAX_BATCH) {
          return { detail: `一次最多 ${MAX_BATCH} 步（收到 ${steps.length} 步），请拆成几次调用。`, results: [] };
        }

        const stopOnError = args.stop_on_error !== false;
        const results = [];
        /** 按索引保存每一步的规范值，供后续 $N.path 引用。 */
        const values = [];
        /** 自动纠正过的引用（字段名风格不一致时）。 */
        const corrections = [];

        for (const [index, step] of steps.entries()) {
          const name = String(step?.tool ?? "").trim();
          if (name === "") {
            results.push({ tool: "(空)", ok: false, isError: true, output: "step 缺少 tool。" });
            if (stopOnError) break;
            continue;
          }

          let parsed;
          const notes = [];
          try {
            parsed = parseStepArguments(step?.arguments, values, notes);
          } catch (error) {
            results.push({
              tool: name, ok: false, isError: true,
              output: `参数不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
            });
            if (stopOnError) break;
            continue;
          }

          const outcome = await callTool(tools, {
            agent: exec.agent,
            signal: exec.signal,
            parentToken: exec.token,
            rootCallId: exec.callId,
            depth: 0,
          }, name, parsed);

          // 把这一跳的规范值留给后续步骤做 $N.path 引用；失败就没有规范值。
          values[index] = outcome.value;
          results.push({
            tool: name,
            ok: outcome.ok,
            isError: outcome.isError,
            output: outcome.text,
          });
          // 纠正记录不能塞进 results（output schema 声明了 additionalProperties: false），
          // 单独攒一份，最后统一打印。
          if (notes.length > 0) corrections.push(...notes);
          if (outcome.isError && stopOnError) break;
        }

        const failed = results.filter((row) => row.isError || !row.ok).length;
        const lines = [`## 调用 ${results.length} 个工具，失败 ${failed} 个`, ""];
        for (const [index, row] of results.entries()) {
          // 三态：成功 / 执行失败（真的跑了但报错或参数不合法）/ 未执行（前面失败后中断）
          const state = row.isError || !row.ok ? "失败" : "成功";
          lines.push(`### ${index + 1}. ${row.tool} — ${state}`);
          lines.push(row.output);
          lines.push("");
        }
        // 字段名风格不一致导致的「自动纠正」要显式说出来，否则模型下次还会写错。
        if (corrections.length > 0) {
          lines.push(`ℹ️ 自动纠正的引用：${corrections.join("；")}`);
          lines.push("");
        }
        if (failed > 0 && stopOnError && results.length < steps.length) {
          lines.push(`（第 ${results.length + 1} 步起未执行：stop_on_error 默认在首次失败后中断；要跑完全部步骤传 stop_on_error: false。）`);
        }
        return { detail: lines.join("\n"), results };
      }

      return { detail: `未知 action ${args.action}（只支持 list / call）。`, results: [] };
    },
    presentCall: (args) => ({
      card: "generic",
      title: "Plugin tools",
      kind: "other",
      rawInput: args.action,
    }),
  }));

  // 启动日志：一眼看出这版插件在什么状态下起来的
  appendLog({
    kind: "plugin_start",
    build: BUILD_TAG,
    channels: configuredChannels(resolved, env),
    acl: acl.mode,
    reports: reports.length,
    feishu: state.feishu.status,
    qq: qqConfig ? "configured" : "off",
  }).catch(() => {});
}

export { Config, apply, inject, name };
