/**
 * @module dsh-whale-notify/feishu
 *
 * Feishu (Lark) Open Platform integration: tenant token, sending text
 * messages, and the WebSocket long-connection for receiving events. Uses the
 * host runtime's native `fetch` and `WebSocket` — no third-party SDK.
 */

/** Base URL of the Feishu Open Platform API. */
const API_BASE = "https://open.feishu.cn/open-apis";

/** Lazily-loaded official SDK (optional runtime dep; loaded on first use). */
let sdkPromise = undefined;
function loadSdk() {
  sdkPromise ??= import("@larksuiteoapi/node-sdk");
  return sdkPromise;
}

/** In-memory tenant token cache. */
let tokenCache = {
  token: undefined,
  expiresAt: 0,
};

/** Default token TTL safety margin (ms) — refresh 5 min before expiry. */
const TOKEN_MARGIN_MS = 5 * 60 * 1000;

/**
 * Obtain a tenant_access_token, cached until near expiry.
 * @param appId - the app's App ID.
 * @param appSecret - the app's App Secret.
 * @returns the access token.
 */
export async function getTenantToken(appId, appSecret) {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - TOKEN_MARGIN_MS) {
    return tokenCache.token;
  }
  const response = await fetch(`${API_BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = await response.json();
  if (data.code !== 0) {
    throw new Error(`飞书获取 token 失败 (${data.code}): ${data.msg}`);
  }
  tokenCache = {
    token: data.tenant_access_token,
    expiresAt: Date.now() + data.expire * 1000,
  };
  return tokenCache.token;
}

/**
 * Send a text message via the Feishu IM API.
 * @param token - tenant_access_token.
 * @param receiveId - the chat/open_id/user_id to receive the message.
 * @param receiveIdType - "open_id" | "user_id" | "chat_id" | "email".
 * @param text - the message text.
 */
export async function sendText(token, receiveId, receiveIdType, text) {
  const response = await fetch(`${API_BASE}/im/v1/messages?receive_id_type=${receiveIdType}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: "text",
      content: JSON.stringify({ text }),
    }),
  });
  const data = await response.json();
  if (data.code !== 0) {
    throw new Error(`飞书发送消息失败 (${data.code}): ${data.msg}`);
  }
  return data.data?.message_id;
}

/**
 * Start the WebSocket long-connection to receive Feishu events.
 *
 * Uses the official `@larksuiteoapi/node-sdk` WSClient, which handles token
 * refresh, the `/callback/ws/endpoint` discovery, protobuf frame decoding,
 * and auto-reconnect. Events are delivered to `onEvent(payload)` as the
 * decoded event object.
 *
 * @param appId - App ID.
 * @param appSecret - App Secret.
 * @param onEvent - callback (payload: object) for each received event.
 * @param opts - { log? }.
 * @returns a function that stops the long connection.
 */
export async function startLongConnection(appId, appSecret, onEvent, opts = {}) {
  const log = opts.log ?? ((...args) => console.log("[dsh-whale-notify/feishu]", ...args));
  const sdk = await loadSdk();
  const client = new sdk.Client({ appId, appSecret });
  const wsClient = new sdk.WSClient({ appId, appSecret });

  const dispatcher = new sdk.EventDispatcher({}).register({
    "im.message.receive_v1": async (data) => {
      onEvent({ event: { type: "im.message.receive_v1", ...data } });
    },
  });

  await wsClient.start({ eventDispatcher: dispatcher, logLevel: sdk.LoggerLevel.warn });
  log("长连接已建立（官方 SDK WSClient）");

  return () => {
    try {
      wsClient.close?.();
    } catch {}
  };
}

/**
 * Extract the message text from an `im.message.receive_v1` event payload.
 * Accepts both the raw long-connection payload shape and the SDK-decoded
 * shape (snake_case and camelCase fields).
 * @param payload - the event payload.
 * @returns { senderId, chatId, text, messageId } or undefined if not a message.
 */
export function extractMessageEvent(payload) {
  const event = payload?.event ?? payload;
  if (!event || (event.type !== "im.message.receive_v1" && event.type !== "message")) return undefined;
  const message = event.message;
  if (!message) return undefined;
  const type = message.message_type ?? message.messageType;
  if (type !== "text") return undefined;
  let content = message.content;
  if (typeof content === "string") {
    try {
      content = JSON.parse(content);
    } catch {
      return undefined;
    }
  }
  const text = content?.text;
  if (typeof text !== "string") return undefined;
  const sender = event.sender;
  const senderId = sender?.sender_id?.open_id ?? sender?.sender_id?.user_id ?? sender?.openId ?? sender?.userId;
  return {
    senderId,
    chatId: message.chat_id ?? message.chatId,
    messageId: message.message_id ?? message.messageId,
    text,
  };
}

