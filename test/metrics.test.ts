/**
 * Metrics tests — pure functions over synthetic session messages.
 *
 * The rate formula mirrors the TUI: (output + reasoning) weighted by each
 * step's provider-active duration (`streamed - created`), not wall-clock time.
 */

import { describe, expect, test } from "bun:test";
import type {
  SessionMessageAssistant,
  SessionMessageInfo,
  SessionMessageAssistantTool,
} from "@opencode/client";

import {
  analyzeSession,
  analyzeTurn,
  canonicalRate,
  estimateLiveRate,
  findTurns,
  mergeMessages,
  stepMetrics,
  type ToolCall,
} from "../src/metrics";

type AssistantInput = {
  id?: string;
  created?: number;
  streamed?: number;
  completed?: number;
  output?: number;
  reasoning?: number;
  cost?: number;
  agent?: string;
  content?: SessionMessageAssistant["content"];
};

const assistant = (input: AssistantInput = {}): SessionMessageAssistant =>
  ({
    type: "assistant",
    id: input.id ?? "a1",
    time: {
      created: input.created ?? 1000,
      ...(input.streamed !== undefined ? { streamed: input.streamed } : {}),
      ...(input.completed !== undefined ? { completed: input.completed } : {}),
    },
    agent: input.agent ?? "build",
    model: { providerID: "local", id: "bonsai" },
    content: input.content ?? [{ type: "text", text: "hello" }],
    ...(input.output !== undefined || input.reasoning !== undefined
      ? {
          tokens: {
            input: 0,
            output: input.output ?? 0,
            reasoning: input.reasoning ?? 0,
            cache: { read: 0, write: 0 },
          },
        }
      : {}),
    ...(input.cost !== undefined ? { cost: input.cost } : {}),
  }) as SessionMessageAssistant;

const user = (id: string, created: number): SessionMessageInfo =>
  ({ type: "user", id, time: { created }, text: "hi" }) as SessionMessageInfo;

const idle = (id: string, created: number): SessionMessageInfo =>
  ({ type: "idle", id, time: { created }, outcome: "succeeded" }) as SessionMessageInfo;

const tool = (input: {
  id: string;
  name: string;
  created: number;
  ran?: number;
  completed?: number;
  status?: "completed" | "error" | "running";
  input?: Record<string, unknown>;
  text?: string;
}): SessionMessageAssistantTool => {
  const status = input.status ?? "completed";
  const state =
    status === "completed"
      ? {
          status: "completed" as const,
          input: input.input ?? { filePath: "src/a.ts" },
          content: [{ type: "text" as const, text: input.text ?? "ok" }],
        }
      : status === "error"
        ? {
            status: "error" as const,
            input: input.input ?? { filePath: "src/a.ts" },
            error: { type: "error", message: "boom" },
            ...(input.text !== undefined
              ? { content: [{ type: "text" as const, text: input.text }] }
              : {}),
          }
        : {
            status: "running" as const,
            input: input.input ?? { filePath: "src/a.ts" },
            metadata: {},
          };
  return {
    type: "tool",
    id: input.id,
    name: input.name,
    state,
    time: {
      created: input.created,
      ...(input.ran !== undefined ? { ran: input.ran } : {}),
      ...(input.completed !== undefined ? { completed: input.completed } : {}),
    },
  } as SessionMessageAssistantTool;
};

describe("stepMetrics", () => {
  test("computes exact rate, durations, reasoning and first token", () => {
    const message = assistant({
      created: 1000,
      streamed: 3000,
      completed: 4000,
      output: 20,
      reasoning: 6,
      content: [
        { type: "reasoning", text: "thinking", time: { created: 1100, completed: 1800 } },
        { type: "text", text: "answer" },
      ],
    });

    const step = stepMetrics(message);
    expect(step.streamMs).toBe(2000);
    expect(step.durationMs).toBe(3000);
    expect(step.rate).toBe(13);
    expect(step.outputTokens).toBe(26);
    expect(step.reasoningTokens).toBe(6);
    expect(step.reasoningMs).toBe(700);
    expect(step.firstTokenMs).toBe(100);
  });

  test("does not invent a rate without streamed tokens", () => {
    const step = stepMetrics(assistant({ created: 1000, completed: 2000, output: 10 }));
    expect(step.rate).toBeUndefined();
    expect(step.streamMs).toBeUndefined();
    expect(step.durationMs).toBe(1000);
  });

  test("reads tool status, duration and argument detail", () => {
    const step = stepMetrics(
      assistant({
        content: [
          tool({ id: "t1", name: "read", created: 1000, ran: 1200, completed: 2500 }),
          tool({ id: "t2", name: "bash", created: 2600, ran: 2700, status: "error" }),
          tool({ id: "t3", name: "grep", created: 2800, status: "running" }),
        ],
      }),
    );

    expect(step.toolCalls).toHaveLength(3);
    const first = step.toolCalls[0]!;
    expect(first.status).toBe("ok");
    expect(first.durationMs).toBe(1300);
    expect(first.detail).toBe("src/a.ts");
    expect(step.toolCalls[1]!.status).toBe("error");
    expect(step.toolCalls[2]!.status).toBe("running");
    expect(step.toolCalls[2]!.startedAt).toBe(2800);
    // Only the completed call has content ("ok" = 2 chars -> 1 token); the
    // error call carries no content and the running one has no result yet.
    expect(step.toolTokens).toBe(1);
  });
});

describe("canonicalRate", () => {
  test("weights each step by its provider-active duration", () => {
    const first = assistant({ id: "a1", created: 0, streamed: 1000, output: 10 });
    const second = assistant({ id: "a2", created: 2000, streamed: 4000, output: 20 });
    expect(canonicalRate([first, second])).toBe(10);
  });

  test("is undefined until every step has streamed", () => {
    const first = assistant({ id: "a1", created: 0, streamed: 1000, output: 10 });
    const second = assistant({ id: "a2", created: 2000, output: 20 });
    expect(canonicalRate([first, second])).toBeUndefined();
  });

  test("is undefined without output", () => {
    expect(canonicalRate([assistant({ streamed: 1000, output: 0 })])).toBeUndefined();
  });
});

describe("findTurns", () => {
  test("groups by prompt and closes on idle", () => {
    const messages = [
      user("u1", 1000),
      assistant({ id: "a1", created: 1200, streamed: 2200, completed: 3200, output: 20 }),
      idle("i1", 3300),
      user("u2", 4000),
      assistant({ id: "a2", created: 4200, output: 10 }),
    ];

    const turns = findTurns(messages);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.closed).toBe(true);
    expect(turns[0]!.assistants).toHaveLength(1);
    expect(turns[1]!.closed).toBe(false);
    expect(turns[1]!.assistants).toHaveLength(1);
  });

  test("treats every prompt as a boundary in legacy sessions", () => {
    const turns = findTurns([
      user("u1", 1000),
      assistant({ id: "a1", created: 1200 }),
      user("u2", 2000),
      assistant({ id: "a2", created: 2200 }),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns.every((turn) => turn.assistants.length === 1)).toBe(true);
  });
});

describe("analyzeTurn", () => {
  test("uses the prompt as the turn start", () => {
    const turn = {
      prompt: user("u1", 1000),
      messages: [],
      assistants: [
        assistant({ id: "a1", created: 1200, streamed: 2200, completed: 3200, output: 20, reasoning: 5 }),
      ],
      closed: true,
    };

    const metrics = analyzeTurn(turn, 5000, false);
    expect(metrics.durationMs).toBe(2200);
    expect(metrics.rate).toBe(25);
    expect(metrics.outputTokens).toBe(25);
    expect(metrics.reasoningTokens).toBe(5);
    expect(metrics.agent).toBe("build");
    expect(metrics.model?.id).toBe("bonsai");
  });

  test("estimates a live rate while the step streams", () => {
    const turn = {
      prompt: user("u1", 1000),
      messages: [],
      assistants: [
        assistant({
          id: "a1",
          created: 2000,
          content: [{ type: "text", text: "x".repeat(40) }],
        }),
      ],
      closed: false,
    };

    const metrics = analyzeTurn(turn, 3000, true);
    expect(metrics.durationMs).toBe(2000);
    expect(metrics.liveRate).toBeGreaterThan(0);
    expect(metrics.rate).toBeUndefined();
  });
});

describe("estimateLiveRate", () => {
  test("estimates tokens from characters over elapsed time", () => {
    const message = assistant({
      created: 1000,
      content: [{ type: "text", text: "x".repeat(40) }],
    });
    expect(estimateLiveRate(message, 2000)).toBeCloseTo(10, 5);
  });

  test("does not sample before there is text", () => {
    const message = assistant({ created: 1000, content: [{ type: "text", text: "hi" }] });
    expect(estimateLiveRate(message, 2000)).toBeUndefined();
  });
});

describe("analyzeSession", () => {
  test("aggregates tokens, cost, averages, tools and models", () => {
    const messages: SessionMessageInfo[] = [
      user("u1", 1000),
      assistant({
        id: "a1",
        created: 1200,
        streamed: 2200,
        completed: 3200,
        output: 20,
        reasoning: 5,
        cost: 0.2,
        content: [
          tool({ id: "t1", name: "read", created: 1300, ran: 1400, completed: 1600 }),
          tool({ id: "t2", name: "read", created: 1700, ran: 1800, completed: 2600 }),
        ],
      }),
      idle("i1", 3300),
      user("u2", 4000),
      assistant({
        id: "a2",
        created: 4200,
        streamed: 5200,
        completed: 6200,
        output: 10,
        cost: 0.1,
        content: [tool({ id: "t3", name: "bash", created: 4300, ran: 4400, completed: 5400 })],
      }),
    ];

    const metrics = analyzeSession(messages);
    expect(metrics.turns).toBe(2);
    expect(metrics.steps).toBe(2);
    expect(metrics.messages).toBe(5);
    expect(metrics.tokens.output).toBe(30);
    expect(metrics.tokens.reasoning).toBe(5);
    expect(metrics.cost).toBeCloseTo(0.3, 5);
    expect(metrics.averageStepMs).toBe(2000);
    expect(metrics.averageTurnMs).toBe(2200);
    expect(metrics.rate).toBeCloseTo(35 / 2, 5);
    expect(metrics.maxRate).toBe(25);

    const read = metrics.tools.find((tool) => tool.name === "read");
    expect(read?.calls).toBe(2);
    expect(read?.ok).toBe(2);
    expect(read?.averageMs).toBe(500);
    expect(metrics.tools[0]!.name).toBe("read");

    expect(metrics.models).toHaveLength(1);
    expect(metrics.models[0]!.steps).toBe(2);
    expect(metrics.models[0]!.tokens.output).toBe(30);
  });

  test("estimates tool result tokens from tool content", () => {
    const messages = [
      user("u1", 1000),
      assistant({
        id: "a1",
        created: 1100,
        content: [
          tool({ id: "t1", name: "read", created: 1200, text: "abcdefgh" }),
          tool({ id: "t2", name: "bash", created: 1300, status: "error", text: "12345" }),
          tool({ id: "t3", name: "grep", created: 1400, status: "running" }),
        ],
      }),
    ];

    // 8 chars -> 2 tokens, 5 chars -> 2 tokens, running content -> 0.
    expect(analyzeSession(messages).toolTokens).toBe(4);
  });

  test("exposes the last completed request usage", () => {
    const messages = [
      user("u1", 1000),
      assistant({
        id: "a1",
        created: 1100,
        completed: 2000,
        output: 10,
        content: [
          { type: "text", text: "answer" },
          tool({ id: "t1", name: "read", created: 1200, text: "abcdefgh" }),
        ],
      }),
      user("u2", 3000),
      // Still streaming: no completion time, so it must not replace the last
      // completed request.
      assistant({ id: "a2", created: 3100, output: 20 }),
    ];

    const metrics = analyzeSession(messages);

    expect(metrics.lastRequest?.tokens.output).toBe(10);
    expect(metrics.lastRequest?.toolTokens).toBe(2);
    expect(metrics.lastRequest?.model.id).toBe("bonsai");
    expect(metrics.lastRequest?.model.providerID).toBe("local");
  });

  test("includes compaction tokens and cost", () => {
    const compaction = {
      type: "compaction",
      id: "c1",
      time: { created: 1000 },
      status: "completed",
      reason: "manual",
      summary: "summary",
      tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
      cost: 0.5,
    } as SessionMessageInfo;

    const metrics = analyzeSession([compaction]);
    expect(metrics.tokens.input).toBe(1);
    expect(metrics.tokens.output).toBe(2);
    expect(metrics.cost).toBe(0.5);
    expect(metrics.steps).toBe(0);
  });
});

describe("mergeMessages", () => {
  test("deduplicates by id and lets the live copy win", () => {
    const old = assistant({ id: "a1", created: 1000, output: 1 });
    const live = assistant({ id: "a1", created: 1000, output: 2 });
    const later = assistant({ id: "a2", created: 2000 });

    const merged = mergeMessages([old], [live, later]);
    expect(merged).toHaveLength(2);
    expect((merged[0] as SessionMessageAssistant).tokens?.output).toBe(2);
    expect(merged.map((message) => message.id)).toEqual(["a1", "a2"]);
  });

  test("drops timeline messages before the active history", () => {
    const oldUser = user("u1", 1000);
    const oldAssistant = assistant({ id: "a1", created: 1100 });
    const compaction = {
      type: "compaction",
      id: "c1",
      time: { created: 5000 },
      status: "completed",
      reason: "auto",
      summary: "summary",
    } as SessionMessageInfo;
    const active = assistant({ id: "a2", created: 6000 });
    const later = user("u2", 7000);

    const merged = mergeMessages(
      [compaction, active],
      [oldUser, oldAssistant, compaction, active, later],
    );

    expect(merged.map((message) => message.id)).toEqual(["c1", "a2", "u2"]);
  });

  test("returns the live window when there is no full history", () => {
    const message = assistant({ id: "a1" });
    expect(mergeMessages([], [message])).toEqual([message]);
  });
});

// Keep the ToolCall import used so the helper type stays checked.
const _toolType: ToolCall = { id: "t", name: "read", status: "ok" };
void _toolType;
