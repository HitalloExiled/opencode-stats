/**
 * Pure metrics over the session transcript.
 *
 * The tok/s formula is the same one the TUI uses: output plus reasoning tokens
 * weighted by each step's provider-active duration (`streamed - created`), not
 * wall-clock time (which would include tool execution and thinking pauses).
 *
 * While a step streams, `estimateLiveRate` estimates tokens from the text
 * received so far (~4 characters per token) over the elapsed time. The estimate
 * is always shown with a `~` and replaced by the exact value when the step ends.
 */

import type {
  ModelRef,
  SessionMessageAssistant,
  SessionMessageInfo,
  TokenUsageInfo,
} from "@opencode/client";

export type ToolStatus = "ok" | "error" | "running";

export type ToolCall = {
  id: string;
  name: string;
  status: ToolStatus;
  durationMs?: number | undefined;
  /** Start of the call, for a live elapsed while it runs. */
  startedAt?: number | undefined;
  /** Short argument summary, e.g. a path or command. */
  detail?: string | undefined;
};

export type StepMetrics = {
  message: SessionMessageAssistant;
  durationMs?: number | undefined;
  streamMs?: number | undefined;
  rate?: number | undefined;
  outputTokens: number;
  reasoningTokens: number;
  /** Estimated tokens of the reasoning text (characters ÷ 4). */
  reasoningTextTokens: number;
  /** Estimated tokens returned by this step's tools. */
  toolTokens: number;
  reasoningMs: number;
  firstTokenMs?: number | undefined;
  toolCalls: ToolCall[];
};

export type Turn = {
  prompt?: SessionMessageInfo | undefined;
  messages: SessionMessageInfo[];
  assistants: SessionMessageAssistant[];
  closed: boolean;
};

export type TurnMetrics = {
  promptID?: string | undefined;
  promptAt?: number | undefined;
  steps: StepMetrics[];
  durationMs?: number | undefined;
  rate?: number | undefined;
  liveRate?: number | undefined;
  outputTokens: number;
  reasoningTokens: number;
  reasoningMs: number;
  firstTokenMs?: number | undefined;
  toolCalls: ToolCall[];
  running: boolean;
  model?: ModelRef | undefined;
  agent?: string | undefined;
};

export type ToolStat = {
  name: string;
  calls: number;
  ok: number;
  error: number;
  running: number;
  totalMs: number;
  averageMs?: number | undefined;
};

export type ModelStat = {
  providerID: string;
  id: string;
  variant?: string | undefined;
  label: string;
  steps: number;
  tokens: TokenUsageInfo;
  cost: number;
};

/** Usage of one completed request: its prompt plus the tool estimates inside it. */
export type RequestUsage = {
  tokens: TokenUsageInfo;
  toolTokens: number;
  /** Estimated reasoning-text tokens of the step, used when the provider reports none. */
  reasoningTextTokens: number;
  /** Model that served the request, used to look up its context-window limit. */
  model: ModelRef;
};

export type SessionMetrics = {
  turns: number;
  steps: number;
  messages: number;
  tokens: TokenUsageInfo;
  /** Estimated tokens returned by tools (content characters ÷ 4). */
  toolTokens: number;
  /** Estimated tokens of all reasoning text (characters ÷ 4), a fallback. */
  reasoningTextTokens: number;
  /** Usage of the last completed request in the active history. */
  lastRequest?: RequestUsage | undefined;
  cost: number;
  firstAt?: number | undefined;
  lastAt?: number | undefined;
  averageStepMs?: number | undefined;
  averageTurnMs?: number | undefined;
  rate?: number | undefined;
  maxRate?: number | undefined;
  reasoningMs: number;
  toolCalls: ToolCall[];
  tools: ToolStat[];
  models: ModelStat[];
};

export const emptyTokens = (): TokenUsageInfo => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
});

export function addTokens(target: TokenUsageInfo, source: TokenUsageInfo | undefined): TokenUsageInfo {
  if (!source) return target;
  target.input += source.input;
  target.output += source.output;
  target.reasoning += source.reasoning;
  target.cache.read += source.cache.read;
  target.cache.write += source.cache.write;
  return target;
}

export function totalTokens(tokens: TokenUsageInfo): number {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write;
}

export function isAssistant(message: SessionMessageInfo): message is SessionMessageAssistant {
  return message.type === "assistant";
}

const isPrompt = (message: SessionMessageInfo): boolean =>
  message.type === "user" || message.type === "synthetic";

const toolStatus = (part: Extract<SessionMessageAssistant["content"][number], { type: "tool" }>): ToolStatus => {
  if (part.state.status === "completed") return "ok";
  if (part.state.status === "error") return "error";
  return "running";
};

const toolStart = (part: Extract<SessionMessageAssistant["content"][number], { type: "tool" }>): number =>
  part.time.ran ?? part.time.created;

const DETAIL_KEYS = [
  "description",
  "command",
  "filePath",
  "path",
  "pattern",
  "query",
  "url",
  "prompt",
  "name",
] as const;

function toolDetail(
  part: Extract<SessionMessageAssistant["content"][number], { type: "tool" }>,
): string | undefined {
  if (part.state.status === "streaming") return undefined;
  const input = part.state.input;
  for (const key of DETAIL_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      const text = value.replace(/\s+/g, " ").trim();
      return text.length > 64 ? `${text.slice(0, 63)}…` : text;
    }
  }
  return undefined;
}

/**
 * Estimated tokens a tool returned to the context, from its text content.
 *
 * Providers do not report tool-result tokens separately; the next request
 * sends them back as input. Characters ÷ 4 is the same rough ratio the live
 * tok/s estimate uses. File parts carry no content, so only text counts.
 */
export function toolResultTokens(
  part: Extract<SessionMessageAssistant["content"][number], { type: "tool" }>,
): number {
  const state = part.state;
  if (state.status !== "completed" && state.status !== "error") return 0;
  const content = state.content;
  if (!content) return 0;
  let chars = 0;
  for (const item of content) {
    if (item.type === "text") chars += item.text.length;
  }
  return Math.ceil(chars / 4);
}

export function toolCallFromPart(
  part: Extract<SessionMessageAssistant["content"][number], { type: "tool" }>,
): ToolCall {
  const status = toolStatus(part);
  const startedAt = toolStart(part);
  const detail = toolDetail(part);
  return {
    id: part.id,
    name: part.name,
    status,
    ...(part.time.completed !== undefined
      ? { durationMs: Math.max(0, part.time.completed - startedAt) }
      : {}),
    ...(status === "running" ? { startedAt } : {}),
    ...(detail ? { detail } : {}),
  };
}

/** Exact and estimated metrics for one assistant step. */
export function stepMetrics(message: SessionMessageAssistant): StepMetrics {
  const tokens = message.tokens;
  const output = (tokens?.output ?? 0) + (tokens?.reasoning ?? 0);
  const reasoning = tokens?.reasoning ?? 0;
  const completed = message.time.completed;
  const streamed = message.time.streamed;
  const durationMs =
    completed !== undefined ? Math.max(0, completed - message.time.created) : undefined;
  const streamMs =
    streamed !== undefined ? Math.max(0, streamed - message.time.created) : undefined;
  const rate =
    streamMs !== undefined && streamMs > 0 && output > 0 ? output / (streamMs / 1000) : undefined;

  let reasoningMs = 0;
  let reasoningChars = 0;
  let firstTokenMs: number | undefined;
  const toolCalls: ToolCall[] = [];
  let toolTokens = 0;

  for (const part of message.content) {
    if (part.type === "reasoning") {
      reasoningChars += part.text.length;
      const started = part.time?.created;
      const ended = part.time?.completed;
      if (started !== undefined && ended !== undefined) reasoningMs += Math.max(0, ended - started);
      if (started !== undefined) {
        const delta = Math.max(0, started - message.time.created);
        firstTokenMs = firstTokenMs === undefined ? delta : Math.min(firstTokenMs, delta);
      }
      continue;
    }
    if (part.type === "tool") {
      toolCalls.push(toolCallFromPart(part));
      toolTokens += toolResultTokens(part);
      const delta = Math.max(0, part.time.created - message.time.created);
      firstTokenMs = firstTokenMs === undefined ? delta : Math.min(firstTokenMs, delta);
    }
  }

  return {
    message,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(streamMs !== undefined ? { streamMs } : {}),
    ...(rate !== undefined ? { rate } : {}),
    outputTokens: output,
    reasoningTokens: reasoning,
    reasoningTextTokens: Math.ceil(reasoningChars / 4),
    toolTokens,
    reasoningMs,
    ...(firstTokenMs !== undefined ? { firstTokenMs } : {}),
    toolCalls,
  };
}

/** Groups messages into turns: a user/synthetic prompt starts one, an idle marker closes it. */
export function findTurns(messages: readonly SessionMessageInfo[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | undefined;

  const flush = () => {
    if (!current) return;
    turns.push(current);
    current = undefined;
  };

  for (const message of messages) {
    if (isPrompt(message)) {
      flush();
      current = { prompt: message, messages: [message], assistants: [], closed: false };
      continue;
    }
    if (message.type === "idle") {
      if (!current) continue;
      current.messages.push(message);
      current.closed = true;
      flush();
      continue;
    }
    if (!current) current = { messages: [], assistants: [], closed: false };
    current.messages.push(message);
    if (isAssistant(message)) current.assistants.push(message);
  }
  flush();
  return turns;
}

/** Live tok/s estimate from the text received so far. */
export function estimateLiveRate(message: SessionMessageAssistant, now: number): number | undefined {
  let chars = 0;
  for (const part of message.content) {
    if (part.type === "text") {
      chars += part.text.length;
      continue;
    }
    if (part.type === "reasoning") {
      chars += part.text.length;
      continue;
    }
    if (part.type === "tool") {
      if (part.state.status === "streaming") chars += part.state.input.length;
      else chars += JSON.stringify(part.state.input ?? {}).length;
    }
  }
  if (chars < 8) return undefined;
  const elapsed = Math.max(250, now - message.time.created);
  return chars / 4 / (elapsed / 1000);
}

/** Canonical turn rate: every step must have streamed; tool wait is excluded. */
export function canonicalRate(steps: readonly SessionMessageAssistant[]): number | undefined {
  if (steps.length === 0) return undefined;
  const durations = steps.flatMap((step) =>
    step.time.streamed === undefined ? [] : [Math.max(0, step.time.streamed - step.time.created)],
  );
  if (durations.length !== steps.length) return undefined;
  const output = steps.reduce(
    (sum, step) => sum + (step.tokens?.output ?? 0) + (step.tokens?.reasoning ?? 0),
    0,
  );
  const total = durations.reduce((sum, value) => sum + value, 0);
  if (output <= 0 || total <= 0) return undefined;
  return output / (total / 1000);
}

export function analyzeTurn(turn: Turn, now: number, running: boolean): TurnMetrics {
  const steps = turn.assistants.map(stepMetrics);
  const last = steps[steps.length - 1];
  const first = steps[0];
  const promptAt = turn.prompt?.time.created;

  let durationMs: number | undefined;
  if (promptAt !== undefined) {
    if (last?.message.time.completed !== undefined) {
      durationMs = Math.max(0, last.message.time.completed - promptAt);
    } else if (running) {
      durationMs = Math.max(0, now - promptAt);
    }
  }

  const rate = canonicalRate(turn.assistants);
  const liveRate =
    running && last && last.message.time.completed === undefined
      ? estimateLiveRate(last.message, now)
      : undefined;

  return {
    ...(turn.prompt ? { promptID: turn.prompt.id, promptAt } : {}),
    steps,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(rate !== undefined ? { rate } : {}),
    ...(liveRate !== undefined ? { liveRate } : {}),
    outputTokens: steps.reduce((sum, step) => sum + step.outputTokens, 0),
    reasoningTokens: steps.reduce((sum, step) => sum + step.reasoningTokens, 0),
    reasoningMs: steps.reduce((sum, step) => sum + step.reasoningMs, 0),
    ...(first?.firstTokenMs !== undefined ? { firstTokenMs: first.firstTokenMs } : {}),
    toolCalls: steps.flatMap((step) => step.toolCalls),
    running,
    ...(last?.message.model ? { model: last.message.model } : {}),
    ...(last?.message.agent ? { agent: last.message.agent } : {}),
  };
}

function messageUsage(message: SessionMessageInfo): { tokens?: TokenUsageInfo; cost?: number } {
  if (message.type === "assistant") return { tokens: message.tokens, cost: message.cost };
  if (message.type === "compaction" && message.status !== "running") {
    return { tokens: message.tokens, cost: message.cost };
  }
  return {};
}

export function modelKey(model: ModelRef): string {
  return `${model.providerID}/${model.id}#${model.variant ?? ""}`;
}

export function analyzeSession(messages: readonly SessionMessageInfo[]): SessionMetrics {
  const turns = findTurns(messages);
  const assistants = messages.filter(isAssistant);
  const steps = assistants.map(stepMetrics);

  const tokens = emptyTokens();
  let cost = 0;
  let firstAt: number | undefined;
  let lastAt: number | undefined;

  for (const message of messages) {
    const createdAt = message.time.created;
    if (firstAt === undefined || createdAt < firstAt) firstAt = createdAt;
    if (lastAt === undefined || createdAt > lastAt) lastAt = createdAt;
    const usage = messageUsage(message);
    addTokens(tokens, usage.tokens);
    cost += usage.cost ?? 0;
  }

  const stepDurations = steps.flatMap((step) =>
    step.durationMs === undefined ? [] : [step.durationMs],
  );
  const turnDurations = turns.flatMap((turn) => {
    const promptAt = turn.prompt?.time.created;
    const last = turn.assistants.at(-1);
    if (promptAt === undefined || last?.time.completed === undefined) return [];
    return [Math.max(0, last.time.completed - promptAt)];
  });

  const ratedSteps = steps.filter(
    (step) => step.rate !== undefined && step.streamMs !== undefined && step.streamMs > 0,
  );
  const ratedOutput = ratedSteps.reduce((sum, step) => sum + step.outputTokens, 0);
  const ratedMs = ratedSteps.reduce((sum, step) => sum + (step.streamMs ?? 0), 0);
  const rate = ratedOutput > 0 && ratedMs > 0 ? ratedOutput / (ratedMs / 1000) : undefined;
  const maxRate =
    steps.length === 0
      ? undefined
      : steps.reduce<number | undefined>(
          (max, step) => (step.rate === undefined ? max : max === undefined ? step.rate : Math.max(max, step.rate)),
          undefined,
        );

  const tools = new Map<string, ToolStat>();
  const models = new Map<string, ModelStat>();
  let toolTokens = 0;
  let reasoningTextTokens = 0;
  let lastRequest: RequestUsage | undefined;
  for (const step of steps) {
    toolTokens += step.toolTokens;
    reasoningTextTokens += step.reasoningTextTokens;
    if (step.message.tokens && step.message.time.completed !== undefined) {
      lastRequest = {
        tokens: step.message.tokens,
        toolTokens: step.toolTokens,
        reasoningTextTokens: step.reasoningTextTokens,
        model: step.message.model,
      };
    }
    for (const call of step.toolCalls) {
      const stat = tools.get(call.name) ?? {
        name: call.name,
        calls: 0,
        ok: 0,
        error: 0,
        running: 0,
        totalMs: 0,
      };
      stat.calls++;
      if (call.status === "ok") stat.ok++;
      else if (call.status === "error") stat.error++;
      else stat.running++;
      if (call.durationMs !== undefined) stat.totalMs += call.durationMs;
      tools.set(call.name, stat);
    }

    const model = step.message.model;
    const key = modelKey(model);
    const stat = models.get(key) ?? {
      providerID: String(model.providerID),
      id: String(model.id),
      ...(model.variant ? { variant: String(model.variant) } : {}),
      label: String(model.id),
      steps: 0,
      tokens: emptyTokens(),
      cost: 0,
    };
    stat.steps++;
    addTokens(stat.tokens, step.message.tokens);
    stat.cost += step.message.cost ?? 0;
    models.set(key, stat);
  }

  const toolList = Array.from(tools.values())
    .map((stat) => {
      const finished = stat.ok + stat.error;
      return {
        ...stat,
        ...(finished > 0 ? { averageMs: stat.totalMs / finished } : {}),
      };
    })
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));

  return {
    turns: turns.length,
    steps: assistants.length,
    messages: messages.length,
    tokens,
    toolTokens,
    ...(lastRequest ? { lastRequest } : {}),
    cost,
    ...(firstAt !== undefined ? { firstAt } : {}),
    ...(lastAt !== undefined ? { lastAt } : {}),
    ...(stepDurations.length > 0
      ? { averageStepMs: stepDurations.reduce((sum, value) => sum + value, 0) / stepDurations.length }
      : {}),
    ...(turnDurations.length > 0
      ? { averageTurnMs: turnDurations.reduce((sum, value) => sum + value, 0) / turnDurations.length }
      : {}),
    ...(rate !== undefined ? { rate } : {}),
    ...(maxRate !== undefined ? { maxRate } : {}),
    reasoningMs: steps.reduce((sum, step) => sum + step.reasoningMs, 0),
    reasoningTextTokens,
    toolCalls: steps.flatMap((step) => step.toolCalls),
    tools: toolList,
    models: Array.from(models.values()).sort((a, b) => b.steps - a.steps || a.label.localeCompare(b.label)),
  };
}

/** Latest turn with assistant steps, preferring the current/last one. */
export function lastAssistantTurn(turns: readonly Turn[]): Turn | undefined {
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    if (turn && turn.assistants.length > 0) return turn;
  }
  return undefined;
}

/** Merges the full-history fetch with the windowed, live messages, preferring the live copy. */
export function mergeMessages(
  full: readonly SessionMessageInfo[],
  loaded: readonly SessionMessageInfo[],
): SessionMessageInfo[] {
  if (full.length === 0) return [...loaded];
  const byID = new Map<string, SessionMessageInfo>();
  let activeFrom = Number.POSITIVE_INFINITY;
  for (const message of full) {
    byID.set(message.id, message);
    if (message.time.created < activeFrom) activeFrom = message.time.created;
  }
  // `session.context` returns the active history: all messages after the last
  // compaction. The timeline keeps the pre-compaction window on screen, so a
  // plain union would re-add those old messages and restore the totals the
  // compaction reset. Only messages inside the active range (or newer) join,
  // and a live copy still wins by id.
  for (const message of loaded) {
    if (byID.has(message.id)) byID.set(message.id, message);
    else if (message.time.created >= activeFrom) byID.set(message.id, message);
  }
  return Array.from(byID.values()).sort((a, b) => {
    const delta = a.time.created - b.time.created;
    return delta !== 0 ? delta : a.id.localeCompare(b.id);
  });
}
