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

/**
 * Sliding time window of `hours` over the series. The window covers the last
 * `hours` of real time; if the samples inside it don't span that whole span
 * (e.g. the session was idle for part of it), the domain adapts to the samples
 * that are present, the same way the turn range spans its own samples — there
 * is never empty space around the data. With no sample inside the window at all
 * it falls back to the full series.
 */
export function windowDomain(
  samples: readonly SeriesSample[],
  now: number,
  hours: number,
): { t0: number; t1: number } {
  const t0Window = now - hours * 3600_000;
  const t1Window = now;
  const inWindow = samples.filter((sample) => sample.t >= t0Window && sample.t <= t1Window);
  if (inWindow.length === 0) return sampleDomain(samples, now);
  const t0 = inWindow[0]!.t;
  const t1 = inWindow[inWindow.length - 1]!.t;
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

/**
 * Maps samples to 0..1 coordinates by position instead of time: x is the
 * sample's index over the count of samples minus one (single sample pins to
 * x=0), y is the usual value/scaleMax. Used by the context chart, whose x
 * axis is "request number", not a time span.
 */
export function normalizeByIndex<T extends SeriesSample>(
  samples: readonly T[],
  scaleMax: number,
): NormalizedPoint<T>[] {
  if (samples.length === 0 || scaleMax <= 0) return [];
  const last = samples.length - 1;
  return samples.map((sample, index) => ({
    x: last > 0 ? index / last : 0,
    y: Number.isFinite(sample.value) ? Math.min(1, Math.max(0, sample.value / scaleMax)) : 0,
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
 * Default number of requests the context chart's sliding window shows,
 * selectable from `CONTEXT_WINDOW_SIZES`.
 */
export const CONTEXT_WINDOW_DEFAULT = 300;

/** Window sizes offered by the chart's selector, in requests. */
export const CONTEXT_WINDOW_SIZES = [100, 300, 500] as const;

/**
 * Keeps only the most recent `count` samples (by position, not by a time or
 * token cutoff) — the x axis plots one tick per request, so the window is a
 * request count, not a token sum. A session shorter than `count` keeps every
 * sample it has; `count <= 0` or a non-finite count yields an empty window.
 */
export function requestWindow(
  samples: readonly ContextSample[],
  count: number = CONTEXT_WINDOW_DEFAULT,
): ContextSample[] {
  if (samples.length === 0) return [];
  if (!Number.isFinite(count) || count <= 0) return [];
  if (count >= samples.length) return [...samples];
  return samples.slice(samples.length - count);
}

/**
 * Keeps only the checkpoints that fall within the time span of the windowed
 * samples. A checkpoint older than the window is still real (it happened),
 * but nothing around it is drawn anymore, so showing it would be confusing;
 * `before`/`after` on the ones that remain still come from the full series.
 */
export function requestWindowCheckpoints(
  checkpoints: readonly CompactionCheckpoint[],
  windowed: readonly ContextSample[],
): CompactionCheckpoint[] {
  if (windowed.length === 0) return [];
  const t0 = windowed[0]!.t;
  const t1 = windowed[windowed.length - 1]!.t;
  return checkpoints.filter((checkpoint) => checkpoint.t >= t0 && checkpoint.t <= t1);
}

/**
 * Places each checkpoint between the two requests it falls between in the
 * windowed series, as a fractional index (e.g. 2.5 = halfway between the
 * 3rd and 4th request, 0-based). Used to draw checkpoints on an x axis that
 * plots request index instead of time. A checkpoint newer than the last
 * windowed request clamps to the last index (it just happened); checkpoints
 * are expected to already be inside the window's time span (see
 * `requestWindowCheckpoints`), so there is nothing older than the first
 * sample to clamp on the low end.
 */
export function checkpointIndex(
  checkpoint: CompactionCheckpoint,
  windowed: readonly ContextSample[],
): number {
  const last = windowed.length - 1;
  if (last < 0) return 0;
  for (let index = 0; index <= last; index++) {
    const sample = windowed[index]!;
    if (checkpoint.t <= sample.t) {
      if (index === 0) return 0;
      const previous = windowed[index - 1]!;
      const span = sample.t - previous.t;
      const fraction = span > 0 ? (checkpoint.t - previous.t) / span : 0;
      return index - 1 + Math.min(1, Math.max(0, fraction));
    }
  }
  return last;
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
