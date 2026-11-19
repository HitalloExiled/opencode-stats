/**
 * Rate history tests — ring buffer, session series and scale selection.
 */

import { describe, expect, test } from "bun:test";
import type { SessionMessageAssistant, SessionMessageInfo } from "@opencode/client";

import {
  accumulatedTokens,
  averageValue,
  chartScale,
  compactionCheckpoints,
  contextSamples,
  createRingBuffer,
  lastValue,
  maxValue,
  niceScale,
  promptTokens,
  sampleDomain,
  samplesForTurn,
  stepSamples,
  tokenScale,
  checkpointIndex,
  requestWindow,
  requestWindowCheckpoints,
  type CompactionCheckpoint,
  type ContextSample,
  type RateSample,
} from "../src/history";
import type { Turn } from "../src/metrics";

const sample = (t: number, value: number, kind: RateSample["kind"] = "live"): RateSample => ({
  t,
  value,
  kind,
});

const assistant = (input: {
  id?: string;
  created?: number;
  streamed?: number;
  output?: number;
  reasoning?: number;
  inputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
}): SessionMessageAssistant =>
  ({
    type: "assistant",
    id: input.id ?? "a1",
    time: {
      created: input.created ?? 1000,
      ...(input.streamed !== undefined ? { streamed: input.streamed } : {}),
    },
    agent: "build",
    model: { providerID: "p", id: "m" },
    content: [{ type: "text", text: "hello" }],
    tokens: {
      input: input.inputTokens ?? 0,
      output: input.output ?? 10,
      reasoning: input.reasoning ?? 0,
      cache: { read: input.cacheRead ?? 0, write: input.cacheWrite ?? 0 },
    },
  }) as SessionMessageAssistant;

const compaction = (input: {
  id?: string;
  created: number;
  status?: "completed" | "running" | "failed";
  reason?: "auto" | "manual";
}): SessionMessageInfo =>
  ({
    type: "compaction",
    id: input.id ?? "c1",
    time: { created: input.created },
    status: input.status ?? "completed",
    reason: input.reason ?? "auto",
    summary: "summary",
  }) as SessionMessageInfo;

describe("createRingBuffer", () => {
  test("keeps the newest samples up to capacity", () => {
    const buffer = createRingBuffer(3);
    buffer.push(sample(1, 10));
    buffer.push(sample(2, 20));
    buffer.push(sample(3, 30));
    buffer.push(sample(4, 40));

    expect(buffer.size).toBe(3);
    expect(buffer.values().map((item) => item.value)).toEqual([20, 30, 40]);
  });

  test("ignores non-finite samples and clears", () => {
    const buffer = createRingBuffer(2);
    buffer.push(sample(1, Number.NaN));
    buffer.push(sample(Number.NaN, 10));
    expect(buffer.size).toBe(0);

    buffer.push(sample(1, 10));
    buffer.clear();
    expect(buffer.values()).toEqual([]);
  });
});

describe("niceScale", () => {
  test("uses round steps with a floor", () => {
    expect(niceScale(0)).toBe(40);
    expect(niceScale(30)).toBe(40);
    expect(niceScale(50)).toBe(60);
    expect(niceScale(100)).toBe(120);
    expect(niceScale(500)).toBe(600);
  });
});

describe("chartScale", () => {
  test("follows the window peak instead of keeping the gauge floor", () => {
    expect(chartScale(0)).toBe(10);
    expect(chartScale(12)).toBe(20);
    expect(chartScale(52.8)).toBe(60);
    expect(chartScale(100)).toBe(120);
    expect(chartScale(1500)).toBe(1600);
  });
});

describe("sampleDomain", () => {
  test("spans the samples and anchors the end at the newest one", () => {
    const samples = [sample(1_000, 10), sample(2_000, 20), sample(3_000, 15)];
    expect(sampleDomain(samples, 9_000)).toEqual({ t0: 1_000, t1: 3_000 });
  });

  test("gives a single point a visible span", () => {
    expect(sampleDomain([sample(1_000, 10)], 9_000)).toEqual({ t0: 1_000, t1: 2_000 });
  });

  test("falls back to a 60-second empty window", () => {
    expect(sampleDomain([], 60_000)).toEqual({ t0: 0, t1: 60_000 });
  });
});

describe("stepSamples", () => {
  test("emits one exact point per completed step", () => {
    const messages: SessionMessageInfo[] = [
      assistant({ id: "a1", created: 1000, streamed: 2000, output: 20 }) as SessionMessageInfo,
      assistant({ id: "a2", created: 3000, streamed: 5000, output: 40 }) as SessionMessageInfo,
      assistant({ id: "a3", created: 6000, output: 10 }) as SessionMessageInfo,
    ];

    const samples = stepSamples(messages);
    expect(samples).toHaveLength(2);
    expect(samples[0]!.t).toBe(2000);
    expect(samples[0]!.value).toBe(20);
    expect(samples[1]!.t).toBe(5000);
    expect(samples[1]!.value).toBe(20);
    expect(samples.every((item) => item.kind === "step")).toBe(true);
  });
});

describe("samplesForTurn", () => {
  test("merges live samples and exact points in time order", () => {
    const turn: Turn = {
      prompt: undefined,
      messages: [],
      assistants: [assistant({ id: "a1", created: 1000, streamed: 2000, output: 20 })],
      closed: true,
    };

    const samples = samplesForTurn(turn, [sample(1500, 12), sample(1800, 14)]);
    expect(samples.map((item) => item.t)).toEqual([1500, 1800, 2000]);
    expect(samples[2]!.kind).toBe("step");
  });
});

describe("aggregates", () => {
  test("average, max and last ignore zero and invalid values", () => {
    const samples = [sample(1, 10), sample(2, 0), sample(3, 30), sample(4, Number.NaN)];
    expect(averageValue(samples)).toBe(20);
    expect(maxValue(samples)).toBe(30);
    expect(lastValue(samples)).toBe(30);
    expect(averageValue([])).toBeUndefined();
  });
});

describe("promptTokens", () => {
  test("counts uncached input plus the cached prefix", () => {
    const message = assistant({ inputTokens: 1_000, cacheRead: 4_000, cacheWrite: 500 });
    expect(promptTokens(message)).toBe(5_500);
  });

  test("is zero without tokens", () => {
    expect(promptTokens({ ...assistant({}), tokens: undefined } as SessionMessageAssistant)).toBe(0);
  });
});

describe("contextSamples", () => {
  test("plots one point per request, ordered by time", () => {
    const messages: SessionMessageInfo[] = [
      assistant({ id: "a2", created: 3_000, inputTokens: 2_000, cacheRead: 1_000 }) as SessionMessageInfo,
      assistant({ id: "a1", created: 1_000, inputTokens: 500, cacheRead: 250, cacheWrite: 250 }) as SessionMessageInfo,
      compaction({ created: 3_500 }),
    ];

    expect(contextSamples(messages)).toEqual([
      { t: 1_000, value: 1_000, messageID: "a1" },
      { t: 3_000, value: 3_000, messageID: "a2" },
    ]);
  });

  test("drops empty and invalid prompts", () => {
    const messages: SessionMessageInfo[] = [
      assistant({ id: "empty", created: 1_000 }) as SessionMessageInfo,
      assistant({
        id: "bad",
        created: 2_000,
        inputTokens: Number.NaN,
      }) as SessionMessageInfo,
    ];
    expect(contextSamples(messages)).toEqual([]);
  });
});

describe("compactionCheckpoints", () => {
  test("marks only completed compactions and keeps the reason", () => {
    const messages: SessionMessageInfo[] = [
      assistant({ id: "a1", created: 1_000, inputTokens: 10_000 }) as SessionMessageInfo,
      compaction({ id: "running", created: 2_000, status: "running" }),
      compaction({ id: "failed", created: 2_500, status: "failed" }),
      compaction({ id: "done", created: 3_000, reason: "manual" }),
      assistant({ id: "a2", created: 4_000, inputTokens: 2_000 }) as SessionMessageInfo,
    ];

    const checkpoints = compactionCheckpoints(messages);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toEqual({
      id: "done",
      t: 3_000,
      reason: "manual",
      before: 10_000,
      after: 2_000,
    });
  });

  test("leaves before/after undefined without a surrounding request", () => {
    const messages: SessionMessageInfo[] = [compaction({ id: "only", created: 1_000 })];
    expect(compactionCheckpoints(messages)).toEqual([
      { id: "only", t: 1_000, reason: "auto" },
    ]);
  });
});

describe("accumulatedTokens", () => {
  test("sums every request across a compaction", () => {
    const messages: SessionMessageInfo[] = [
      assistant({ id: "a1", created: 1_000, inputTokens: 10_000 }) as SessionMessageInfo,
      compaction({ created: 2_000 }),
      assistant({ id: "a2", created: 3_000, inputTokens: 2_000 }) as SessionMessageInfo,
    ];
    expect(accumulatedTokens(contextSamples(messages))).toBe(12_000);
  });

  test("is zero without samples and ignores invalid values", () => {
    expect(accumulatedTokens([])).toBe(0);
    expect(
      accumulatedTokens([
        { t: 1, value: 5, messageID: "a" },
        { t: 2, value: Number.NaN, messageID: "b" },
        { t: 3, value: 0, messageID: "c" },
      ]),
    ).toBe(5);
  });
});

describe("tokenScale", () => {
  test("rounds up to the next token step with headroom", () => {
    expect(tokenScale(0)).toBe(1_000);
    expect(tokenScale(12_000)).toBe(20_000);
    expect(tokenScale(100_000)).toBe(200_000);
  });

  test("keeps round millions above the table", () => {
    expect(tokenScale(2_100_000)).toBe(3_000_000);
  });
});

describe("requestWindow", () => {
  const points = (values: number[]): ContextSample[] =>
    values.map((value, index) => ({ t: index + 1, value, messageID: `m${index + 1}` }));

  test("keeps everything when the session is shorter than the window", () => {
    const samples = points([100, 200, 300]);
    expect(requestWindow(samples, 10)).toEqual(samples);
  });

  test("keeps only the N most recent requests", () => {
    const samples = points([1, 2, 3, 4, 5]);
    expect(requestWindow(samples, 2)).toEqual(samples.slice(3));
  });

  test("returns everything when count equals the length", () => {
    const samples = points([1, 2, 3]);
    expect(requestWindow(samples, 3)).toEqual(samples);
  });

  test("returns an empty array for count <= 0 or an empty input", () => {
    expect(requestWindow(points([1, 2]), 0)).toEqual([]);
    expect(requestWindow(points([1, 2]), -5)).toEqual([]);
    expect(requestWindow([], 300)).toEqual([]);
  });

  test("defaults to 300 requests", () => {
    const samples = points(Array.from({ length: 10 }, (_, i) => i));
    expect(requestWindow(samples)).toEqual(samples);
  });
});

describe("requestWindowCheckpoints", () => {
  const checkpoint = (id: string, t: number): CompactionCheckpoint => ({
    id,
    t,
    reason: "auto",
  });

  test("drops checkpoints outside the windowed span", () => {
    const windowed: ContextSample[] = [
      { t: 10, value: 1, messageID: "a" },
      { t: 30, value: 1, messageID: "b" },
    ];
    const checkpoints = [checkpoint("old", 5), checkpoint("in", 20), checkpoint("new", 40)];
    expect(requestWindowCheckpoints(checkpoints, windowed)).toEqual([checkpoint("in", 20)]);
  });

  test("returns nothing when the window is empty", () => {
    expect(requestWindowCheckpoints([checkpoint("x", 1)], [])).toEqual([]);
  });
});

describe("checkpointIndex", () => {
  const windowed: ContextSample[] = [
    { t: 0, value: 1, messageID: "a" },
    { t: 10, value: 1, messageID: "b" },
    { t: 20, value: 1, messageID: "c" },
  ];
  const checkpoint = (t: number): CompactionCheckpoint => ({ id: "c", t, reason: "auto" });

  test("places a checkpoint between the two requests it falls between", () => {
    expect(checkpointIndex(checkpoint(5), windowed)).toBe(0.5);
    expect(checkpointIndex(checkpoint(15), windowed)).toBe(1.5);
  });

  test("clamps to the last index when newer than the last request", () => {
    expect(checkpointIndex(checkpoint(999), windowed)).toBe(2);
  });

  test("clamps to the first index at or before the first request", () => {
    expect(checkpointIndex(checkpoint(0), windowed)).toBe(0);
  });

  test("returns 0 for an empty window", () => {
    expect(checkpointIndex(checkpoint(5), [])).toBe(0);
  });
});
