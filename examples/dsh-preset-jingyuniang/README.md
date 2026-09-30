# dsh-preset-jingyuniang（鲸鱼娘模式）

DSH **0.2.x** 的 Agent preset bundle：把「鲸鱼娘」做成模式选择器里可选的一个模式。

## 为什么需要这个包（0.2.0 的架构变化）

DSH **0.1.5** 时代，preset 是 `$DSH_HOME/.agent-presets/<id>/{preset.yml, agent.cordis.yml}`
这样的**目录**，内核会扫描发现。

DSH **0.2.0** 改了：preset 变成 **profile 组合里的声明行**
（`@deepseek-ai/dsh-agent-preset` 的 `config.plugins`），内置 preset 来自
`@deepseek-ai/dsh-web-app/presets/*.patch.yml`。官方文档写得很直接：

> The registry **neither scans directories nor accepts preset paths**.
> A new preset or an override of a shipped one is a **bundle patch**: an `insert`
> of a `@deepseek-ai/dsh-agent-preset` row ... installed into the profile.

所以 `.agent-presets/` 目录在 0.2.0 下**不再被读取**——这就是"我的鲸鱼娘 preset 在客户端里
不见了"的根因。

## 安装

在 profile 的 `package.json` 里登记依赖与 bundle：

```jsonc
{
  "dependencies": {
    "dsh-preset-jingyuniang": "file:C:/Users/Master/Documents/Deepseek/dsh-preset-jingyuniang"
  },
  "dsh": {
    "profile": {
      "bundles": [ "...", "dsh-preset-jingyuniang" ]
    }
  }
}
```

```powershell
cd $env:DSH_HOME\profiles\<profile>
pnpm install
```

**重启客户端**后在模式选择器里选「鲸鱼娘」。

## 内容

`cordis.patch.yml` 以 0.2.0 内置 `standard` preset 为模板（19 个插件一行不差），
只做两处改动：

1. `config.id: standard-units` + 展示名「鲸鱼娘」+ `order: 0`（排在列表最前）；
2. `persona` 的 `prefix` 换成鲸鱼娘人设（形象设定 / 说话风格 / 工作准则 / 回执策略 /
   渠道格式 / 记忆模式 / 对话内配置 / 学习模式）。

**故意不在这里声明 `tool-notify` / `tool-unit-convert`**：这两个插件已经作为 profile bundle
挂载，由它们自己的 `cordis.patch.yml` 带上完整渠道配置。preset 里再写一行同 id 的行会出现
**两个实例**——带配置的那个照常收信，而工具注册表里活下来的可能是没配置的那个，于是
`whale_check` 报「渠道未配置」，看起来像插件坏了。**渠道配置只允许一个来源。**

## ⚠️ `config.id` 永远不要改

会话把自己的 preset 写进 header（`agentPreset` 字段），0.2.0 恢复会话时拿它去注册表查表，
**查不到就整场失败**：

```
resume failed for session "session-…": RemoteError: Unknown agent preset: <id>
```

`standard-units` 是 0.1.5 时代真实存在的 preset 目录名
（`$DSH_HOME/.agent-presets/standard-units/`），所以本机 **24 个历史会话里有 21 个**
header 存的就是这个名字。沿用旧 id，这些会话才能在新客户端里继续打开——把 id 改成
`jingyuniang` 之类的名字，代价就是这 21 个会话全部打不开。

### 万一已经改错了 id：怎么救回来

会话的 preset 标识存在**两个地方**，改错 id 后两处都要迁回来，否则照样报
`Unknown agent preset`：

1. **会话文件里的 `agent-preset/selected` 事件**——
   `$DSH_HOME/sessions/**/session[.v3|.v4].jsonl.zstd`（zstd 分帧，要**逐帧**解压改写再重压，
   帧边界和行数必须保持不变）；
2. **客户端侧的投影缓存**——
   `$DSH_HOME/storages/session_projcache/sessions/<session-id>.json` 里的
   `record.rows.agentPreset.val`。

工作区脚本就是干这个的（默认 dry-run，`--apply` 才写盘，写前自动留 `.bak-jingyuniang`）：

```powershell
node C:\Users\Master\Documents\Deepseek\_whale-diag\_fix_jingyuniang.cjs          # 先看会改哪些
node C:\Users\Master\Documents\Deepseek\_whale-diag\_fix_jingyuniang.cjs --apply  # 执行
node C:\Users\Master\Documents\Deepseek\_whale-diag\_verify_jingyuniang_fix.cjs   # 校验（帧数/行数不变、只有那一处值变化）
```

改完重启客户端。**注意**：只改 header 是没用的——恢复会话时用的是
`agent-preset/selected` 投影，不是 header 里那个初始值。

## 让新会话默认用鲸鱼娘

0.2.0 里 `settings.yaml` 的 `agent-presets.default` **已经不存在了**。默认 preset 由
`agent-preset-registry` 这一行的 `config.default` 决定，在 profile 的 `cordis.patch.yml`
里覆盖（不覆盖就回落到内置 `standard`，也就是**没有鲸鱼娘人设**）：

```yaml
- id: agent-preset-registry
  name: "@deepseek-ai/dsh-agent-preset-registry"
  config:
    default: standard-units
```

改完重启客户端生效；也可以在「设置 → 通用」里直接选默认模式。

## 校验

```powershell
# 静态验收（preset id / 默认 preset / 部署副本 / 历史会话可解析性）
node C:\Users\Master\Documents\Deepseek\_whale-diag\_preset_alias_accept.cjs
```

生成脚本与校验脚本见工作区 `_whale-diag/_gen_preset_bundle.cjs`、`_validate_preset_bundle.cjs`
与 `_preset_alias_accept.cjs`。
