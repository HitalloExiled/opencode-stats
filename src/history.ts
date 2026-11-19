/**
 * Rate history helpers: a bounded sample buffer for the live turn, the session
 * series derived from the transcript, and the geometry used by the SVG chart.
 *
 * Everything here is pure so the buffer, scale and paths can be tested without
 * a browser.
 */

import type {
  SessionMessageAssistant,
  SessionMessageInfo,
} from "@opencode/client";

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
  samples: readonly SeriesSample[],
  now: number,
): { t0: number; t1: number } {
  const first = samples[0]?.t;
  const last = samples[samples.length - 1]?.t;
  const t1 = last ?? now;
  const t0 = first ?? t1 - 60_000;
  return { t0, t1: t1 > t0 ? t1 : t0 + 1000 };
}

export function averageValue(samples: readonly SeriesSample[]): number | undefined {
  const values = samples.map((sample) => sample.value).filter((value) => Number.isFinite(value) && value > 0);
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function maxValue(samples: readonly SeriesSample[]): number | undefined {
  const values = samples.map((sample) => sample.value).filter((value) => Number.isFinite(value) && value > 0);
  if (values.length === 0) return undefined;
  return Math.max(...values);
}

export function lastValue(samples: readonly SeriesSample[]): number | undefined {
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

/** Anything the chart geometry can plot: a time and a magnitude. */
export type SeriesSample = {
  t: number;
  value: number;
};

export type NormalizedPoint<T extends SeriesSample = RateSample> = {
  x: number;
  y: number;
  sample: T;
};

/** Maps samples to 0..1 coordinates; y=0 is zero and y=1 is scaleMax. */
export function normalizeSeries<T extends SeriesSample>(
  samples: readonly T[],
  t0: number,
  t1: number,
  scaleMax: number,
): NormalizedPoint<T>[] {
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
export function linePath(
  points: readonly NormalizedPoint<SeriesSample>[],
  width: number,
  height: number,
): string {
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
export function areaPath(
  points: readonly NormalizedPoint<SeriesSample>[],
  width: number,
  height: number,
): string {
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

/* ------------------------------------------------------------------ */
/* Context growth                                                      */
/* ------------------------------------------------------------------ */

/** One request's prompt size: uncached input plus the cached prefix. */
export type ContextSample = {
  /** Epoch milliseconds of the request. */
  t: number;
  /** Prompt tokens: input + cache read + cache write. */
  value: number;
  messageID: string;
};

export type CompactionReason = "auto" | "manual";

export type CompactionCheckpoint = {
  id: string;
  /** Epoch milliseconds, when the compaction was recorded. */
  t: number;
  reason: CompactionReason;
  /** Prompt size of the last request before the compaction. */
  before?: number | undefined;
  /** Prompt size of the first request after the compaction. */
  after?: number | undefined;
};

/**
 * Prompt tokens of one request. Providers report the uncached input and the
 * cached prefix separately; both are sent to the model, so both count. This is
 * the same convention the context composition card uses.
 */
export function promptTokens(message: SessionMessageAssistant): number {
  const tokens = message.tokens;
  if (!tokens) return 0;
  return tokens.input + tokens.cache.read + tokens.cache.write;
}

/** One point per completed request, in timeline order. */
export function contextSamples(messages: readonly SessionMessageInfo[]): ContextSample[] {
  const samples: ContextSample[] = [];
  for (const message of messages) {
    if (!isAssistant(message) || message.tokens === undefined) continue;
    const value = promptTokens(message);
    if (
      !Number.isFinite(message.time.created) ||
      !Number.isFinite(value) ||
      value <= 0
    ) {
      continue;
    }
    samples.push({ t: message.time.created, value, messageID: String(message.id) });
  }
  return samples.sort((a, b) => a.t - b.t || a.messageID.localeCompare(b.messageID));
}

/**
 * Visual checkpoints for completed compactions. Only `completed` counts: a
 * running compaction may still fail and a failed one never reset the context.
 * `before`/`after` let the marker describe the drop.
 */
export function compactionCheckpoints(
  messages: readonly SessionMessageInfo[],
  samples: readonly ContextSample[] = contextSamples(messages),
): CompactionCheckpoint[] {
  const ordered = [...samples].sort(
    (a, b) => a.t - b.t || a.messageID.localeCompare(b.messageID),
  );
  const checkpoints: CompactionCheckpoint[] = [];
  for (const message of messages) {
    if (message.type !== "compaction" || message.status !== "completed") continue;
    if (!Number.isFinite(message.time.created)) continue;
    const at = message.time.created;
    let before: number | undefined;
    let after: number | undefined;
    for (const sample of ordered) {
      if (sample.t < at) before = sample.value;
      else if (sample.t > at) {
        after = sample.value;
        break;
      }
    }
    checkpoints.push({
      id: String(message.id),
      t: at,
      reason: message.reason,
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
    });
  }
  return checkpoints.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
}

/**
 * Sum of every request's prompt in the timeline. Compactions reset the series
 * but not this total: it is how much context the model was sent overall.
 */
export function accumulatedTokens(samples: readonly ContextSample[]): number {
  let total = 0;
  for (const sample of samples) {
    if (Number.isFinite(sample.value) && sample.value > 0) total += sample.value;
  }
  return total;
}

/**
 * Fixed ceiling for the chart's sliding window, in tokens. The chart only
 * draws the most recent samples whose prompts sum to at most this many
 * tokens; the session-wide total (`accumulatedTokens`) is unaffected.
 */
export const CONTEXT_WINDOW_TOKENS = 1_000_000;

/**
 * Keeps only the most recent samples whose prompt sizes sum to at most
 * `limit` tokens. Walks from the newest sample backwards, including samples
 * until adding one more would exceed the limit; that boundary sample is kept
 * even if it alone pushes the running sum over the limit, so a single huge
 * prompt still shows up instead of leaving the window empty. Below the
 * limit, every sample is kept (same order as the input).
 */
export function windowedSamples(
  samples: readonly ContextSample[],
  limit: number = CONTEXT_WINDOW_TOKENS,
): ContextSample[] {
  if (samples.length === 0) return [];
  if (!Number.isFinite(limit) || limit <= 0) return [];
  let sum = 0;
  let start = samples.length;
  for (let index = samples.length - 1; index >= 0; index--) {
    const sample = samples[index]!;
    const value = Number.isFinite(sample.value) && sample.value > 0 ? sample.value : 0;
    if (sum > 0 && sum + value > limit) {
      start = index;
      break;
    }
    sum += value;
    start = index;
  }
  return samples.slice(start);
}

/**
 * Keeps only the checkpoints that fall within the time span of the windowed
 * samples. A checkpoint older than the window is still real (it happened),
 * but nothing around it is drawn anymore, so showing it would be confusing;
 * `before`/`after` on the ones that remain still come from the full series.
 */
export function windowedCheckpoints(
  checkpoints: readonly CompactionCheckpoint[],
  windowed: readonly ContextSample[],
): CompactionCheckpoint[] {
  if (windowed.length === 0) return [];
  const t0 = windowed[0]!.t;
  const t1 = windowed[windowed.length - 1]!.t;
  return checkpoints.filter((checkpoint) => checkpoint.t >= t0 && checkpoint.t <= t1);
}

/** Round step for the context chart's y axis, in tokens. */
const TOKEN_STEPS = [
  1_000,
  2_000,
  5_000,
  10_000,
  20_000,
  50_000,
  100_000,
  200_000,
  500_000,
  1_000_000,
];

export function tokenScale(max: number): number {
  const target = Number.isFinite(max) && max > 0 ? max * 1.05 : TOKEN_STEPS[0]!;
  const found = TOKEN_STEPS.find((step) => step >= target);
  if (found !== undefined) return found;
  return Math.ceil(target / 1_000_000) * 1_000_000;
}
