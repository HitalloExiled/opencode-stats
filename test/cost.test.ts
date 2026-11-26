/**
 * Cost projection tests — day window, cumulative series, average, projection,
 * limit crossing, scale and formatting.
 */

import { describe, expect, test } from "bun:test";

import {
  addDays,
  adjustmentTotal,
  applyCostAdjustments,
  averageDailyCost,
  axisEnd,
  baselineAtMark,
  clampStart,
  COST_PROJECTION_MAX_DAYS,
  COST_WINDOW_DEFAULT,
  costAxisDigits,
  costRanges,
  costScale,
  cumulativeSeries,
  dayKey,
  dayWindow,
  fitCheckpoints,
  forecastTicks,
  formatCost,
  formatCostAxis,
  formatCostDate,
  formatCostInstant,
  formatCostValue,
  formatPercent,
  formatRechargeDate,
  gatewayCycle,
  limitCrossing,
  monotoneCurve,
  parseMoney,
  parseRechargeDate,
  percentOf,
  percentScale,
  projectionSeries,
  spanDays,
  startOfLocalDay,
  validateCostConfig,
  type CostDay,
} from "../src/cost";
import {
  providerDays,
  providerTotals,
} from "../src/gui/cost-source";

const DAY = 86_400_000;
const at = (year: number, month: number, day: number, hour = 12): number =>
  new Date(year, month - 1, day, hour, 0, 0, 0).getTime();

const day = (t: number, cost: number): CostDay => ({ date: dayKey(t), t, cost });

describe("startOfLocalDay / dayKey", () => {
  test("snaps to local midnight", () => {
    const start = startOfLocalDay(at(2026, 11, 26, 18));
    const date = new Date(start);
    expect(date.getHours()).toBe(0);
    expect(date.getMinutes()).toBe(0);
    expect(dayKey(start)).toBe("2026-11-26");
  });

  test("pads month and day", () => {
    expect(dayKey(new Date(2026, 0, 5).getTime())).toBe("2026-01-05");
  });
});

describe("addDays", () => {
  test("crosses month boundaries by calendar day", () => {
    expect(dayKey(addDays(at(2026, 11, 30), 1))).toBe("2026-12-01");
    expect(dayKey(addDays(at(2026, 12, 1), -1))).toBe("2026-11-30");
  });

  test("keeps the local wall-clock time", () => {
    const date = new Date(addDays(at(2026, 11, 26, 18), 2));
    expect(date.getHours()).toBe(18);
    expect(dayKey(date.getTime())).toBe("2026-11-28");
  });
});

describe("dayWindow", () => {
  const now = at(2026, 11, 26, 18);
  const today = startOfLocalDay(now);

  test("returns the requested count, oldest first, ending today", () => {
    const window = dayWindow(now, 30);
    expect(window.days).toHaveLength(30);
    expect(window.days[0]!.date).toBe("2026-10-28");
    expect(window.days[29]!.date).toBe("2026-11-26");
    expect(window.from).toBe(window.days[0]!.t);
    expect(window.to).toBe(addDays(today, 1) - 1);
  });

  test("every day starts at local midnight", () => {
    for (const entry of dayWindow(now, 10).days) {
      expect(new Date(entry.t).getHours()).toBe(0);
    }
  });

  test("clamps invalid counts and defaults a non-finite one", () => {
    expect(dayWindow(now, 0).days).toHaveLength(1);
    expect(dayWindow(now, Number.NaN).days).toHaveLength(COST_WINDOW_DEFAULT);
    expect(dayWindow(now, 400).days).toHaveLength(COST_PROJECTION_MAX_DAYS);
  });
});

describe("cumulativeSeries", () => {
  const now = at(2026, 11, 26, 18);
  const today = startOfLocalDay(now);
  const days = [day(addDays(today, -2), 1), day(addDays(today, -1), 2), day(today, 3)];

  test("adds the baseline and sums each day", () => {
    const series = cumulativeSeries(days, 10, now);
    expect(series.total).toBe(6);
    expect(series.points.map((point) => point.value)).toEqual([10, 11, 13, 16]);
    expect(series.points).toHaveLength(4);
    expect(series.points[3]!.t).toBe(now);
    expect(series.points[3]!.date).toBe("2026-11-26");
  });

  test("starts at zero without a baseline and is monotonic", () => {
    const series = cumulativeSeries(days, 0, now);
    expect(series.points[0]!.value).toBe(0);
    const values = series.points.map((point) => point.value);
    expect(values).toEqual([...values].sort((a, b) => a - b));
  });

  test("ignores invalid costs and an empty window", () => {
    const series = cumulativeSeries(
      [day(addDays(today, -1), Number.NaN), day(today, -5)],
      0,
      now,
    );
    expect(series.total).toBe(0);
    expect(cumulativeSeries([], 5, now)).toEqual({ points: [], total: 0 });
  });
});

describe("baselineAtMark / adjustmentTotal", () => {
  test("the informed total already includes every external change", () => {
    const adjustments = [
      { at: 1_000, delta: 50 },
      { at: 2_000, delta: -20 },
    ];
    expect(adjustmentTotal(adjustments)).toBe(30);
    expect(baselineAtMark(130, adjustments)).toBe(100);
    expect(baselineAtMark(100, [])).toBe(100);
    expect(baselineAtMark(0, adjustments)).toBe(-30);
  });

  test("missing or invalid values do not poison the baseline", () => {
    expect(adjustmentTotal(undefined)).toBe(0);
    expect(adjustmentTotal([{ at: 1, delta: Number.NaN }])).toBe(0);
    expect(baselineAtMark(undefined, [{ at: 1, delta: 10 }])).toBe(-10);
    expect(baselineAtMark(Number.NaN, undefined)).toBe(0);
  });
});

describe("applyCostAdjustments", () => {
  const points = [
    { t: 0, value: 100, date: "d0" },
    { t: 10, value: 120, date: "d1" },
    { t: 20, value: 150, date: "d2" },
  ];

  test("an increase steps up at the edit and lifts the later points", () => {
    const out = applyCostAdjustments(points, [{ at: 5, delta: 50 }]);
    expect(out.map((point) => [point.t, point.value])).toEqual([
      [0, 100],
      [5, 100],
      [5, 150],
      [10, 170],
      [20, 200],
    ]);
  });

  test("a decrease steps down and leaves the history before it untouched", () => {
    const out = applyCostAdjustments(points, [{ at: 5, delta: -30 }]);
    expect(out.map((point) => [point.t, point.value])).toEqual([
      [0, 100],
      [5, 100],
      [5, 70],
      [10, 90],
      [20, 120],
    ]);
  });

  test("changes at or before the first point fold into its value", () => {
    const out = applyCostAdjustments(points, [{ at: -5, delta: 40 }]);
    expect(out.map((point) => point.value)).toEqual([140, 160, 190]);
  });

  test("several signed changes keep their order", () => {
    const out = applyCostAdjustments(points, [
      { at: 15, delta: -20 },
      { at: 5, delta: 50 },
    ]);
    expect(out.map((point) => [point.t, point.value])).toEqual([
      [0, 100],
      [5, 100],
      [5, 150],
      [10, 170],
      [15, 170],
      [15, 150],
      [20, 180],
    ]);
  });

  test("a change after the last point still moves the total", () => {
    // A save happens after the slices were fetched: the step must land.
    const out = applyCostAdjustments(points, [{ at: 30, delta: -50 }]);
    expect(out.map((point) => [point.t, point.value])).toEqual([
      [0, 100],
      [10, 120],
      [20, 150],
      [30, 150],
      [30, 100],
    ]);
  });

  test("the saved `seen` places the step where the card drew it", () => {
    // The card drew 135 at t=15 (between the fetched points), not 120.
    const out = applyCostAdjustments(points, [{ at: 15, delta: -20, seen: 135 }]);
    expect(out.map((point) => [point.t, point.value])).toEqual([
      [0, 100],
      [10, 120],
      [15, 135],
      [15, 115],
      [20, 130],
    ]);
  });

  test("ignores zero, invalid and missing changes", () => {
    expect(applyCostAdjustments(points, undefined).map((point) => point.value)).toEqual([
      100, 120, 150,
    ]);
    expect(
      applyCostAdjustments(points, [
        { at: 5, delta: 0 },
        { at: Number.NaN, delta: 10 },
      ]).map((point) => point.value),
    ).toEqual([100, 120, 150]);
    expect(applyCostAdjustments([], [{ at: 5, delta: 10 }])).toEqual([]);
  });
});

describe("averageDailyCost", () => {
  test("divides by calendar days", () => {
    expect(averageDailyCost(6, 3)).toBe(2);
    expect(averageDailyCost(410, 30)).toBeCloseTo(13.667, 2);
  });

  test("is zero without spending or a window", () => {
    expect(averageDailyCost(0, 30)).toBe(0);
    expect(averageDailyCost(6, 0)).toBe(0);
    expect(averageDailyCost(Number.NaN, 30)).toBe(0);
  });
});

describe("projectionSeries", () => {
  const now = at(2026, 11, 26, 18);

  test("extends with a constant daily slope", () => {
    const points = projectionSeries({ t: now, value: 16 }, 2, addDays(now, 5));
    expect(points).toHaveLength(2);
    expect(points[0]!.value).toBe(16);
    expect(points[1]!.value).toBeCloseTo(26, 5);
  });

  test("is empty without a positive slope or a future end", () => {
    expect(projectionSeries({ t: now, value: 16 }, 0, addDays(now, 5))).toEqual([]);
    expect(projectionSeries({ t: now, value: 16 }, 2, now)).toEqual([]);
  });
});

describe("limitCrossing", () => {
  const now = at(2026, 11, 26, 18);

  test("returns the crossing instant", () => {
    expect(limitCrossing(16, 30, 2, now)).toBe(now + 7 * DAY);
  });

  test("reports an already reached limit as now", () => {
    expect(limitCrossing(16, 16, 2, now)).toBe(now);
    expect(limitCrossing(20, 10, 2, now)).toBe(now);
  });

  test("has no date without a limit or a positive slope", () => {
    expect(limitCrossing(16, undefined, 2, now)).toBeUndefined();
    expect(limitCrossing(16, 0, 2, now)).toBeUndefined();
    expect(limitCrossing(16, 30, 0, now)).toBeUndefined();
  });

  test("gives up beyond the horizon", () => {
    expect(limitCrossing(0, 1_000_000, 2, now)).toBeUndefined();
    expect(limitCrossing(0, 2 * COST_PROJECTION_MAX_DAYS, 2, now)).toBe(
      now + COST_PROJECTION_MAX_DAYS * DAY,
    );
  });
});

describe("costScale", () => {
  test("rounds up to a readable step", () => {
    expect(costScale(0)).toBe(0.1);
    expect(costScale(0.2)).toBe(0.25);
    expect(costScale(3)).toBe(5);
    expect(costScale(410)).toBe(500);
    expect(costScale(1_200)).toBe(2_000);
    expect(costScale(200_000)).toBe(300_000);
  });
});

describe("formatting", () => {
  test("formats USD for the locale", () => {
    expect(formatCost(1.234, "en-US")).toBe("$1.23");
    expect(formatCost(undefined, "en-US")).toBe("—");
    expect(formatCostAxis(500, "en-US", 500)).toBe("$500");
  });

  test("a typed amount keeps up to four decimals", () => {
    expect(formatCostValue(3.2345, "en-US")).toBe("$3.2345");
    expect(formatCostValue(3.2, "en-US")).toBe("$3.20");
    expect(formatCostValue(undefined, "en-US")).toBe("—");
    expect(formatCostValue(12.5, "pt-BR")).toContain("12,50");
  });

  test("picks the axis precision from the scale", () => {
    expect(costAxisDigits(0.5)).toBe(2);
    expect(costAxisDigits(50)).toBe(1);
    expect(costAxisDigits(500)).toBe(0);
  });

  test("formats a short local date", () => {
    expect(formatCostDate(at(2026, 11, 26), "en-US")).toContain("26");
  });

  test("formats the zero mark with date and time", () => {
    const text = formatCostInstant(at(2026, 11, 26, 14), "en-US");
    expect(text).toContain("26");
    expect(text).toContain("02:00");
  });
});

describe("costRanges", () => {
  const now = at(2026, 11, 26, 18);
  const windowStart = dayWindow(now, 30).from;

  test("without a reset it is the whole day window, ending now", () => {
    const plan = costRanges(now, 30);
    expect(plan.start).toBe(windowStart);
    expect(plan.end).toBe(now);
    expect(plan.offset).toBeNull();
    expect(plan.buckets).toHaveLength(30);
    expect(plan.buckets[0]!.from).toBe(windowStart);
    expect(plan.buckets[29]!.to).toBe(now);
    expect(new Date(plan.buckets[1]!.from).getHours()).toBe(0);
  });

  test("a reset today collapses the axis to the sliver since the mark", () => {
    const reset = at(2026, 11, 26, 10);
    const plan = costRanges(now, 30, reset);
    expect(plan.start).toBe(reset);
    expect(plan.offset).toBeNull();
    expect(plan.buckets).toHaveLength(1);
    expect(plan.buckets[0]).toMatchObject({ from: reset, to: now, date: "2026-11-26" });
  });

  test("a reset inside the window splits at local midnights", () => {
    const reset = at(2026, 11, 24, 9);
    const plan = costRanges(now, 30, reset);
    expect(plan.start).toBe(reset);
    expect(plan.buckets).toHaveLength(3);
    expect(plan.buckets[0]!.to).toBe(addDays(startOfLocalDay(reset), 1) - 1);
    expect(plan.buckets[1]!.from).toBe(addDays(startOfLocalDay(reset), 1));
    expect(plan.buckets[2]!.to).toBe(now);
  });

  test("a reset older than the window becomes an offset", () => {
    const reset = addDays(windowStart, -5);
    const plan = costRanges(now, 30, reset);
    expect(plan.start).toBe(windowStart);
    expect(plan.buckets).toHaveLength(30);
    expect(plan.offset).toMatchObject({ from: reset, to: windowStart - 1, date: dayKey(reset) });
  });

  test("clamps a reset in the future to now and treats null as absent", () => {
    expect(costRanges(now, 30, now + 5_000).start).toBe(now);
    expect(costRanges(now, 30, null).start).toBe(windowStart);
  });

  test("a mark exactly at the window start has no offset", () => {
    expect(costRanges(now, 30, windowStart).offset).toBeNull();
  });
});

describe("spanDays", () => {
  const now = at(2026, 11, 26, 18);

  test("uses the nominal window without a reset", () => {
    expect(spanDays(now, dayWindow(now, 30).from, 30, false)).toBe(30);
    expect(spanDays(now, dayWindow(now, 10).from, 10, false)).toBe(10);
  });

  test("uses the elapsed time since the mark, at least one day", () => {
    expect(spanDays(now, now, 30, true)).toBe(1);
    expect(spanDays(now, addDays(now, -2), 30, true)).toBeCloseTo(2, 5);
    expect(spanDays(now, addDays(now, -0.25), 30, true)).toBe(1);
  });
});

describe("percentOf / percentScale", () => {
  test("converts a cost into a percentage of the limit", () => {
    expect(percentOf(412.55, 500)).toBeCloseTo(82.51, 2);
    expect(percentOf(500, 500)).toBe(100);
    expect(percentOf(0, 500)).toBe(0);
  });

  test("an unusable limit or value yields zero", () => {
    expect(percentOf(10, undefined)).toBe(0);
    expect(percentOf(10, 0)).toBe(0);
    expect(percentOf(10, Number.NaN)).toBe(0);
    expect(percentOf(Number.NaN, 500)).toBe(0);
  });

  test("keeps the 100% line with headroom and rounds up to 50", () => {
    const base = percentScale(100);
    expect(base.max).toBe(150);
    expect(base.ticks).toEqual([0, 50, 100, 150]);
    expect(percentScale(150).max).toBe(150);
    expect(percentScale(130).max).toBe(150);
    expect(percentScale(160).max).toBe(200);
    expect(percentScale(260).ticks).toEqual([0, 50, 100, 150, 200, 250, 300]);
  });

  test("an invalid max falls back to the minimum axis", () => {
    expect(percentScale(Number.NaN).max).toBe(150);
    expect(percentScale(-10).max).toBe(150);
  });
});

describe("forecastTicks", () => {
  const now = at(2026, 11, 26, 18);

  test("today first, then one every 10 days, up to the axis end", () => {
    const ticks = forecastTicks(now, addDays(now, 30));
    expect(ticks).toEqual([
      { t: now, current: true, hit: false },
      { t: addDays(now, 10), current: false, hit: false },
      { t: addDays(now, 20), current: false, hit: false },
      { t: addDays(now, 30), current: false, hit: false },
    ]);
  });

  test("the hit date closes the axis", () => {
    const hit = addDays(now, 12);
    const ticks = forecastTicks(now, addDays(hit, 3), hit);
    expect(ticks.map((tick) => tick.t)).toEqual([now, addDays(now, 10), hit]);
    expect(ticks[ticks.length - 1]!.hit).toBe(true);
  });

  test("a hit before the first step leaves only today and the hit", () => {
    const hit = addDays(now, 9);
    expect(forecastTicks(now, addDays(hit, 3), hit).map((tick) => tick.t)).toEqual([
      now,
      hit,
    ]);
  });

  test("a step that lands on the hit is not duplicated", () => {
    const hit = addDays(now, 30);
    const ticks = forecastTicks(now, addDays(hit, 3), hit);
    expect(ticks.map((tick) => tick.t)).toEqual([
      now,
      addDays(now, 10),
      addDays(now, 20),
      hit,
    ]);
    expect(ticks.filter((tick) => tick.hit)).toHaveLength(1);
  });

  test("an already reached limit marks today as the hit", () => {
    expect(forecastTicks(now, addDays(now, 30), now)).toEqual([
      { t: now, current: true, hit: true },
    ]);
    expect(forecastTicks(now, addDays(now, 30), now - 1_000)).toEqual([
      { t: now, current: true, hit: true },
    ]);
  });

  test("a fractional hit keeps its exact instant", () => {
    const hit = now + 12.5 * DAY;
    const ticks = forecastTicks(now, addDays(hit, 3), hit);
    expect(ticks[ticks.length - 1]!.t).toBe(hit);
  });

  test("a degenerate axis keeps just today", () => {
    expect(forecastTicks(now, now)).toEqual([{ t: now, current: true, hit: false }]);
    expect(forecastTicks(now, now - DAY)).toEqual([{ t: now, current: true, hit: false }]);
  });

  test("honors a custom step", () => {
    const ticks = forecastTicks(now, addDays(now, 21), undefined, 7);
    expect(ticks.map((tick) => tick.t)).toEqual([
      now,
      addDays(now, 7),
      addDays(now, 14),
      addDays(now, 21),
    ]);
  });
});

describe("fitCheckpoints", () => {
  const tick = (x: number, extra: { current?: boolean; hit?: boolean } = {}) => ({
    x,
    label: `d${x}`,
    current: extra.current ?? false,
    hit: extra.hit ?? false,
  });

  test("keeps checkpoints that fit", () => {
    const list = [tick(0), tick(100), tick(200, { current: true })];
    expect(fitCheckpoints(list)).toEqual(list);
  });

  test("drops an earlier checkpoint that would collide with today", () => {
    const list = [tick(0), tick(200), tick(210, { current: true })];
    expect(fitCheckpoints(list)).toEqual([tick(0), tick(210, { current: true })]);
  });

  test("the hit date wins over today", () => {
    const list = [tick(0), tick(200, { current: true }), tick(206, { hit: true })];
    expect(fitCheckpoints(list)).toEqual([tick(0), tick(206, { hit: true })]);
  });

  test("a lone hit close to today keeps only the hit", () => {
    const list = [tick(210, { current: true }), tick(213, { hit: true })];
    expect(fitCheckpoints(list)).toEqual([tick(213, { hit: true })]);
  });

  test("the hit is appended after the measured stretch", () => {
    const list = [
      tick(0),
      tick(120),
      tick(240, { current: true }),
      tick(300, { hit: true }),
    ];
    expect(fitCheckpoints(list).map((item) => item.x)).toEqual([0, 120, 240, 300]);
  });
});

describe("monotoneCurve", () => {
  test("handles empty, one and two points", () => {
    expect(monotoneCurve([])).toBe("");
    expect(monotoneCurve([{ x: 1, y: 2 }])).toBe("M1.00 2.00");
    expect(monotoneCurve([{ x: 0, y: 0 }, { x: 10, y: 5 }])).toBe("M0.00 0.00L10.00 5.00");
  });

  test("touches every point without NaN", () => {
    const path = monotoneCurve([
      { x: 0, y: 0 },
      { x: 10, y: 12 },
      { x: 20, y: 13 },
      { x: 30, y: 40 },
    ]);
    expect(path).not.toContain("NaN");
    expect(path).not.toContain("Infinity");
    expect(path).toContain("10.00 12.00");
    expect(path).toContain("30.00 40.00");
  });

  test("a zero-width segment does not divide by zero", () => {
    const path = monotoneCurve([
      { x: 0, y: 0 },
      { x: 10, y: 5 },
      { x: 10, y: 7 },
      { x: 20, y: 20 },
    ]);
    expect(path).not.toContain("NaN");
    expect(path).not.toContain("Infinity");
  });

  test("never overshoots a segment: control points stay inside its y range", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 30 },
      { x: 30, y: 32 },
      { x: 40, y: 31 },
    ];
    const path = monotoneCurve(points);
    const segments = path.match(/C[^C]+/g) ?? [];
    expect(segments.length).toBe(points.length - 1);

    let startY = points[0]!.y;
    segments.forEach((segment, index) => {
      const numbers = [...segment.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
      const [c1y, c2y, endY] = [numbers[1]!, numbers[3]!, numbers[5]!];
      const low = Math.min(startY, endY);
      const high = Math.max(startY, endY);
      for (const control of [c1y, c2y]) {
        expect(control).toBeGreaterThanOrEqual(low - 1e-6);
        expect(control).toBeLessThanOrEqual(high + 1e-6);
      }
      startY = endY;
      expect(numbers[4]).toBeCloseTo(points[index + 1]!.x, 2);
    });
  });

  test("a flat stretch stays flat", () => {
    const path = monotoneCurve([
      { x: 0, y: 10 },
      { x: 10, y: 10 },
      { x: 20, y: 30 },
    ]);
    expect(path).toContain("C3.33 10.00 6.67 10.00 10.00 10.00");
  });
});

describe("formatPercent", () => {
  test("formats a ratio for the locale", () => {
    expect(formatPercent(0.035, "en-US")).toContain("3.5");
    expect(formatPercent(0.035, "pt-BR")).toContain("3,5");
    expect(formatPercent(1, "en-US")).toContain("100");
  });

  test("an invalid ratio becomes an em dash", () => {
    expect(formatPercent(Number.NaN, "en-US")).toBe("—");
  });
});

describe("provider aggregation", () => {
  type Slice = {
    date: string;
    t: number;
    cost: number;
    providers: Record<string, number>;
    cached: boolean;
  };

  const bucket = (
    date: string,
    t: number,
    providers: Record<string, number>,
  ): Slice => ({
    date,
    t,
    cost: Object.values(providers).reduce((sum, value) => sum + value, 0),
    providers,
    cached: false,
  });

  const window = [
    bucket("2026-11-25", at(2026, 11, 25), { insi: 3, opencode: 0.5 }),
    bucket("2026-11-26", at(2026, 11, 26), { insi: 1, anthropic: 2 }),
  ];

  test("sums each provider, most expensive first", () => {
    expect(providerTotals(window)).toEqual([
      { id: "insi", cost: 4 },
      { id: "anthropic", cost: 2 },
      { id: "opencode", cost: 0.5 },
    ]);
  });

  test("projects one provider onto the days, zero-filling the gaps", () => {
    expect(providerDays(window, "insi").map((day) => day.cost)).toEqual([3, 1]);
    expect(providerDays(window, "anthropic").map((day) => day.cost)).toEqual([0, 2]);
    expect(providerDays(window, "missing").map((day) => day.cost)).toEqual([0, 0]);
  });
});

describe("parseMoney", () => {
  test("reads the separators the field accepts", () => {
    expect(parseMoney("12,50")).toEqual({ ok: true, value: 12.5 });
    expect(parseMoney("12.50")).toEqual({ ok: true, value: 12.5 });
    expect(parseMoney(" 12 ")).toEqual({ ok: true, value: 12 });
    expect(parseMoney("R$ 12,50")).toEqual({ ok: true, value: 12.5 });
    expect(parseMoney("0")).toEqual({ ok: true, value: 0 });
    expect(parseMoney("1.234,56")).toEqual({ ok: true, value: 1234.56 });
    expect(parseMoney("1,234.56")).toEqual({ ok: true, value: 1234.56 });
  });

  test("reads up to four decimals", () => {
    expect(parseMoney("3.2345")).toEqual({ ok: true, value: 3.2345 });
    expect(parseMoney("3,2345")).toEqual({ ok: true, value: 3.2345 });
    expect(parseMoney("1.234")).toEqual({ ok: true, value: 1.234 });
    expect(parseMoney("0,0001")).toEqual({ ok: true, value: 0.0001 });
  });

  test("an empty field means not informed", () => {
    expect(parseMoney("")).toEqual({ ok: true, value: null });
    expect(parseMoney("   ")).toEqual({ ok: true, value: null });
  });

  test("rejects partial and ambiguous input", () => {
    for (const raw of ["12,", "abc", "-5", "1.23456", "1,2,3", ".5", "12,5,0"]) {
      expect(parseMoney(raw).ok).toBe(false);
    }
  });
});

describe("parseRechargeDate / formatRechargeDate", () => {
  const now = at(2026, 11, 26, 18);
  const midnight = (year: number, month: number, day: number): number =>
    new Date(year, month - 1, day).getTime();

  test("reads day-first and ISO formats", () => {
    expect(parseRechargeDate("26/11/2026", now)).toEqual({
      ok: true,
      value: midnight(2026, 11, 26),
    });
    expect(parseRechargeDate("2026-11-26", now)).toEqual({
      ok: true,
      value: midnight(2026, 11, 26),
    });
    expect(parseRechargeDate("26-11-2026", now)).toEqual({
      ok: true,
      value: midnight(2026, 11, 26),
    });
  });

  test("a missing year means the most recent occurrence that is not in the future", () => {
    expect(parseRechargeDate("26/11", now)).toEqual({
      ok: true,
      value: midnight(2026, 11, 26),
    });
    expect(parseRechargeDate("27/11", now)).toEqual({
      ok: true,
      value: midnight(2025, 11, 27),
    });
    expect(parseRechargeDate("05/06", now)).toEqual({
      ok: true,
      value: midnight(2026, 6, 5),
    });
  });

  test("an empty field means no recharge", () => {
    expect(parseRechargeDate("", now)).toEqual({ ok: true, value: null });
  });

  test("rejects impossible days and a future recharge", () => {
    expect(parseRechargeDate("31/02/2026", now)).toEqual({ ok: false, reason: "invalid" });
    expect(parseRechargeDate("2026-02-30", now)).toEqual({ ok: false, reason: "invalid" });
    expect(parseRechargeDate("32/01/2026", now)).toEqual({ ok: false, reason: "invalid" });
    expect(parseRechargeDate("26/11/26", now)).toEqual({ ok: false, reason: "invalid" });
    expect(parseRechargeDate("27/11/2026", now)).toEqual({ ok: false, reason: "future" });
    expect(parseRechargeDate("26/11/2027", now)).toEqual({ ok: false, reason: "future" });
  });

  test("formats with the locale order", () => {
    const value = midnight(2026, 11, 26);
    expect(formatRechargeDate(value, "pt-BR")).toBe("26/11/2026");
    expect(formatRechargeDate(value, "en-US")).toBe("11/26/2026");
  });
});

describe("validateCostConfig", () => {
  const now = at(2026, 11, 26, 18);

  test("returns the typed values in one shot", () => {
    expect(
      validateCostConfig(
        { limit: "100,50", spent: "", lastRecharge: "01/11/2026", window: 15 },
        now,
      ),
    ).toEqual({
      ok: true,
      value: {
        limit: 100.5,
        spent: null,
        lastRecharge: new Date(2026, 10, 1).getTime(),
        window: 15,
      },
    });
  });

  test("an unknown window falls back to the default", () => {
    const result = validateCostConfig(
      { limit: "", spent: "", lastRecharge: "", window: 7 },
      now,
    );
    expect(result).toEqual({
      ok: true,
      value: { limit: null, spent: null, lastRecharge: null, window: COST_WINDOW_DEFAULT },
    });
  });

  test("reports every failing field and writes nothing", () => {
    const result = validateCostConfig(
      { limit: "abc", spent: "1,2,3", lastRecharge: "31/02/2026", window: 10 },
      now,
    );
    expect(result).toEqual({
      ok: false,
      errors: {
        limit: "invalidMoney",
        spent: "invalidMoney",
        lastRecharge: "invalidDate",
      },
    });
  });

  test("a future recharge is its own error", () => {
    const result = validateCostConfig(
      { limit: "", spent: "", lastRecharge: "27/11/2026", window: 10 },
      now,
    );
    expect(result).toEqual({ ok: false, errors: { lastRecharge: "futureDate" } });
  });
});

describe("axisEnd", () => {
  const now = at(2026, 11, 26, 18);

  test("pads a few days past the crossing", () => {
    // 50 left at 5/day = 10 days away, plus 3 days of tail.
    expect(axisEnd(50, 100, 5, now)).toBe(now + 13 * DAY);
  });

  test("caps the reach at 90 days", () => {
    // 88 days away, plus the tail, would pass the cap.
    expect(axisEnd(50, 100, 50 / 88, now)).toBe(now + 90 * DAY);
  });

  test("falls back to a 30-day future without a crossing", () => {
    expect(axisEnd(10, undefined, 2, now)).toBe(now + 30 * DAY);
    expect(axisEnd(10, 100, 0, now)).toBe(now + 30 * DAY);
    // 1000 days away is outside the reach of `limitCrossing`.
    expect(axisEnd(0, 100, 0.1, now)).toBe(now + 30 * DAY);
  });

  test("an already reached limit keeps a short future", () => {
    expect(axisEnd(120, 100, 5, now)).toBe(now + 3 * DAY);
  });
});

describe("clampStart", () => {
  const now = at(2026, 11, 26, 18);

  test("keeps a recent recharge and caps an old one", () => {
    expect(clampStart(undefined, now)).toBeUndefined();
    expect(clampStart(Number.NaN, now)).toBeUndefined();
    expect(clampStart(now - 10 * DAY, now)).toBe(now - 10 * DAY);
    expect(clampStart(now - 200 * DAY, now)).toBe(now - 90 * DAY);
    expect(clampStart(now + DAY, now)).toBe(now);
  });
});

describe("gatewayCycle", () => {
  const reset = at(2026, 12, 1, 0);

  test("subtracts the base captured at the top-up from spend and limit", () => {
    expect(gatewayCycle(12.5, 100, null, 10, null)).toEqual({
      spent: 2.5,
      limit: 90,
      base: 10,
      reset: false,
    });
  });

  test("without a base the raw spend is the cycle", () => {
    expect(gatewayCycle(12.5, 100, null, null, null)).toEqual({
      spent: 12.5,
      limit: 100,
      base: 0,
      reset: false,
    });
    expect(gatewayCycle(12.5, null, null, undefined, undefined)).toEqual({
      spent: 12.5,
      limit: undefined,
      base: 0,
      reset: false,
    });
  });

  test("a changed budget reset drops the base and restores the whole budget", () => {
    expect(gatewayCycle(3, 100, reset, 10, reset - 30 * DAY)).toEqual({
      spent: 3,
      limit: 100,
      base: 0,
      reset: true,
    });
  });

  test("a spend below the base is a reset signal", () => {
    expect(gatewayCycle(1, 100, null, 10, null)).toEqual({
      spent: 1,
      limit: 100,
      base: 0,
      reset: true,
    });
  });

  test("an unchanged reset keeps the base", () => {
    expect(gatewayCycle(12, 100, reset, 10, reset)).toEqual({
      spent: 2,
      limit: 90,
      base: 10,
      reset: false,
    });
  });

  test("rejects a missing or negative spend", () => {
    expect(gatewayCycle(undefined, 100, null, 0, null)).toBeUndefined();
    expect(gatewayCycle(Number.NaN, 100, null, 0, null)).toBeUndefined();
    expect(gatewayCycle(-1, 100, null, 0, null)).toBeUndefined();
  });

  test("a budget at or below the base leaves no room", () => {
    expect(gatewayCycle(12, 10, null, 10, null)).toEqual({
      spent: 2,
      limit: 0,
      base: 10,
      reset: false,
    });
  });
});