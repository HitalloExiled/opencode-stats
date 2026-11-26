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

/** Two instants fall on the same local calendar day, whatever their time. */
export function sameLocalDay(left: number, right: number): boolean {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  const a = new Date(left);
  const b = new Date(right);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** The instant is exactly local midnight — what the date field yields. */
export function isLocalMidnight(t: number): boolean {
  const date = new Date(t);
  return (
    date.getHours() === 0 &&
    date.getMinutes() === 0 &&
    date.getSeconds() === 0 &&
    date.getMilliseconds() === 0
  );
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

/**
 * A change the user typed into `already spent`, kept at the instant it happened.
 * `spent` already includes every one of them, so the baseline at the zero mark is
 * `spent - sum(deltas)`; the chart draws each delta as a step, which is how an
 * external cost (or a correction downwards) enters the measured history without
 * rewriting it.
 */
export type CostAdjustment = {
  /** Epoch milliseconds of the edit. */
  at: number;
  /** Signed change in USD: positive adds external cost, negative removes it. */
  delta: number;
  /**
   * The measured curve's value at `at`, as the card showed it when the edit was
   * saved. It places the step at the right height even when the series has no
   * point at that instant (a day is a single slice), so the typed total lands
   * exactly where the user saw it instead of dropping to the cycle baseline.
   * Older edits lack it and fall back to the interpolated curve.
   */
  seen?: number | null;
};

/** Net external change already folded into the informed `spent`. */
export function adjustmentTotal(adjustments: readonly CostAdjustment[] | undefined): number {
  if (!adjustments || adjustments.length === 0) return 0;
  let sum = 0;
  for (const item of adjustments) {
    if (Number.isFinite(item.delta)) sum += item.delta;
  }
  return sum;
}

/** The baseline as it was at the zero mark: the informed total minus later edits. */
export function baselineAtMark(
  spent: number | undefined,
  adjustments: readonly CostAdjustment[] | undefined,
): number {
  const total = spent !== undefined && Number.isFinite(spent) ? spent : 0;
  const base = total - adjustmentTotal(adjustments);
  return Number.isFinite(base) ? base : 0;
}

/**
 * The cycle as the gateway reports it. `base` is the key spend captured when
 * the credits were topped up; the card draws `spend - base`. A changed
 * `budget_reset_at` (or a spend below the base) means the gateway window reset:
 * the base is dropped, so the cycle restarts at `spend`.
 */
export type GatewayCycle = {
  /** Spend inside the cycle, in USD. */
  spent: number;
  /** Budget of the cycle, in USD; `undefined` when the key has no limit. */
  limit: number | undefined;
  /** Baseline currently applied (0 after a reset). */
  base: number;
  /** The gateway window reset since the top-up. */
  reset: boolean;
};

/**
 * Folds the captured base into the gateway's spend. `budget` is the key's
 * `max_budget`; the cycle's limit is what is left from the base, or the whole
 * budget after a reset. Returns `undefined` when the spend is not usable.
 */
export function gatewayCycle(
  spend: number | undefined,
  budget: number | null | undefined,
  resetsAt: number | null | undefined,
  base: number | null | undefined,
  baseResetsAt: number | null | undefined,
): GatewayCycle | undefined {
  if (spend === undefined || !Number.isFinite(spend) || spend < 0) return undefined;
  const safeBase =
    base !== undefined && base !== null && Number.isFinite(base) && base >= 0 ? base : 0;
  const previousReset =
    baseResetsAt !== undefined && baseResetsAt !== null && Number.isFinite(baseResetsAt)
      ? baseResetsAt
      : null;
  const resetAt =
    resetsAt !== undefined && resetsAt !== null && Number.isFinite(resetsAt) ? resetsAt : null;
  const reset =
    (previousReset !== null && resetAt !== null && resetAt !== previousReset) ||
    spend < safeBase;
  const applied = reset ? 0 : safeBase;
  const cap =
    budget !== undefined && budget !== null && Number.isFinite(budget) && budget > 0
      ? budget
      : undefined;
  return {
    spent: Math.max(0, spend - applied),
    limit: cap === undefined ? undefined : Math.max(0, reset ? cap : cap - applied),
    base: applied,
    reset,
  };
}

/**
 * Folds the external changes into a cumulative series. Each change adds a step at
 * its instant: a flat run to the edit, a vertical move, then the measured curve
 * resumes with the new level. Changes at or before the first point are already
 * part of its value, so only the offset is applied. The result keeps ascending
 * `t` (duplicates at the step are intentional) and never moves the values before
 * an edit.
 */
export function applyCostAdjustments(
  points: readonly CostPoint[],
  adjustments: readonly CostAdjustment[] | undefined,
): CostPoint[] {
  const source = points.map((point) => ({ ...point }));
  if (source.length === 0) return source;
  const list = (adjustments ?? [])
    .filter(
      (item) =>
        Number.isFinite(item.at) && Number.isFinite(item.delta) && item.delta !== 0,
    )
    .sort((left, right) => left.at - right.at);
  if (list.length === 0) return source;

  const start = source[0]!.t;

  const merged: CostPoint[] = [];
  let carried = 0;
  let cursor = 0;

  /**
   * Draws one step: a flat run up to the edit at the height the card showed,
   * then the vertical move and the new level. `seen` (saved with the edit) is
   * the exact drawn value, so the step lands where the user saw it; an edit from
   * before that field existed keeps the previous point's height.
   */
  const pushStep = (item: CostAdjustment, fallback: number): void => {
    const seen = item.seen;
    const before =
      seen !== undefined && seen !== null && Number.isFinite(seen)
        ? seen + carried
        : fallback;
    merged.push({ t: item.at, value: before, date: dayKey(item.at) });
    merged.push({ t: item.at, value: before + item.delta, date: dayKey(item.at) });
    carried += item.delta;
  };

  for (const point of source) {
    while (cursor < list.length && list[cursor]!.at <= point.t) {
      const item = list[cursor++]!;
      // A step before the first point only shifts the baseline.
      if (item.at <= start) {
        carried += item.delta;
        continue;
      }
      pushStep(item, merged[merged.length - 1]?.value ?? point.value + carried);
    }
    merged.push({ ...point, value: point.value + carried });
  }

  // Steps after the last measured point still move the total (a save happens
  // after the data was fetched): extend the series with a flat run to each one
  // and the jump at its instant, so the card reflects the edit immediately.
  while (cursor < list.length) {
    const item = list[cursor++]!;
    pushStep(item, merged[merged.length - 1]?.value ?? 0);
  }
  return merged;
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

/**
 * Money for an amount typed with precision: at least two decimals, at most
 * four (what `parseMoney` accepts), so `3.2345` keeps its digits instead of
 * being shown as `3.23`.
 */
export function formatCostValue(value: number | undefined, locale: string): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
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

/** Axis step of the percentage mode, in points. */
const PERCENT_STEP = 50;

/** Minimum top of the percentage axis, so the 100% limit line has headroom. */
const PERCENT_MIN_MAX = 150;

/** Cost as a percentage of `limit`; zero when the limit is not usable. */
export function percentOf(value: number, limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return 0;
  if (!Number.isFinite(value)) return 0;
  return (value / limit) * 100;
}

/**
 * Round top and gridlines for the percentage axis: multiples of 50 with a 150%
 * minimum, mirroring the reference chart (0/50/100/150).
 */
export function percentScale(max: number): { max: number; ticks: number[] } {
  const target =
    Number.isFinite(max) && max > 0 ? Math.max(max, PERCENT_MIN_MAX) : PERCENT_MIN_MAX;
  const top = Math.ceil(target / PERCENT_STEP) * PERCENT_STEP;
  const ticks: number[] = [];
  for (let tick = 0; tick <= top; tick += PERCENT_STEP) ticks.push(tick);
  return { max: top, ticks };
}

/** One date label on the x axis. */
export type CostTick = {
  /** Epoch milliseconds. */
  t: number;
  /** Today, the first checkpoint. */
  current: boolean;
  /** The date the forecast reaches the limit. */
  hit: boolean;
};

/** Days between the forecast checkpoints. */
export const COST_TICK_DAYS = 10;

/** A date checkpoint already mapped into plot pixels. */
export type CostCheckpoint = {
  /** Pixel position on the x axis. */
  x: number;
  /** Label shown in the axis strip. */
  label: string;
  /** Today, the first checkpoint. */
  current: boolean;
  /** The date the forecast reaches the limit. */
  hit: boolean;
};

/**
 * Drops checkpoints that would collide at the current width. The hit date wins
 * over today and both win over an earlier checkpoint, so the date the budget
 * ends is never the one that disappears.
 */
export function fitCheckpoints(
  list: readonly CostCheckpoint[],
  minGap = 26,
): CostCheckpoint[] {
  const rank = (tick: CostCheckpoint): number => (tick.hit ? 2 : tick.current ? 1 : 0);
  const kept: CostCheckpoint[] = [];
  for (const tick of list) {
    const previous = kept[kept.length - 1];
    if (previous && Math.abs(tick.x - previous.x) < minGap) {
      if (rank(tick) > rank(previous)) kept[kept.length - 1] = tick;
      continue;
    }
    kept.push(tick);
  }
  return kept;
}

/**
 * Date labels for the axis: today first, then one every `stepDays` into the
 * forecast, and the date the budget ends last. Checkpoints that would sit on or
 * past the hit are dropped so the hit is the closing label; the chart then
 * drops any that would collide at the current width.
 */
export function forecastTicks(
  now: number,
  end: number,
  hit?: number,
  stepDays: number = COST_TICK_DAYS,
): CostTick[] {
  if (!Number.isFinite(now)) return [];
  const reached = hit !== undefined && Number.isFinite(hit) && hit <= now;
  const ticks: CostTick[] = [{ t: now, current: true, hit: reached }];
  if (reached) return ticks;

  const step = Math.max(1, stepDays) * DAY_MS;
  const stop =
    hit !== undefined && Number.isFinite(hit)
      ? hit
      : Number.isFinite(end) && end > now
        ? end
        : now;
  for (let t = now + step; t <= stop; t += step) {
    if (hit !== undefined && t >= hit) break;
    ticks.push({ t, current: false, hit: false });
  }
  if (hit !== undefined && Number.isFinite(hit) && hit > now) {
    ticks.push({ t: hit, current: false, hit: true });
  }
  return ticks;
}

/** A point already mapped into plot space. */
export type PlotPoint = { x: number; y: number };

const scaled = (value: number): string => (Number.isFinite(value) ? value.toFixed(2) : "0");

/**
 * Monotone cubic (Fritsch–Carlson) path through the points: it touches every
 * point, keeps the direction of the data and never overshoots, so the smoothed
 * line cannot suggest spending between two days that did not happen. Zero-width
 * segments (a mark made minutes ago) degrade to a straight jump.
 */
export function monotoneCurve(points: readonly PlotPoint[]): string {
  const count = points.length;
  const first = points[0];
  if (!first) return "";
  if (count === 1) return `M${scaled(first.x)} ${scaled(first.y)}`;
  if (count === 2) {
    const last = points[1]!;
    return `M${scaled(first.x)} ${scaled(first.y)}L${scaled(last.x)} ${scaled(last.y)}`;
  }

  const widths: number[] = [];
  const slopes: number[] = [];
  for (let index = 0; index < count - 1; index++) {
    const left = points[index]!;
    const right = points[index + 1]!;
    const width = right.x - left.x;
    widths.push(width);
    slopes.push(width > 0 ? (right.y - left.y) / width : 0);
  }

  const tangent: number[] = new Array(count);
  tangent[0] = slopes[0]!;
  tangent[count - 1] = slopes[count - 2]!;
  for (let index = 1; index < count - 1; index++) {
    const before = slopes[index - 1]!;
    const after = slopes[index]!;
    tangent[index] = before * after <= 0 ? 0 : (before + after) / 2;
  }
  // Fritsch–Carlson: shrink the tangents that would overshoot the segment.
  for (let index = 0; index < count - 1; index++) {
    const delta = slopes[index]!;
    if (delta === 0) {
      tangent[index] = 0;
      tangent[index + 1] = 0;
      continue;
    }
    const left = tangent[index]! / delta;
    const right = tangent[index + 1]! / delta;
    const magnitude = left * left + right * right;
    if (magnitude > 9) {
      const shrink = 3 / Math.sqrt(magnitude);
      tangent[index] = shrink * left * delta;
      tangent[index + 1] = shrink * right * delta;
    }
  }

  let path = `M${scaled(first.x)} ${scaled(first.y)}`;
  for (let index = 0; index < count - 1; index++) {
    const width = widths[index]!;
    if (!(width > 0)) continue;
    const left = points[index]!;
    const right = points[index + 1]!;
    const third = width / 3;
    path += `C${scaled(left.x + third)} ${scaled(left.y + tangent[index]! * third)}`;
    path += ` ${scaled(right.x - third)} ${scaled(right.y - tangent[index + 1]! * third)}`;
    path += ` ${scaled(right.x)} ${scaled(right.y)}`;
  }
  return path;
}

/** Locale-aware percentage from a ratio (0.035 → "3,5%"). */
export function formatPercent(ratio: number, locale: string): string {
  if (!Number.isFinite(ratio)) return "—";
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(ratio);
}

/** Furthest the axis may reach past the crossing, in days. */
export const COST_AXIS_MAX_DAYS = 90;

/** Stretch drawn past today when no crossing is in reach, in days. */
export const COST_FUTURE_DAYS = 30;

/** Padding drawn past the crossing, so the line visibly passes the limit. */
const COST_CROSS_PAD_DAYS = 3;

/**
 * End of the drawn axis: a little past the limit crossing, capped at 90 days
 * from now. Without a crossing in reach — no limit, no spending, or a date too
 * far away — it falls back to a fixed 30-day future, so the forecast never
 * stretches the axis to a year.
 */
export function axisEnd(
  current: number,
  limit: number | undefined,
  average: number,
  now: number,
): number {
  const fallback = now + COST_FUTURE_DAYS * DAY_MS;
  const cross = limitCrossing(current, limit, average, now, COST_AXIS_MAX_DAYS);
  if (cross === undefined) return fallback;
  return Math.min(
    cross + COST_CROSS_PAD_DAYS * DAY_MS,
    now + COST_AXIS_MAX_DAYS * DAY_MS,
  );
}

/**
 * Start of the measured stretch: the informed recharge (or the old zero mark),
 * never later than `now` and never further back than 90 days — past that the
 * daily slices would be more than the cache holds.
 */
export function clampStart(start: number | null | undefined, now: number): number | undefined {
  if (start === null || start === undefined || !Number.isFinite(start)) return undefined;
  const capped = Math.min(start, now);
  return Math.max(capped, now - COST_AXIS_MAX_DAYS * DAY_MS);
}

/** Result of reading a money field: `null` means "not informed". */
export type MoneyParse = { ok: true; value: number | null } | { ok: false };

/** Up to four decimals, one separator; `1.234,56` and `1,234.56` both read. */
const MONEY_SHAPE = /^\d+(?:\.\d{1,4})?$/;

/**
 * Parses an amount typed into the config modal. Accepts a comma or a dot as the
 * decimal separator (the later one wins when both appear), an optional
 * `R$`/`US$` prefix and surrounding spaces; an empty field is "not informed".
 * Thousands separators are only understood when both kinds appear.
 */
export function parseMoney(raw: string): MoneyParse {
  let text = raw.replace(/[\s\u00a0]/g, "").replace(/^(?:R|US)\$/i, "");
  if (text === "") return { ok: true, value: null };

  const comma = text.lastIndexOf(",");
  const dot = text.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    const decimal = Math.max(comma, dot);
    const thousands = decimal === comma ? "." : ",";
    text = text.split(thousands).join("");
    if (decimal === comma) text = text.replace(",", ".");
  } else if (comma >= 0) {
    text = text.replace(",", ".");
  }

  if (text.indexOf(".") !== text.lastIndexOf(".")) return { ok: false };
  if (!MONEY_SHAPE.test(text)) return { ok: false };
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return { ok: false };
  return { ok: true, value };
}

/** Result of reading the recharge date: `null` means "not informed". */
export type DateParse =
  | { ok: true; value: number | null }
  | { ok: false; reason: "invalid" | "future" };

/** `dd/mm`, `dd/mm/aaaa` (also `-`/`.`) and ISO `aaaa-mm-dd`. */
const DATE_SHAPE = /^(\d{1,4})[/.-](\d{1,2})(?:[/.-](\d{1,4}))?$/;

/** Local midnight of a calendar day, or `undefined` when the day does not exist. */
function localMidnight(year: number, month: number, day: number): number | undefined {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return undefined;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  // Noon avoids the DST-at-midnight corner where the wall clock has no 00:00.
  const noon = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (
    noon.getFullYear() !== year ||
    noon.getMonth() !== month - 1 ||
    noon.getDate() !== day
  ) {
    return undefined;
  }
  return startOfLocalDay(noon.getTime());
}

/**
 * Parses the date the credits were last topped up. A `dd/mm` without a year
 * means the most recent occurrence that is not in the future; a date after
 * `now` is rejected instead of being silently moved.
 */
export function parseRechargeDate(raw: string, now: number): DateParse {
  const text = raw.trim();
  if (text === "") return { ok: true, value: null };
  const match = DATE_SHAPE.exec(text);
  if (!match) return { ok: false, reason: "invalid" };
  const [, first, second, third] = match;
  let day: number;
  let month: number;
  let year: number;
  if (first!.length === 4) {
    if (!third) return { ok: false, reason: "invalid" };
    year = Number(first);
    month = Number(second);
    day = Number(third);
  } else {
    day = Number(first);
    month = Number(second);
    if (third) {
      year = Number(third);
    } else {
      const current = new Date(now).getFullYear();
      const thisYear = localMidnight(current, month, day);
      year = thisYear !== undefined && thisYear <= now ? current : current - 1;
    }
  }
  if (year < 1970 || year > 9999) return { ok: false, reason: "invalid" };
  const value = localMidnight(year, month, day);
  if (value === undefined) return { ok: false, reason: "invalid" };
  if (value > now) return { ok: false, reason: "future" };
  return { ok: true, value };
}

/** Locale date with the year, for the card subtitle and the recap line. */
export function formatRechargeDate(t: number, locale: string): string {
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(t));
}

/** What the config modal edits, as typed. */
export type CostDraft = {
  limit: string;
  spent: string;
  lastRecharge: string;
  window: number;
};

/** Config field that can fail validation. */
export type CostField = "limit" | "spent" | "lastRecharge";

/** Why a field failed, so the modal can translate the message. */
export type CostFieldError = "invalidMoney" | "invalidDate" | "futureDate";

/** Validated config, ready for a single atomic write. */
export type CostConfig = {
  limit: number | null;
  spent: number | null;
  lastRecharge: number | null;
  window: number;
};

export type CostConfigResult =
  | { ok: true; value: CostConfig }
  | { ok: false; errors: Partial<Record<CostField, CostFieldError>> };

/**
 * Reads every field of the config modal at once. Nothing is written unless all
 * of them pass, so a half-typed date never reaches the store.
 */
export function validateCostConfig(draft: CostDraft, now: number): CostConfigResult {
  const errors: Partial<Record<CostField, CostFieldError>> = {};
  const limit = parseMoney(draft.limit);
  if (!limit.ok) errors.limit = "invalidMoney";
  const spent = parseMoney(draft.spent);
  if (!spent.ok) errors.spent = "invalidMoney";
  const recharge = parseRechargeDate(draft.lastRecharge, now);
  if (!recharge.ok) {
    errors.lastRecharge = recharge.reason === "future" ? "futureDate" : "invalidDate";
  }
  if (!limit.ok || !spent.ok || !recharge.ok) return { ok: false, errors };

  const window = (COST_WINDOW_SIZES as readonly number[]).includes(draft.window)
    ? draft.window
    : COST_WINDOW_DEFAULT;
  return {
    ok: true,
    value: {
      limit: limit.value,
      spent: spent.value,
      lastRecharge: recharge.value,
      window,
    },
  };
}