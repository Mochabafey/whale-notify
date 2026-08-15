# dsh-whale-notify（鲸鱼通知）

DeepSeek Harness（DSH）的通知、邮件问答与飞书机器人插件。

## 工具

| 工具 | 说明 |
| --- | --- |
| `notify(title, message, channel?, level?, awaitReply?)` | 发送通知：飞书开放平台 / 微信 Server酱 / 飞书 webhook / 企业微信 / 钉钉 / 邮箱。`awaitReply:true` 时邮件可回复指挥 |
| `ask_user_email(question, context?, options?)` | 发邮件向用户提问，回复自动注入会话 |
| **飞书双向聊天** | 飞书里给机器人发消息 → 注入 DSH 会话（长连接接收） |

## 安装

1. 将本目录复制到 DSH profile 的 `node_modules`（如 `$DSH_HOME\profiles\node_modules\dsh-whale-notify`）
2. 安装依赖：`cd <profile 目录> && npm install imapflow @larksuiteoapi/node-sdk`
3. 在 preset 的 `agent.cordis.yml` 加行：

```yaml
- id: tool-notify
  name: 'dsh-whale-notify'
  config:
    smtp:
      host: 'smtp.feishu.cn'
      port: 587
      secure: false
      user: 'your-mailbox@example.com'
      pass: '$ENV:FEISHU_SMTP_PASS'
      from: 'your-mailbox@example.com'
      to: ['you@example.com']
    imap:
      host: 'imap.feishu.cn'
      port: 993
      secure: true
      user: 'your-mailbox@example.com'
      pass: '$ENV:FEISHU_SMTP_PASS'
      mailbox: 'INBOX'
    pollIntervalMs: 30000
```

> 完整配置示例见仓库 `examples/agent.cordis.whale.yml`。密钥一律用 `$ENV:变量名`，勿写明文。

## 依赖

- peerDependencies：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`
- 运行时：`imapflow`（`ask_user_email` 收信）、`@larksuiteoapi/node-sdk`（飞书长连接接收）
- 插件需注入 `timer` 服务（host 层提供）：`inject: ["tools", "timer"]`

## 许可

MIT
