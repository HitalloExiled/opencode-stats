/**
 * Stats RPC handler tests — prompt payloads and the observability switch.
 */

import { describe, expect, test } from "bun:test";

import { createCaptureStore } from "../src/capture";
import { createObservability, type ObservabilityStorage } from "../src/observability";
import type { CaptureInput } from "../src/prompt";
import { createRpcHandlers } from "../src/rpc";
import type { StatsRuntime } from "../src/runtime";
import { createCaptureScheduler } from "../src/scheduler";

const input = (sessionID: string, text: string): CaptureInput => ({
  sessionID,
  agent: "build",
  model: { providerID: "local", id: "bonsai" },
  system: [{ type: "text", text }],
});

type Unary<F> = F extends (input: infer I, ...rest: never[]) => infer R ? (input: I) => R : never;

function setup(initial?: boolean) {
  const store = createCaptureStore({ now: () => 1000 });
  const scheduler = createCaptureScheduler({ store });
  const values = new Map<string, unknown>();
  if (initial !== undefined) values.set("observability", initial);
  const writes: unknown[] = [];
  const storage = {
    get: async (key: string) => values.get(key),
    set: async (key: string, value: unknown) => {
      values.set(key, value);
      writes.push(value);
    },
  } as unknown as ObservabilityStorage;
  const observability = createObservability({
    storage: () => storage,
    store,
    scheduler,
    now: () => 1000,
  });
  const runtime = {
    store,
    scheduler,
    observability,
    bindStorage: async () => undefined,
  } as StatsRuntime;
  const handlers = createRpcHandlers(runtime) as unknown as {
    [K in keyof ReturnType<typeof createRpcHandlers>]: Unary<
      ReturnType<typeof createRpcHandlers>[K]
    >;
  };
  return { store, scheduler, observability, values, writes, handlers };
}

describe("stats RPC handlers", () => {
  test("observability reports the initial enabled state", async () => {
    const { handlers } = setup();

    const status = await handlers.observability({});

    expect(status.enabled).toBe(true);
    expect(status.since).toBe(1000);
    expect(status.sessions).toBe(0);
    expect(status.bytes).toBe(0);
    expect(status.pending).toBe(0);
  });

  test("setObservability persists and clears the captures", async () => {
    const { store, values, writes, handlers } = setup(true);
    store.capture(input("s1", "one"));
    expect(store.size).toBe(1);

    const status = await handlers.setObservability({ enabled: false });

    expect(status.enabled).toBe(false);
    expect(status.sessions).toBe(0);
    expect(values.get("observability")).toBe(false);
    expect(writes).toEqual([false]);

    const back = await handlers.setObservability({ enabled: true });
    expect(back.enabled).toBe(true);
    expect(values.get("observability")).toBe(true);
  });

  test("systemPrompt reports a missing capture", async () => {
    const { handlers } = setup();
    const result = await handlers.systemPrompt({ sessionID: "missing" });
    expect(result.status).toBe("missing");
  });

  test("systemPrompt returns the capture and supports ifNoneMatch", async () => {
    const { store, handlers } = setup();
    const capture = store.capture(input("s1", "one"));

    const fresh = await handlers.systemPrompt({ sessionID: "s1" });
    expect(fresh.status).toBe("capture");
    if (fresh.status !== "capture") throw new Error("expected a capture");
    expect(fresh.capture.parts[0]!.text).toBe("one");

    const unchanged = await handlers.systemPrompt({
      sessionID: "s1",
      ifNoneMatch: capture.hash,
    });
    expect(unchanged.status).toBe("unchanged");
    if (unchanged.status !== "unchanged") throw new Error("expected unchanged");
    expect(unchanged.hash).toBe(capture.hash);
    expect(unchanged.requestCount).toBe(1);

    const changed = await handlers.systemPrompt({
      sessionID: "s1",
      ifNoneMatch: "stale-hash",
    });
    expect(changed.status).toBe("capture");
  });
});
