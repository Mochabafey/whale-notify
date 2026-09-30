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
只做三处改动：

1. `id: jingyuniang` + 展示名「鲸鱼娘」+ `order: 0`（排在列表最前）；
2. `persona` 的 `prefix` 换成鲸鱼娘人设（形象设定 / 说话风格 / 工作准则 / 回执策略 /
   渠道格式 / 记忆模式 / 对话内配置 / 学习模式）；
3. 追加 `- id: tool-notify / name: 'dsh-whale-notify'`，让这个模式一定带鲸鱼通知工具
   （渠道配置在 `dsh-whale-notify` 自己的 `cordis.patch.yml` 里，单一数据源）。

`unit_convert` 不在这里声明——它由 `dsh-tool-unit-convert` 的 profile bundle 全局注册。

## 校验

```powershell
# 组合树里应出现 preset-jingyuniang 行
dsh --profile <profile> --dump-config
```

生成脚本与校验脚本见工作区 `_whale-diag/_gen_preset_bundle.cjs` 与 `_validate_preset_bundle.cjs`。
