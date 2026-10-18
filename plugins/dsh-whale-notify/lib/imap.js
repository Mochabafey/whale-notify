/**
 * @module dsh-whale-notify/imap
 *
 * IMAP 轮询与回复解析，供邮件问答/回复指挥使用。
 *
 * 只做三件事：连上收件箱 → 找到主题里带 `[DSH:<id>]` 的回信 → 解析出正文。
 * `imapflow` 是可选的懒加载依赖：缺了它只有邮件功能报错，插件照常加载。
 */

/** Cached lazy loader for the optional `imapflow` dependency. */
let imapFlowPromise;
function loadImapFlow() {
  imapFlowPromise ??= import("imapflow").then((mod) => mod.ImapFlow);
  return imapFlowPromise;
}

/** Subject tag used to correlate a reply with a decision. */
export const DECISION_TAG = "DSH";

/** Build the decision subject tag: [DSH:abc123] */
export function decisionTag(id) {
  return `[${DECISION_TAG}:${id}]`;
}

/** Extract a decision id from a subject line, or undefined. */
export function extractDecisionId(subject) {
  if (typeof subject !== "string") return undefined;
  const match = /\[DSH:([A-Za-z0-9_-]{1,64})\]/.exec(subject);
  return match ? match[1] : undefined;
}

/** Decode `=?charset?B?...?=` / `=?charset?Q?...?=` encoded words. */
function decodeMimeWords(value) {
  if (typeof value !== "string") return value;
  const pattern = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;
  let match;
  let output = "";
  let last = 0;
  let matched = false;
  while ((match = pattern.exec(value)) !== null) {
    matched = true;
    output += value.slice(last, match.index);
    const [, charset, encoding, payload] = match;
    try {
      const bytes = encoding.toLowerCase() === "b"
        ? Buffer.from(payload, "base64")
        : Buffer.from(
            payload
              .replace(/_/g, " ")
              .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))),
            "binary",
          );
      output += new TextDecoder(charset || "utf-8").decode(bytes);
    } catch {
      output += match[0];
    }
    last = pattern.lastIndex;
  }
  return matched ? output + value.slice(last) : value;
}

/**
 * Extract the plain-text body from a raw RFC 5322 message.
 * Handles text/plain, quoted-printable/base64 transfer encodings, and
 * multipart (prefers the first text/plain part; falls back to HTML stripped).
 *
 * @param raw - raw message buffer or string.
 * @returns the decoded plain-text body, or "" when none is found.
 */
export function extractBody(raw) {
  const source = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  const headerEnd = source.indexOf("\r\n\r\n");
  if (headerEnd === -1) return "";

  const headersText = source.slice(0, headerEnd);
  const bodyStart = headerEnd + 4;
  const contentType = headerValue(headersText, "content-type");
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType);

  if (boundary) {
    const delimiter = `--${boundary[1]}`;
    const parts = source.slice(bodyStart).split(delimiter);
    let htmlFallback = "";
    for (const part of parts) {
      if (part.startsWith("--")) continue; // terminator
      const partHeaderEnd = part.indexOf("\r\n\r\n");
      if (partHeaderEnd === -1) continue;
      const partHeaders = part.slice(0, partHeaderEnd);
      const partType = headerValue(partHeaders, "content-type");
      const encoding = headerValue(partHeaders, "content-transfer-encoding");
      const partBody = part.slice(partHeaderEnd + 4).replace(/\r\n$/, "");
      if (/text\/plain/i.test(partType)) {
        return decodeTransfer(partBody, encoding).trim();
      }
      if (htmlFallback === "" && /text\/html/i.test(partType)) {
        htmlFallback = stripHtml(decodeTransfer(partBody, encoding));
      }
    }
    return htmlFallback.trim();
  }

  if (!/text\/plain/i.test(contentType)) {
    if (/text\/html/i.test(contentType)) {
      return stripHtml(decodeTransfer(source.slice(bodyStart), headerValue(headersText, "content-transfer-encoding"))).trim();
    }
    return "";
  }
  return decodeTransfer(source.slice(bodyStart), headerValue(headersText, "content-transfer-encoding")).trim();
}

/** Crude HTML → text (only used when the sender has no text/plain part). */
function stripHtml(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n");
}

/** Extract one header value by lowercased name (handles continuation lines). */
function headerValue(headersText, name) {
  const lines = headersText.split("\r\n");
  const normalized = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && normalized.length > 0) {
      normalized[normalized.length - 1] += " " + line.trim();
    } else {
      normalized.push(line);
    }
  }
  const match = normalized.find((line) => line.toLowerCase().startsWith(name + ":"));
  if (!match) return "";
  return decodeMimeWords(match.slice(match.indexOf(":") + 1).trim());
}

/** Decode a body by its transfer encoding (quoted-printable / base64 / 8bit). */
function decodeTransfer(body, encoding) {
  const enc = String(encoding || "").trim().toLowerCase();
  if (enc === "base64") return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  if (enc === "quoted-printable") {
    // 先按字节还原，再按 UTF-8 解码 —— 直接 String.fromCharCode 会把中文拆坏。
    const bytes = [];
    const text = body.replace(/=\r?\n/g, "");
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === "=" && /^[0-9A-Fa-f]{2}$/.test(text.slice(index + 1, index + 3))) {
        bytes.push(parseInt(text.slice(index + 1, index + 3), 16));
        index += 2;
      } else {
        bytes.push(...Buffer.from(char, "utf8"));
      }
    }
    return Buffer.from(bytes).toString("utf8");
  }
  return body;
}

/**
 * Normalize a reply body: drop the quoted original, reply separators, and
 * signatures, keeping only what the user actually typed.
 */
export function normalizeReply(rawBody) {
  const lines = String(rawBody || "").split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^[-—–_]{3,}/.test(trimmed)) break;               // 分隔线（163/飞书常见）
    if (/^----/.test(trimmed)) break;
    if (/^>/.test(line)) break;                            // 引用
    if (/^On .+wrote:$/i.test(line)) break;
    if (/^在 .+写道[:：]\s*$/.test(trimmed)) break;
    if (/^发件人[:：]|^收件人[:：]|^抄送[:：]|^主题[:：]|^日期[:：]/.test(trimmed) && kept.length > 0) break;
    if (trimmed === "--") break;                           // 签名分隔
    kept.push(line);
  }
  return kept.join("\n").trim();
}

/**
 * Poll the inbox once for replies matching pending decision ids.
 *
 * 只读最近 `maxMessages` 封（默认 50），并且跳过已读标记之外的历史邮件；
 * 早期版本每次拉 100 封全文，邮箱一大就明显拖慢。
 *
 * @param config - { host, port, secure, user, pass, mailbox?, maxMessages? }.
 * @param pendingIds - decision ids to look for.
 * @param opts - { rejectUnauthorized?, timeoutMs?, maxMessages? }.
 * @returns array of { id, uid, subject, from, text } for matched replies.
 */
export async function pollReplies(config, pendingIds, opts = {}) {
  if (!config?.host || !config?.user || !config?.pass) {
    throw new Error("imap: host, user and pass are required");
  }
  if (!pendingIds || pendingIds.length === 0) return [];

  let ImapFlow;
  try {
    ImapFlow = await loadImapFlow();
  } catch (error) {
    throw new Error(
      `imap: 缺少可选依赖 imapflow（${error instanceof Error ? error.message : String(error)}）；`
      + "请在 DSH profile 里安装它（pnpm add imapflow），或去掉 imap 配置。",
    );
  }

  const client = new ImapFlow({
    host: config.host,
    port: config.port ?? 993,
    secure: config.secure ?? true,
    auth: { user: config.user, pass: config.pass },
    tls: { rejectUnauthorized: opts.rejectUnauthorized ?? config.rejectUnauthorized ?? true },
    logger: false,
    timeout: opts.timeoutMs ?? 30000,
  });

  const wanted = new Set(pendingIds);
  const found = [];
  try {
    await client.connect();
    const mailbox = await client.mailboxOpen(config.mailbox ?? "INBOX");
    if (!mailbox || mailbox.exists === 0) return [];

    // 从新往旧取最近 N 封；不依赖 search 的 UID 语义，最稳。
    const maxMessages = opts.maxMessages ?? config.maxMessages ?? 50;
    const range = mailbox.exists > maxMessages ? `${mailbox.exists - maxMessages + 1}:*` : "1:*";

    for await (const message of client.fetch(range, { uid: true, envelope: true, source: true })) {
      const id = extractDecisionId(message.envelope?.subject);
      if (id === undefined || !wanted.has(id)) continue;
      found.push({
        id,
        uid: message.uid,
        subject: message.envelope?.subject ?? "",
        from: message.envelope?.from?.map((address) => address.address).filter(Boolean).join(", ") ?? "",
        text: normalizeReply(extractBody(message.source)),
      });
    }
    return found;
  } finally {
    await client.logout().catch(() => {});
  }
}
