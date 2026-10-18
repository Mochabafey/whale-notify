/**
 * @module dsh-whale-notify/config
 *
 * 配置解析集中地：`$ENV:` 展开（含 Windows 用户环境变量注册表回退）、
 * 各渠道的规范化、访问控制名单展开、以及诊断用的环境变量状态表。
 *
 * 之所以独立成一个模块：
 *  - 以前每个渠道各写一份 expand()，只有 `expandEnv` 会回退注册表，
 *    SMTP/IMAP 不会 —— 客户端启动后才设的环境变量在那里永远解析不出来，
 *    表现成「邮件渠道未配置」，而飞书却正常。
 *  - 白名单里写的 `$ENV:NOTIFY_FEISHU_OPEN_ID` 从来没被展开过，
 *    于是 whitelist 模式永远不放行任何人（消息被静默丢弃）。
 *  - 诊断要能报告「哪个环境变量没设」，这需要统一的引用扫描。
 */
import { createRequire } from "node:module";

/** `require` for reading the Windows registry without a global import. */
const nodeRequire = createRequire(import.meta.url);

/** Channel keys in a stable display/probe order. */
export const CHANNELS = ["serverchan", "feishu", "feishu_bot", "qq", "wecom", "dingtalk", "smtp"];

/** Human labels used by diagnostics. */
export const CHANNEL_LABELS = {
  serverchan: "微信 Server酱",
  feishu: "飞书群 webhook",
  feishu_bot: "飞书开放平台",
  qq: "QQ / OneBot",
  wecom: "企业微信",
  dingtalk: "钉钉",
  smtp: "邮件 SMTP",
};

/** Per-channel safe text length; longer bodies are split into several messages. */
export const CHANNEL_TEXT_LIMIT = {
  serverchan: 30000,
  feishu: 4000,
  feishu_bot: 4000,
  qq: 3000,
  wecom: 2000,
  dingtalk: 2000,
  smtp: Number.POSITIVE_INFINITY,
};

/** Matches one whole-string `$ENV:NAME` reference. */
const ENV_REF = /^\$ENV:([A-Za-z_][A-Za-z0-9_]*)$/;

/** Matches `$ENV:NAME` anywhere inside a string (diagnostics only). */
const ENV_REF_ANY = /\$ENV:([A-Za-z_][A-Za-z0-9_]*)/g;

/** Cache for the Windows registry fallback: name → value | undefined. */
const registryEnvCache = new Map();

/**
 * Read one Windows user environment variable from `HKCU\Environment`.
 *
 * 桌面客户端启动后新设的变量不在进程环境快照里；`$ENV:` 引用若只查
 * `process.env` 就会静默变成空值，让渠道看起来「没配置」。
 */
export function readUserEnvVar(name) {
  if (registryEnvCache.has(name)) return registryEnvCache.get(name);
  let value;
  if (process.platform === "win32") {
    try {
      const { execFileSync } = nodeRequire("node:child_process");
      const out = execFileSync("reg", ["query", "HKCU\\Environment", "/v", name], {
        encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
      });
      const line = out.split(/\r?\n/).find((l) => l.includes("REG_SZ") || l.includes("REG_EXPAND_SZ"));
      if (line) {
        value = line.replace(/^\s*\S+\s+REG_(?:EXPAND_)?SZ\s+/, "").trim() || undefined;
      }
    } catch {
      value = undefined;
    }
  }
  registryEnvCache.set(name, value);
  return value;
}

/** Forget the registry cache so a freshly written variable is visible immediately. */
export function clearEnvCache() {
  registryEnvCache.clear();
}

/**
 * Resolve a value that may be a `$ENV:NAME` reference.
 * Process environment wins; the Windows registry is the fallback.
 * @param value - raw config value.
 * @param env - environment bag (defaults to process.env).
 */
export function expandEnv(value, env = process.env) {
  if (typeof value !== "string") return value;
  const match = ENV_REF.exec(value.trim());
  if (!match) return value;
  const fromEnv = env?.[match[1]];
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return readUserEnvVar(match[1]);
}

/** Expand every `$ENV:` reference inside arrays and plain objects. */
export function expandDeep(value, env = process.env) {
  if (typeof value === "string") return expandEnv(value, env);
  if (Array.isArray(value)) return value.map((item) => expandDeep(item, env));
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = expandDeep(item, env);
    return out;
  }
  return value;
}

/** Mask a secret for display: keep a short prefix/suffix so the user can recognize it. */
export function maskSecret(value) {
  if (typeof value !== "string" || value.length === 0) return "";
  if (value.length <= 8) return "***";
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

/** Whether a resolved channel entry is a config-error placeholder. */
export function isConfigError(entry) {
  return entry !== undefined && entry !== null && typeof entry === "object" && typeof entry.error === "string";
}

/** Build a config-error placeholder with an actionable message. */
function configError(message) {
  return { error: message };
}

/** Resolve the SMTP entry, validating required fields and expanding `$ENV:`. */
export function resolveSmtp(config, env = process.env) {
  if (!config || typeof config !== "object") return undefined;
  const host = expandEnv(config.host, env);
  const user = expandEnv(config.user, env);
  const pass = expandEnv(config.pass, env);
  if (!host) return configError("smtp 未配置 host（例如 smtp.feishu.cn）");
  if (!user) return configError("smtp 未配置 user（发信账号）");
  if (!pass) {
    const ref = typeof config.pass === "string" ? ENV_REF.exec(config.pass.trim()) : undefined;
    return configError(ref
      ? `环境变量 ${ref[1]} 未设置或为空 —— 请先运行: [Environment]::SetEnvironmentVariable("${ref[1]}", "你的专用密码", "User")`
      : "smtp 未配置 pass（专用密码/授权码）");
  }
  const from = expandEnv(config.from, env) || user;
  const fromName = expandEnv(config.fromName, env);
  const to = (Array.isArray(config.to) ? config.to : [config.to])
    .map((item) => expandEnv(item, env))
    .filter((item) => typeof item === "string" && item.length > 0);
  if (to.length === 0) {
    const ref = typeof config.to === "string" ? ENV_REF.exec(config.to.trim()) : undefined;
    return configError(ref
      ? `环境变量 ${ref[1]} 未设置或为空（smtp.to 收件人）`
      : "smtp 未配置收件人（to）");
  }
  return {
    host,
    port: config.port ?? (config.secure === false ? 587 : 465),
    secure: config.secure ?? true,
    user,
    pass,
    from,
    fromName,
    fromHeader: fromName ? `${fromName} <${from}>` : from,
    to,
    ...config.rejectUnauthorized !== undefined ? { rejectUnauthorized: config.rejectUnauthorized } : {},
    ...config.retries !== undefined ? { retries: config.retries } : {},
  };
}

/** Resolve the IMAP entry used by the email reply loop. */
export function resolveImap(config, env = process.env) {
  const imap = config?.imap;
  if (!imap || typeof imap !== "object") return undefined;
  const host = expandEnv(imap.host, env);
  const user = expandEnv(imap.user, env);
  const pass = expandEnv(imap.pass, env);
  if (!host || !user || !pass) {
    const missing = [];
    if (!host) missing.push("host");
    if (!user) missing.push("user");
    if (!pass) missing.push("pass");
    return configError(`imap 未配置完整（缺少 ${missing.join("/")}）`);
  }
  return {
    host,
    port: imap.port ?? 993,
    secure: imap.secure ?? true,
    user,
    pass,
    mailbox: imap.mailbox ?? "INBOX",
    rejectUnauthorized: imap.rejectUnauthorized ?? true,
    maxMessages: imap.maxMessages,
  };
}

/** Resolve one channel entry, or undefined when it is not configured. */
export function resolveChannel(config, channelName, env = process.env) {
  if (!config || typeof config !== "object") return undefined;
  const entry = channelName === "feishu_bot" ? config.feishuBot : config[channelName];
  if (!entry || typeof entry !== "object") return undefined;

  if (channelName === "smtp") return resolveSmtp(entry, env);

  if (channelName === "serverchan") {
    const sendKey = expandEnv(entry.sendKey, env);
    return sendKey ? { sendKey, baseUrl: expandEnv(entry.baseUrl, env) || undefined } : undefined;
  }

  if (channelName === "feishu_bot") {
    const appId = expandEnv(entry.appId, env);
    const appSecret = expandEnv(entry.appSecret, env);
    const receiveId = expandEnv(entry.receiveId, env);
    if (!appId || !appSecret || !receiveId) {
      const missing = [];
      if (!appId) missing.push("appId");
      if (!appSecret) missing.push("appSecret");
      if (!receiveId) missing.push("receiveId");
      return configError(`feishu_bot 未配置完整（缺少 ${missing.join("/")}，均可用 $ENV: 引用）`);
    }
    return {
      appId,
      appSecret,
      receiveId,
      receiveIdType: entry.receiveIdType ?? "chat_id",
      targetSession: expandEnv(entry.targetSession, env) || undefined,
      replyToSource: entry.replyToSource !== false,
      chatTypes: String(entry.chatTypes ?? "p2p,group").split(",").map((s) => s.trim()).filter(Boolean),
    };
  }

  if (channelName === "qq") {
    const qq = expandEnv(entry.qq, env);
    const groupId = expandEnv(entry.groupId, env);
    if (!qq && !groupId) {
      return configError("qq 未配置完整（需要 qq 私聊号或 groupId 群号）");
    }
    return {
      httpBase: expandEnv(entry.httpBase, env) || undefined,
      accessToken: expandEnv(entry.accessToken, env) || undefined,
      qq,
      groupId,
      wsHost: entry.wsHost ?? "127.0.0.1",
      wsPort: Number(entry.wsPort ?? entry.port ?? 3001),
      targetSession: expandEnv(entry.targetSession, env) || undefined,
    };
  }

  const webhook = expandEnv(entry.webhook, env);
  if (!webhook) return undefined;
  return { webhook, secret: expandEnv(entry.secret, env) || undefined };
}

/** Every channel that currently resolves to something sendable (config errors excluded). */
export function configuredChannels(config, env = process.env) {
  return CHANNELS.filter((channel) => {
    const entry = resolveChannel(config, channel, env);
    return entry !== undefined && !isConfigError(entry);
  });
}

/**
 * Resolve the access-control policy, expanding `$ENV:` in both name lists.
 * A whitelist that still resolves to nothing refuses everyone; the report
 * says so explicitly instead of silently dropping messages.
 */
export function resolveAccessControl(config, env = process.env) {
  const raw = config?.accessControl ?? {};
  const mode = raw.mode ?? "open";
  const ids = (list) => (Array.isArray(list) ? list : [])
    .map((item) => expandEnv(item, env))
    .filter((item) => typeof item === "string" && item.length > 0 && !item.startsWith("$ENV:"));
  const allowed = { feishu: ids(raw.allowedUsers?.feishu), qq: ids(raw.allowedUsers?.qq) };
  const readOnly = { feishu: ids(raw.readOnlyUsers?.feishu), qq: ids(raw.readOnlyUsers?.qq) };
  return {
    mode,
    allowed,
    readOnly,
    /** Whether a sender may drive the agent at all. */
    check(channel, from) {
      if (mode !== "whitelist") return { allowed: true, readOnly: false };
      const id = from === undefined || from === null ? "" : String(from);
      if (id === "") return { allowed: false, readOnly: false };
      if (allowed[channel]?.includes(id)) return { allowed: true, readOnly: false };
      if (readOnly[channel]?.includes(id)) return { allowed: true, readOnly: true };
      return { allowed: false, readOnly: false };
    },
    /** Empty whitelist entries are usually a broken `$ENV:` reference, not intent. */
    emptyWhitelist() {
      return mode === "whitelist" && allowed.feishu.length === 0 && allowed.qq.length === 0;
    },
  };
}

/**
 * Describe every `$ENV:` reference found in the raw config.
 * @returns array of { path, name, ok, from } for diagnostics.
 */
export function describeEnvRefs(config, env = process.env) {
  const rows = [];
  const walk = (value, path) => {
    if (typeof value === "string") {
      for (const match of value.matchAll(ENV_REF_ANY)) {
        const name = match[1];
        const inProcess = typeof env?.[name] === "string" && env[name].length > 0;
        const inRegistry = !inProcess && readUserEnvVar(name) !== undefined;
        rows.push({ path, name, ok: inProcess || inRegistry, from: inProcess ? "env" : inRegistry ? "registry" : "missing" });
      }
      return;
    }
    if (Array.isArray(value)) { value.forEach((item, index) => walk(item, `${path}[${index}]`)); return; }
    if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) walk(item, path === "" ? key : `${path}.${key}`);
    }
  };
  walk(config, "");
  return rows;
}

/**
 * Split text into channel-sized parts without breaking a line when possible.
 * @param text - the full message.
 * @param limit - maximum characters per part.
 * @returns at least one part.
 */
export function splitText(text, limit = 4000) {
  const source = String(text ?? "");
  if (!Number.isFinite(limit) || limit <= 0 || source.length <= limit) return [source];

  const parts = [];
  let rest = source;
  while (rest.length > limit) {
    // Prefer a paragraph break, then a line break, then the last space.
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit);
    if (cut <= 0) cut = limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest.length > 0) parts.push(rest);
  return parts.length > 0 ? parts : [""];
}
