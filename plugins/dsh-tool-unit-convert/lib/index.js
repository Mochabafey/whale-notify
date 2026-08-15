import { defineTool } from "@deepseek-ai/dsh-tools";

/**
 * @module dsh-tool-unit-convert
 *
 * Model-facing `unit_convert` tool. Converts a numeric value between units
 * within one of six categories (length / mass / temperature / data / time /
 * speed). Pure computation — no files, no network, no host services beyond
 * the tool registry. Registered on `ctx.tools` exactly like the shipped
 * `@deepseek-ai/dsh-tool-*` plugins.
 */

const name = "tool-unit-convert";
const inject = ["tools"];

/** Linear-factor unit tables; base unit per category has factor 1. */
const LINEAR_CATEGORIES = {
  length: {
    m: 1, km: 1000, cm: 0.01, mm: 0.001, um: 1e-6, nm: 1e-9,
    mi: 1609.344, yd: 0.9144, ft: 0.3048, in: 0.0254, nmi: 1852,
  },
  mass: {
    kg: 1, g: 0.001, mg: 1e-6, ug: 1e-9, t: 1000, lb: 0.45359237,
    oz: 0.028349523125, st: 6.35029318,
  },
  data: {
    b: 1, kb: 1000, mb: 1e6, gb: 1e9, tb: 1e12, pb: 1e15,
    kib: 1024, mib: 1048576, gib: 1073741824, tib: 1099511627776,
    bit: 0.125, kbit: 125, mbit: 125000,
  },
  time: {
    s: 1, ms: 0.001, min: 60, h: 3600, day: 86400, week: 604800,
    month: 2629800, year: 31557600,
  },
  speed: {
    "m/s": 1, "km/h": 1 / 3.6, "mph": 0.44704, knot: 0.5144444444444445,
    "ft/s": 0.3048,
  },
};

/** Affine units: value = slope * base + intercept (in base-unit terms). */
const AFFINE_CATEGORIES = {
  temperature: {
    c: { slope: 1, intercept: 0, base: "c", labels: ["c", "celsius", "°c"] },
    f: { slope: 9 / 5, intercept: 32, base: "c", labels: ["f", "fahrenheit", "°f"] },
    k: { slope: 1, intercept: 273.15, base: "c", labels: ["k", "kelvin"] },
  },
};

/** Normalize a unit alias to its canonical key, or undefined if unknown. */
function normalizeUnit(category, raw) {
  const value = String(raw).trim().toLowerCase();
  if (category === "temperature") {
    const table = AFFINE_CATEGORIES.temperature;
    for (const key of Object.keys(table)) {
      if (table[key].labels.includes(value)) return key;
    }
    return undefined;
  }
  const table = LINEAR_CATEGORIES[category];
  if (Object.hasOwn(table, value)) return value;
  return undefined;
}

/** Resolve the category a unit token belongs to, or undefined. */
function categoryOf(raw) {
  const value = String(raw).trim().toLowerCase();
  for (const category of Object.keys(LINEAR_CATEGORIES)) {
    if (normalizeUnit(category, value) !== undefined) return category;
  }
  if (normalizeUnit("temperature", value) !== undefined) return "temperature";
  return undefined;
}

/** Convert via the shared base unit, keeping full float precision. */
function convert(category, value, fromKey, toKey) {
  if (category === "temperature") {
    const table = AFFINE_CATEGORIES.temperature;
    const from = table[fromKey];
    const to = table[toKey];
    // base (celsius): v = slope * base + intercept  =>  base = (v - intercept) / slope
    const base = (value - from.intercept) / from.slope;
    return base * to.slope + to.intercept;
  }
  const table = LINEAR_CATEGORIES[category];
  const base = value * table[fromKey];
  return base / table[toKey];
}

/** Format a finite number with sensible precision, stripping float noise. */
function formatNumber(value) {
  if (!Number.isFinite(value)) throw new Error(`conversion produced a non-finite value (${value})`);
  if (value === 0) return "0";
  const abs = Math.abs(value);
  let digits = 12;
  if (abs >= 1e12 || abs < 1e-6) digits = 6;
  else if (abs >= 1e6) digits = 8;
  const rounded = Number(value.toPrecision(digits));
  // Drop trailing zeros after the decimal point.
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function apply(ctx) {
  ctx.tools.register(defineTool({
    name: "unit_convert",
    description:
      "在同一类别内进行单位换算。支持的类别和单位：" +
      "长度（m, km, cm, mm, um, nm, mi, yd, ft, in, nmi）、" +
      "质量（kg, g, mg, ug, t, lb, oz, st）、温度（c, f, k）、" +
      "数据量（b, kb, mb, gb, tb, pb, kib, mib, gib, tib, bit, kbit, mbit）、" +
      "时间（s, ms, min, h, day, week, month, year）、速度（m/s, km/h, mph, knot, ft/s）。" +
      "单位不区分大小写。",
    parameters: {
      value: {
        type: "number",
        required: true,
        description: "要换算的数值。",
      },
      from: {
        type: "string",
        required: true,
        description: "原单位，例如 \"km\" 或 \"f\"。",
      },
      to: {
        type: "string",
        required: true,
        description: "目标单位，例如 \"mi\" 或 \"c\"。",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          category: { type: "string", required: true },
          from: { type: "string", required: true },
          to: { type: "string", required: true },
          value: { type: "number", required: true },
          result: { type: "number", required: true },
          display: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: value.display,
      }],
    },
    execute(args) {
      const fromCategory = categoryOf(args.from);
      const toCategory = categoryOf(args.to);
      if (fromCategory === undefined || toCategory === undefined) {
        const unknown = [args.from, args.to].filter((unit) => categoryOf(unit) === undefined);
        throw new Error(`未知单位：${unknown.join(", ")}（支持的单位见工具说明）`);
      }
      if (fromCategory !== toCategory) {
        throw new Error(`无法换算：${JSON.stringify(args.from)}（${fromCategory}）→ ${JSON.stringify(args.to)}（${toCategory}），两个单位必须属于同一类别`);
      }
      const fromKey = normalizeUnit(fromCategory, args.from);
      const toKey = normalizeUnit(toCategory, args.to);
      const result = convert(fromCategory, args.value, fromKey, toKey);
      const display = `${formatNumber(args.value)} ${fromKey} = ${formatNumber(result)} ${toKey}`;
      return Promise.resolve({
        category: fromCategory,
        from: fromKey,
        to: toKey,
        value: args.value,
        result,
        display,
      });
    },
    presentCall: (args) => ({
      card: "generic",
      title: "Convert units",
      kind: "other",
      rawInput: `${args.value} ${args.from} → ${args.to}`,
    }),
  }));
}

export { apply, inject, name };
