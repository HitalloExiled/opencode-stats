/**
 * Cost projection tests — day window, cumulative series, average, projection,
 * limit crossing, scale and formatting.
 */

import { describe, expect, test } from "bun:test";

import {
  addDays,
  averageDailyCost,
  COST_PROJECTION_MAX_DAYS,
  COST_WINDOW_DEFAULT,
  costAxisDigits,
  costRanges,
  costScale,
  cumulativeSeries,
  dayKey,
  dayWindow,
  formatCost,
  formatCostAxis,
  formatCostDate,
  formatCostInstant,
  limitCrossing,
  projectionSeries,
  spanDays,
  startOfLocalDay,
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