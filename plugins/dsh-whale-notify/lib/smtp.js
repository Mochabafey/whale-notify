import net from "node:net";
import tls from "node:tls";

/**
 * @module dsh-whale-notify/smtp
 *
 * Minimal dependency-free SMTP client used by the `notify` tool. Supports
 * implicit TLS (465) and STARTTLS (587/25), AUTH LOGIN and AUTH PLAIN,
 * multiple recipients, UTF-8 subjects/bodies, automatic retry, whole-call
 * timeout, and RFC 5322 line-length folding.
 */

/** Default per-step timeout in milliseconds. */
const STEP_TIMEOUT_MS = 15000;
/** Default whole-call timeout in milliseconds. */
const CALL_TIMEOUT_MS = 60000;
/** Default number of send attempts (1 initial + this many retries). */
const DEFAULT_RETRIES = 2;

/** RFC 5321 command-terminating line ending. */
const CRLF = "\r\n";

/** Base64-encode a string (Node Buffer, always available). */
function b64(input) {
  return Buffer.from(input, "utf8").toString("base64");
}

/** Escape a message subject to RFC 2047 encoded-word form for non-ASCII. */
function encodeSubject(subject) {
  // Pure ASCII subjects pass through unchanged.
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  // RFC 2047 encoded-word with UTF-8 base64.
  return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

/**
 * Extract the bare mailbox from a From value, tolerating an optional
 * "Display Name <addr>" form so MAIL FROM never carries a display name.
 */
function parseMailbox(value) {
  const match = /<([^>]+)>$/.exec(String(value).trim());
  return match ? match[1].trim() : String(value).trim();
}

/**
 * Build a From header value from a raw one, RFC 2047-encoding any non-ASCII
 * display name. Plain addresses and ASCII names pass through unchanged.
 */
function encodeFromHeader(value) {
  const raw = String(value).trim();
  const match = /^([^<]*)<([^>]+)>$/.exec(raw);
  if (!match) return raw;
  const name = match[1].trim();
  const addr = match[2].trim();
  if (!name) return `<${addr}>`;
  const encoded = /^[\x20-\x7e]*$/.test(name)
    ? name
    : `=?UTF-8?B?${Buffer.from(name, "utf8").toString("base64")}?=`;
  return `${encoded} <${addr}>`;
}

/** RFC 5322 maximum line length (recommended) — fold longer lines. */
const MAX_LINE_LENGTH = 998;

/** Fold every line of a plain-text body to at most MAX_LINE_LENGTH bytes. */
function foldLines(text) {
  return text
    .replace(/\r?\n/g, CRLF)
    .split(CRLF)
    .map((line) => {
      const bytes = Buffer.byteLength(line, "utf8");
      if (bytes <= MAX_LINE_LENGTH) return line;
      // Split on the UTF-8 boundary nearest the limit.
      const chunks = [];
      let rest = line;
      while (Buffer.byteLength(rest, "utf8") > MAX_LINE_LENGTH) {
        let cut = MAX_LINE_LENGTH;
        while (cut > 0 && (Buffer.from(rest.slice(0, cut), "utf8").byteLength > MAX_LINE_LENGTH || (rest.charCodeAt(cut - 1) & 0xfc) === 0xdc)) cut--;
        chunks.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      chunks.push(rest);
      return chunks.join(CRLF);
    })
    .join(CRLF);
}

/** A single SMTP exchange over one socket with a read-line helper. */
class SmtpSession {
  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
    this._waiters = [];
    this._onData = (chunk) => {
      this.buffer += chunk.toString("utf8");
      const pending = this._waiters.splice(0);
      for (const waiter of pending) waiter();
    };
    socket.on("data", this._onData);
  }

  /** Detach the data listener (call before swapping the socket to TLS). */
  detach() {
    this.socket.off("data", this._onData);
    this._onData = null;
  }

  /** Read one full server response (handles multi-line 250-xxx replies). */
  async readReply() {
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    let first = null;
    const lines = [];
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) {
        if (Date.now() > deadline) throw new Error("smtp: timed out waiting for server reply");
        await new Promise((resolve) => this._waiters.push(resolve));
        continue;
      }
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (first === null) first = line;
      lines.push(line);
      // A multi-line reply continues while the code and first line share a
      // "-" separator; the final line uses a space.
      const continued = line.length >= 4 && line[3] === "-";
      if (!continued) return lines.join("\n");
    }
  }
}

/** Parse the AUTH mechanisms advertised in an EHLO reply (e.g. "LOGIN PLAIN"). */
function authMechanisms(ehlo) {
  const match = /\bauth(?:=|\s+)([A-Z0-9 _-]+)/i.exec(ehlo);
  if (!match) return [];
  return match[1].trim().split(/[\s=]+/).map((m) => m.toUpperCase());
}

/**
 * Authenticate with AUTH LOGIN first, falling back to AUTH PLAIN when the
 * server does not advertise LOGIN.
 */
async function authenticate(session, caps, user, pass, lastErrorRef) {
  const mechs = authMechanisms(caps);
  if (mechs.length === 0 || mechs.includes("LOGIN")) {
    const authReply = await command(session, "AUTH LOGIN", () => lastErrorRef());
    if (authReply.startsWith("3")) {
      await rawCommand(session, b64(user));
      const passReply = await readReplyWithRetry(session, () => lastErrorRef());
      if (!passReply.startsWith("3")) {
        throw new Error("smtp: authentication failed (bad username or password)");
      }
      await rawCommand(session, b64(pass));
      const authDone = await readReplyWithRetry(session, () => lastErrorRef());
      if (!authDone.startsWith("2")) {
        throw new Error(`smtp: authentication rejected: ${authDone}`);
      }
      return;
    }
  }
  if (mechs.includes("PLAIN")) {
    const plainReply = await command(session, `AUTH PLAIN ${b64(`\u0000${user}\u0000${pass}`)}`, () => lastErrorRef());
    if (!plainReply.startsWith("2")) {
      throw new Error(`smtp: AUTH PLAIN rejected: ${plainReply}`);
    }
    return;
  }
  throw new Error(`smtp: no supported auth mechanism (server offers: ${mechs.join(", ") || "none"})`);
}

/**
 * Run one full SMTP conversation on a fresh connection.
 * @returns true on success.
 */
async function runOnce(config, subject, text) {
  const { host, port, secure, user, pass, from, to, rejectUnauthorized, fromHeader } = config;

  const connectRaw = () => {
    const socket = secure
      ? tls.connect({ host, port, servername: host, rejectUnauthorized })
      : net.connect({ host, port });
    socket.setTimeout(STEP_TIMEOUT_MS, () => {
      socket.destroy(new Error(`smtp: connection to ${host}:${port} timed out`));
    });
    return socket;
  };

  let socket = connectRaw();
  let session = new SmtpSession(socket);
  let lastError;

  try {
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", (error) => {
        lastError = error;
        reject(error);
      });
    });

    // Read the greeting (220).
    const greeting = await readReplyWithRetry(session, () => lastError);
    if (!/^2\d\d/.test(greeting)) throw new Error(`smtp: unexpected greeting: ${greeting}`);

    // EHLO to learn capabilities.
    let ehlo = await command(session, "EHLO dsh.local", () => lastError);
    let caps = ehlo;

    // Upgrade to TLS when STARTTLS is advertised and we are not already secure.
    if (!secure && /starttls/i.test(caps)) {
      await command(session, "STARTTLS", () => lastError);
      session.detach();
      socket = tls.connect({ socket, servername: host, rejectUnauthorized });
      session = new SmtpSession(socket);
      await new Promise((resolve, reject) => {
        socket.once("secureConnect", resolve);
        socket.once("error", (error) => {
          lastError = error;
          reject(error);
        });
      });
      ehlo = await command(session, "EHLO dsh.local", () => lastError);
      caps = ehlo;
    } else if (!secure) {
      // Plain-text auth only when the server refuses encryption is dangerous;
      // require STARTTLS for non-implicit-TLS ports.
      throw new Error("smtp: server does not advertise STARTTLS; refusing plaintext auth");
    }

    // AUTH LOGIN, then AUTH PLAIN fallback.
    await authenticate(session, caps, user, pass, () => lastError);

    // MAIL FROM / RCPT TO.
    const mailReply = await command(session, `MAIL FROM:<${parseMailbox(from)}>`, () => lastError);
    if (!mailReply.startsWith("2")) throw new Error(`smtp: MAIL FROM rejected: ${mailReply}`);
    const recipients = Array.isArray(to) && to.length > 0 ? to : [to].filter(Boolean);
    if (recipients.length === 0) throw new Error("smtp: no recipients configured");
    for (const recipient of recipients) {
      const rcptReply = await command(session, `RCPT TO:<${recipient}>`, () => lastError);
      if (!rcptReply.startsWith("2")) throw new Error(`smtp: RCPT TO rejected for ${recipient}: ${rcptReply}`);
    }

    // DATA with headers + body (dot-stuffing, folded lines).
    const dataReply = await command(session, "DATA", () => lastError);
    if (!dataReply.startsWith("3")) throw new Error(`smtp: DATA rejected: ${dataReply}`);
    const headers = [
      `From: ${encodeFromHeader(fromHeader ?? from)}`,
      `To: ${recipients.join(", ")}`,
      `Subject: ${encodeSubject(subject)}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
    ].join(CRLF);
    const folded = foldLines(text);
    const stuffed = folded.replace(/^\./gm, "..");
    await rawCommand(session, `${headers}${CRLF}${stuffed}`);
    await rawCommand(session, ".");
    const doneReply = await readReplyWithRetry(session, () => lastError);
    if (!doneReply.startsWith("2")) throw new Error(`smtp: message rejected after DATA: ${doneReply}`);

    // QUIT.
    await command(session, "QUIT", () => lastError);
    socket.end();
    return true;
  } finally {
    socket.destroy();
  }
}

/**
 * Send an email, retrying transient failures.
 * @param config - { host, port, secure, user, pass, from, to[], rejectUnauthorized?, retries? }.
 * @param subject - email subject.
 * @param text - plain-text body.
 * @returns the number of attempts that were made (>= 1).
 */
export async function sendEmail(config, subject, text) {
  const {
    host,
    port = config.secure === false ? 587 : 465,
    secure = true,
    user,
    pass,
    from,
    to,
    rejectUnauthorized = true,
    retries = DEFAULT_RETRIES,
    timeoutMs = CALL_TIMEOUT_MS,
  } = config;

  if (!host || !user || !pass) throw new Error("smtp: host, user and pass are required");
  if (!from) throw new Error("smtp: from address is required");

  const attempts = [];
  let lastError;
  const started = Date.now();
  const deadline = Date.now() + timeoutMs;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      await Promise.race([
        runOnce({ ...config, host, port, secure, user, pass, from, to, rejectUnauthorized }, subject, text),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`smtp: whole-call timeout after ${timeoutMs}ms`)), remaining)),
      ]);
      return attempts.length + 1;
    } catch (error) {
      lastError = error;
      attempts.push(error);
      // Non-transient auth/config errors should not be retried.
      const message = error instanceof Error ? error.message : String(error);
      if (/authentication|rejected|no supported auth|not advertise|recipients configured|from address|required/i.test(message)) {
        break;
      }
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  }

  const elapsed = Date.now() - started;
  const detail = attempts.length > 0
    ? attempts.map((e, i) => `attempt ${i + 1}: ${e instanceof Error ? e.message : String(e)}`).join("; ")
    : "no attempt completed";
  const error = new Error(`smtp: send failed after ${attempts.length} attempt(s) in ${elapsed}ms — ${detail}`);
  error.attempts = attempts;
  throw error;
}

/** Read a reply, rethrowing the socket's last error when the connection dies. */
async function readReplyWithRetry(session, lastErrorRef) {
  try {
    return await session.readReply();
  } catch (error) {
    const last = lastErrorRef?.();
    if (last) throw last;
    throw error;
  }
}

/** Send a command and read the (possibly multi-line) reply. */
async function command(session, text, lastErrorRef) {
  await rawCommand(session, text);
  return readReplyWithRetry(session, lastErrorRef);
}

/** Write a raw line to the socket. */
function rawCommand(session, text) {
  return new Promise((resolve) => {
    session.socket.write(text + CRLF, resolve);
  });
}
