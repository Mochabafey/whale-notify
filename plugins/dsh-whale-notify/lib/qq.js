/**
 * @module dsh-whale-notify/qq
 *
 * QQ integration via the OneBot v11 protocol (NapCat / Lagrange / go-cqhttp).
 *
 * Sending: HTTP POST to the OneBot HTTP API (`send_private_msg` /
 * `send_group_msg`).
 *
 * Receiving: WebSocket reverse/forward connection — the framework pushes
 * `message` events (private or group) which we normalize and forward.
 */
import { createRequire } from "node:module";

/** Default OneBot HTTP API base. */
const DEFAULT_HTTP = "http://127.0.0.1:3000";

/** Default OneBot WebSocket server (reverse WS the framework connects to). */
const DEFAULT_WS_SERVER = "ws://127.0.0.1:3001";

/**
 * Send a message to a QQ target via the OneBot HTTP API.
 * @param config - { httpBase?, accessToken? }.
 * @param target - { qq (number) for private, groupId (number) for group }.
 * @param text - the message text.
 * @returns the OneBot message id.
 */
export async function sendQQ(config, target, text) {
  const base = (config?.httpBase ?? DEFAULT_HTTP).replace(/\/$/, "");
  const action = target.groupId !== undefined ? "send_group_msg" : "send_private_msg";
  const params = target.groupId !== undefined
    ? { group_id: target.groupId, message: text }
    : { user_id: target.qq, message: text };

  const headers = { "Content-Type": "application/json" };
  if (config?.accessToken) headers.Authorization = `Bearer ${config.accessToken}`;

  const response = await fetch(`${base}/${action}`, {
    method: "POST",
    headers,
    body: JSON.stringify(params),
  });
  const data = await response.json();
  if (data.status !== "ok" && data.retcode !== 0) {
    throw new Error(`QQ 发送失败 (${data.retcode}): ${data.message ?? JSON.stringify(data).slice(0, 120)}`);
  }
  return data.data?.message_id;
}

/**
 * Start a OneBot WebSocket server (reverse WS) to receive QQ messages.
 *
 * OneBot frameworks (NapCat) can connect to a WebSocket server we host
 * (`ws://127.0.0.1:<port>`), pushing `message` events. We normalize private
 * and group messages and call `onMessage`.
 *
 * @param config - { wsServer?, accessToken?, port? }.
 * @param onMessage - callback ({ type: "private"|"group", userId, groupId?, text }).
 * @param opts - { log? }.
 * @returns a stop function.
 */
export function startQQReceiver(config, onMessage, opts = {}) {
  const log = opts.log ?? ((...args) => console.log("[dsh-whale-notify/qq]", ...args));
  const { WebSocketServer } = require("ws");
  const port = config?.port ?? 3001;
  const wss = new WebSocketServer({ port });
  log(`QQ OneBot WebSocket 接收端已启动 ws://127.0.0.1:${port}（在 NapCat 中配置该地址为反向 WS）`);

  wss.on("connection", (socket) => {
    log("NapCat 已连接");
    socket.on("message", (raw) => {
      try {
        const payload = JSON.parse(raw.toString());
        const event = payload?.post_type;
        if (event !== "message") return;
        const msgType = payload.message_type; // private | group
        const text = extractMessageText(payload.message);
        if (!text) return;
        onMessage({
          type: msgType === "group" ? "group" : "private",
          userId: payload.user_id,
          groupId: msgType === "group" ? payload.group_id : undefined,
          text,
          // 群友模式需要：是否 @ 机器人、是否回复引用、原始段
          atMe: msgType === "group" && isAtMe(payload.message, payload.self_id),
          isReply: msgType === "group" && hasReply(payload.message),
          rawSegments: Array.isArray(payload.message) ? payload.message : [],
        });
      } catch (error) {
        log("解析消息失败:", error instanceof Error ? error.message : String(error));
      }
    });
  });

  return () => wss.close();
}

/** Whether a group message contains an @mention of the bot itself. */
function isAtMe(segments, selfId) {
  if (!Array.isArray(segments)) return false;
  return segments.some((seg) => {
    if (seg.type !== "at") return false;
    const qq = seg.data?.qq;
    // OneBot: qq may be a number (self) or "all"
    return qq !== "all" && String(qq) === String(selfId);
  });
}

/** Whether a group message is a reply/quote of another message. */
function hasReply(segments) {
  if (!Array.isArray(segments)) return false;
  return segments.some((seg) => seg.type === "reply");
}

/** Extract plain text from a OneBot message segment array (or string). */
function extractMessageText(message) {
  if (typeof message === "string") return message.trim();
  if (Array.isArray(message)) {
    const parts = message
      .filter((seg) => seg.type === "text")
      .map((seg) => seg.data?.text ?? "");
    return parts.join("").trim();
  }
  return "";
}

/** Lazy `require` for the ws server (avoid hard dependency when QQ unused). */
const require = createRequire(import.meta.url);
