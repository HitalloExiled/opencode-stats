/**
 * Chart geometry tests — normalization, paths and step dots.
 */

import { describe, expect, test } from "bun:test";

import {
  areaPath,
  linePath,
  normalizeSeries,
  stepPointIndices,
  type RateSample,
} from "../src/history";

const sample = (t: number, value: number, kind: RateSample["kind"] = "step"): RateSample => ({
  t,
  value,
  kind,
});

describe("normalizeSeries", () => {
  test("maps time and rate into 0..1", () => {
    const points = normalizeSeries(
      [sample(0, 0), sample(500, 50), sample(1000, 100)],
      0,
      1000,
      100,
    );

    expect(points.map((point) => point.x)).toEqual([0, 0.5, 1]);
    expect(points.map((point) => point.y)).toEqual([0, 0.5, 1]);
  });

  test("clamps values above the scale and drops out-of-range samples", () => {
    const points = normalizeSeries(
      [sample(-1, 10), sample(0, 200), sample(500, 50), sample(1000, 10), sample(2000, 10)],
      0,
      1000,
      100,
    );

    expect(points).toHaveLength(3);
    expect(points[0]!.y).toBe(1);
    expect(points[1]!.y).toBe(0.5);
  });

  test("returns no points for an invalid domain", () => {
    expect(normalizeSeries([sample(0, 10)], 0, 0, 100)).toEqual([]);
    expect(normalizeSeries([sample(0, 10)], 0, 100, 0)).toEqual([]);
  });
});

describe("paths", () => {
  const points = normalizeSeries(
    [sample(0, 0), sample(500, 50), sample(1000, 100)],
    0,
    1000,
    100,
  );

  test("linePath maps y to the plot's bottom-up direction", () => {
    expect(linePath(points, 100, 50)).toBe("M0 50 L50 25 L100 0");
  });

  test("areaPath closes along the bottom", () => {
    expect(areaPath(points, 100, 50)).toBe("M0 50 L50 25 L100 0 L100 50 L0 50 Z");
  });

  test("empty series produce empty paths", () => {
    expect(linePath([], 100, 50)).toBe("");
    expect(areaPath([], 100, 50)).toBe("");
  });
});

describe("stepPointIndices", () => {
  test("returns only exact step points", () => {
    const points = normalizeSeries(
      [sample(0, 10, "live"), sample(500, 20, "step"), sample(1000, 30, "live")],
      0,
      1000,
      100,
    );
    expect(stepPointIndices(points)).toEqual([1]);
  });
});
