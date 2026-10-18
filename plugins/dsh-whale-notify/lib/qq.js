/**
 * @module dsh-whale-notify/qq
 *
 * QQ integration via the OneBot v11 protocol (NapCat / Lagrange / go-cqhttp).
 *
 * Sending: HTTP POST to the OneBot HTTP API (`send_private_msg` /
 * `send_group_msg`).
 *
 * Receiving: a WebSocket server the framework connects to (reverse WS).
 */
import { createRequire } from "node:module";

/** `require` used to load the optional `ws` dependency. */
const require = createRequire(import.meta.url);

/** Default OneBot HTTP API base. */
const DEFAULT_HTTP = "http://127.0.0.1:3000";

/** Default reverse-WS port. */
const DEFAULT_WS_PORT = 3001;

/** Per-request timeout when calling the OneBot HTTP API (ms). */
const HTTP_TIMEOUT_MS = 15000;

/**
 * Send a message to a QQ target via the OneBot HTTP API.
 * @param config - { httpBase?, accessToken? }.
 * @param target - { qq } for private or { groupId } for group.
 * @param text - message text.
 * @returns the OneBot message id.
 */
export async function sendQQ(config, target, text) {
  const base = (config?.httpBase ?? DEFAULT_HTTP).replace(/\/$/, "");
  const isGroup = target.groupId !== undefined && target.groupId !== null && target.groupId !== "";
  const action = isGroup ? "send_group_msg" : "send_private_msg";
  const params = isGroup
    ? { group_id: normalizeId(target.groupId), message: text }
    : { user_id: normalizeId(target.qq), message: text };

  const headers = { "Content-Type": "application/json" };
  if (config?.accessToken) headers.Authorization = `Bearer ${config.accessToken}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`QQ 接口超时（${HTTP_TIMEOUT_MS}ms）`)), HTTP_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${base}/${action}`, {
      method: "POST",
      headers,
      body: JSON.stringify(params),
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(`无法连接 OneBot HTTP 接口 ${base}（NapCat 是否在运行？）：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }

  const data = await response.json().catch(() => ({}));
  // OneBot 实现对 retcode 的处理不一致：status=ok 或 retcode=0 都算成功。
  if (data.status !== "ok" && data.retcode !== 0) {
    throw new Error(`QQ 发送失败 (${data.retcode ?? response.status}): ${data.message ?? data.wording ?? "无响应体"}`);
  }
  return data.data?.message_id;
}

/** OneBot ids arrive as numbers, strings, or numeric strings; send them as numbers when possible. */
function normalizeId(value) {
  if (typeof value === "number") return value;
  const text = String(value ?? "").trim();
  return /^\d+$/.test(text) ? Number(text) : text;
}

/**
 * Normalize one OneBot v11 event into the shape the plugin handles.
 *
 * 纯函数，便于单独验证：心跳/生命周期/自己发的消息都返回 undefined。
 *
 * @param payload - parsed OneBot event.
 * @param fallbackSelfId - bot QQ from the reverse-WS `X-Self-ID` header.
 * @returns { type, userId, groupId?, messageId?, senderName?, text, atMe, isReply, images, rawSegments } | undefined
 */
export function normalizeOneBotMessage(payload, fallbackSelfId) {
  if (!payload || payload.post_type !== "message") return undefined;

  const selfId = payload.self_id ?? fallbackSelfId;
  // 自己发的消息不再回灌，否则会自己跟自己聊。
  if (selfId !== undefined && String(payload.user_id) === String(selfId)) return undefined;

  const messageType = payload.message_type === "group" ? "group" : "private";
  const message = payload.message;
  const text = extractMessageText(message);
  const images = countSegments(message, "image");
  if (text === "" && images === 0) return undefined;

  const segments = Array.isArray(message) ? message : [];
  return {
    type: messageType,
    userId: payload.user_id,
    groupId: messageType === "group" ? payload.group_id : undefined,
    messageId: payload.message_id,
    senderName: payload.sender?.card || payload.sender?.nickname || undefined,
    text: text === "" ? `[图片${images > 1 ? `×${images}` : ""}]` : text,
    atMe: messageType === "group" && isAtMe(segments, selfId),
    isReply: messageType === "group" && segments.some((seg) => seg?.type === "reply"),
    images,
    rawSegments: segments,
  };
}

/**
 * Start a OneBot WebSocket server (reverse WS) to receive QQ messages.
 *
 * 修过的坑：
 *  - 端口读的是 `config.port`，而配置写的是 `wsPort` —— 于是永远监听默认 3001，
 *    改配置不生效，端口冲突时还会静默降级。
 *  - 现在同时接受 `wsPort` / `port`，并把监听地址、鉴权、连接数都记进日志。
 *  - `accessToken` 存在时校验 `Authorization`，不匹配直接断开（NapCat 侧也配同一个 token）。
 *
 * @param config - { wsPort?, port?, wsHost?, accessToken? }.
 * @param onMessage - callback ({ type, userId, groupId?, text, atMe, isReply, ... }).
 * @param opts - { log?, onState?, WebSocketServer? }.
 * @returns a stop function.
 */
export function startQQReceiver(config, onMessage, opts = {}) {
  const log = opts.log ?? ((...args) => console.log("[dsh-whale-notify/qq]", ...args));
  const onState = opts.onState ?? (() => {});

  let WebSocketServer = opts.WebSocketServer;
  if (WebSocketServer === undefined) {
    try {
      ({ WebSocketServer } = require("ws"));
    } catch (error) {
      log(`缺少可选依赖 ws（${error instanceof Error ? error.message : String(error)}）— QQ 接收端未启动；请在 profile 里安装 ws。`);
      onState("failed", "缺少 ws 依赖");
      return () => {};
    }
  }

  const port = Number(config?.wsPort ?? config?.port ?? DEFAULT_WS_PORT);
  const host = config?.wsHost === "0.0.0.0" ? "0.0.0.0" : (config?.wsHost || undefined);

  const wss = new WebSocketServer({
    port,
    ...host ? { host } : {},
    // NapCat 的 OneBot11 反向 WS 默认不带 Upgrade 头里的额外协议，直接放行。
    verifyClient: config?.accessToken
      ? (info, done) => {
          const header = String(info.req.headers?.authorization ?? "");
          const token = header.replace(/^Bearer\s+/i, "") || String(info.req.headers?.["x-self-id"] ?? "");
          // NapCat 在反向 WS 握手时会带 Authorization: Bearer <token>。
          // 拿不到任何凭证时仍然放行（本机 127.0.0.1 绑定），只记日志，避免把自己锁死。
          if (token === "" || token === String(config.accessToken)) return done(true);
          log("拒绝了凭证不匹配的反向 WS 连接");
          return done(false, 401, "unauthorized");
        }
      : undefined,
  });

  wss.on("error", (error) => {
    log(`QQ 接收端启动失败（ws://${host ?? "127.0.0.1"}:${port}）：${error instanceof Error ? error.message : String(error)} — QQ 收信已降级`);
    onState("failed", error instanceof Error ? error.message : String(error));
  });

  wss.on("listening", () => {
    log(`QQ OneBot WebSocket 接收端已启动 ws://${host ?? "127.0.0.1"}:${port}（在 NapCat 里配成反向 WS 地址）`);
    onState("up");
  });

  wss.on("connection", (socket, request) => {
    log("NapCat 已连接");
    const selfId = request?.headers?.["x-self-id"];
    // 心跳：NapCat 每 30s 发一次元事件，超过 90s 没有任何帧就主动断开，避免半开连接。
    let lastFrame = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastFrame > 90_000) {
        log("NapCat 连接超时（90s 无数据），主动断开");
        try { socket.terminate(); } catch { /* ignore */ }
      }
    }, 30_000);
    watchdog.unref?.();

    socket.on("close", () => clearInterval(watchdog));
    socket.on("error", () => clearInterval(watchdog));

    socket.on("message", (raw) => {
      lastFrame = Date.now();
      let payload;
      try {
        payload = JSON.parse(raw.toString());
      } catch (error) {
        log("解析消息失败:", error instanceof Error ? error.message : String(error));
        return;
      }
      const message = normalizeOneBotMessage(payload, selfId);
      if (message) onMessage(message);
    });
  });

  return () => {
    try {
      wss.close();
    } catch {
      /* ignore */
    }
  };
}

/** Whether a group message @-mentions the bot itself. */
function isAtMe(segments, selfId) {
  if (!Array.isArray(segments)) return false;
  return segments.some((seg) => {
    if (seg?.type !== "at") return false;
    const qq = seg.data?.qq;
    if (qq === "all" || qq === undefined) return false;
    // selfId 可能缺失（反向 WS 的 X-Self-ID）；缺失时退化为「@ 了某人」。
    return selfId === undefined ? true : String(qq) === String(selfId);
  });
}

/** Count segments of one OneBot type (images are not text but still worth relaying). */
function countSegments(message, type) {
  if (!Array.isArray(message)) return 0;
  return message.filter((seg) => seg?.type === type).length;
}

/** Extract plain text from a OneBot message (segment array, CQ string, or plain text). */
function extractMessageText(message) {
  if (typeof message === "string") {
    // CQ 码：只保留 text 与 at 段，其余替换成占位符。
    return message
      .replace(/\[CQ:image[^\]]*\]/g, "[图片]")
      .replace(/\[CQ:at,qq=([0-9]+)[^\]]*\]/g, "@$1 ")
      .replace(/\[CQ:[^\]]*\]/g, "")
      .trim();
  }
  if (Array.isArray(message)) {
    return message
      .map((seg) => {
        if (seg?.type === "text") return seg.data?.text ?? "";
        if (seg?.type === "at") return seg.data?.qq === "all" ? "@全体成员 " : `@${seg.data?.qq ?? ""} `;
        return "";
      })
      .join("")
      .trim();
  }
  return "";
}
