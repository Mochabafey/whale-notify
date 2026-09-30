# 🐋 Whale Notify（鲸鱼通知）—— DeepSeek Harness 通知、聊天机器人与记忆插件

给 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的 agent 注入鲸鱼娘的灵魂：一个 **鲸鱼娘人设**，和一个**能发通知、能收回复、能听你指挥、有记忆会学习**的插件——支持**飞书/QQ 双向聊天**、群友模式、邮件问答、定时汇报、统一记忆库、技能知识库。

> 人设灵感来自 [萌娘百科·DeepSeek娘](https://zh.moegirl.org.cn/DeepSeek%E5%A8%98)（白发蓝瞳、鲸鱼尾巴、傲娇天才）。

## ✨ 功能全景

| 能力 | 说明 | 工具 |
| --- | --- | --- |
| 📢 **多渠道通知** | 任务完成/失败通知：飞书开放平台、QQ（NapCat）、微信 Server酱、飞书 webhook、企业微信、钉钉、邮箱 | `notify` |
| 💬 **飞书双向聊天** | 你在飞书给机器人发消息 → 注入 DSH 会话 → agent 执行；结果推回飞书 | 内置（长连接） |
| 💬 **QQ 双向聊天** | 通过 NapCat（OneBot）收发 QQ 消息，注入 DSH 会话 | 内置（反向 WS） |
| 👥 **群友模式** | QQ 群里像真实网友互动：黑名单、@/回复触发、独立称呼/记忆/提示词 | `friend_mode` / `settings` |
| 🔐 **访问控制** | 只有白名单用户能指挥，名单外无反应，只读用户标记 | `settings` |
| 📅 **定时汇报** | 每日定点/定期推送（`daily:HH:MM` / `every:N`，默认关闭） | `settings` |
| 🧠 **统一记忆库** | 保存会话总结、跨会话恢复、群友独立记忆（`$DSH_HOME/memory/`） | `save_memory` / `recall_memory` |
| 🎓 **学习模式** | 学会新技能询问 → 存知识库 → 随时调取（`$DSH_HOME/knowledge/`） | `learn_skill` / `recall_skill` |
| ✉️ **邮件问答** | agent 通过邮件提问/审批，你回复后答案自动注入会话；通知邮件可回复指挥 | `ask_user_email` / `notify(awaitReply)` |
| ⚙️ **对话内配置** | 所有配置在对话里完成，不用手改 yml | `settings` |
| 🐋 **鲸鱼娘 persona** | 傲娇天才 AI 人设，附完整工作准则 | 内置 |

## 📚 文档索引

| 文档 | 内容 |
| --- | --- |
| **本文件** | 功能总览、安装、快速开始 |
| [📖 会话内配置指南](docs/会话内配置.md) | `settings` 工具、模式切换、全部配置路径 |
| [📖 外部服务配置指南](docs/外部服务配置.md) | QQ（NapCat）、飞书开放平台、邮箱 SMTP/IMAP 的申请与配置 |

## 📦 目录结构

```text
whale-notify/
├── README.md                          # 本文件
├── docs/
│   ├── 会话内配置.md                   # settings 工具与模式切换
│   └── 外部服务配置.md                 # NapCat / 飞书 / 邮箱配置
├── examples/
│   ├── agent.cordis.whale.yml         # 脱敏的 preset 组合配置示例
│   └── preset.yml                     # 鲸鱼娘 preset 元数据示例（人设介绍）
├── plugins/
│   └── dsh-whale-notify/              # 鲸鱼通知插件
│       ├── package.json
│       └── lib/
│           ├── index.js               # 插件主体：全部工具 + 消息注入 + 定时汇报
│           ├── feishu.js              # 飞书开放平台（官方 SDK 长连接）
│           ├── qq.js                  # QQ OneBot（发送 + 反向 WS 接收）
│           ├── friendmode.js          # 群友模式（称呼/黑名单/提示词）
│           ├── memory.js              # 统一记忆库（conversations/friend/summaries）
│           ├── knowledge.js           # 学习知识库
│           ├── smtp.js                # 手写 SMTP 客户端
│           ├── imap.js                # IMAP 轮询
│           └── ask.js                 # 邮件问答决策管理
└── verify-notify.mjs                  # 通知插件自测脚本
```

## 🚀 快速开始

> ⚠️ **DSH 版本说明**：本文档以 **DSH 0.2.x** 为准。0.2.0 改了插件/preset 机制——
> preset 不再是 `$DSH_HOME\.agent-presets\` 目录，而是 **profile 组合里的声明行**；
> 插件也不再靠往 profile 的 `node_modules` 里拷目录来装，而是作为 **profile bundle** 安装。
> 0.1.5 及更早的装法见文末「旧版本（DSH ≤ 0.1.5）」。

### 1. 作为 profile bundle 安装（0.2.x 推荐）

把插件登记到目标 profile 的 `package.json`：

```jsonc
// $DSH_HOME/profiles/<profile>/package.json
{
  "dependencies": {
    "dsh-whale-notify": "file:<本仓库绝对路径>/plugins/dsh-whale-notify",
    "@larksuiteoapi/node-sdk": "^1.73.0",
    "imapflow": "^1.7.1",
    "ws": "^8.21.3"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-whale-notify"        // ← 加上这一行
      ]
    }
  }
}
```

```powershell
cd $env:DSH_HOME\profiles\<profile>
pnpm install          # 用 DSH 客户端自带的 pnpm
```

**重启客户端**后在任意 preset 的会话里就有 `notify` / `whale_check` / 记忆库等工具了。
插件的渠道配置在它自己的 `plugins/dsh-whale-notify/cordis.patch.yml` 里（单一数据源）。

### 2. 想要「鲸鱼娘」这个模式（可选）

`examples/dsh-preset-jingyuniang/` 是一个预设 bundle：鲸鱼娘人设 + 标准模式全部能力。
按它的 README 装成 bundle 后，模式选择器里就会出现「鲸鱼娘」。

### 3. 配置外部服务

按 [📖 外部服务配置指南](docs/外部服务配置.md) 申请/配置：
- **飞书开放平台应用**（双向聊天，需要开启长连接订阅）
- **NapCat + QQ**（QQ 双向聊天）
- **邮箱 SMTP/IMAP**（邮件通知/问答）

### 4. 设置密钥环境变量

```powershell
# 飞书开放平台
[Environment]::SetEnvironmentVariable("FEISHU_APP_ID", "cli_xxx", "User")
[Environment]::SetEnvironmentVariable("FEISHU_APP_SECRET", "xxx", "User")
[Environment]::SetEnvironmentVariable("FEISHU_CHAT_ID", "oc_xxx", "User")
# 邮箱
[Environment]::SetEnvironmentVariable("FEISHU_SMTP_PASS", "xxx", "User")
[Environment]::SetEnvironmentVariable("NOTIFY_MAIL_USER", "you@example.com", "User")
[Environment]::SetEnvironmentVariable("NOTIFY_MAIL_TO", "you@example.com", "User")
```

> 🔑 **密钥只进环境变量，永不写进配置文件**。
> 插件的 `$ENV:` 解析会先查进程环境，**查不到时回退读 Windows 用户环境变量注册表**
> （`HKCU\Environment`），所以刚设置的环境变量不用重启客户端也能生效。

### 5. 重启并开始使用

重启 DSH 客户端 → 新建会话（可选「鲸鱼娘」模式）→ 让它跑 `whale_check` 自检。
之后**所有配置都可以在对话里完成**，详见 [📖 会话内配置指南](docs/会话内配置.md)。

## 🐟 飞书收信：只走长连接（v0.2.5 起）

收信由官方 `WSClient` 长连接实时接收。早期版本另有一条「轮询兜底」
（调 `GET /im/v1/messages` 读会话消息），但它需要额外的 `im:message` 读权限，
且与长连接并存时容易出现**跨重启重放**（游标只在轮询路径推进、去重表只在内存里）。
实测确认长连接稳定工作后已移除，链路更简单。

**需要在飞书开发者后台**：事件与回调 → 订阅方式选「使用长连接接收事件」，
订阅 `im.message.receive_v1`，并发布版本。若这里没配对，
`whale_check` 会显示「长连接已建立但事件数长期为 0」。

## 🔐 隐私与安全

- 密钥一律 `$ENV:变量名` 引用，源码与配置示例不含真实密钥/邮箱/密码
- 本仓库不含任何真实信息（示例均为占位符）
- 提交前自查：`git ls-files -z | xargs -0 grep -nE '真实邮箱|真实号码|oc_[0-9a-f]{20,}|ou_[0-9a-f]{20,}'`（或按自己的标识 grep 一遍）
- 记忆、聊天记录、日志全在 `$DSH_HOME\`（私密区），`.gitignore` 保护，不随仓库提交
- App Secret 若曾在聊天中出现，建议到后台重置

## 🧪 自测

```sh
node verify-notify.mjs    # mock HTTP + TLS SMTP，验证发送渠道与 SMTP 全流程（需 openssl）
```

## 🕰 旧版本（DSH ≤ 0.1.5）

0.1.5 及更早的机制是：

1. 把 `plugins/dsh-whale-notify` 拷到 `$DSH_HOME\profiles\node_modules\dsh-whale-notify\`；
2. 在 `$DSH_HOME\.agent-presets\<你的预设>\agent.cordis.yml` 里加一行
   `- id: tool-notify / name: 'dsh-whale-notify' / config: …`
   （参考 `examples/agent.cordis.whale.yml`）。

> ⚠️ **0.2.0 起这套不再生效**：`.agent-presets` 目录不会被读取，
> 而且 preset 里的插件名是相对 **harness 安装目录**解析的——插件只装在 profile 里时
> 会被标成 `broken`，**整个 preset 会从客户端的模式选择器里消失**。
> 请改用上面的 bundle 装法。

## 📄 许可

MIT。人设基于萌娘百科 DeepSeek娘条目（社区创作），非商业用途。

---

**Made with 🐋 by 鲸鱼娘** — *"才、才不是特意为你做的呢……（摇尾巴）"*
