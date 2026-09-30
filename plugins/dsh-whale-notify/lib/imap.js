/**
 * @module dsh-whale-notify/imap
 *
 * IMAP polling + reply parsing for the `notify` tool's reply/approval loop.
 * Polls the configured inbox for replies whose subject carries a decision id
 * (`[DSH:<id>]`), extracts the plain-text reply body, and returns the parsed
 * replies. Pure JS MIME parsing for the body; imapflow handles the wire.
 *
 * `imapflow` is an optional runtime dependency, loaded lazily on first use:
 * a profile without it must still load this plugin (the rest of the channels
 * keep working) and only the IMAP features report a clear error.
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

/**
 * Decode one MIME word (`=?charset?B?...?=` or `=?charset?Q?...?=`) sequence.
 * Falls back to the raw string when decoding fails.
 */
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
        : Buffer.from(payload.replace(/_/g, " "), "base64");
      const text = new TextDecoder(charset || "utf-8").decode(bytes);
      output += text;
    } catch {
      output += match[0];
    }
    last = pattern.lastIndex;
  }
  return matched ? output + value.slice(last) : value;
}

/**
 * Extract the plain-text body from a raw RFC 5322 message.
 * Handles text/plain parts, quoted-printable/base64 transfer encodings,
 * and multipart/alternative (prefers text/plain over text/html).
 * @param raw - the raw message buffer.
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
    // Multipart: split on boundary, take the first text/plain part.
    const delimiter = `--${boundary[1]}`;
    const parts = source.slice(bodyStart).split(delimiter);
    for (const part of parts) {
      if (part.startsWith("--")) continue; // trailing -- terminator
      const partHeaderEnd = part.indexOf("\r\n\r\n");
      if (partHeaderEnd === -1) continue;
      const partHeaders = part.slice(0, partHeaderEnd);
      const partContentType = headerValue(partHeaders, "content-type");
      if (!/text\/plain/i.test(partContentType)) continue;
      const partBody = part.slice(partHeaderEnd + 4).replace(/\r\n$/, "");
      return decodeTransfer(partBody, headerValue(partHeaders, "content-transfer-encoding"));
    }
    return "";
  }

  if (!/text\/plain/i.test(contentType)) return "";
  const body = source.slice(bodyStart);
  return decodeTransfer(body, headerValue(headersText, "content-transfer-encoding"));
}

/** Extract one header value by lowercased name (may span continuation lines). */
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
  let text;
  if (enc === "base64") {
    text = Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  } else if (enc === "quoted-printable") {
    text = body
      .replace(/=\r?\n/g, "") // soft line breaks
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  } else {
    text = body;
  }
  return text.trim();
}

/**
 * Normalize a reply body: strip the quoted original (lines starting with ">"),
 * common reply separators, signatures (lines after "-- "), and empty
 * leading/trailing lines.
 */
export function normalizeReply(rawBody) {
  const lines = String(rawBody || "").split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // 常见引用分隔：邮件客户端的分隔线（如 163 的 "---- 回复的原邮件 ----"）
    if (/^[-—–_]{3,}/.test(trimmed)) break;
    if (/^----/.test(trimmed)) break;
    if (/^>/.test(line)) break;
    if (/^On .+wrote:$/i.test(line)) break;
    if (/^在 .+写道：$/.test(line)) break;
    if (/^发件人[:：]|^收件人[:：]|^抄送[:：]|^主题[:：]|^日期[:：]/.test(trimmed) && kept.length > 0) break;
    if (trimmed === "--") break;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

/**
 * Poll the inbox once for replies matching pending decision ids.
 * @param config - { host, port, secure, user, pass, mailbox? }.
 * @param pendingIds - array of decision ids to look for.
 * @param opts - { sinceDays?, rejectUnauthorized?, timeoutMs? }.
 * @returns array of { id, subject, from, text } for matched replies.
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
      `imap: 缺少可选依赖 imapflow（${error instanceof Error ? error.message : String(error)}）；` +
      `请在 DSH profile 里安装它（pnpm add imapflow），或关闭 imap 配置。`,
    );
  }

  const client = new ImapFlow({
    host: config.host,
    port: config.port ?? 993,
    secure: config.secure ?? true,
    auth: { user: config.user, pass: config.pass },
    tls: { rejectUnauthorized: opts.rejectUnauthorized ?? true },
    logger: false,
    timeout: opts.timeoutMs ?? 30000,
  });

  const wanted = new Set(pendingIds);
  const found = [];
  try {
    await client.connect();
    const mailbox = await client.mailboxOpen(config.mailbox ?? "INBOX");
    if (!mailbox || mailbox.exists === 0) return [];

    // 直接取全部邮件并按主题过滤（不依赖 search 的 UID 语义，最稳）。
    // 收件箱通常很小；如需控制量可配置 maxMessages。
    const maxMessages = opts.maxMessages ?? 100;
    const range = mailbox.exists > maxMessages ? `${mailbox.exists - maxMessages + 1}:*` : "1:*";

    for await (const message of client.fetch(range, { uid: true, envelope: true, source: true })) {
      const id = extractDecisionId(message.envelope?.subject);
      if (id === undefined || !wanted.has(id)) continue;
      const raw = message.source;
      const body = extractBody(raw);
      found.push({
        id,
        uid: message.uid,
        subject: message.envelope?.subject ?? "",
        from: message.envelope?.from?.map((a) => a.address).filter(Boolean).join(", ") ?? "",
        text: normalizeReply(body),
      });
    }
    return found;
  } finally {
    await client.logout().catch(() => {});
  }
}
