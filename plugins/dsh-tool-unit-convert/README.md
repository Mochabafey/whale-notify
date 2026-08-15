# dsh-tool-unit-convert（单位换算）

DeepSeek Harness（DSH）的单位换算工具插件。纯计算、零依赖、不发网络请求。

## 工具

```
unit_convert(value, from, to)
```

支持类别：长度（m, km, cm, mm, um, nm, mi, yd, ft, in, nmi）、质量（kg, g, mg, ug, t, lb, oz, st）、
温度（c, f, k）、数据量（b, kb, mb, gb, tb, pb, kib, mib, gib, tib, bit, kbit, mbit）、
时间（s, ms, min, h, day, week, month, year）、速度（m/s, km/h, mph, knot, ft/s）。
单位不区分大小写，`from`/`to` 必须同类别。

## 安装

1. 将本目录复制到 DSH profile 的 `node_modules`（如 `$DSH_HOME\profiles\node_modules\dsh-tool-unit-convert`）
2. 在 preset 的 `agent.cordis.yml` 加行：

```yaml
- id: tool-unit-convert
  name: 'dsh-tool-unit-convert'
```

## 依赖

- peerDependencies：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`

## 许可

MIT
