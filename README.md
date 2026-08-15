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

### 1. 放置插件

把 `plugins/dsh-whale-notify` 复制到 DSH profile 的 node_modules：

```text
$DSH_HOME\profiles\node_modules\dsh-whale-notify\
```

> ⚠️ 运行时依赖（装到同一 node_modules 目录）：
> ```sh
> cd <profile 目录> && npm install imapflow @larksuiteoapi/node-sdk
> ```

### 2. 配置 preset

参考 `examples/agent.cordis.whale.yml`，把内容合并进你的 agent preset 的 `agent.cordis.yml`（用户 preset 位于 `$DSH_HOME\.agent-presets\<你的预设>\`）。

### 3. 配置外部服务

按 [📖 外部服务配置指南](docs/外部服务配置.md) 申请/配置：
- **飞书开放平台应用**（双向聊天）
- **NapCat + QQ**（QQ 双向聊天）
- **邮箱 SMTP/IMAP**（邮件通知/问答）

### 4. 设置密钥环境变量

```powershell
# 飞书开放平台
[Environment]::SetEnvironmentVariable("FEISHU_APP_ID", "cli_xxx", "User")
[Environment]::SetEnvironmentVariable("FEISHU_APP_SECRET", "xxx", "User")
# 邮箱授权码
[Environment]::SetEnvironmentVariable("MAIL_PASS", "xxx", "User")
```

> 🔑 **密钥只进环境变量，永不写进配置文件**。设置后需**新开窗口**重启 DSH（环境变量才会生效）。

### 5. 重启并开始使用

```powershell
dsh web
```

新建会话选 **鲸鱼娘** preset。之后**所有配置都可以在对话里完成**，详见 [📖 会话内配置指南](docs/会话内配置.md)。

## 🔐 隐私与安全

- 密钥一律 `$ENV:变量名` 引用，源码与配置示例不含真实密钥/邮箱/密码
- 本仓库不含任何真实信息（示例均为占位符）
- 记忆、聊天记录、日志全在 `$DSH_HOME\`（私密区），`.gitignore` 保护，不随仓库提交
- App Secret 若曾在聊天中出现，建议到后台重置

## 🧪 自测

```sh
node verify-notify.mjs    # mock HTTP + TLS SMTP，验证发送渠道与 SMTP 全流程（需 openssl）
```

## 📄 许可

MIT。人设基于萌娘百科 DeepSeek娘条目（社区创作），非商业用途。

---

**Made with 🐋 by 鲸鱼娘** — *"才、才不是特意为你做的呢……（摇尾巴）"*
