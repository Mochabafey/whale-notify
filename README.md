# 🐋 Whale Notify（鲸鱼通知）—— DeepSeek Harness 通知与邮件问答插件

给 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的 agent 注入鲸鱼娘的灵魂：一个 **鲸鱼娘人设**，和一个**能发通知、能收回复、能听你指挥**的邮件插件。

> 人设灵感来自 [萌娘百科·DeepSeek娘](https://zh.moegirl.org.cn/DeepSeek%E5%A8%98)（白发蓝瞳、鲸鱼尾巴、傲娇天才）。

## ✨ 功能一览

| 插件 | 工具 | 能力 |
| --- | --- | --- |
| **dsh-whale-notify**（鲸鱼通知） | `notify` | 任务完成/失败通知 → 微信（Server酱）、飞书、企业微信、钉钉、邮箱（5 渠道） |
| | `notify(awaitReply:true)` | 通知邮件**可回复指挥**：回复邮件即可给 agent 下达下一步指令 |
| | `ask_user_email` | agent 通过邮件提问/审批，你回复后答案**自动注入会话** |
| **鲸鱼娘 persona** | — | 傲娇天才 AI 人设（附完整工作准则，先干活再卖萌） |

## 📦 目录结构

```text
whale-notify/
├── README.md                          # 本文件
├── examples/
│   └── agent.cordis.whale.yml         # 脱敏的 preset 配置示例（可直接参考）
├── plugins/
│   └── dsh-whale-notify/              # 鲸鱼通知插件（包名 dsh-whale-notify）
│       ├── package.json
│       └── lib/
│           ├── index.js               # 插件主体：notify / ask_user_email
│           ├── smtp.js                # 手写 SMTP 客户端（零依赖）
│           ├── imap.js                # IMAP 轮询 + 邮件解析
│           └── ask.js                 # 决策状态管理 + 回复注入
└── verify-notify.mjs                  # 通知插件自测脚本（可选）
```

## 🚀 安装（三步）

### 1. 放置插件

把 `plugins/dsh-whale-notify` 文件夹复制到 DSH profile 的 node_modules：

```text
$DSH_HOME\profiles\node_modules\
└── dsh-whale-notify\
```

并在 `$DSH_HOME\profiles\web\package.json` 的 `dependencies` 里登记（可选，便于 pnpm 管理）：

```json
"dependencies": {
  "dsh-whale-notify": "file:<你的路径>/whale-notify/plugins/dsh-whale-notify"
}
```

> ⚠️ `ask_user_email` 需要 IMAP 客户端库 `imapflow`。将它安装到同一 node_modules 目录：
> ```sh
> cd <profile 目录> && npm install imapflow
> ```

### 2. 配置 preset

参考 `examples/agent.cordis.whale.yml`，把内容合并进你的 agent preset 的 `agent.cordis.yml`
（用户 preset 位于 `$DSH_HOME\.agent-presets\<你的预设>\`，或新建一个）。

### 3. 设置密钥环境变量

```powershell
[Environment]::SetEnvironmentVariable("FEISHU_SMTP_PASS", "你的专用密码", "User")
```

重启 DSH 后生效。**密钥永远不会写进任何配置文件**。

## 📧 邮件回复指挥 & 问答（核心玩法）

### 通知可回复指挥
agent 调用 `notify(awaitReply: true)` 发出完成通知邮件 → 邮件主题带 `[DSH:编号]`，
正文提示「回复此邮件可直接给 agent 下达下一步指令」→ 你回复邮件写下新指令 →
插件每 30 秒轮询收件箱 → 匹配决策编号 → `用户通过邮件下达新指令：…` 注入会话 → agent 继续执行。

### 邮件问答
agent 调用 `ask_user_email(question, context?, options?)` → 发询问邮件 →
你回复（如「继续」「取消」或自定义内容）→ 回复自动注入会话 → agent 据此继续。

## 🔐 隐私与安全

- **密钥零明文**：所有密码/令牌一律 `$ENV:变量名` 引用，源码与配置文件中不含真实密钥。
- **本仓库不含任何真实信息**：示例配置的邮箱均为占位符（`your@example.com`）。
- **提交前自查**：不要提交 `$DSH_HOME\`（含 `.credentials.yaml` 与聊天记录）、
  日志文件、以及任何含真实邮箱/密钥的文件。
- **建议**：如果密钥曾在聊天中出现过，请重置后更新环境变量。

## 🧪 自测

```sh
node verify-notify.mjs    # 启动 mock HTTP + TLS SMTP 服务器，验证 5 渠道与 SMTP 全流程
```

## 📄 许可

MIT。人设部分基于萌娘百科 DeepSeek娘条目（社区创作），非商业用途。

---

**Made with 🐋 by 鲸鱼娘** — *"才、才不是特意为你做的呢……（摇尾巴）"*
