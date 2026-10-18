/**
 * @module dsh-whale-notify/scheduler
 *
 * 定时汇报的最小调度器。
 *
 * 旧实现的 `isDue` 有两条真实缺陷：
 *  1. `daily:09:00` 在每 30 秒一次的轮询里，只要这一分钟内被调用两次就会**重复发送**
 *     （没有「今天已经发过」的记录）；客户端休眠错过后也补不上。
 *  2. `every:N` 用 `minutes % N === 0` 判断，N=7 时会在 :00/:07/:14 触发，
 *     但在 :07 那一分钟里同样可能触发两次。
 *
 * 现在改成「按分钟对齐 + 记住上次触发的分钟」，并把上报/跳过都写进日志，
 * 这样「今天怎么没发」和「怎么发了两条」都能从日志里看出来。
 */

/** Parse `daily:HH:MM` / `every:N` / `at:HH:MM,HH:MM` into a spec object, or undefined. */
export function parseSchedule(spec) {
  const text = String(spec ?? "").trim();
  const daily = /^daily:(\d{1,2}):(\d{2})$/.exec(text);
  if (daily) {
    const hour = Number(daily[1]);
    const minute = Number(daily[2]);
    if (hour > 23 || minute > 59) return undefined;
    return { kind: "daily", hour, minute, text };
  }
  const every = /^every:(\d+)$/.exec(text);
  if (every) {
    const minutes = Number(every[1]);
    if (minutes < 1) return undefined;
    return { kind: "every", minutes, text };
  }
  const at = /^at:([0-9:,]+)$/.exec(text);
  if (at) {
    const times = at[1].split(",").map((item) => {
      const match = /^(\d{1,2}):(\d{2})$/.exec(item.trim());
      return match ? { hour: Number(match[1]), minute: Number(match[2]) } : undefined;
    });
    if (times.some((item) => item === undefined || item.hour > 23 || item.minute > 59)) return undefined;
    return { kind: "at", times, text };
  }
  return undefined;
}

/** Local date key (YYYY-MM-DD) used to dedupe one-per-day schedules. */
function dateKey(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local minute key (YYYY-MM-DDTHH:MM) used to dedupe minute-based schedules. */
function minuteKey(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${dateKey(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Create a scheduler state machine.
 *
 * @param reports - configured report rows: [{ name, channel, schedule, text }].
 * @param fire - async (report) => void.
 * @param opts - { log?, now? }.
 * @returns { tick, describe }
 */
export function createReportScheduler(reports, fire, opts = {}) {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  /** Last minute in which a report was fired: name → minute key. */
  const lastFired = new Map();
  /** Reports whose schedule spec is invalid, reported once. */
  const invalid = new Map();

  const rows = reports.map((report, index) => {
    const spec = parseSchedule(report?.schedule);
    const row = {
      report,
      index,
      spec,
      name: String(report?.name ?? `report-${index + 1}`),
      channel: String(report?.channel ?? ""),
      text: String(report?.text ?? ""),
    };
    if (spec === undefined) {
      invalid.set(row.name, String(report?.schedule ?? ""));
      log({ kind: "report_schedule_invalid", name: row.name, schedule: String(report?.schedule ?? "") });
    }
    return row;
  });

  /** Whether this report is due at `date`, given it has not fired this minute. */
  const isDue = (row, date) => {
    const spec = row.spec;
    if (spec === undefined) return false;
    if (lastFired.get(row.name) === minuteKey(date)) return false;
    if (spec.kind === "daily") {
      return date.getHours() === spec.hour && date.getMinutes() === spec.minute;
    }
    if (spec.kind === "at") {
      return spec.times.some((time) => date.getHours() === time.hour && date.getMinutes() === time.minute);
    }
    // every:N —— 按「距当天 0 点过了多少分钟」取模，跨小时也均匀。
    const minutesOfDay = date.getHours() * 60 + date.getMinutes();
    return minutesOfDay % spec.minutes === 0;
  };

  return {
    /** Evaluate every report once; returns the names fired in this tick. */
    async tick() {
      const date = now();
      const fired = [];
      for (const row of rows) {
        if (!isDue(row, date)) continue;
        lastFired.set(row.name, minuteKey(date));
        fired.push(row.name);
        if (row.channel === "") {
          log({ kind: "report_skipped", name: row.name, reason: "未配置 channel" });
          continue;
        }
        try {
          await fire({ name: row.name, channel: row.channel, text: row.text });
        } catch (error) {
          log({
            kind: "report_failed",
            name: row.name,
            channel: row.channel,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return fired;
    },
    /** Human-readable schedule summary for diagnostics. */
    describe() {
      return rows.map((row) => ({
        name: row.name,
        channel: row.channel,
        schedule: row.spec?.text ?? String(row.report?.schedule ?? ""),
        valid: row.spec !== undefined,
        lastFired: lastFired.get(row.name) ?? null,
      }));
    },
    invalidSchedules() {
      return [...invalid.entries()].map(([name, schedule]) => ({ name, schedule }));
    },
  };
}
