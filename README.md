# 🐋 Whale Notify（鲸鱼通知）—— DeepSeek Harness 通知、聊天机器人与记忆插件

给 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的 agent 注入鲸鱼娘的灵魂：一个 **鲸鱼娘人设**，和一个**能发通知、能收回复、能听你指挥、有记忆会学习**的插件——支持**飞书/QQ 双向聊天**、群友模式、邮件问答、定时汇报、统一记忆库、技能知识库。

> 人设灵感来自 [萌娘百科·DeepSeek娘](https://zh.moegirl.org.cn/DeepSeek%E5%A8%98)（白发蓝瞳、鲸鱼尾巴、傲娇天才）。

## ✨ 功能全景

| 能力 | 说明 | 工具 |
| --- | --- | --- |
| 📢 **多渠道通知** | 任务完成/失败通知：飞书开放平台、QQ（NapCat）、微信 Server酱、飞书 webhook、企业微信、钉钉、邮箱；超长文本自动分条 | `notify` |
| 💬 **飞书双向聊天** | 你在飞书给机器人发消息（私聊或群）→ 注入 DSH 会话 → 结果用 `notify(to=…)` 发回原会话 | 内置（长连接） |
| 💬 **QQ 双向聊天** | 通过 NapCat（OneBot）收发 QQ 消息，注入 DSH 会话 | 内置（反向 WS） |
| 👥 **群友模式** | QQ 群里像真实网友互动：黑名单、@/回复触发、独立称呼/**按群隔离的记忆**/提示词 | `friend_mode` / `settings` |
| 🔐 **访问控制** | 只有白名单用户能指挥，名单外无反应，只读用户标记；名单里的 `$ENV:` 会真正展开 | `settings` |
| 📅 **定时汇报** | `daily:HH:MM` / `every:N` / `at:HH:MM,HH:MM`，分钟级去重，默认关闭 | `settings` |
| 🧠 **统一记忆库** | 保存会话总结、跨会话恢复、群友独立记忆（`$DSH_HOME/memory/`） | `save_memory` / `recall_memory` |
| 🎓 **学习模式** | 学会新技能询问 → 存知识库 → 随时调取（`$DSH_HOME/knowledge/`） | `learn_skill` / `recall_skill` |
| ✉️ **邮件问答** | agent 通过邮件提问/审批，回复自动注入会话；通知邮件可回复指挥；决策表**落盘**，重启不丢 | `ask_user_email` / `notify(awaitReply)` |
| ⚙️ **对话内配置** | `settings` 走 `configEditor`：schema 校验 + **热生效**，不用重启 | `settings` |
| 🧩 **跨插件调用** | 看见并调用宿主上别的插件的工具（SSH/数据库/Office…），带前置条件说明，支持多步 `$N` 引用 | `plugin_tools` |
| 🩺 **一键自检** | 渠道、`$ENV:` 来源、白名单展开结果、长连接、会话、汇报计划、日志尾 | `whale_check` |
| 🐋 **鲸鱼娘 persona** | 傲娇天才 AI 人设，附完整工作准则 | 内置 |

## 🧩 v0.3.0 新增：鲸鱼娘会用别的插件了（`plugin_tools`）

以前模型只看到「工具名 + 参数」，看不到**属于哪个插件、要不要前置条件、为什么用不了**。
结果是：明明装了 SSH/数据库/Office 插件，它却在教用户手敲命令，或者说「我没有这个能力」。

```text
plugin_tools(action: "list")                          # 按能力分类列出本会话可用工具
plugin_tools(action: "list", group: "SSH")             # 只看一类
plugin_tools(action: "list", keyword: "sql")           # 工具名/插件名/参数名都能匹配
plugin_tools(action: "list", include_unavailable: true)# 连被 restrict 挡掉的也列，并说明原因

plugin_tools(action: "call", steps: [
  {tool: "db_connect", arguments: "{\"type\":\"mysql\",\"host\":\"127.0.0.1\"}"},
  {tool: "db_query",   arguments: "{\"sql\":\"select 1\",\"db_connection_id\":\"$0.db_connection_id\"}"}
])
```

- **`$N.field`**：引用第 N 步（0 起）的**规范返回值**，数字/布尔保持原类型，支持嵌套与数组下标；引用失败会列出可用字段。
- **硬约束**：只能调本会话可见的工具；不能调自己（防递归）；嵌套 ≤4 层；一次 ≤8 步；
  审批与沙箱**完全复用** `ctx.tools.execute`（`tools/pre-execute`、guard、timeout 包装器照常生效）；子调用继承外层 `signal`。
- **失败可见**：默认遇错即停，并写明「第 N 步起未执行 + 怎么改成继续」；参数非法时报解析位置而不是抛异常。
- 鲸鱼娘 preset 的提示词也新增了【插件能力·主动调用】一节，要求它**先查清单再动手**、不要造轮子。
- 内置两本**使用手册**（`plugin_tools(action:"guide")`）：`ssh-ops` 与 `dsh-ops`，
  内容是从真实排障里提炼的「前置条件 → 推荐流程 → 踩过的坑 → 怎么验证」；
  最关键的 6 条同时作为系统提示词 section 常驻，模型不读手册也不会犯低级错误。

## 🆕 v0.3.0：适配 DSH 0.2.1 的一轮整修

这一版不是加功能，是把「装上了但某些情况没反应」的坑逐个补齐。每条都对应一个能复现的现象：

| 现象 | 根因 | 修复 |
| --- | --- | --- |
| 白名单模式下**所有人的消息都被丢弃**，日志只有 `feishu_denied` | `allowedUsers` 里的 `$ENV:…` 从来没被展开，字面量永远匹配不上 open_id | 名单统一展开（进程环境 → 注册表）后再比对；解析后全空时 `whale_check` 直接警告 |
| 邮件渠道显示「未配置」，但环境变量明明设了 | SMTP/IMAP 用的是自己那份 `expand()`，只查进程环境，没有注册表回退 | 全仓库只有 `config.js` 一个 `$ENV:` 实现 |
| 改 `qq.wsPort` 不生效，端口冲突时静默降级 | 接收端读的是 `config.port`，配置写的是 `wsPort` | 两个字段都认，实际端口进日志与自检 |
| `settings set` 写完重启也不生效 | 改的是 0.2.x 已废弃的 preset 目录 | 改为 `configEditor.edit()`：校验后热重载 |
| 每日晨报可能同一分钟发两次 / 休眠错过就没了 | `isDue` 只看「时分相等」，没有触发记录 | 20 秒一跳 + 分钟级去重；自检显示上次触发时间 |
| 插件热重载后旧飞书长连接还在跑 | disposer 捕获的是启动前的空函数 | disposer 读最新引用；启动失败按指数退避重连（上限 6 次） |
| 只认配置里那一个群 `chat_id`，私聊完全没反应 | 硬编码「chat_id 必须等于 receiveId」 | 私聊始终响应；群聊按配置过滤；`chatTypes` 可配 |
| 超长消息直接失败（飞书 4000 / 企微 2000） | 不分条 | 按渠道上限切分并标 `(1/N)` |
| DSH 重启后用户回信无人接收，也没痕迹 | 决策只在内存 Map 里 | 落盘 `logs/notify-pending.json`，启动按 sessionId 重绑 |
| 群友记忆串群 | 所有群共用一段记忆 | 记忆按 `groupId` 隔离 |
| 注入的飞书消息里是 `@_user_1` | 没处理 `mentions` | 用 `mentions` 还原成 `@名字` |

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
│       ├── cordis.patch.yml           # 唯一配置来源（渠道/白名单/汇报）
│       └── lib/
│           ├── index.js               # 工具注册 + 消息注入 + 定时任务编排
│           ├── config.js              # $ENV: 展开、渠道规范化、访问控制、文本切分
│           ├── channels.js            # 各渠道最后一步发送（含分条）
│           ├── scheduler.js           # 定时汇报到点判定（分钟级去重）
│           ├── registry.js            # 插件能力索引 + 跨插件工具调用
│           ├── playbooks.js           # ssh-ops / dsh-ops 使用手册
│           ├── feishu.js              # 飞书开放平台（官方 SDK 长连接）
│           ├── qq.js                  # QQ OneBot（发送 + 反向 WS 接收）
│           ├── friendmode.js          # 群友模式（称呼/黑名单/提示词）
│           ├── memory.js              # 统一记忆库（conversations/friend/summaries）
│           ├── knowledge.js           # 学习知识库
│           ├── smtp.js                # 手写 SMTP 客户端
│           ├── imap.js                # IMAP 轮询
│           └── ask.js                 # 邮件问答决策管理（落盘恢复）
└── verify-notify.mjs                  # 通知插件自测脚本
```

## 🚀 快速开始

> ⚠️ **DSH 版本说明**：本文档以 **DSH 0.2.x** 为准。0.2.0 改了插件/preset 机制——
> preset 不再是 `$DSH_HOME\.agent-presets\` 目录，而是 **profile 组合里的声明行**；
> 插件也不再靠往 profile 的 `node_modules` 里拷目录来装，而是作为 **profile bundle** 安装。
> 0.1.5 及更早的装法见文末「旧版本（DSH ≤ 0.1.5）」。
>
> 🧱 **0.2.0 的插件兼容闸门**：`dsh-app-boot` 会拿插件 `package.json` 里的
> `@deepseek-ai/dsh-*` peerDependencies 去比运行时版本，**对不上就整个插件不加载**
> （不是降级、也不只是警告）。所以第三方插件必须升到声明了 0.2.x 的版本——
> 本机实测：`dsh-ssh-ops` 要 ≥ **0.3.14**（旧 0.3.12 声明 `^0.1.6-alpha.1`，被拦），
> `dshmarket` 要 ≥ **1.66.6**（旧 1.47.0 声明 `^0.1.2-alpha.2`，被拦）。
> 确实没有适配版时，才在 `$DSH_HOME/profiles/<profile>/compatibility.json` 里按
> `{"包名@精确版本": ["精确的 DSH 版本"]}` 授予豁免（官方途径 `dsh plugin allow-version`）。
> 本仓库的插件只把 `@deepseek-ai/cordis` / `dsh-tools` / `schemastery` 声明成
> **optional peer**，不锁 DSH 版本，因此不会被这道闸门拦下（0.2.0 与 0.2.1-rc 都实测可加载）。

### 1. 作为 profile bundle 安装（0.2.x 推荐）

把插件登记到目标 profile 的 `package.json`：

```jsonc
// $DSH_HOME/profiles/<profile>/package.json
{
  "dependencies": {
    "dsh-whale-notify": "file:<本仓库绝对路径>/plugins/dsh-whale-notify",
    "@larksuiteoapi/node-sdk": "^1.76.0",
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
之后改配置可以两条路：编辑这个 yml 后重启，或者在对话里 `settings set <路径> <值>`（热生效）。

### 2. 想要「鲸鱼娘」这个模式（可选）

`examples/dsh-preset-jingyuniang/` 是一个预设 bundle：鲸鱼娘人设 + 标准模式全部能力。
按它的 README 装成 bundle 后，模式选择器里就会出现「鲸鱼娘」。

> ⚠️ 它的 `config.id` 是 **`standard-units`**（0.1.5 时代 preset 目录名），**不要改**：
> 会话 header 里存的就是这个 id，改了会让历史会话报
> `RemoteError: Unknown agent preset`。想让**新会话默认**用它，要在 profile 的
> `cordis.patch.yml` 里覆盖 `agent-preset-registry` 的 `config.default: standard-units`
> （0.2.0 已不再读 `settings.yaml` 里的 `agent-presets.default`）。

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

## 🐟 飞书收信：只走长连接

收信由官方 `WSClient` 长连接实时接收。早期版本另有一条「轮询兜底」
（调 `GET /im/v1/messages` 读会话消息），但它需要额外的 `im:message` 读权限，
且与长连接并存时容易出现**跨重启重放**（游标只在轮询路径推进、去重表只在内存里）。
实测确认长连接稳定工作后已移除，链路更简单。

**需要在飞书开发者后台**：事件与回调 → 订阅方式选「使用长连接接收事件」，
订阅 `im.message.receive_v1`，并发布版本。若这里没配对，
`whale_check` 会显示「长连接已建立但事件数长期为 0」。

v0.3.0 又补了三件事：长连接状态分 `up / reconnecting / failed` 三态并进自检；
初次握手失败会按指数退避重连（5s→300s，最多 6 次，之后明确报告停止）；
插件卸载/热重载时真的会关掉连接（旧版本捕获的是启动前的空函数，旧连接会一直挂着）。

## 🩺 出问题了先跑 whale_check

一次给出七段信息，覆盖「没反应」的所有常见原因：

1. **渠道**：每行是「已配置 / 未配置 / 缺哪个字段」，不再是笼统的「未配置」；
2. **`$ENV:` 变量**：逐条列出引用位置、变量名、来源（进程环境 / 注册表 / 未设置）；
3. **访问控制**：**展开后**的白名单。如果是空列表，会直接警告「谁发的都会被丢弃」；
4. **飞书长连接**：状态、已收事件数、最后一条时间、重连次数；
5. **QQ 接收端**：状态、端口、NapCat 连接过几次；
6. **可注入的会话**：存活 agent 数（**为 0 时外部消息必定注入失败**）；
7. **定时汇报**：每条计划解析后的时间、上次触发时间、总开关状态。

## 🔐 隐私与安全

- 密钥一律 `$ENV:变量名` 引用，源码与配置示例不含真实密钥/邮箱/密码
- 本仓库不含任何真实信息（示例均为占位符）
- 提交前自查：`git ls-files -z | xargs -0 grep -nE '真实邮箱|真实号码|oc_[0-9a-f]{20,}|ou_[0-9a-f]{20,}'`（或按自己的标识 grep 一遍）
- 记忆、聊天记录、日志全在 `$DSH_HOME\`（私密区），`.gitignore` 保护，不随仓库提交
- App Secret 若曾在聊天中出现，建议到后台重置

## 🧪 自测

```sh
node verify-notify.mjs    # mock HTTP + TLS SMTP，验证发送渠道与 SMTP 全流程（需 openssl 或备用测试证书）
```

v0.3.0 另有 61 项行为验证（配置解析 / 访问控制 / 分条 / 调度去重 / 六渠道发送 / 飞书与 OneBot
事件解析 / 记忆与知识检索 / 工具注册与 JSON Schema / 自检报告 / 插件能力索引与跨插件调用），
见 `_verify/verify.mjs`（不在仓库内，属本机验证脚手架）。

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
