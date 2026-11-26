/**
 * Cost projection math.
 *
 * The chart is cumulative spend over a day window: the real line adds the
 * provider's daily cost on top of a user-informed baseline (`already spent`),
 * and the projection continues from the last real point with the average daily
 * cost of the window as its slope. A horizontal limit line is optional; when
 * the projection crosses it, the caller marks the date.
 *
 * Everything here is pure so the window, the series and the crossing can be
 * tested without a browser. Day boundaries are local (the window follows the
 * user's calendar), and adding days goes through the Date constructor so a DST
 * transition does not shift a boundary by an hour.
 */

const DAY_MS = 86_400_000;

/** One day of the window, in local time. */
export type CostDay = {
  /** Local `YYYY-MM-DD`. */
  date: string;
  /** Local midnight, epoch milliseconds. */
  t: number;
  /** Cost of that day, in USD. */
  cost: number;
};

/** A point of the cumulative (or projected) series. */
export type CostPoint = {
  /** Epoch milliseconds. */
  t: number;
  /** Cumulative cost in USD. */
  value: number;
  /** Local `YYYY-MM-DD` of `t`. */
  date: string;
};

export type DayWindow = {
  /** Oldest day first; exactly the requested count of days. */
  days: CostDay[];
  /** Local midnight of the first day. */
  from: number;
  /** Last millisecond of today. */
  to: number;
};

/** One fetchable slice of the chart's x axis. */
export type CostRange = {
  /** First millisecond of the slice. */
  from: number;
  /** Last millisecond of the slice. */
  to: number;
  /** Slice start, used as the series point. */
  t: number;
  /** Local `YYYY-MM-DD` of `from`. */
  date: string;
};

/**
 * The x axis after a zero mark (`already spent` informed at `spentAt`).
 * `offset` is the spending between the mark and the window, folded into the
 * baseline; `buckets` are consecutive slices from `start` to `end`.
 */
export type CostRangePlan = {
  /** First instant drawn: the mark, or the window start when it is older. */
  start: number;
  /** Last instant drawn (the load's `now`). */
  end: number;
  /** Pre-window slice, when the mark predates the window. */
  offset: CostRange | null;
  /** Consecutive slices from `start` to `end`, split at local midnights. */
  buckets: CostRange[];
};

/** Default window, in days. */
export const COST_WINDOW_DEFAULT = 30;

/** Window sizes offered by the selector. */
export const COST_WINDOW_SIZES = [10, 15, 30] as const;

/** Ceiling for the projection, in days, before the limit counts as unreachable. */
export const COST_PROJECTION_MAX_DAYS = 365;

/** Local midnight of the day containing `t`. */
export function startOfLocalDay(t: number): number {
  const date = new Date(t);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Local `YYYY-MM-DD` of `t`. */
export function dayKey(t: number): string {
  const date = new Date(t);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Adds calendar days to an instant, keeping the local wall-clock time. A DST
 * day is 23 or 25 hours long, so this is not the same as adding `DAY_MS`.
 */
export function addDays(t: number, days: number): number {
  const date = new Date(t);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + Math.trunc(days),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  ).getTime();
}

/**
 * The window ending today: `days` local calendar days, oldest first. A count
 * that is not finite falls back to the default; the result is always between
 * one day and a year.
 */
export function dayWindow(now: number, days: number = COST_WINDOW_DEFAULT): DayWindow {
  const count = Number.isFinite(days)
    ? Math.min(COST_PROJECTION_MAX_DAYS, Math.max(1, Math.floor(days)))
    : COST_WINDOW_DEFAULT;
  const today = startOfLocalDay(now);
  const result: CostDay[] = [];
  for (let offset = count - 1; offset >= 0; offset--) {
    const t = addDays(today, -offset);
    result.push({ date: dayKey(t), t, cost: 0 });
  }
  return { days: result, from: result[0]?.t ?? today, to: addDays(today, 1) - 1 };
}

/**
 * Splits the visible x axis into cost slices. Without a zero mark the axis is
 * the whole day window; with one it starts at the mark (or at the window start,
 * when the mark is older, in which case the spending in between becomes the
 * `offset` folded into the baseline).
 */
export function costRanges(
  now: number,
  days: number = COST_WINDOW_DEFAULT,
  spentAt?: number | null,
): CostRangePlan {
  const window = dayWindow(now, days);
  const windowStart = window.from;
  const reset =
    spentAt !== undefined && spentAt !== null && Number.isFinite(spentAt)
      ? Math.min(Math.max(0, spentAt), now)
      : undefined;

  let start = windowStart;
  let offset: CostRange | null = null;
  if (reset !== undefined) {
    if (reset < windowStart) {
      if (windowStart - 1 >= reset) {
        offset = { from: reset, to: windowStart - 1, t: reset, date: dayKey(reset) };
      }
    } else {
      start = reset;
    }
  }

  const buckets: CostRange[] = [];
  let cursor = start;
  // Guard against a non-progressing cursor (clock skew at a day boundary).
  for (let steps = 0; steps < COST_PROJECTION_MAX_DAYS + 1; steps++) {
    const dayEnd = addDays(startOfLocalDay(cursor), 1) - 1;
    const to = Math.max(cursor, Math.min(dayEnd, now));
    buckets.push({ from: cursor, to, t: cursor, date: dayKey(cursor) });
    if (to >= now) break;
    cursor = to + 1;
  }

  return { start, end: now, offset, buckets };
}

/**
 * Days the daily average divides by: the nominal window without a zero mark,
 * or the elapsed time since the mark (at least one day, so a mark made minutes
 * ago does not produce an infinite daily rate).
 */
export function spanDays(
  now: number,
  start: number,
  days: number,
  hasReset: boolean,
): number {
  if (!hasReset) {
    return Number.isFinite(days) && days > 0 ? days : COST_WINDOW_DEFAULT;
  }
  const elapsed = (now - start) / DAY_MS;
  if (!Number.isFinite(elapsed) || elapsed <= 0) return 1;
  return Math.max(1, elapsed);
}

/**
 * Cumulative series of the window. Each day contributes a point at its start
 * with everything spent before it; a final point at `now` closes today's
 * partial day. The baseline is added to every value but stays out of `total`,
 * so the average daily cost describes the window's own spending.
 */
export function cumulativeSeries(
  days: readonly CostDay[],
  baseline: number,
  now: number,
): { points: CostPoint[]; total: number } {
  const base = Number.isFinite(baseline) && baseline > 0 ? baseline : 0;
  let running = base;
  const points: CostPoint[] = [];
  for (const day of days) {
    points.push({ t: day.t, value: running, date: day.date });
    if (Number.isFinite(day.cost) && day.cost > 0) running += day.cost;
  }
  const total = running - base;
  if (days.length > 0) {
    const last = days[days.length - 1]!;
    const end = Math.max(now, last.t + 1);
    points.push({ t: end, value: running, date: dayKey(end) });
  }
  return { points, total };
}

/** Cost per calendar day of the window; days without spending count as zero. */
export function averageDailyCost(total: number, days: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  if (!Number.isFinite(days) || days <= 0) return 0;
  return total / days;
}

/** Straight projection from `from` to `until` with a constant daily slope. */
export function projectionSeries(
  from: { t: number; value: number },
  perDay: number,
  until: number,
): CostPoint[] {
  if (!Number.isFinite(perDay) || perDay <= 0) return [];
  if (!Number.isFinite(until) || until <= from.t) return [];
  const days = (until - from.t) / DAY_MS;
  return [
    { t: from.t, value: from.value, date: dayKey(from.t) },
    { t: until, value: from.value + perDay * days, date: dayKey(until) },
  ];
}

/**
 * When the projection reaches `limit`, from the current cumulative `current`.
 * `now` means it is already reached; `undefined` means there is no limit, the
 * slope is zero or the crossing is beyond `maxDays`.
 */
export function limitCrossing(
  current: number,
  limit: number | undefined,
  perDay: number,
  now: number,
  maxDays: number = COST_PROJECTION_MAX_DAYS,
): number | undefined {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return undefined;
  if (!Number.isFinite(current)) return undefined;
  if (limit <= current) return now;
  if (!Number.isFinite(perDay) || perDay <= 0) return undefined;
  const days = (limit - current) / perDay;
  if (!Number.isFinite(days) || days > maxDays) return undefined;
  return now + days * DAY_MS;
}

/** Round step for the y axis, in USD. */
const COST_STEPS = [
  0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1_000, 2_000,
  2_500, 5_000, 10_000, 20_000, 50_000, 100_000,
];

/**
 * Stable, round maximum for the cost axis. Follows the series on screen, so it
 * may shrink when the window or the provider changes.
 */
export function costScale(max: number): number {
  const target = Number.isFinite(max) && max > 0 ? max * 1.05 : COST_STEPS[0]!;
  const found = COST_STEPS.find((step) => step >= target);
  if (found !== undefined) return found;
  return Math.ceil(target / 100_000) * 100_000;
}

/** Formats a USD amount for the locale; `undefined` becomes an em dash. */
export function formatCost(value: number | undefined, locale: string, digits = 2): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/** Decimal places that keep the axis labels readable at the given scale. */
export function costAxisDigits(scale: number): number {
  if (!Number.isFinite(scale) || scale < 1) return 2;
  if (scale < 100) return 1;
  return 0;
}

/** Axis label for a cost value, with the precision the scale needs. */
export function formatCostAxis(value: number, locale: string, scale: number): string {
  return formatCost(value, locale, costAxisDigits(scale));
}

/** Short local date (day + month) for the crossing label; add the year when it matters. */
export function formatCostDate(t: number, locale: string, withYear = false): string {
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat(
    locale,
    withYear ? { day: "2-digit", month: "short", year: "numeric" } : { day: "2-digit", month: "short" },
  ).format(new Date(t));
}

/** Date and local time, for the instant the zero mark was set. */
export function formatCostInstant(t: number, locale: string): string {
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(t));
}