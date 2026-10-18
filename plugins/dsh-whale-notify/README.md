# dsh-whale-notify（鲸鱼通知）v0.3.0

DeepSeek Harness（DSH）的通知、聊天机器人、记忆与知识库插件。

> 📚 完整文档：主文档 `whale-notify/README.md`、[会话内配置指南](../docs/会话内配置.md)、
> [外部服务配置指南](../docs/外部服务配置.md)

## 工具

| 工具 | 说明 |
| --- | --- |
| `notify(title, message, channel?, level?, awaitReply?, groupId?, to?)` | 发送通知：飞书开放平台 / QQ / 邮件 / Server酱 / 飞书 webhook / 企业微信 / 钉钉。超长文本按渠道上限自动分条 |
| `plugin_tools(action, …)` | **插件能力索引**：`list` 按分类列出本会话可用的工具（含所属插件、前置条件、典型用法）；`call` 以当前身份连续调用 1-8 个工具，支持 `$N.field` 引用上一步返回值 |
| `whale_check()` | **自检**：渠道、`$ENV:` 解析、访问控制名单、长连接状态、可注入会话、待回复决策、定时汇报、日志尾 |
| `ask_user_email(question, context?, options?)` | 发邮件提问，回复自动注入会话（决策表落盘，重启后可恢复） |
| `save_memory` / `recall_memory` | 统一记忆库（`$DSH_HOME/memory/`），检索按标题/标签/正文加权 |
| `learn_skill` / `recall_skill` | 知识库（`$DSH_HOME/knowledge/`） |
| `settings` | 对话内改配置；走 `configEditor`，校验后**立即热生效** |
| `friend_mode` | 群友模式：称呼、只读、黑名单、提示词 |
| **飞书/QQ 双向聊天** | 外部消息 → 注入最活跃会话；结果用 `notify(to=…)` 发回原处 |

## 🧩 plugin_tools：让鲸鱼娘会用别的插件

模型默认只能看到「工具名 + 参数」，看不到三件关键的事：**这工具属于哪个插件**、
**要不要前置条件**、**为什么现在用不了**。于是最常见的浪费是：明明装了 SSH/数据库/Office 插件，
它却在教用户手敲命令，或者干脆说「我没有这个能力」。

`plugin_tools` 补上这一层：

```text
# 1. 先看这台机器上有什么（按能力分类，带所属插件与前置条件）
plugin_tools(action: "list")
plugin_tools(action: "list", group: "SSH")        # 只看某一类
plugin_tools(action: "list", keyword: "sql")      # 关键词（工具名/插件名/参数名都能匹配）
plugin_tools(action: "list", include_unavailable: true)  # 连被 restrict 挡掉的也列出来，并说明原因

# 2. 需要「先准备再执行」时，一次跑完
plugin_tools(action: "call", steps: [
  { tool: "db_connect", arguments: "{\"type\":\"mysql\",\"host\":\"127.0.0.1\",\"username\":\"u\",\"password\":\"p\"}" },
  { tool: "db_query",   arguments: "{\"sql\":\"select 1\",\"db_connection_id\":\"$0.db_connection_id\"}" }
])
```

**`$N.field` 引用**：第 N 步（0 起）的**规范返回值**，不必让模型从渲染文本里再抠一次。
支持嵌套路径（`$0.data.id`）与数组下标（`$0.items[0].id`）；数字/布尔保持原类型。
引用不存在时会明确报「可用字段有哪些」。

**安全边界（代码硬约束，不靠提示词）**：

| 约束 | 行为 |
| --- | --- |
| 只能调用本会话可见的工具 | 不可见 → 直接说明原因（插件没装 / 没启用 / 被 restrict 挡掉） |
| 不能调用自己 | 拒绝，防无限递归 |
| 嵌套深度 | 上限 4 层，超出拒绝 |
| 批量上限 | 一次最多 8 步，超出报错而不是静默截断 |
| 审批与沙箱 | **完全复用** `ctx.tools.execute`：`tools/pre-execute`（含审批）、单调 guard、超时/重试包装器全都照常生效 |
| 取消 | 子调用继承调用方的 `signal`，外层中断时一起取消 |
| 输出体积 | 单个工具结果超过 12000 字自动截断并注明 |

失败语义也是显式的：默认遇错即停，并在结果里写明「第 N 步起未执行」以及怎么改成继续
（`stop_on_error: false`）；参数不是合法 JSON 时给出解析位置而不是抛异常。

## v0.3.0 修掉的问题

| 问题 | 现象 | 现在 |
| --- | --- | --- |
| 白名单从不展开 `$ENV:` | `accessControl.mode: whitelist` 下**所有人的消息都被丢弃**，日志只有 `feishu_denied` | 名单先展开变量再比对；全为空时 `whale_check` 明确警告 |
| SMTP/IMAP 不读注册表 | 客户端启动后才设的 `NOTIFY_MAIL_USER` 解析不出来，邮件渠道显示「未配置」 | 所有 `$ENV:` 统一走 `expandEnv`（进程环境 → `HKCU\Environment`） |
| QQ 端口读错字段 | 配置写 `wsPort`，代码读 `config.port` → 永远监听 3001，改配置无效 | 同时接受 `wsPort`/`port`，并在日志/自检里显示实际端口 |
| `settings` 改错文件 | 改的是 0.2.x 已废弃的 preset 目录，写完重启也不生效 | 走 `configEditor.edit()`：schema 校验 + 热重载 |
| 定时汇报重复/漏发 | `daily:09:00` 在 30s 轮询下可能同分钟发两次；休眠错过不补 | 20s 一跳 + 分钟级去重，支持 `at:HH:MM,HH:MM` |
| 长连接卸载不关闭 | `ctx.effect` 捕获启动前的空函数，插件重载后旧连接仍在收信 | disposer 读最新引用；启动失败按指数退避重连 |
| 飞书群 id 写死 | 只认配置的 `chat_id`，私聊/其它群一律忽略 | 私聊始终响应；群聊按配置过滤；`chatTypes` 可配 |
| 消息不按渠道切分 | 超过飞书/企微/钉钉上限直接发送失败 | 按渠道上限切分并标注 `(1/N)` |
| 邮件决策只在内存 | DSH 重启后用户回信无人接收、也没有痕迹 | 决策表落盘，启动时按 sessionId 重绑存活会话 |
| 群友记忆跨群串味 | 所有群的聊天记忆混在一起进提示词 | 记忆按 `groupId` 隔离 |
| 飞书 @ 占位符 | 注入会话里是 `@_user_1` | 用 `mentions` 替换成 `@名字` |

## 安装（DSH 0.2.x profile bundle）

```jsonc
// $DSH_HOME/profiles/<profile>/package.json
{
  "dependencies": {
    "dsh-whale-notify": "file:<仓库路径>/plugins/dsh-whale-notify",
    "@larksuiteoapi/node-sdk": "^1.76.0",
    "imapflow": "^1.7.1",
    "ws": "^8.21.3"
  },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-whale-notify"] } }
}
```

```powershell
cd $env:DSH_HOME\profiles\<profile>; pnpm install
```

配置在插件自己的 `cordis.patch.yml`（唯一来源），**不**要再在 preset 里声明 `tool-notify`。

## 结构

```text
lib/
├── index.js       # 工具注册、消息注入、定时任务编排
├── config.js      # $ENV: 展开、渠道规范化、访问控制、文本切分
├── channels.js    # 各渠道最后一步发送
├── scheduler.js   # 定时汇报到点判定（分钟级去重）
├── registry.js    # 插件能力索引 + 跨插件工具调用（plugin_tools 的后端）
├── feishu.js      # 飞书开放平台（官方 WSClient）
├── qq.js          # OneBot 发送 + 反向 WS 接收
├── imap.js        # IMAP 轮询与回复解析
├── smtp.js        # 手写 SMTP 客户端
├── ask.js         # 邮件决策闭环（落盘恢复）
├── memory.js      # 统一记忆库
├── knowledge.js   # 知识库
└── friendmode.js  # 群友模式
```

## `$ENV:` 解析

先查进程环境，查不到时回退读 Windows 用户环境变量注册表（`HKCU\Environment`）。
`whale_check` 会逐条列出引用、变量名、来源（进程/注册表/未设置）。

## 故障排查

1. 跑 `whale_check`：
   - 渠道那一行显示的是「已配置 / 未配置 / 缺哪个字段」；
   - `$ENV:` 段显示变量到底有没有解析到；
   - 访问控制段显示**展开后**的白名单；
   - 「可注入的会话」为 0 → 外部消息必定注入失败（客户端里要开着会话）。
2. 飞书「发了没反应」：看长连接状态与事件数；`up` 但事件数长期 0 → 后台订阅方式不是「使用长连接接收事件」。
3. QQ「没反应」：看接收端状态与连接次数；0 次 → NapCat 的反向 WS 没指向该端口。
4. 注入失败会落日志：`feishu_in_failed` / `qq_in_failed` / `friend_in_failed`，写明原因。
