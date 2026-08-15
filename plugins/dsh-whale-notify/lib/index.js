import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createHmac, randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sendEmail } from "./smtp.js";
import { registerPending, pollAndInject, decisionTag } from "./ask.js";
import { getTenantToken, sendText, startLongConnection, extractMessageEvent } from "./feishu.js";
import { sendQQ, startQQReceiver } from "./qq.js";

/** Append one JSONL record to $DSH_HOME/logs/notify.log (creates dir/file). */
async function appendLog(record) {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? ".", ".dsh");
  const dir = join(home, "logs");
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, "notify.log"), `${JSON.stringify(record)}\n`, "utf8");
}

/**
 * @module dsh-whale-notify
 *
 * Model-facing `notify` tool. Sends a completion/status message through one
 * or more configured channels: WeChat (ServerChan), Feishu, WeCom, DingTalk,
 * and email (SMTP). All transport uses the host runtime's native `fetch` and
 * `node:net`/`node:tls` — no runtime dependencies beyond the DSH tool
 * registry and cordis.
 */

const name = "tool-notify";
// timer 是 host 层服务（dsh-base 提供）；邮件回复轮询（ctx.interval）需要注入它。
const inject = ["tools", "timer"];

/** Schema of the `notify` tool's parameters (registry-facing JSON Schema). */
const PARAMETERS = {
  title: {
    type: "string",
    required: true,
    description: "通知标题，例如「任务完成」或「构建失败」。",
  },
  message: {
    type: "string",
    required: true,
    description: "通知正文。发送到机器人渠道时是纯文本；发送邮件时是邮件正文（纯文本）。",
  },
  channel: {
    type: "string",
    description:
      "要发送的渠道。可用渠道：feishu_bot（飞书开放平台，双向聊天，推荐）、qq（QQ，需 NapCat）、" +
      "serverchan（微信）、feishu（飞书群 webhook）、wecom（企业微信）、dingtalk（钉钉）、smtp（邮箱）。" +
      "不填时使用默认渠道；填 all 则发送到所有已配置的渠道。未配置的渠道会被跳过。",
    enum: ["all", "serverchan", "feishu", "feishu_bot", "qq", "wecom", "dingtalk", "smtp"],
  },
  level: {
    type: "string",
    description: "可选的通知级别，会在标题前加上对应标签，例如 [完成]、[错误]。",
    enum: ["info", "success", "warning", "error"],
  },
  awaitReply: {
    type: "boolean",
    description:
      "设为 true 时，邮件通知会附带决策编号，你直接回复该邮件即可给 agent 下达下一步指令，" +
      "回复内容会自动注入回当前会话。仅对邮件渠道生效；要求配置了 imap。",
  },
};

/** Schema of the `ask_user_email` tool's parameters. */
const ASK_PARAMETERS = {
  question: {
    type: "string",
    required: true,
    description: "要问用户的问题，例如「是否允许我删除这些临时文件？」或「接下来先做哪个任务？」。",
  },
  context: {
    type: "string",
    description: "可选的背景信息，会附在邮件里帮助用户决策。",
  },
  options: {
    type: "array",
    description: "可选的建议选项（例如 ['继续', '取消']），用户可以直接回复选项文字。",
    items: { type: "string" },
  },
};

/** Default HTTP timeout for webhook calls, in milliseconds. */
const HTTP_TIMEOUT_MS = 15000;

/** Fetch with a hard timeout via AbortController (host runtime has fetch). */
async function fetchWithTimeout(url, options = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Read a JSON error message from a failed webhook response body. */
async function readErrorBody(response) {
  try {
    const text = await response.text();
    const trimmed = text.trim();
    if (trimmed.length === 0) return "";
    try {
      const parsed = JSON.parse(trimmed);
      const pick = parsed.msg || parsed.message || parsed.errmsg || parsed.error;
      return typeof pick === "string" ? pick : trimmed.slice(0, 200);
    } catch {
      return trimmed.slice(0, 200);
    }
  } catch {
    return "";
  }
}

/** Assert a 2xx response; throw with a channel-specific message otherwise. */
async function assertOk(response, channelLabel, url) {
  if (!response.ok) {
    const detail = await readErrorBody(response);
    throw new Error(`${channelLabel} failed (HTTP ${response.status}${detail ? `: ${detail}` : ""})`);
  }
}

/**
 * Send a plain-text message to a Feishu custom-bot webhook.
 * @param webhook - the bot's webhook URL.
 * @param secret - optional signing secret (used when the bot requires signing).
 * @param text - the message text.
 */
async function sendFeishu(webhook, secret, text) {
  const body = { msg_type: "text", content: { text } };
  if (secret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sign = await hmacSha256Base64(`${timestamp}\n${secret}`, secret);
    body.timestamp = timestamp;
    body.sign = sign;
  }
  const response = await fetchWithTimeout(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await assertOk(response, "Feishu", webhook);
}

/**
 * Send a plain-text message to a WeCom (WeChat Work) group-bot webhook.
 * @param webhook - the bot's webhook URL.
 * @param text - the message text.
 */
async function sendWecom(webhook, text) {
  const response = await fetchWithTimeout(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msgtype: "text", text: { content: text } }),
  });
  await assertOk(response, "WeCom", webhook);
}

/**
 * Send a plain-text message to a DingTalk custom-bot webhook.
 * @param webhook - the bot's webhook URL (without query string).
 * @param secret - optional signing secret (used when the bot requires signing).
 * @param text - the message text.
 */
async function sendDingTalk(webhook, secret, text) {
  let url = webhook;
  if (secret) {
    const timestamp = Date.now();
    const sign = await hmacSha256Base64(`${timestamp}\n${secret}`, secret);
    const separator = webhook.includes("?") ? "&" : "?";
    url = `${webhook}${separator}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
  }
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msgtype: "text", text: { content: text } }),
  });
  await assertOk(response, "DingTalk", url);
}

/**
 * Send a message via ServerChan (WeChat push).
 * @param sendKey - the ServerChan Turbo send key.
 * @param title - the push title.
 * @param desp - the push body (Markdown).
 * @param baseUrl - optional API base (defaults to the official endpoint).
 */
async function sendServerChan(sendKey, title, desp, baseUrl) {
  const url = `${baseUrl ?? "https://sctapi.ftqq.com"}/${encodeURIComponent(sendKey)}.send`;
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ title, desp }),
  });
  await assertOk(response, "ServerChan", url);
}

/** Resolve an SMTP config entry, validating required fields. */
function resolveSmtp(config, env) {
  if (!config || typeof config !== "object") return undefined;
  const expand = (value) => {
    if (typeof value !== "string") return value;
    const match = /^\$ENV:([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
    return match ? env[match[1]] : value;
  };
  const host = expand(config.host);
  const user = expand(config.user);
  const pass = expand(config.pass);
  // 区分「没配置」和「配置了但环境变量没解析出来」，给出可操作的错误提示。
  if (!host) return { error: "smtp 未配置 host（例如 smtp.feishu.cn）" };
  if (!user) return { error: "smtp 未配置 user（发信账号）" };
  if (!pass) {
    const rawPass = config.pass;
    const envRef = typeof rawPass === "string" && /^\$ENV:([A-Za-z_][A-Za-z0-9_]*)$/.exec(rawPass);
    return {
      error: envRef
        ? `环境变量 ${envRef[1]} 未设置或为空 —— 请先运行: [Environment]::SetEnvironmentVariable("${envRef[1]}", "你的专用密码", "User") 并重启 DSH`
        : "smtp 未配置 pass（专用密码/授权码）",
    };
  }
  const from = expand(config.from) ?? user;
  const fromName = expand(config.fromName);
  return {
    host,
    port: config.port ?? (config.secure === false ? 587 : 465),
    secure: config.secure ?? true,
    user,
    pass,
    from,
    fromName,
    fromHeader: fromName ? `${fromName} <${from}>` : from,
    to: (Array.isArray(config.to) ? config.to : [config.to]).map(expand).filter(Boolean),
    ...config.rejectUnauthorized !== undefined ? { rejectUnauthorized: config.rejectUnauthorized } : {},
    ...config.retries !== undefined ? { retries: config.retries } : {},
  };
}

/** Expand a `$ENV:NAME` reference against the given environment. */
function expandEnv(value, env) {
  if (typeof value !== "string") return value;
  const match = /^\$ENV:([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
  return match ? env[match[1]] : value;
}

/**
 * Resolve one channel entry from plugin config, or undefined when not
 * configured. `serverchan` requires `sendKey`; webhook channels require
 * `webhook`; `smtp` requires host/user/pass.
 */
function resolveChannel(config, channelName, env) {
  if (!config || typeof config !== "object") return undefined;
  const entry = channelName === "feishu_bot" ? config.feishuBot : config[channelName];
  if (!entry || typeof entry !== "object") return undefined;
  if (channelName === "smtp") {
    return resolveSmtp(entry, env);
  }
  if (channelName === "serverchan") {
    const sendKey = expandEnv(entry.sendKey, env);
    return sendKey ? { sendKey, baseUrl: expandEnv(entry.baseUrl, env) } : undefined;
  }
  if (channelName === "feishu_bot") {
    const appId = expandEnv(entry.appId, env);
    const appSecret = expandEnv(entry.appSecret, env);
    const receiveId = expandEnv(entry.receiveId, env);
    if (!appId || !appSecret || !receiveId) {
      return { error: "feishu_bot 未配置完整（需要 appId/appSecret/receiveId，均可用 $ENV: 引用）" };
    }
    return {
      appId,
      appSecret,
      receiveId,
      receiveIdType: entry.receiveIdType ?? "chat_id",
      targetSession: expandEnv(entry.targetSession, env) || undefined,
    };
  }
  if (channelName === "qq") {
    const qq = expandEnv(entry.qq, env);
    const groupId = expandEnv(entry.groupId, env);
    if (!qq && !groupId) {
      return { error: "qq 未配置完整（需要 qq 私聊号或 groupId 群号）" };
    }
    return {
      httpBase: expandEnv(entry.httpBase, env) || undefined,
      accessToken: expandEnv(entry.accessToken, env) || undefined,
      qq,
      groupId,
      wsPort: entry.wsPort ?? 3001,
      targetSession: expandEnv(entry.targetSession, env) || undefined,
    };
  }
  const webhook = expandEnv(entry.webhook, env);
  if (!webhook) return undefined;
  return { webhook, secret: expandEnv(entry.secret, env) };
}

/** Whether a resolved channel entry is a config-error placeholder. */
function isConfigError(entry) {
  return entry !== undefined && entry !== null && typeof entry === "object" && typeof entry.error === "string";
}

/** HMAC-SHA256 → base64 (shared by Feishu and DingTalk signing). */
function hmacSha256Base64(data, secret) {
  return Promise.resolve().then(() => createHmac("sha256", secret).update(data).digest("base64"));
}

/**
 * Build the level tag prefix and the final titled text.
 */
function formatTitle(title, level) {
  const tag = { info: "[信息]", success: "[完成]", warning: "[警告]", error: "[错误]" }[level];
  return tag ? `${tag} ${title}` : title;
}

/**
 * Run one send attempt; resolves the outcome, never throws.
 * @param reply - optional { id, hint } — when set, the SMTP subject carries
 *   the decision tag and the body gains a "reply to command" hint.
 */
async function trySend(channel, config, title, message, env, reply) {
  const entry = resolveChannel(config, channel, env);
  try {
    switch (channel) {
      case "serverchan": {
        if (!entry) throw new Error("Server酱渠道未配置（缺少 sendKey）");
        await sendServerChan(entry.sendKey, title, message, entry.baseUrl);
        return { channel, ok: true, detail: "sent" };
      }
      case "feishu": {
        if (!entry) throw new Error("飞书渠道未配置（缺少 webhook）");
        await sendFeishu(entry.webhook, entry.secret, message);
        return { channel, ok: true, detail: "sent" };
      }
      case "feishu_bot": {
        if (!entry) throw new Error("飞书开放平台渠道未配置");
        if (isConfigError(entry)) throw new Error(entry.error);
        const token = await getTenantToken(entry.appId, entry.appSecret);
        const text = reply ? `${title}\n\n${message}\n\n[决策编号 ${reply.id}] 回复本消息可直接给 agent 下达下一步指令。` : `${title}\n\n${message}`;
        await sendText(token, entry.receiveId, entry.receiveIdType, text);
        return { channel, ok: true, detail: "sent via open platform" };
      }
      case "qq": {
        if (!entry) throw new Error("QQ 渠道未配置");
        if (isConfigError(entry)) throw new Error(entry.error);
        const target = entry.groupId ? { groupId: entry.groupId } : { qq: entry.qq };
        const text = reply ? `${title}\n\n${message}\n\n[决策编号 ${reply.id}] 回复本消息可直接给 agent 下达下一步指令。` : `${title}\n\n${message}`;
        await sendQQ(entry, target, text);
        return { channel, ok: true, detail: entry.groupId ? `sent to group ${entry.groupId}` : `sent to ${entry.qq}` };
      }
      case "wecom": {
        if (!entry) throw new Error("企业微信渠道未配置（缺少 webhook）");
        await sendWecom(entry.webhook, message);
        return { channel, ok: true, detail: "sent" };
      }
      case "dingtalk": {
        if (!entry) throw new Error("钉钉渠道未配置（缺少 webhook）");
        await sendDingTalk(entry.webhook, entry.secret, message);
        return { channel, ok: true, detail: "sent" };
      }
      case "smtp": {
        if (!entry) throw new Error("邮件渠道未配置");
        if (isConfigError(entry)) throw new Error(entry.error);
        const finalTitle = reply ? `${decisionTag(reply.id)} ${title}` : title;
        const finalMessage = reply
          ? `${message}\n\n---\n回复此邮件可直接给 agent 下达下一步指令（决策编号 ${reply.id}）。回复内容会作为你的指令自动回到会话中。`
          : message;
        await sendEmail(entry, finalTitle, finalMessage);
        return { channel, ok: true, detail: `sent to ${entry.to.join(", ")}` };
      }
      default:
        throw new Error(`未知渠道 ${JSON.stringify(channel)}`);
    }
  } catch (error) {
    return { channel, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Build the list of channels to send to for this call. */
function targetChannels(channelArg, config, env) {
  const configured = [];
  for (const candidate of ["serverchan", "feishu", "feishu_bot", "qq", "wecom", "dingtalk", "smtp"]) {
    if (resolveChannel(config, candidate, env) !== undefined) configured.push(candidate);
  }
  if (channelArg === "all") return configured;
  if (channelArg !== undefined) {
    if (!["serverchan", "feishu", "feishu_bot", "qq", "wecom", "dingtalk", "smtp"].includes(channelArg)) {
      throw new Error(`无效的渠道 ${JSON.stringify(channelArg)}（可选：all/serverchan/feishu/feishu_bot/wecom/dingtalk/smtp）`);
    }
    return configured.includes(channelArg) ? [channelArg] : [];
  }
  // Default: the configured default channel, else every configured channel.
  const defaultChannel = config?.defaultChannel;
  if (typeof defaultChannel === "string" && defaultChannel !== "all" && configured.includes(defaultChannel)) {
    return [defaultChannel];
  }
  return configured;
}

/** Plugin config schema. Optional object fields: all fields are optional by default. */
const Config = z.object({
  defaultChannel: z.string().default(""),
  serverchan: z.object({ sendKey: z.string(), baseUrl: z.string() }),
  feishu: z.object({ webhook: z.string(), secret: z.string() }),
  feishuBot: z.object({
    appId: z.string(),
    appSecret: z.string(),
    receiveId: z.string(),
    receiveIdType: z.string(),
    targetSession: z.string(),
  }),
  wecom: z.object({ webhook: z.string() }),
  dingtalk: z.object({ webhook: z.string(), secret: z.string() }),
  qq: z.object({
    httpBase: z.string(),
    accessToken: z.string(),
    qq: z.string(),            // 私聊目标 QQ 号
    groupId: z.string(),       // 群聊目标群号（可选）
    wsPort: z.number(),        // 接收端反向 WS 端口
    targetSession: z.string(), // 可选：QQ 消息注入哪个 DSH 会话
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
  // 收件配置：用于「ask_user_email」轮询用户对邮件的回复。
  imap: z.object({
    host: z.string(),
    port: z.number(),
    secure: z.boolean(),
    user: z.string(),
    pass: z.string(),
    mailbox: z.string(),
    rejectUnauthorized: z.boolean(),
  }),
  pollIntervalMs: z.number(),
  // 定时汇报：{ name, channel, schedule, text } 数组。
  // schedule 格式："daily:HH:MM"（每日定点）或 "every:N"（每 N 分钟，N>=5）。
  reports: z.array(z.object({
    name: z.string(),
    channel: z.string(),
    schedule: z.string(),
    text: z.string(),
  })),
});

/** Resolve the IMAP config (same $ENV: expansion as SMTP). */
function resolveImap(config, env) {
  if (!config?.imap) return undefined;
  const expand = (value) => {
    if (typeof value !== "string") return value;
    const match = /^\$ENV:([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
    return match ? env[match[1]] : value;
  };
  const imap = config.imap;
  const host = expand(imap.host);
  const user = expand(imap.user);
  const pass = expand(imap.pass);
  if (!host || !user || !pass) return undefined;
  return {
    host,
    port: imap.port ?? 993,
    secure: imap.secure ?? true,
    user,
    pass,
    mailbox: imap.mailbox ?? "INBOX",
    rejectUnauthorized: imap.rejectUnauthorized ?? true,
  };
}

function apply(ctx, config) {
  const resolved = config ?? {};
  const env = process.env;
  const imapConfig = resolveImap(resolved, env);
  const pollIntervalMs = resolved.pollIntervalMs ?? 60000;
  const feishuBotConfig = resolveChannel(resolved, "feishu_bot", env);
  const qqConfig = resolveChannel(resolved, "qq", env);

  /** 注入一条用户消息到目标 agent（配置指定 session 或注册表第一个）。 */
  const injectToAgent = (agents, targetSession, text, logKind, from) => {
    if (!agents || typeof agents.list !== "function") return;
    const list = agents.list();
    let target = targetSession ? agents.get(targetSession) : list[0];
    if (target && typeof target.followup === "function") {
      target.followup({
        id: randomUUID(),
        role: "user",
        content: [{ type: "text", text }],
        source: { kind: "user" },
      });
      appendLog({ ts: new Date().toISOString(), kind: logKind, from, text }).catch(() => {});
    }
  };

  // 邮件回复轮询：有 imap 配置且有 pending 决策时才真正连接（间隔轮询）。
  // timer 已通过 inject 声明（host 层 dsh-base 提供），这里直接可用。
  if (imapConfig) {
    ctx.interval(async () => {
      try {
        await pollAndInject(imapConfig);
      } catch (error) {
        console.error("[dsh-whale-notify] imap poll failed:", error instanceof Error ? error.message : String(error));
      }
    }, pollIntervalMs);
  }

  // 飞书开放平台：长连接接收消息 → 注入目标 agent 会话。
  // agents 是 host 层服务（可选依赖）；没有它时只保留发信能力。
  if (feishuBotConfig && !isConfigError(feishuBotConfig)) {
    const agents = ctx.get("agents");
    if (agents && typeof agents.list === "function") {
      let stopLongConnection = () => {};
      startLongConnection(feishuBotConfig.appId, feishuBotConfig.appSecret, (payload) => {
        const msg = extractMessageEvent(payload);
        if (!msg) return;
        // 只处理发往配置的目标会话（或用户发给机器人的私聊）
        if (feishuBotConfig.receiveIdType === "chat_id" && msg.chatId !== feishuBotConfig.receiveId) return;
        injectToAgent(agents, feishuBotConfig.targetSession, `飞书消息（来自 ${msg.senderId ?? "用户"}）：${msg.text}`, "feishu_in", msg.senderId);
      }).then((stop) => {
        stopLongConnection = stop;
      }).catch((error) => {
        console.error("[dsh-whale-notify] 飞书长连接启动失败:", error instanceof Error ? error.message : String(error));
      });
      // 插件停止时断开长连接
      ctx.effect(() => stopLongConnection);
    } else {
      console.warn("[dsh-whale-notify] agents 服务不可用 — 飞书消息注入未启用（仅保留发信）");
    }
  }

  // QQ（OneBot/NapCat）：接收 QQ 消息 → 注入目标 agent 会话。
  if (qqConfig && !isConfigError(qqConfig)) {
    const agents = ctx.get("agents");
    try {
      const stopQQ = startQQReceiver(qqConfig, (msg) => {
        const label = msg.type === "group" ? `群 ${msg.groupId}` : `QQ ${msg.userId}`;
        injectToAgent(agents, qqConfig.targetSession, `QQ 消息（来自 ${label}）：${msg.text}`, "qq_in", msg.userId);
      });
      ctx.effect(() => stopQQ);
    } catch (error) {
      console.error("[dsh-whale-notify] QQ 接收端启动失败:", error instanceof Error ? error.message : String(error));
    }
  }

  // 定时汇报：到点通过 notify 推送到配置的渠道（飞书/QQ/邮件等）。
  // reports: [{ name, channel, schedule: "daily:09:00" | "every:<min>", text }]
  const reports = Array.isArray(resolved.reports) ? resolved.reports : [];
  if (reports.length > 0 && typeof ctx.interval === "function") {
    const fire = (report) => {
      // 用 notify 的发送链路（复用 trySend 逻辑，无需 agent）
      trySend(report.channel, resolved, `【定时汇报】${report.name}`, report.text, env)
        .then((result) => {
          appendLog({ ts: new Date().toISOString(), kind: "report", name: report.name, result }).catch(() => {});
        })
        .catch((error) => console.error("[dsh-whale-notify] 定时汇报失败:", error instanceof Error ? error.message : String(error)));
    };
    const isDue = (report) => {
      const now = new Date();
      const spec = String(report.schedule ?? "");
      if (/^daily:(\d{2}):(\d{2})$/.test(spec)) {
        const [, hh, mm] = /^daily:(\d{2}):(\d{2})$/.exec(spec);
        return now.getHours() === Number(hh) && now.getMinutes() === Number(mm);
      }
      if (/^every:(\d+)$/.test(spec)) {
        const minutes = Number(/^every:(\d+)$/.exec(spec)[1]);
        return now.getMinutes() % minutes === 0 && now.getSeconds() < 30;
      }
      return false;
    };
    // 每 30 秒检查一次到点汇报（timer 已注入）
    ctx.interval(() => {
      for (const report of reports) {
        if (isDue(report)) fire(report);
      }
    }, 30000);
  }
  ctx.tools.register(defineTool({
    name: "notify",
    description:
      "向用户发送一条通知消息。渠道可选：feishu_bot（飞书开放平台，双向聊天，推荐）、" +
      "serverchan（微信 Server酱）、feishu（飞书群 webhook）、wecom（企业微信）、" +
      "dingtalk（钉钉）、smtp（邮件）。" +
      "当耗时任务完成、失败，或需要用户离开聊天也能注意到时使用。" +
      "传入标题和正文；可选指定 channel（渠道）或 'all'（全部渠道）。" +
      "未配置的渠道会被跳过。",
    parameters: PARAMETERS,
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
        text: value.delivered.map((d) => `${d.channel}: ${d.ok ? "OK" : "FAILED — " + d.detail}`).join("\n"),
      }],
    },
    async execute(args, exec) {
      const title = formatTitle(args.title, args.level);
      const channels = targetChannels(args.channel, resolved, process.env);
      if (channels.length === 0) {
        throw new Error("notify：尚未配置任何通知渠道 —— 请在 tool-notify 插件配置中添加 webhook 或 SMTP 信息");
      }
      // awaitReply=true：让邮件通知可回复指挥（要求已配置 imap 收信）。
      let reply = undefined;
      if (args.awaitReply === true) {
        if (!imapConfig) {
          throw new Error("notify(awaitReply:true)：需要先配置 imap（收信）才能接收你的邮件回复 —— 请在 tool-notify 插件配置中添加 imap 段");
        }
        const smtp = resolveChannel(resolved, "smtp", env);
        if (!smtp || isConfigError(smtp)) {
          throw new Error("notify(awaitReply:true)：需要先配置 smtp（发信）才能发送可回复的通知邮件");
        }
        reply = {
          id: registerPending(exec.agent, title, smtp.to, undefined, "command"),
        };
      }
      const delivered = [];
      for (const channel of channels) {
        delivered.push(await trySend(channel, resolved, title, args.message, process.env, reply));
      }
      const failed = delivered.filter((d) => !d.ok);
      // 发送日志：追加 JSONL 到 $DSH_HOME/logs/notify.log（失败静默降级，不影响通知）。
      try {
        await appendLog({
          ts: new Date().toISOString(),
          title,
          channels: delivered,
          allOk: failed.length === 0,
          ...reply ? { decisionId: reply.id } : {},
        });
      } catch {
        // 日志失败不影响发送结果。
      }
      if (failed.length === delivered.length) {
        throw new Error(`notify：所有渠道都发送失败 —— ${failed.map((d) => `${d.channel}（${d.detail}）`).join("；")}`);
      }
      return { delivered };
    },
    presentCall: (args) => ({
      card: "generic",
      title: "Notify user",
      kind: "other",
      rawInput: args.title,
    }),
  }));

  // ── ask_user_email：发邮件询问用户，并轮询回复后唤醒 agent ──
  ctx.tools.register(defineTool({
    name: "ask_user_email",
    description:
      "通过电子邮件向用户提问并等待回复。适合需要用户决策/审批、但用户不在电脑前时使用：" +
      "邮件发出后本工具立即返回，插件会后台轮询收件箱；用户回复邮件后，回复内容会作为一条" +
      "用户消息注入回当前会话，agent 据此继续。要求配置了 smtp（发）和 imap（收）。",
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
        text: `已通过邮件询问用户（${value.sentTo}）。决策编号 ${value.decisionId}。${value.note}`,
      }],
    },
    async execute(args, exec) {
      const smtp = resolveChannel(resolved, "smtp", env);
      if (!smtp || isConfigError(smtp)) {
        throw new Error("ask_user_email：需要先配置 smtp（发信）才能发送询问邮件");
      }
      if (!imapConfig) {
        throw new Error("ask_user_email：需要先配置 imap（收信）才能接收用户的邮件回复 —— 请在 tool-notify 插件配置中添加 imap 段");
      }
      const recipients = smtp.to.length > 0 ? smtp.to : ["no-reply@localhost"];
      const id = registerPending(exec.agent, args.question, recipients);

      const optionsText = Array.isArray(args.options) && args.options.length > 0
        ? `\n\n可选项：${args.options.map((o) => `「${o}」`).join("、")}（直接回复其中一个即可）`
        : "";
      const contextText = args.context ? `\n\n背景：${args.context}` : "";
      const body =
        `你好，agent 需要你做一个决定：\n\n${args.question}${optionsText}${contextText}\n\n` +
        `请直接回复这封邮件告知你的选择（例如：继续 / 取消 / 具体指示）。回复会自动回到会话中。`;

      const title = `${decisionTag(id)} 需要你的决定：${args.question.slice(0, 40)}`;
      await sendEmail(smtp, title, body);
      await appendLog({
        ts: new Date().toISOString(),
        kind: "ask_user_email",
        decisionId: id,
        question: args.question,
        sentTo: recipients,
      }).catch(() => {});

      return {
        decisionId: id,
        sentTo: recipients.join(", "),
        note: "用户回复后会自动回到本会话，请等待（不要重复询问）。",
      };
    },
    presentCall: (args) => ({
      card: "generic",
      title: "Ask user by email",
      kind: "other",
      rawInput: args.question,
    }),
  }));
}

export { Config, apply, inject, name };
