/**
 * Cost settings tests — the atomic config write and the gateway base rules,
 * without the Solid store (only the pure `applyCostConfig`).
 */

import { describe, expect, test } from "bun:test";

import {
  applyCostConfig,
  type GatewayCapture,
  type ProviderCost,
} from "../src/gui/cost-settings";
import { applyCostAdjustments, baselineAtMark, type CostConfig } from "../src/cost";

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 26, 18, 0, 0, 0).getTime();
const REST = new Date(2026, 11, 1, 0, 0, 0, 0).getTime();

const entry = (overrides: Partial<ProviderCost> = {}): ProviderCost => ({
  id: "insi",
  limit: 100,
  spent: 0,
  spentAt: NOW,
  adjustments: null,
  lastRecharge: NOW,
  gatewayBase: 10,
  gatewayResetAt: REST,
  ...overrides,
});

const config = (overrides: Partial<CostConfig> = {}): CostConfig => ({
  limit: 100,
  spent: 0,
  lastRecharge: NOW,
  window: 30,
  ...overrides,
});

const capture = (overrides: Partial<GatewayCapture> = {}): GatewayCapture => ({
  spend: 12.5,
  resetsAt: REST,
  ...overrides,
});

describe("applyCostConfig gateway base", () => {
  test("a new cycle captures the gateway spend and reset", () => {
    const next = applyCostConfig(
      entry(),
      config({ lastRecharge: NOW - DAY }),
      NOW,
      0,
      false,
      capture(),
    );

    expect(next.lastRecharge).toBe(NOW - DAY);
    expect(next.gatewayBase).toBe(12.5);
    expect(next.gatewayResetAt).toBe(REST);
  });

  test("a new cycle without a gateway clears a stale base", () => {
    const next = applyCostConfig(
      entry(),
      config({ lastRecharge: NOW - DAY }),
      NOW,
      0,
      false,
    );

    expect(next.gatewayBase).toBeNull();
    expect(next.gatewayResetAt).toBeNull();
  });

  test("editing the limit keeps the captured base", () => {
    const next = applyCostConfig(entry(), config({ limit: 200 }), NOW, 2, false, capture());

    expect(next.limit).toBe(200);
    expect(next.gatewayBase).toBe(10);
    expect(next.gatewayResetAt).toBe(REST);
  });

  test("clearing the recharge drops the gateway base", () => {
    const next = applyCostConfig(
      entry(),
      config({ lastRecharge: null }),
      NOW,
      0,
      false,
    );

    expect(next.lastRecharge).toBeNull();
    expect(next.gatewayBase).toBeNull();
    expect(next.gatewayResetAt).toBeNull();
  });

  test("a same-day date change keeps the stored instant and the base", () => {
    const stored = entry({ lastRecharge: new Date(2026, 10, 26, 9, 30).getTime() });
    const midnight = new Date(2026, 10, 26, 0, 0, 0, 0).getTime();

    const next = applyCostConfig(stored, config({ lastRecharge: midnight }), NOW, 0, false);

    expect(next.lastRecharge).toBe(stored.lastRecharge);
    expect(next.gatewayBase).toBe(10);
  });
});

describe("applyCostConfig manual spent", () => {
  test("an untouched field writes nothing", () => {
    const stored = entry({ gatewayBase: null, gatewayResetAt: null });
    expect(applyCostConfig(stored, config({ spent: null }), NOW, 0, false)).toEqual(stored);
  });

  test("a same-cycle edit lands on the typed total", () => {
    const stored = entry({ spent: 2, gatewayBase: null, gatewayResetAt: null });
    const next = applyCostConfig(stored, config({ spent: 3.23 }), NOW + 60_000, 2);

    expect(next.spent).toBeCloseTo(3.23, 10);
    expect(next.adjustments?.[0]?.at).toBe(NOW + 60_000);
    expect(next.adjustments?.[0]?.delta).toBeCloseTo(1.23, 10);
    expect(next.spentAt).toBe(NOW);
  });

  test("a later edit records what the card drew, not the last point", () => {
    const stored = entry({
      spent: 5,
      gatewayBase: null,
      gatewayResetAt: null,
      adjustments: [{ at: NOW - 1000, delta: 1, seen: 2 }],
    });
    const next = applyCostConfig(stored, config({ spent: 3 }), NOW, 4);
    const step = next.adjustments?.[next.adjustments.length - 1];

    expect(step?.delta).toBeCloseTo(-1, 10);
    // The card drew 4 and the prior step already added 1: the step starts at 3.
    expect(step?.seen).toBeCloseTo(3, 10);
    expect(next.spent).toBeCloseTo(4, 10);
  });

  test("a with-recharge edit keeps the history and lands on the typed total", () => {
    const mark = NOW - 10 * DAY;
    const stored = entry({
      spent: 2,
      spentAt: mark,
      lastRecharge: mark,
      gatewayBase: null,
      gatewayResetAt: null,
    });
    // The card draws 5 now (2 at the mark + 3 measured); the user types 4.
    const next = applyCostConfig(stored, config({ spent: 4, lastRecharge: mark }), NOW, 5);

    expect(next.spentAt).toBe(mark);
    expect(baselineAtMark(next.spent ?? undefined, next.adjustments ?? [])).toBeCloseTo(2, 10);
    const points = [
      { t: mark, value: 2, date: "d0" },
      { t: NOW, value: 5, date: "d1" },
    ];
    const drawn = applyCostAdjustments(points, next.adjustments ?? []);
    // The earlier half of the line is untouched; the total lands on 4.
    expect(drawn[0]?.value).toBe(2);
    expect(drawn[drawn.length - 1]?.value).toBeCloseTo(4, 10);
  });
});

describe("applyCostConfig first value without a cycle mark", () => {
  const fresh = (): ProviderCost => ({
    id: "insi",
    limit: null,
    spent: null,
    spentAt: null,
    adjustments: null,
    lastRecharge: null,
    gatewayBase: null,
    gatewayResetAt: null,
  });

  test("saving only the total keeps the measured history", () => {
    const next = applyCostConfig(
      fresh(),
      config({ limit: 100, spent: 1.319, lastRecharge: null }),
      NOW,
      3.23,
      true,
    );

    // No zero mark at `now`: the x axis still starts on the measured window.
    expect(next.spentAt).toBeNull();
    expect(next.lastRecharge).toBeNull();
    // The baseline stays at zero, so the days before the save are not cut.
    expect(baselineAtMark(next.spent ?? undefined, next.adjustments ?? [])).toBeCloseTo(0, 10);
    // One step drops the running total onto the typed value.
    expect(next.adjustments).toHaveLength(1);
    expect(next.adjustments?.[0]?.at).toBe(NOW);
    expect(next.adjustments?.[0]?.delta).toBeCloseTo(1.319 - 3.23, 10);
    expect(next.adjustments?.[0]?.seen).toBeCloseTo(3.23, 10);
  });

  test("the typed total is what the card draws after the step", () => {
    const next = applyCostConfig(
      fresh(),
      config({ spent: 1.319, lastRecharge: null }),
      NOW,
      3.23,
      true,
    );
    const points = [
      { t: NOW - DAY, value: 0, date: "d0" },
      { t: NOW, value: 3.23, date: "d1" },
    ];
    const drawn = applyCostAdjustments(points, next.adjustments ?? []);
    expect(drawn[drawn.length - 1]?.value).toBeCloseTo(1.319, 10);
  });

  test("without a drawn total it falls back to the value now", () => {
    const next = applyCostConfig(
      fresh(),
      config({ spent: 3.23, lastRecharge: null }),
      NOW,
      undefined,
      true,
    );

    expect(next.spent).toBe(3.23);
    expect(next.spentAt).toBe(NOW);
    expect(next.adjustments).toBeNull();
  });

  test("a legacy mark without a value keeps its anchor", () => {
    const marked = fresh();
    marked.spentAt = NOW - DAY;

    const next = applyCostConfig(
      marked,
      config({ spent: 3.23, lastRecharge: null }),
      NOW,
      3.23,
      true,
    );

    expect(next.spent).toBe(3.23);
    expect(next.spentAt).toBe(NOW - DAY);
    expect(next.adjustments).toBeNull();
  });
});

describe("applyCostConfig legacy adjustments", () => {
  const measured = 4.15;
  const legacy = (): ProviderCost =>
    entry({
      spent: 1.5103,
      spentAt: NOW,
      lastRecharge: NOW,
      gatewayBase: null,
      gatewayResetAt: null,
      adjustments: [
        { at: NOW - 3_600_000, delta: 0.46 },
        { at: NOW - 2_400_000, delta: -2.3709887720000014 },
        { at: NOW - 600_000, delta: 0.1912875879999989, seen: 7.274301184000002 },
      ],
    });

  test("any save drops the steps saved without `seen`, keeping the total", () => {
    const stored = legacy();
    const next = applyCostConfig(stored, config({ limit: 200 }), NOW, 6, false);

    expect(next.adjustments).toBeNull();
    // `spent` is untouched, so `spent + measured` (the drawn total) does not move.
    expect(next.spent).toBe(stored.spent);
    expect((next.spent ?? 0) + measured).toBeCloseTo((stored.spent ?? 0) + measured, 10);
  });

  test("the cleaned curve ends on the same total, without the bounce", () => {
    const stored = legacy();
    const points = (baseline: number) => [
      { t: NOW - 16 * 3_600_000, value: baseline, date: "d0" },
      { t: NOW, value: baseline + measured, date: "d1" },
    ];
    const next = applyCostConfig(stored, config({ limit: 200 }), NOW, 6, false);
    const before = applyCostAdjustments(
      points(baselineAtMark(stored.spent ?? undefined, stored.adjustments ?? [])),
      stored.adjustments ?? [],
    );
    const after = applyCostAdjustments(
      points(baselineAtMark(next.spent ?? undefined, next.adjustments ?? [])),
      next.adjustments ?? [],
    );

    expect(after[after.length - 1]?.value).toBeCloseTo(
      before[before.length - 1]?.value ?? 0,
      10,
    );
    // No downward step survives: the cleaned series never dips.
    const values = after.map((point) => point.value);
    expect(values).toEqual([...values].sort((left, right) => left - right));
  });

  test("a `seen` history is preserved as-is", () => {
    const stored = entry({
      spent: 5,
      adjustments: [{ at: NOW - 1000, delta: 1, seen: 2 }],
    });
    const next = applyCostConfig(stored, config({ limit: 100 }), NOW, 4, false);

    expect(next.adjustments).toEqual(stored.adjustments);
  });

  test("the next edit records a clean `seen` step over the drawn total", () => {
    const stored = legacy();
    const drawn = (stored.spent ?? 0) + measured;
    const next = applyCostConfig(stored, config({ spent: drawn + 2 }), NOW, drawn);

    expect(next.adjustments).toHaveLength(1);
    expect(next.adjustments?.[0]?.seen).toBeCloseTo(drawn, 10);
    expect(next.adjustments?.[0]?.delta).toBeCloseTo(2, 10);
  });
});