# dsh-whale-notify（鲸鱼通知）

DeepSeek Harness（DSH）的通知、聊天机器人、记忆与学习插件。

> 📚 **完整文档**：
> - 主文档：`whale-notify/README.md`
> - [会话内配置指南](../docs/会话内配置.md)
> - [外部服务配置指南（NapCat/飞书/邮箱）](../docs/外部服务配置.md)

## 工具

| 工具 | 说明 |
| --- | --- |
| `notify(title, message, channel?, level?, awaitReply?)` | 发送通知：飞书开放平台 / 微信 Server酱 / 飞书 webhook / 企业微信 / 钉钉 / 邮箱。`awaitReply:true` 时邮件可回复指挥 |
| `whale_check()` | **自检**：渠道配置、飞书长连接与轮询状态、可注入的会话、最近日志 |
| `ask_user_email(question, context?, options?)` | 发邮件向用户提问，回复自动注入会话 |
| `save_memory` / `recall_memory` | 统一记忆库（`$DSH_HOME/memory/`） |
| `learn_skill` / `recall_skill` | 技能知识库（`$DSH_HOME/knowledge/`） |
| `settings` | 对话内改配置 |
| `friend_mode` | 群友模式 |
| **飞书双向聊天** | 飞书里给机器人发消息 → 注入 DSH 会话（长连接 + 轮询兜底） |

## 安装（DSH 0.2.x profile bundle 形态，推荐）

本插件是 **bundle**：装进 profile 的 `node_modules`，并在 profile 的 `package.json`
里登记为 bundle。它自带的 `cordis.patch.yml` 会插入 `tool-notify` 行与全部渠道配置，
这样**任何 preset 的会话**都能用到（不再依赖是否选了鲸鱼娘 preset）。

```jsonc
// $DSH_HOME/profiles/<profile>/package.json
{
  "dependencies": {
    "dsh-whale-notify": "file:C:/Users/Master/Documents/Deepseek/whale-notify/plugins/dsh-whale-notify",
    "@larksuiteoapi/node-sdk": "^1.73.0",
    "imapflow": "^1.7.1",
    "ws": "^8.21.3"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-whale-notify"     // ← 加上这一行
      ]
    }
  }
}
```

```powershell
cd $env:DSH_HOME\profiles\<profile>
pnpm install          # 用 DSH 客户端自带的 pnpm
```

改完 **重启 DSH 客户端**（bundle 列表在启动时读取）。

### 旧形态（仅 preset 挂载，不推荐）

把本目录复制到 `$DSH_HOME\profiles\node_modules\dsh-whale-notify`，并在 agent preset 的
`agent.cordis.yml` 里加 `- id: tool-notify / name: 'dsh-whale-notify' / config: ...`。
注意：**只有选了这个 preset 的会话**才有这些工具，而且插件依赖必须能解析。

> ⚠️ **踩过的坑（会让整个 preset 从客户端消失）**：agent preset 里的 `name:` 是相对
> **harness 安装目录**解析的，**不是**相对 profile 的 `node_modules`。插件只装在 profile 里、
> preset 里却写了这一行时，内核会把该行标成 broken：
> `row "tool-notify" names a plugin that cannot be resolved: dsh-whale-notify` ——
> 而 **broken 的 preset 会被客户端的模式选择器直接隐藏**，表现就是"我的 preset 不见了"。
> 正确做法：**装成 profile bundle**（见上），或把包真装进 harness 安装目录。
> 自查：`_whale-diag\_preset_check.mjs` 会用内核逻辑扫一遍 preset 并打印 broken 原因。

## 飞书收消息：两条通道

收信曾经只有长连接一条路，它有个隐蔽的坑：

> 开发者后台「事件与回调 → 订阅方式」若不是「使用长连接接收事件」，
> `WSClient` 照样连上并打印 `ws client ready`，但**一条事件都不会来**。
> 现象就是「飞书发消息，DSH 毫无反应」，且日志里什么都没有。

现在两条通路互为兜底：

1. **长连接**（`WSClient`，实时）——唯一收信通道。

> **为什么没有轮询兜底**：早期版本另有一条「轮询」（调 `GET /im/v1/messages` 读会话消息）作为兜底，
> 但它需要额外的 `im:message` 读权限，而且与长连接并存时容易出现**跨重启重放**
> （游标只在轮询路径推进、去重表只在内存里）。实测确认长连接稳定工作后，
> **v0.2.5 起移除了轮询**，收信只走长连接，链路更简单、不再有重放面。
> 若后台订阅失效：`whale_check` 会显示「长连接 up 但事件数长期为 0」，
> 去开发者后台把订阅方式改回「使用长连接接收事件」即可。

保留两个小设施：
- `logs/feishu-seen.json`：已处理消息表（最近 500 条），长连接重连时飞书可能重投事件，靠它去重；
- `logs/feishu-poll-cursor.json`：只记录「最后收到的消息」，作为诊断对照，不参与收信逻辑。

```yaml
feishuBot:
  appId: '$ENV:FEISHU_APP_ID'
  appSecret: '$ENV:FEISHU_APP_SECRET'
  receiveId: '$ENV:FEISHU_CHAT_ID'
  receiveIdType: 'chat_id'
  targetSession: ''          # 留空 = 自动注入最近活跃会话
```

### 需要的飞书权限

| 用途 | 权限 |
| --- | --- |
| 发消息 | `im:message:send_as_bot`（或 `im:message`） |
| **收消息** | 后台订阅方式选「使用长连接接收事件」+ 订阅 `im.message.receive_v1` + 发布版本 |

## `$ENV:` 解析

先查进程环境；**查不到时回退读 Windows 用户环境变量注册表**（`HKCU\Environment`）。
所以刚设置的环境变量不用重启客户端也能生效。

## 故障排查

让 agent 跑 `whale_check`，一次给出：渠道配置、长连接状态（`up` 但事件数长期 0 → 后台没开长连接）、
最后收到的消息时间、可注入的存活会话数（**为 0 时外部消息必定注入失败**——客户端里要开着会话）、
以及 `$DSH_HOME/logs/notify.log` 尾部。

注入失败**会留痕**：日志里出现 `feishu_in_failed` / `qq_in_failed` 等记录并写明原因
（没有存活会话 / targetSession 无效 / followup 抛错）。

## 可选依赖与降级

`imapflow`、`ws`、`@larksuiteoapi/node-sdk` 都是**懒加载**：缺哪个只影响对应功能，
插件照常加载、其余渠道照常工作，并给出明确报错。
