/**
 * Rate history helpers: a bounded sample buffer for the live turn, the session
 * series derived from the transcript, and the geometry used by the SVG chart.
 *
 * Everything here is pure so the buffer, scale and paths can be tested without
 * a browser.
 */

import type { SessionMessageInfo } from "@opencode/client";

import { isAssistant, stepMetrics, type Turn } from "./metrics.js";

export type RateSample = {
  /** Epoch milliseconds. */
  t: number;
  /** Tokens per second. */
  value: number;
  /** Live estimates are drawn as a line; exact step points get a dot. */
  kind: "live" | "step";
  stepID?: string | undefined;
};

export type RingBuffer = {
  push(sample: RateSample): void;
  clear(): void;
  values(): RateSample[];
  readonly size: number;
  readonly capacity: number;
};

export function createRingBuffer(capacity = 300): RingBuffer {
  const max = Math.max(1, Math.floor(capacity));
  let samples: RateSample[] = [];
  return {
    push(sample) {
      if (!Number.isFinite(sample.value) || !Number.isFinite(sample.t)) return;
      samples.push(sample);
      if (samples.length > max) samples = samples.slice(samples.length - max);
    },
    clear() {
      samples = [];
    },
    values() {
      return [...samples];
    },
    get size() {
      return samples.length;
    },
    get capacity() {
      return max;
    },
  };
}

/** Exact rate points for every completed step in the transcript. */
export function stepSamples(messages: readonly SessionMessageInfo[]): RateSample[] {
  return messages
    .filter(isAssistant)
    .flatMap((message) => {
      const step = stepMetrics(message);
      if (step.rate === undefined || message.time.streamed === undefined) return [];
      return [
        {
          t: message.time.streamed,
          value: step.rate,
          kind: "step" as const,
          stepID: String(message.id),
        },
      ];
    })
    .sort((a, b) => a.t - b.t);
}

/** Exact points for one turn plus the live samples collected for it. */
export function samplesForTurn(turn: Turn | undefined, live: readonly RateSample[]): RateSample[] {
  if (!turn) return [...live].sort((a, b) => a.t - b.t);
  const exact = turn.assistants.flatMap((message) => {
    const step = stepMetrics(message);
    if (step.rate === undefined || message.time.streamed === undefined) return [];
    return [
      {
        t: message.time.streamed,
        value: step.rate,
        kind: "step" as const,
        stepID: String(message.id),
      },
    ];
  });
  return [...live, ...exact].sort((a, b) => a.t - b.t || (a.kind === "step" ? 1 : -1));
}

/**
 * Time span of the series on screen. The newest sample anchors the right edge,
 * so the line always reaches the border instead of stopping short until the
 * next 1 Hz tick; there is no fixed window that truncates the turn.
 */
export function sampleDomain(
  samples: readonly RateSample[],
  now: number,
): { t0: number; t1: number } {
  const first = samples[0]?.t;
  const last = samples[samples.length - 1]?.t;
  const t1 = last ?? now;
  const t0 = first ?? t1 - 60_000;
  return { t0, t1: t1 > t0 ? t1 : t0 + 1000 };
}

export function averageValue(samples: readonly RateSample[]): number | undefined {
  const values = samples.map((sample) => sample.value).filter((value) => Number.isFinite(value) && value > 0);
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function maxValue(samples: readonly RateSample[]): number | undefined {
  const values = samples.map((sample) => sample.value).filter((value) => Number.isFinite(value) && value > 0);
  if (values.length === 0) return undefined;
  return Math.max(...values);
}

export function lastValue(samples: readonly RateSample[]): number | undefined {
  for (let index = samples.length - 1; index >= 0; index--) {
    const sample = samples[index];
    if (sample && Number.isFinite(sample.value)) return sample.value;
  }
  return undefined;
}

/**
 * Chooses a stable, round maximum for the gauge. The scale only grows during a
 * session, so the arc does not jump every second.
 */
const RATE_STEPS = [10, 20, 30, 40, 60, 80, 100, 120, 160, 200, 240, 320, 400, 600, 800, 1000];

export function niceScale(max: number, floor = 40): number {
  const target = Math.max(floor, (Number.isFinite(max) ? max : floor) * 1.15);
  const found = RATE_STEPS.find((step) => step >= target);
  if (found !== undefined) return found;
  return Math.ceil(target / 200) * 200;
}

/**
 * Round maximum for the chart's y axis. Unlike the gauge, the chart follows the
 * window on screen, so the axis may shrink when the window changes. The small
 * headroom keeps the peak just below the top edge; the half tick stays round.
 */
export function chartScale(max: number): number {
  const target = Number.isFinite(max) && max > 0 ? max * 1.05 : RATE_STEPS[0]!;
  const found = RATE_STEPS.find((step) => step >= target);
  if (found !== undefined) return found;
  return Math.ceil(target / 200) * 200;
}

export type NormalizedPoint = {
  x: number;
  y: number;
  sample: RateSample;
};

/** Maps samples to 0..1 coordinates; y=0 is zero rate and y=1 is scaleMax. */
export function normalizeSeries(
  samples: readonly RateSample[],
  t0: number,
  t1: number,
  scaleMax: number,
): NormalizedPoint[] {
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0 || scaleMax <= 0) return [];
  return samples
    .filter((sample) => sample.t >= t0 && sample.t <= t1 && Number.isFinite(sample.value))
    .sort((a, b) => a.t - b.t)
    .map((sample) => ({
      x: Math.min(1, Math.max(0, (sample.t - t0) / (t1 - t0))),
      y: Math.min(1, Math.max(0, sample.value / scaleMax)),
      sample,
    }));
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

/** SVG path in the given plot size; x grows right, y grows down. */
export function linePath(points: readonly NormalizedPoint[], width: number, height: number): string {
  if (points.length === 0) return "";
  return points
    .map((point, index) => {
      const x = round(point.x * width);
      const y = round((1 - point.y) * height);
      return `${index === 0 ? "M" : "L"}${x} ${y}`;
    })
    .join(" ");
}

/** Closes the line along the bottom edge for the area fill. */
export function areaPath(points: readonly NormalizedPoint[], width: number, height: number): string {
  if (points.length === 0) return "";
  const line = linePath(points, width, height);
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return `${line} L${round(last.x * width)} ${round(height)} L${round(first.x * width)} ${round(height)} Z`;
}

/** Smooths nothing; returns the indices of exact step points for dots. */
export function stepPointIndices(points: readonly NormalizedPoint[]): number[] {
  return points.flatMap((point, index) => (point.sample.kind === "step" ? [index] : []));
}
