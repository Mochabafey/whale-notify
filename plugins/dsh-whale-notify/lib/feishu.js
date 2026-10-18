/**
 * @module dsh-whale-notify/feishu
 *
 * Feishu (Lark) Open Platform integration: tenant token, sending text
 * messages, and the WebSocket long-connection for receiving events. Uses the
 * host runtime's native `fetch` and the official SDK's `WSClient`.
 */

/** Base URL of the Feishu Open Platform API. */
const API_BASE = "https://open.feishu.cn/open-apis";

/** Lazily-loaded official SDK (optional runtime dep; loaded on first use). */
let sdkPromise = undefined;
function loadSdk() {
  sdkPromise ??= import("@larksuiteoapi/node-sdk");
  return sdkPromise;
}

/** Tenant token cache, shared by every caller. */
let tokenCache = { token: undefined, expiresAt: 0, appId: undefined };

/** Refresh the token this long before it expires (ms). */
const TOKEN_MARGIN_MS = 5 * 60 * 1000;

/**
 * Obtain a tenant_access_token, cached until near expiry.
 *
 * 缓存的键是 appId：换应用（或改密）后旧 token 不能再复用，
 * 否则表现为「发送失败 99991663 invalid access token」。
 *
 * @param appId - the app's App ID.
 * @param appSecret - the app's App Secret.
 * @param force - bypass the cache and mint a fresh token.
 */
export async function getTenantToken(appId, appSecret, force = false) {
  const fresh = tokenCache.token !== undefined
    && tokenCache.appId === appId
    && Date.now() < tokenCache.expiresAt - TOKEN_MARGIN_MS;
  if (fresh && !force) return tokenCache.token;

  const response = await fetch(`${API_BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = await response.json().catch(() => ({}));
  if (data.code !== 0) {
    throw new Error(`飞书获取 token 失败 (${data.code ?? response.status}): ${data.msg ?? "无响应体"}`);
  }
  tokenCache = {
    token: data.tenant_access_token,
    expiresAt: Date.now() + Number(data.expire ?? 7200) * 1000,
    appId,
  };
  return tokenCache.token;
}

/** Drop the cached tenant token (called after an auth-style failure). */
export function resetTenantToken() {
  tokenCache = { token: undefined, expiresAt: 0, appId: undefined };
}

/**
 * Send one text message via the Feishu IM API.
 * @param token - tenant_access_token.
 * @param receiveId - chat_id / open_id / user_id / email of the receiver.
 * @param receiveIdType - "open_id" | "user_id" | "chat_id" | "email".
 * @param text - message text.
 * @param opts - optional { replyTo } to answer a specific message in-thread.
 * @returns the new message id.
 */
export async function sendText(token, receiveId, receiveIdType, text, opts = {}) {
  const body = { msg_type: "text", content: JSON.stringify({ text }) };
  const url = opts.replyTo
    ? `${API_BASE}/im/v1/messages/${encodeURIComponent(opts.replyTo)}/reply`
    : `${API_BASE}/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`;
  if (!opts.replyTo) body.receive_id = receiveId;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (data.code !== 0) {
    const error = new Error(`飞书发送消息失败 (${data.code ?? response.status}): ${data.msg ?? "无响应体"}`);
    error.code = data.code;
    throw error;
  }
  return data.data?.message_id;
}

/**
 * Start the WebSocket long-connection to receive Feishu events.
 *
 * 用官方 SDK 的 WSClient（自带 token 刷新、endpoint 发现、protobuf 解码、断线重连）。
 * 这里额外做三件 SDK 不管的事：
 *  1. 把 `onReady` / `onReconnecting` / `onReconnected` / `onError` 接到状态回调上，
 *     让 `whale_check` 能区分「连上了但没事件」和「断了在重连」；
 *  2. `start()` 只等到第一次握手成功才 resolve —— 旧实现 resolve 得太早，
 *     失败也只能从日志里看出来；
 *  3. 返回的对象带 `status()`，直接读 SDK 的连接状态快照。
 *
 * @param appId - App ID.
 * @param appSecret - App Secret.
 * @param onEvent - callback (payload) for each received event.
 * @param opts - { log?, onState? }.
 * @returns { stop, status }
 */
export async function startLongConnection(appId, appSecret, onEvent, opts = {}) {
  const log = opts.log ?? ((...args) => console.log("[dsh-whale-notify/feishu]", ...args));
  const onState = opts.onState ?? (() => {});
  const sdk = await loadSdk();

  const dispatcher = new sdk.EventDispatcher({}).register({
    "im.message.receive_v1": async (data) => {
      try {
        onEvent({ event: { type: "im.message.receive_v1", ...data } });
      } catch (error) {
        log(`事件处理异常: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  const wsClient = new sdk.WSClient({
    appId,
    appSecret,
    autoReconnect: true,
    loggerLevel: sdk.LoggerLevel?.warn ?? 2,
    onReady: () => { log("长连接就绪"); onState("up"); },
    onReconnecting: () => { log("长连接断开，正在重连"); onState("reconnecting"); },
    onReconnected: () => { log("长连接已重连"); onState("up"); },
    onError: (error) => {
      log(`长连接错误: ${error?.message ?? error}`);
      onState("failed", error);
    },
  });

  await wsClient.start({ eventDispatcher: dispatcher });
  onState("up");

  const stop = () => {
    try {
      wsClient.close?.({ force: true });
    } catch (error) {
      log(`关闭长连接异常: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  stop.status = () => {
    try {
      return wsClient.getConnectionStatus?.();
    } catch {
      return undefined;
    }
  };
  return stop;
}

/**
 * Extract one message from an `im.message.receive_v1` payload.
 * Accepts both raw long-connection and SDK-decoded shapes (snake/camel case).
 *
 * @returns { senderId, chatId, chatType, messageId, text, mentions, raw } or undefined
 */
export function extractMessageEvent(payload) {
  const event = payload?.event ?? payload;
  const type = event?.type;
  if (!event || (type !== "im.message.receive_v1" && type !== "message")) return undefined;
  const message = event.message;
  if (!message) return undefined;

  const messageType = message.message_type ?? message.messageType;
  let content = message.content;
  if (typeof content === "string") {
    try {
      content = JSON.parse(content);
    } catch {
      return undefined;
    }
  }

  // 只处理文字；@ 提醒也算文字（content.text 里带 @_user_1 占位符）。
  let text = typeof content?.text === "string" ? content.text : undefined;
  if (text === undefined) return undefined;

  // 去掉 @ 占位符（@_user_1 → @名字），否则注入会话里会看到一串无意义的 key。
  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  for (const mention of mentions) {
    const key = mention?.key;
    const name = mention?.name;
    if (typeof key === "string" && typeof name === "string") {
      text = text.split(key).join(`@${name}`);
    }
  }
  text = text.trim();
  if (text.length === 0) return undefined;

  const sender = event.sender;
  const senderId = sender?.sender_id?.open_id ?? sender?.sender_id?.user_id ?? sender?.openId ?? sender?.userId;

  return {
    senderId,
    senderType: sender?.sender_type ?? sender?.senderType,
    chatId: message.chat_id ?? message.chatId,
    chatType: message.chat_type ?? message.chatType,
    messageId: message.message_id ?? message.messageId,
    messageType,
    createTime: Number(message.create_time ?? message.createTime) || undefined,
    text,
    raw: message,
  };
}
