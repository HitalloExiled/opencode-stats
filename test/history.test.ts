/**
 * Rate history tests — ring buffer, session series and scale selection.
 */

import { describe, expect, test } from "bun:test";
import type { SessionMessageAssistant, SessionMessageInfo } from "@opencode/client";

import {
  averageValue,
  createRingBuffer,
  lastValue,
  maxValue,
  niceScale,
  samplesForTurn,
  stepSamples,
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
      input: 0,
      output: input.output ?? 10,
      reasoning: input.reasoning ?? 0,
      cache: { read: 0, write: 0 },
    },
  }) as SessionMessageAssistant;

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
