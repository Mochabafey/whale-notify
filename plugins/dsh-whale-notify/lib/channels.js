/**
 * @module dsh-whale-notify/channels
 *
 * 各发送渠道的最后一步：把一段文本真正投出去。
 *
 * 这里只负责「协议 + 错误」，配置解析在 ./config.js，会话注入在 ./index.js。
 * 所有函数都不抛「业务异常」给调用方：`trySend` 会把失败折成
 * `{ ok: false, detail }`，因为通知失败不应该打断 agent 的一轮对话。
 */
import { createHmac } from "node:crypto";
import { CHANNEL_LABELS, CHANNEL_TEXT_LIMIT, splitText, isConfigError, resolveChannel, expandEnv } from "./config.js";
import { getTenantToken, sendText } from "./feishu.js";
import { sendQQ } from "./qq.js";
import { sendEmail } from "./smtp.js";

/** Default HTTP timeout for webhook calls, in milliseconds. */
const HTTP_TIMEOUT_MS = 15000;

/** fetch with a hard timeout via AbortController. */
async function fetchWithTimeout(url, options = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Read a JSON error message from a failed response body. */
async function readErrorBody(response) {
  try {
    const text = (await response.text()).trim();
    if (text.length === 0) return "";
    try {
      const parsed = JSON.parse(text);
      const pick = parsed.msg || parsed.message || parsed.errmsg || parsed.error || parsed.StatusMessage;
      return typeof pick === "string" ? pick : text.slice(0, 200);
    } catch {
      return text.slice(0, 200);
    }
  } catch {
    return "";
  }
}

/** Assert a 2xx response; throw with a channel-specific message otherwise. */
async function assertOk(response, label, url) {
  if (!response.ok) {
    const detail = await readErrorBody(response);
    throw new Error(`${label} failed (HTTP ${response.status}${detail ? `: ${detail}` : ""})`);
  }
}

/** HMAC-SHA256 → base64 (Feishu and DingTalk signing). */
function hmacSha256Base64(data, secret) {
  return createHmac("sha256", secret).update(data).digest("base64");
}

/** Send one plain-text part to a Feishu custom-bot webhook. */
async function sendFeishuWebhook(webhook, secret, text) {
  const body = { msg_type: "text", content: { text } };
  if (secret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    body.timestamp = timestamp;
    body.sign = hmacSha256Base64(`${timestamp}\n${secret}`, secret);
  }
  const response = await fetchWithTimeout(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await assertOk(response, "Feishu webhook", webhook);
}

/** Send one plain-text part to a WeCom group-bot webhook. */
async function sendWecom(webhook, text) {
  const response = await fetchWithTimeout(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msgtype: "text", text: { content: text } }),
  });
  await assertOk(response, "WeCom", webhook);
}

/** Send one plain-text part to a DingTalk custom-bot webhook. */
async function sendDingTalk(webhook, secret, text) {
  let url = webhook;
  if (secret) {
    const timestamp = Date.now();
    const sign = encodeURIComponent(hmacSha256Base64(`${timestamp}\n${secret}`, secret));
    url = `${webhook}${webhook.includes("?") ? "&" : "?"}timestamp=${timestamp}&sign=${sign}`;
  }
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msgtype: "text", text: { content: text } }),
  });
  await assertOk(response, "DingTalk", url);
}

/** Send one part via ServerChan (WeChat push). */
async function sendServerChan(sendKey, title, desp, baseUrl) {
  const url = `${baseUrl ?? "https://sctapi.ftqq.com"}/${encodeURIComponent(sendKey)}.send`;
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ title, desp }),
  });
  await assertOk(response, "ServerChan", url);
}

/**
 * Send one message through one channel, splitting it when the channel has a
 * text limit. Never throws.
 *
 * @param channel - channel key (see ./config.js CHANNELS).
 * @param config - the plugin config.
 * @param title - already level-tagged title.
 * @param message - body text.
 * @param env - environment bag.
 * @param reply - optional { id } for email/QQ/Feishu reply-command hints.
 * @param extra - optional { groupId, to, chatId } per-call routing overrides.
 * @returns { channel, ok, detail, parts? }
 */
export async function trySend(channel, config, title, message, env, reply, extra = {}) {
  const label = CHANNEL_LABELS[channel] ?? channel;
  let entry = resolveChannel(config, channel, env);
  // QQ：`to`/`groupId` 是调用时的目标覆盖。此时配置里不写默认 qq/groupId 也算可用，
  // 否则「临时发回某个群」会被判定成「渠道未配置」。
  if (channel === "qq" && (entry === undefined || isConfigError(entry)) && (extra.to || extra.groupId)) {
    const raw = config?.qq ?? {};
    entry = {
      httpBase: expandEnv(raw.httpBase, env) || undefined,
      accessToken: expandEnv(raw.accessToken, env) || undefined,
      qq: undefined,
      groupId: undefined,
      wsPort: Number(raw.wsPort ?? raw.port ?? 3001),
      targetSession: undefined,
    };
  }
  try {
    if (entry === undefined) throw new Error(`${label} 渠道未配置`);
    if (isConfigError(entry)) throw new Error(entry.error);

    const hint = reply
      ? `\n\n[决策编号 ${reply.id}] 回复本消息可直接给 agent 下达下一步指令。`
      : "";
    const text = `${title}\n\n${message}${hint}`;
    const limit = CHANNEL_TEXT_LIMIT[channel] ?? 4000;

    switch (channel) {
      case "smtp": {
        const subject = reply ? `[DSH:${reply.id}] ${title}` : title;
        const body = reply
          ? `${message}\n\n---\n回复此邮件可直接给 agent 下达下一步指令（决策编号 ${reply.id}）。回复内容会作为你的指令自动回到会话中。`
          : message;
        await sendEmail(entry, subject, body);
        return { channel, ok: true, detail: `sent to ${entry.to.join(", ")}` };
      }

      case "feishu_bot": {
        const token = await getTenantToken(entry.appId, entry.appSecret);
        const override = extra.to ?? extra.chatId;
        const receiveId = override ?? entry.receiveId;
        // 显式给了目标时按 id 前缀推断类型；否则用配置的 receiveIdType。
        const receiveIdType = override
          ? (extra.receiveIdType ?? inferFeishuIdType(override))
          : entry.receiveIdType;
        const parts = splitText(text, limit);
        for (const [index, part] of parts.entries()) {
          const body = parts.length > 1 ? `(${index + 1}/${parts.length})\n${part}` : part;
          await sendText(token, receiveId, receiveIdType, body);
        }
        return { channel, ok: true, detail: `sent via open platform (${parts.length} part${parts.length > 1 ? "s" : ""})`, parts: parts.length };
      }

      case "qq": {
        // 调用时指定的群号优先（群友模式回原群），其次配置的 groupId，最后私聊。
        const groupId = extra.groupId ?? entry.groupId;
        const target = groupId ? { groupId } : { qq: extra.to ?? entry.qq };
        const parts = splitText(text, limit);
        for (const [index, part] of parts.entries()) {
          const body = parts.length > 1 ? `(${index + 1}/${parts.length})\n${part}` : part;
          await sendQQ(entry, target, body);
        }
        return {
          channel, ok: true,
          detail: groupId ? `sent to group ${groupId}` : `sent to ${target.qq}`,
          parts: parts.length,
        };
      }

      case "serverchan": {
        // ServerChan 自带 title/desp 结构，不做拆分。
        await sendServerChan(entry.sendKey, title, message, entry.baseUrl);
        return { channel, ok: true, detail: "sent" };
      }

      case "feishu": {
        const parts = splitText(text, limit);
        for (const part of parts) await sendFeishuWebhook(entry.webhook, entry.secret, part);
        return { channel, ok: true, detail: "sent", parts: parts.length };
      }

      case "wecom": {
        const parts = splitText(text, limit);
        for (const part of parts) await sendWecom(entry.webhook, part);
        return { channel, ok: true, detail: "sent", parts: parts.length };
      }

      case "dingtalk": {
        const parts = splitText(text, limit);
        for (const part of parts) await sendDingTalk(entry.webhook, entry.secret, part);
        return { channel, ok: true, detail: "sent", parts: parts.length };
      }

      default:
        throw new Error(`未知渠道 ${JSON.stringify(channel)}`);
    }
  } catch (error) {
    return { channel, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Which channels this call should use.
 *
 * - explicit `channel` → that one (when configured), else empty;
 * - `all` → every configured channel;
 * - none → `defaultChannel` when valid, else every configured channel.
 */
export function targetChannels(channelArg, config, env) {
  const configured = ["serverchan", "feishu", "feishu_bot", "qq", "wecom", "dingtalk", "smtp"]
    .filter((channel) => {
      const entry = resolveChannel(config, channel, env);
      return entry !== undefined && !isConfigError(entry);
    });

  if (channelArg === "all") return configured;
  if (channelArg !== undefined) {
    if (!["serverchan", "feishu", "feishu_bot", "qq", "wecom", "dingtalk", "smtp"].includes(channelArg)) {
      throw new Error(`无效的渠道 ${JSON.stringify(channelArg)}（可选：all/serverchan/feishu/feishu_bot/qq/wecom/dingtalk/smtp）`);
    }
    return configured.includes(channelArg) ? [channelArg] : [];
  }
  const preferred = config?.defaultChannel;
  if (typeof preferred === "string" && preferred !== "" && preferred !== "all" && configured.includes(preferred)) {
    return [preferred];
  }
  return configured;
}

/** Level tags prepended to a title. */
const LEVEL_TAGS = { info: "[信息]", success: "[完成]", warning: "[警告]", error: "[错误]" };

/** Infer a Feishu `receive_id_type` from the id's prefix (`oc_` chat, `ou_` open, `on_` union). */
export function inferFeishuIdType(id) {
  if (id.startsWith("oc_")) return "chat_id";
  if (id.startsWith("ou_")) return "open_id";
  if (id.startsWith("on_")) return "union_id";
  if (id.includes("@")) return "email";
  return "open_id";
}

/** Build the level tag prefix and the final titled text. */
export function formatTitle(title, level) {
  const tag = LEVEL_TAGS[level];
  return tag ? `${tag} ${title}` : title;
}
