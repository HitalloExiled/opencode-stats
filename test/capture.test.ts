/**
 * Capture store tests — deduplication, isolation and LRU eviction.
 */

import { describe, expect, test } from "bun:test";

import { createCaptureStore, hashPrompt } from "../src/capture";
import type { CaptureInput } from "../src/prompt";

let clock = 1000;
const now = () => clock;

const input = (sessionID: string, text: string, agent = "build"): CaptureInput => ({
  sessionID,
  agent,
  model: { providerID: "local", id: "bonsai" },
  system: [{ type: "text", text }],
});

describe("hashPrompt", () => {
  test("is stable and order-sensitive", () => {
    const a = hashPrompt([
      { key: "base", text: "one" },
      { key: "core/date", text: "two" },
    ]);
    const b = hashPrompt([
      { key: "base", text: "one" },
      { key: "core/date", text: "two" },
    ]);
    const c = hashPrompt([
      { key: "core/date", text: "two" },
      { key: "base", text: "one" },
    ]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(64);
  });
});

describe("createCaptureStore", () => {
  test("includes tool definitions in the hash and byte count", () => {
    const store = createCaptureStore({ now });
    const tools = {
      read: { description: "Read a file", input: { type: "object" } },
    };

    const withTools = store.capture({ ...input("s1", "prompt"), tools });
    expect(withTools.toolBytes).toBe(
      new TextEncoder().encode(JSON.stringify(tools)).length,
    );

    const withoutTools = store.capture({ ...input("s1", "prompt"), tools: {} });
    expect(withoutTools.toolBytes).toBe(2); // "{}"
    expect(withoutTools.hash).not.toBe(withTools.hash);
  });

  test("captures, deduplicates by hash and counts requests", () => {
    clock = 1000;
    const store = createCaptureStore({ now });

    const first = store.capture(input("s1", "prompt one"));
    expect(first.sessionID).toBe("s1");
    expect(first.capturedAt).toBe(1000);
    expect(first.requestCount).toBe(1);
    expect(first.parts[0]!.key).toBe("base");
    expect(first.hash).toHaveLength(64);

    clock = 2000;
    const second = store.capture(input("s1", "prompt one", "plan"));
    expect(second.hash).toBe(first.hash);
    expect(second.requestCount).toBe(2);
    expect(second.capturedAt).toBe(2000);
    expect(second.agent).toBe("plan");

    clock = 3000;
    const third = store.capture(input("s1", "prompt two"));
    expect(third.hash).not.toBe(first.hash);
    expect(third.requestCount).toBe(3);
  });

  test("isolates sessions and returns null for unknown ids", () => {
    const store = createCaptureStore({ now });
    store.capture(input("s1", "one"));
    store.capture(input("s2", "two"));

    expect(store.get("s1")?.parts[0]!.text).toBe("one");
    expect(store.get("s2")?.parts[0]!.text).toBe("two");
    expect(store.get("missing")).toBeNull();
  });

  test("evicts the least recently used session", () => {
    const store = createCaptureStore({ maxSessions: 2, now });
    store.capture(input("s1", "one"));
    store.capture(input("s2", "two"));
    store.get("s1"); // touch s1, s2 becomes the oldest
    store.capture(input("s3", "three"));

    expect(store.get("s1")).not.toBeNull();
    expect(store.get("s2")).toBeNull();
    expect(store.get("s3")).not.toBeNull();
  });

  test("respects the total byte budget", () => {
    const store = createCaptureStore({ maxTotalBytes: 10, now });
    store.capture(input("s1", "12345678"));
    store.capture(input("s2", "12345678"));

    expect(store.get("s1")).toBeNull();
    expect(store.get("s2")).not.toBeNull();
    expect(store.bytes).toBeGreaterThan(0);
  });

  test("keeps at least one capture even when it exceeds the budget", () => {
    const store = createCaptureStore({ maxTotalBytes: 1, now });
    store.capture(input("s1", "a long prompt"));
    expect(store.size).toBe(1);
    expect(store.get("s1")).not.toBeNull();
  });

  test("clears every session", () => {
    const store = createCaptureStore({ now });
    store.capture(input("s1", "one"));
    store.capture(input("s2", "two"));
    store.clear();
    expect(store.size).toBe(0);
    expect(store.bytes).toBe(0);
    expect(store.get("s1")).toBeNull();
  });
});
