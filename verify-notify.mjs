// Verification harness for dsh-whale-notify without booting DSH.
// Mocks HTTP endpoints for Feishu/WeCom/DingTalk/ServerChan and a real TLS
// SMTP server (self-signed cert, implicit TLS) for the email channel, then
// drives the plugin's tool through a fake tools registry and asserts every
// wire format.
import { createServer as createHttpServer } from "node:http";
import { createServer as createTlsServer } from "node:tls";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

// 优先从 DSH profile 的安装副本加载（peer 依赖来自 DSH 环境）；
// 找不到安装副本时回退到本仓库 plugins/（用于开发自测，需自行提供 peer 依赖）。
const here = dirname(fileURLToPath(import.meta.url));
const candidates = [
  process.env.DSH_HOME ? join(process.env.DSH_HOME, "profiles", "node_modules", "dsh-whale-notify", "lib", "index.js") : null,
  join(here, "plugins", "dsh-whale-notify", "lib", "index.js"),
].filter(Boolean);
let mod = null;
let pluginLibDir = null;
for (const candidate of candidates) {
  if (existsSync(candidate)) {
    pluginLibDir = dirname(candidate);
    mod = await import(pathToFileURL(candidate).href);
    break;
  }
}
if (mod === null) {
  console.error("找不到 dsh-whale-notify 插件。请先安装到 DSH profile，或设置 DSH_HOME。");
  process.exit(1);
}

// ---------- 1. module shape ----------
assert.equal(typeof mod.name, "string");
assert.ok(mod.inject.includes("tools"), "injects tools");
assert.ok(mod.inject.includes("timer"), "injects timer (host service)");
assert.equal(typeof mod.apply, "function");
assert.ok(mod.Config, "exports Config");
console.log("module shape OK:", { name: mod.name, inject: mod.inject });

// ---------- 2. registration ----------
const registeredTools = [];
const fakeCtx = { tools: { register: (def) => { registeredTools.push(def); } } };
mod.apply(fakeCtx, {});
assert.ok(registeredTools.length >= 2, "register() was called for notify + ask_user_email");
const registered = registeredTools.find((t) => t.name === "notify");
assert.ok(registered, "notify tool registered");
assert.equal(registered.name, "notify");
assert.ok(registeredTools.some((t) => t.name === "ask_user_email"), "ask_user_email tool registered");
console.log("registration OK:", registeredTools.map((t) => t.name).join(", "));

// ---------- 3. mock HTTP webhook server ----------
const webhookBodies = [];
const httpServer = createHttpServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    webhookBodies.push({
      method: req.method,
      url: req.url,
      contentType: req.headers["content-type"],
      body: Buffer.concat(chunks).toString("utf8"),
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 0, msg: "ok" }));
  });
});
await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
const httpPort = httpServer.address().port;
const base = `http://127.0.0.1:${httpPort}`;

// ---------- 4. mock TLS SMTP server (implicit TLS on a local port) ----------
// 生成一次性的自签名测试证书（需要系统 openssl；Git for Windows 自带）。
const certDir = join(tmpdir(), "dsh-whale-notify-test-certs");
const { execFileSync } = await import("node:child_process");
const OPENSSL_CANDIDATES = [
  "openssl",
  "C:/Program Files/Git/usr/bin/openssl.exe",
  "C:/Program Files/OpenSSL/bin/openssl.exe",
  "/usr/bin/openssl",
];
function findOpenssl() {
  for (const candidate of OPENSSL_CANDIDATES) {
    try {
      execFileSync(candidate, ["version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}
if (!existsSync(join(certDir, "key.pem"))) {
  mkdirSync(certDir, { recursive: true });
  const openssl = findOpenssl();
  if (openssl === null) {
    console.error("未找到 openssl，无法生成测试证书。请安装 openssl（或 Git for Windows）后重试。");
    process.exit(1);
  }
  execFileSync(openssl, [
    "req", "-x509", "-newkey", "rsa:2048",
    "-keyout", join(certDir, "key.pem"),
    "-out", join(certDir, "cert.pem"),
    "-days", "30", "-nodes", "-subj", "/CN=localhost",
  ], { stdio: "ignore" });
}
const smtpLog = [];
const smtpServer = createTlsServer({
  key: readFileSync(`${certDir}/key.pem`),
  cert: readFileSync(`${certDir}/cert.pem`),
}, (socket) => {
  socket.setEncoding("utf8");
  let buffer = "";
  let sentUser = false;
  let inData = false;
  const send = (line) => socket.write(line + "\r\n");
  send("220 mock-smtp ESMTP ready");
  socket.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\r\n");
    buffer = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      smtpLog.push(line);
      const upper = line.toUpperCase();
      if (upper.startsWith("EHLO")) {
        send("250-mock-smtp");
        send("250 AUTH LOGIN PLAIN");
      } else if (upper === "AUTH LOGIN") {
        send("334 VXNlcm5hbWU6");
      } else if (upper.startsWith("AUTH PLAIN")) {
        send("235 2.7.0 auth ok");
      } else if (upper === "QUIT") {
        send("221 bye");
        socket.end();
      } else if (upper.startsWith("MAIL FROM")) {
        send("250 ok");
      } else if (upper.startsWith("RCPT TO")) {
        send("250 ok");
      } else if (upper === "DATA") {
        inData = true;
        send("354 go ahead");
      } else if (inData && line === ".") {
        inData = false;
        send("250 2.0.0 queued");
      } else if (inData) {
        // message body/headers — no reply
      } else if (sentUser) {
        sentUser = false;
        send("235 2.7.0 auth ok");
      } else if (/^[A-Za-z0-9+/=]{4,}$/.test(line)) {
        sentUser = true;
        send("334 UGFzc3dvcmQ6");
      }
    }
  });
  socket.on("error", () => {});
});
await new Promise((r) => smtpServer.listen(0, "127.0.0.1", r));
const smtpPort = smtpServer.address().port;

// ---------- 5. run tool with all channels configured ----------
const config = {
  defaultChannel: "serverchan",
  serverchan: { sendKey: "SCT-test-key", baseUrl: base },
  feishu: { webhook: `${base}/feishu`, secret: "feishu-secret" },
  wecom: { webhook: `${base}/wecom` },
  dingtalk: { webhook: `${base}/dingtalk`, secret: "ding-secret" },
  smtp: {
    host: "127.0.0.1",
    port: smtpPort,
    secure: true,
    rejectUnauthorized: false,
    user: "user@example.com",
    pass: "secret-pass",
    from: "user@example.com",
    to: ["a@example.com", "b@example.com"],
  },
};

let reg2 = null;
{
  const collected = [];
  mod.apply({ tools: { register: (def) => { collected.push(def); } } }, config);
  reg2 = collected.find((t) => t.name === "notify");
}
const run = (args) => reg2.execute(args);

// all channels
const all = await run({ title: "任务完成", message: "构建成功\n第二行", channel: "all", level: "success" });
assert.equal(all.delivered.length, 5, "all five channels attempted");
assert.ok(all.delivered.every((d) => d.ok), "every channel succeeded: " + JSON.stringify(all.delivered));
console.log("all channels OK:", all.delivered.map((d) => `${d.channel}:${d.ok}`).join(", "));

// inspect HTTP payloads
const feishu = JSON.parse(webhookBodies.find((r) => r.url.includes("feishu")).body);
assert.equal(feishu.msg_type, "text");
assert.equal(feishu.content.text, "构建成功\n第二行");
assert.ok(feishu.timestamp && feishu.sign, "feishu signed");
console.log("feishu payload OK (signed)");

const wecom = JSON.parse(webhookBodies.find((r) => r.url.includes("wecom")).body);
assert.equal(wecom.msgtype, "text");
assert.equal(wecom.text.content, "构建成功\n第二行");
console.log("wecom payload OK");

const ding = webhookBodies.find((r) => r.url.includes("dingtalk"));
assert.ok(ding.url.includes("timestamp=") && ding.url.includes("sign="), "dingtalk signed query");
const dingBody = JSON.parse(ding.body);
assert.equal(dingBody.msgtype, "text");
console.log("dingtalk payload OK (signed)");

const sctForm = webhookBodies.find((r) => r.contentType?.includes("x-www-form-urlencoded"));
assert.ok(sctForm, "serverchan form body present");
assert.ok(sctForm.body.includes("title=%5B%E5%AE%8C%E6%88%90%5D"), "serverchan title has level tag: " + sctForm.body.slice(0, 80));
console.log("serverchan form OK (level tag in title, local baseUrl)");

// inspect SMTP log
assert.ok(smtpLog.includes("EHLO dsh.local"), "EHLO sent");
assert.ok(smtpLog.includes("AUTH LOGIN"), "AUTH LOGIN sent");
const b64User = Buffer.from("user@example.com").toString("base64");
const b64Pass = Buffer.from("secret-pass").toString("base64");
assert.ok(smtpLog.includes(b64User), "base64 user sent");
assert.ok(smtpLog.includes(b64Pass), "base64 pass sent");
assert.ok(smtpLog.some((l) => l.startsWith("MAIL FROM:<user@example.com>")), "MAIL FROM sent");
assert.equal(smtpLog.filter((l) => l.startsWith("RCPT TO")).length, 2, "two recipients");
assert.ok(smtpLog.includes("DATA"), "DATA sent");
const dataIdx = smtpLog.indexOf("DATA");
const dotIdx = smtpLog.indexOf(".", dataIdx);
assert.ok(dotIdx > dataIdx, "message terminator dot sent");
const messageLines = smtpLog.slice(dataIdx + 1, dotIdx);
assert.ok(messageLines.some((l) => l.startsWith("Subject:")), "subject header present");
assert.ok(messageLines.some((l) => l === "构建成功"), "utf-8 body line present");
console.log("smtp exchange OK (implicit TLS + EHLO/AUTH LOGIN/MAIL/RCPT/DATA/body)");

// ---------- 6. default channel + error paths ----------
const defaults = await run({ title: "t", message: "m" });
assert.equal(defaults.delivered.length, 1, "default channel only (serverchan)");
assert.equal(defaults.delivered[0].channel, "serverchan");
console.log("default channel OK:", defaults.delivered[0].channel);

const sparseCollected = [];
mod.apply({ tools: { register: (def) => { sparseCollected.push(def); } } }, {});
const runSparse = (args) => sparseCollected.find((t) => t.name === "notify").execute(args);
await assert.rejects(() => runSparse({ title: "t", message: "m" }), /尚未配置任何通知渠道/);
console.log("unconfigured -> error OK (中文报错)");

await assert.rejects(() => run({ title: "t", message: "m", channel: "pigeon" }), /must be one of/);
console.log("invalid channel -> schema error OK");

// ---------- 7. output schema + render ----------
assert.ok(reg2.output.schema.required?.includes("delivered"));
const rendered = reg2.output.render({}, all);
assert.equal(rendered[0].type, "text");
assert.ok(rendered[0].text.includes("serverchan: OK"));
console.log("render OK");

// ---------- 8. AUTH PLAIN-only server ----------
const plainLog = [];
const plainServer = createTlsServer({
  key: readFileSync(`${certDir}/key.pem`),
  cert: readFileSync(`${certDir}/cert.pem`),
}, (socket) => {
  socket.setEncoding("utf8");
  let buffer = "";
  let inData = false;
  const send = (line) => socket.write(line + "\r\n");
  send("220 plain-smtp ESMTP ready");
  socket.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\r\n");
    buffer = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      plainLog.push(line);
      const upper = line.toUpperCase();
      if (upper.startsWith("EHLO")) { send("250-plain-smtp"); send("250 AUTH PLAIN"); }
      else if (upper.startsWith("AUTH PLAIN")) { send("235 2.7.0 auth ok"); }
      else if (upper.startsWith("AUTH LOGIN")) { send("504 auth mechanism not supported"); }
      else if (upper === "QUIT") { send("221 bye"); socket.end(); }
      else if (upper.startsWith("MAIL FROM") || upper.startsWith("RCPT TO")) { send("250 ok"); }
      else if (upper === "DATA") { inData = true; send("354 go ahead"); }
      else if (inData && line === ".") { inData = false; send("250 queued"); }
      else if (inData) { /* body */ }
    }
  });
  socket.on("error", () => {});
});
await new Promise((r) => plainServer.listen(0, "127.0.0.1", r));
const plainPort = plainServer.address().port;

const { sendEmail } = await import(pathToFileURL(join(pluginLibDir, "smtp.js")).href);
const plainOk = await sendEmail({
  host: "127.0.0.1", port: plainPort, secure: true, rejectUnauthorized: false,
  user: "u@e.com", pass: "p", from: "u@e.com", to: ["a@e.com"],
  retries: 0,
}, "plain test", "body");
assert.ok(plainOk);
assert.ok(plainLog.some((l) => l.startsWith("AUTH PLAIN")), "AUTH PLAIN sent on PLAIN-only server");
console.log("AUTH PLAIN fallback OK");

// ---------- 9. retry: first connection refused, second succeeds ----------
const retryLog = [];
const retryServer = createTlsServer({
  key: readFileSync(`${certDir}/key.pem`),
  cert: readFileSync(`${certDir}/cert.pem`),
}, (socket) => {
  socket.setEncoding("utf8");
  let buffer = "";
  let inData = false;
  let sentUser = false;
  const send = (line) => socket.write(line + "\r\n");
  send("220 retry-smtp ESMTP ready");
  socket.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\r\n");
    buffer = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      retryLog.push(line);
      const upper = line.toUpperCase();
      if (upper.startsWith("EHLO")) { send("250-retry-smtp"); send("250 AUTH LOGIN"); }
      else if (upper === "AUTH LOGIN") { send("334 VXNlcm5hbWU6"); }
      else if (upper === "QUIT") { send("221 bye"); socket.end(); }
      else if (upper.startsWith("MAIL FROM") || upper.startsWith("RCPT TO")) { send("250 ok"); }
      else if (upper === "DATA") { inData = true; send("354 go ahead"); }
      else if (inData && line === ".") { inData = false; send("250 queued"); }
      else if (inData) { /* body */ }
      else if (sentUser) { sentUser = false; send("235 2.7.0 auth ok"); }
      else if (/^[A-Za-z0-9+/=]{4,}$/.test(line)) { sentUser = true; send("334 UGFzc3dvcmQ6"); }
    }
  });
  socket.on("error", () => {});
});
await new Promise((r) => retryServer.listen(0, "127.0.0.1", r));
const retryPort = retryServer.address().port;

// Retry semantics: an unreachable port with retries:1 should produce 2 attempts.
const attempts = await (async () => {
  const counts = [];
  try {
    await sendEmail({
      host: "127.0.0.1", port: retryPort + 30000, secure: true, rejectUnauthorized: false,
      user: "u@e.com", pass: "p", from: "u@e.com", to: ["a@e.com"],
      retries: 1, timeoutMs: 6000,
    }, "t", "m");
  } catch (error) {
    counts.push(...(error.attempts ?? []));
  }
  return counts;
})();
assert.ok(attempts.length >= 2, `retries attempted (got ${attempts.length})`);
console.log("retry attempts OK:", attempts.length);

// ---------- 10. send log written ----------
// 插件的 appendLog 写入 $DSH_HOME/logs/notify.log（DSH_HOME 未设时默认 ~/.dsh）
const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const logPath = join(dshHome, "logs", "notify.log");
await new Promise((r) => setTimeout(r, 300));
const logText = readFileSync(logPath, "utf8");
assert.ok(logText.trim().length > 0, "notify.log has content");
const lastLine = logText.trim().split("\n").pop();
assert.ok(lastLine.includes("serverchan"), "log records channels");
console.log("send log OK:", lastLine.slice(0, 120));

// ---------- 11. line folding (>998 chars) ----------
const longBody = "x".repeat(2000);
const folded = await sendEmail({
  host: "127.0.0.1", port: retryPort, secure: true, rejectUnauthorized: false,
  user: "u@e.com", pass: "p", from: "u@e.com", to: ["a@e.com"],
  retries: 0,
}, "fold test", longBody);
assert.ok(folded);
const dataStart = retryLog.indexOf("DATA");
const term = retryLog.indexOf(".", dataStart);
const bodyLines = retryLog.slice(dataStart + 1, term);
assert.ok(bodyLines.every((l) => Buffer.byteLength(l, "utf8") <= 1000), "no body line exceeds ~1000 bytes");
console.log("line folding OK: longest line", Math.max(...bodyLines.map((l) => Buffer.byteLength(l, "utf8"))), "bytes");

httpServer.close();
smtpServer.close();
plainServer.close();
retryServer.close();
console.log("\nALL NOTIFY CHECKS PASSED ✔");
