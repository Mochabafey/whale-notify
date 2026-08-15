# 🐋 Whale Notify（鲸鱼通知）—— DeepSeek Harness 通知、聊天机器人与定时汇报插件

给 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的 agent 注入鲸鱼娘的灵魂：一个 **鲸鱼娘人设**，和一个**能发通知、能收回复、能听你指挥**的插件——支持**飞书/QQ 双向聊天**、邮件问答、定时汇报、多渠道通知。

> 人设灵感来自 [萌娘百科·DeepSeek娘](https://zh.moegirl.org.cn/DeepSeek%E5%A8%98)（白发蓝瞳、鲸鱼尾巴、傲娇天才）。

## ✨ 功能一览

| 插件 | 工具/能力 | 说明 |
| --- | --- | --- |
| **dsh-whale-notify**（鲸鱼通知） | `notify` | 任务完成/失败通知 → 飞书开放平台、QQ（NapCat）、微信（Server酱）、飞书 webhook、企业微信、钉钉、邮箱 |
| | **飞书双向聊天** | 你在飞书里给机器人发消息 → 注入 DSH 会话 → agent 执行；任务结果可推回飞书 |
| | **QQ 双向聊天** | 通过 NapCat（OneBot）收发 QQ 消息，注入 DSH 会话 |
| | **定时汇报** | 每日定点/定期推送状态到飞书或 QQ（`daily:HH:MM` / `every:N`） |
| | `notify(awaitReply:true)` | 邮件通知**可回复指挥**：回复邮件即可给 agent 下达下一步指令 |
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
│           ├── index.js               # 插件主体：notify / ask_user_email + 消息注入 + 定时汇报
│           ├── feishu.js              # 飞书开放平台：token/发消息/长连接接收（官方 SDK）
│           ├── qq.js                  # QQ（OneBot/NapCat）：发送 + 反向 WS 接收
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

> ⚠️ **运行时依赖**（安装到同一 node_modules 目录）：
> ```sh
> cd <profile 目录> && npm install imapflow @larksuiteoapi/node-sdk
> ```
> - `imapflow` — `ask_user_email` 收信需要（IMAP）
> - `@larksuiteoapi/node-sdk` — 飞书开放平台长连接接收需要

### 2. 配置 preset

参考 `examples/agent.cordis.whale.yml`，把内容合并进你的 agent preset 的 `agent.cordis.yml`
（用户 preset 位于 `$DSH_HOME\.agent-presets\<你的预设>\`，或新建一个）。

### 3. 配置渠道

编辑 preset 的 `agent.cordis.yml`，在 `tool-notify` 的 `config` 下按需启用渠道
（完整示例见 `examples/agent.cordis.whale.yml`）。密钥一律用 `$ENV:变量名` 引用。

#### 📧 邮箱（SMTP + IMAP）—— 支持通知、邮件问答、回复指挥

```yaml
    smtp:
      host: 'smtp.feishu.cn'          # 你的邮箱发信服务器
      port: 587                       # 587=STARTTLS；465=隐式SSL(secure:true)
      secure: false
      user: 'your-mailbox@example.com'
      pass: '$ENV:MAIL_PASS'          # 邮箱专用密码/授权码
      from: 'your-mailbox@example.com'
      to: ['you@example.com']         # 收件人
    imap:
      host: 'imap.feishu.cn'          # 收信服务器（ask_user_email 用）
      port: 993
      secure: true
      user: 'your-mailbox@example.com'
      pass: '$ENV:MAIL_PASS'          # 同一个授权码
      mailbox: 'INBOX'
    pollIntervalMs: 30000             # 轮询间隔（毫秒）
```

> ⚠️ 各邮箱的授权码互不通用：飞书用「专用密码」、QQ 用「授权码」、163 用「客户端授权码」、
> Gmail 用「应用专用密码」。每个邮箱单独开启 SMTP/IMAP 服务后各拿各的码。

#### 💬 飞书开放平台（自建应用）—— 双向聊天，可收发

**能力**：你在飞书里给机器人发消息 → 注入 DSH 会话 → agent 执行；`notify` 也能推消息回飞书。

**飞书后台准备**（[open.feishu.cn/app](https://open.feishu.cn/app)）：
1. 创建**自建应用**，记下 App ID / App Secret
2. **事件与回调** → 订阅方式选 **「使用长连接接收事件/回调」**
3. **事件**：添加 **`im.message.receive_v1`**（接收消息）
4. **权限管理**：开通 **`im:message`**（获取与发送单聊、群组消息）等
5. **版本管理与发布**：创建版本并**发布**（自建应用改配置必须发布才生效）

**配置**：

```yaml
    feishuBot:
      appId: '$ENV:FEISHU_APP_ID'          # 环境变量引用，勿写明文
      appSecret: '$ENV:FEISHU_APP_SECRET'
      receiveId: 'oc_xxxxxxxxxxxxxxxx'      # 目标会话 chat_id / open_id（私聊给机器人发条消息即可在日志/事件中看到）
      receiveIdType: 'chat_id'             # chat_id / open_id / user_id
      targetSession: ''                    # 可选：飞书消息注入哪个 DSH 会话（sessionId）；留空=最近活跃会话
```

**环境变量**：

```powershell
[Environment]::SetEnvironmentVariable("FEISHU_APP_ID", "cli_xxxxxxxxxxxx", "User")
[Environment]::SetEnvironmentVariable("FEISHU_APP_SECRET", "你的AppSecret", "User")
```

> 💡 长连接由官方 `@larksuiteoapi/node-sdk` 处理（token 刷新、protobuf 解码、自动重连）。
> 自建应用的 App Secret 是敏感凭证，泄露后请到后台重置。

#### 💬 QQ（OneBot / NapCat）—— 双向聊天

**前提**：本机运行 [NapCat](https://github.com/NapNeko/NapCatQQ)（登录一个 QQ 号），HTTP API 默认 `http://127.0.0.1:3000`。

**配置**：

```yaml
    qq:
      httpBase: 'http://127.0.0.1:3000'   # OneBot HTTP API
      accessToken: ''                     # OneBot 访问令牌（可选）
      qq: '123456789'                         # 私聊目标 QQ 号
      groupId: ''                         # 或填群号（二选一，优先群）
      wsPort: 3001                        # 本插件监听反向 WS 的端口
      targetSession: ''                   # 可选：QQ 消息注入哪个 DSH 会话
```

> 💡 反向 WS：在 NapCat 的 OneBot 配置里添加「反向 WebSocket」指向 `ws://127.0.0.1:3001`，
> 插件即能接收 QQ 消息并注入会话。

#### 📅 定时汇报

**配置**（`reports` 数组，可多条）：

```yaml
    reports:
      - name: '每日晨报'                  # 汇报名称（作为通知标题）
        channel: 'feishu_bot'             # 推送渠道（已配置的：feishu_bot / smtp / qq 等）
        schedule: 'daily:09:00'           # daily:HH:MM 每日定点；或 every:N 每 N 分钟（N>=5）
        text: '🐋 鲸鱼娘每日晨报：新的一天开始了！'
```

**schedule 格式**：
- `daily:09:00` — 每天 09:00 推送
- `every:30` — 每 30 分钟推送

> 内容当前为静态文本模板（如含会话数/任务数等动态信息的日报需要 agent 驱动，属后续增强）。

#### 💬 飞书群机器人（webhook）—— 只发通知，最简接入

1. 飞书群 → 设置 → 群机器人 → 添加机器人 → **自定义机器人**
2. 复制 Webhook 地址；若创建时选「签名校验」，记下签名密钥
3. 配置：

```yaml
    feishu:
      webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx'
      secret: '$ENV:FEISHU_BOT_SECRET'   # 可选：签名校验密钥
```

#### 💬 微信（Server酱）—— 微信推送通知

1. 微信扫码登录 https://sct.ftqq.com 拿 SendKey
2. 配置：

```yaml
    serverchan:
      sendKey: '$ENV:SERVERCHAN_SEND_KEY'
```

#### 💬 企业微信群机器人

```yaml
    wecom:
      webhook: '$ENV:WECOM_WEBHOOK'
```

#### 💬 钉钉群机器人

```yaml
    dingtalk:
      webhook: '$ENV:DINGTALK_WEBHOOK'
      secret: '$ENV:DINGTALK_SECRET'   # 可选：加签密钥
```

> 📝 **渠道能力一览**：
>
> | 渠道 | 发通知 | 回复指挥 | 说明 |
> | --- | --- | --- | --- |
> | **飞书开放平台**（自建应用） | ✅ | ✅（飞书里直接回复） | 双向聊天，实时注入会话 |
> | **QQ（NapCat / OneBot）** | ✅ | ✅（QQ 里直接回复） | 双向聊天，实时注入会话 |
> | 邮箱 SMTP/IMAP | ✅ | ✅（回复邮件） | 全功能 |
> | 飞书 webhook | ✅ | ❌（单向） | 最简单，只发不收 |
> | 微信 Server酱 | ✅ | ❌（单向） | |
> | 企业微信 | ✅ | ❌（单向） | |
> | 钉钉 | ✅ | ❌（单向） | |
>
> 另有 **定时汇报**（`reports`）：每日定点/定期推送到任一已配置渠道。

### 4. 设置密钥环境变量

```powershell
# 邮箱授权码（发/收信共用）
[Environment]::SetEnvironmentVariable("MAIL_PASS", "你的专用密码", "User")
# 飞书开放平台 App ID / App Secret（自建应用）
[Environment]::SetEnvironmentVariable("FEISHU_APP_ID", "cli_xxxxxxxxxxxx", "User")
[Environment]::SetEnvironmentVariable("FEISHU_APP_SECRET", "你的AppSecret", "User")
# 飞书机器人签名密钥（如果创建时加了签）
[Environment]::SetEnvironmentVariable("FEISHU_BOT_SECRET", "你的密钥", "User")
# 微信 SendKey
[Environment]::SetEnvironmentVariable("SERVERCHAN_SEND_KEY", "你的SendKey", "User")
```

重启 DSH 后生效。**密钥永远不会写进任何配置文件**。

## 💬 飞书双向聊天（核心玩法）

你在飞书里给「鲸鱼娘」机器人发消息 → 长连接实时收到 → 注入 DSH 会话 →
agent 把消息当作你的指令执行 → 结果可通过 `notify(channel: "feishu_bot")` 推回飞书。

```text
你（飞书）──消息──▶ 鲸鱼娘机器人 ──长连接──▶ DSH 会话（agent 执行）
                                              │
你 ◀──通知/结果──── notify(feishu_bot) ◀──────┘
```

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
node verify-notify.mjs    # mock HTTP + TLS SMTP 服务器，验证 5 个发送渠道 + SMTP 全流程（14 项检查）
```

> 需要系统 `openssl`（生成一次性测试证书；Git for Windows 自带）。若插件未安装到 DSH，可设置
> `DSH_HOME` 环境变量指向你的 DSH 用户目录后再运行。

## 📄 许可

MIT。人设部分基于萌娘百科 DeepSeek娘条目（社区创作），非商业用途。

---

**Made with 🐋 by 鲸鱼娘** — *"才、才不是特意为你做的呢……（摇尾巴）"*
