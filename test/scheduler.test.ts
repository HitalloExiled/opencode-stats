/**
 * Deferred capture scheduler tests — coalescing, gating and metrics.
 *
 * The scheduler is the boundary between the request path and the expensive
 * prompt processing, so these tests inject both the scheduler tick and the
 * clock instead of waiting for real timers.
 */

import { describe, expect, test } from "bun:test";

import { createCaptureStore } from "../src/capture";
import type { PromptCapture } from "../src/gui/contract";
import type { CaptureInput } from "../src/prompt";
import {
  createCaptureScheduler,
  type CaptureScheduler,
} from "../src/scheduler";

const input = (sessionID: string, text: string): CaptureInput => ({
  sessionID,
  agent: "build",
  model: { providerID: "local", id: "bonsai" },
  system: [{ type: "text", text }],
});

function manualSchedule() {
  const queue: Array<() => void> = [];
  return {
    queue,
    schedule: (flush: () => void) => {
      queue.push(flush);
    },
  };
}

const captureStub = (): PromptCapture =>
  ({ hash: "hash", parts: [], totalBytes: 0 }) as unknown as PromptCapture;

describe("createCaptureScheduler", () => {
  test("coalesces per session and keeps the latest snapshot", () => {
    const { queue, schedule } = manualSchedule();
    const store = createCaptureStore({ now: () => 1000 });
    const scheduler = createCaptureScheduler({ store, schedule });

    scheduler.enqueue(input("s1", "one"));
    scheduler.enqueue(input("s1", "two"));
    scheduler.enqueue(input("s2", "three"));

    expect(queue).toHaveLength(1);
    expect(scheduler.stats().pending).toBe(2);

    queue.shift()!();

    expect(store.peek("s1")?.parts[0]!.text).toBe("two");
    expect(store.peek("s2")?.parts[0]!.text).toBe("three");
    expect(scheduler.stats()).toMatchObject({
      captured: 2,
      coalesced: 1,
      batches: 1,
      pending: 0,
    });
  });

  test("drops enqueues while disabled and clears pending on disable", () => {
    const { queue } = manualSchedule();
    const store = createCaptureStore();
    const scheduler = createCaptureScheduler({
      store,
      schedule: (flush) => queue.push(flush),
    });

    scheduler.enqueue(input("s1", "one"));
    expect(queue).toHaveLength(1);

    scheduler.setEnabled(false);
    expect(scheduler.stats()).toMatchObject({ pending: 0, dropped: 1 });

    scheduler.enqueue(input("s1", "two"));
    expect(scheduler.stats().dropped).toBe(2);

    // The already queued tick finds nothing to do.
    queue.shift()!();
    expect(scheduler.stats().captured).toBe(0);

    scheduler.setEnabled(true);
    scheduler.enqueue(input("s1", "three"));
    queue.shift()!();
    expect(store.peek("s1")?.parts[0]!.text).toBe("three");
  });

  test("clear drops pending work without counting it as processed", () => {
    const { queue } = manualSchedule();
    const scheduler = createCaptureScheduler({
      store: { capture: captureStub },
      schedule: (flush) => queue.push(flush),
    });

    scheduler.enqueue(input("s1", "one"));
    scheduler.clear();
    queue.shift()!();
    expect(scheduler.stats()).toMatchObject({ captured: 0, pending: 0, batches: 0 });
  });

  test("reports lag and processing time", () => {
    let clock = 100;
    const { queue } = manualSchedule();
    const scheduler = createCaptureScheduler({
      store: {
        capture: () => {
          clock += 4;
          return captureStub();
        },
      },
      schedule: (flush) => queue.push(flush),
      now: () => clock,
    });

    scheduler.enqueue(input("s1", "one"));
    clock = 130;
    queue.shift()!();

    expect(scheduler.stats()).toMatchObject({
      maxLagMs: 30,
      lastProcessMs: 4,
      maxProcessMs: 4,
      batches: 1,
    });
  });

  test("swallows capture failures and keeps draining the batch", () => {
    const errors: unknown[] = [];
    const { queue } = manualSchedule();
    let calls = 0;
    const scheduler = createCaptureScheduler({
      store: {
        capture: () => {
          calls += 1;
          if (calls === 1) throw new Error("boom");
          return captureStub();
        },
      },
      schedule: (flush) => queue.push(flush),
      onError: (error) => errors.push(error),
    });

    scheduler.enqueue(input("s1", "one"));
    scheduler.enqueue(input("s2", "two"));
    queue.shift()!();

    expect(errors).toHaveLength(1);
    expect(scheduler.stats()).toMatchObject({ errors: 1, captured: 1 });
  });

  test("schedules another flush when an enqueue lands during a flush", () => {
    const { queue } = manualSchedule();
    let scheduler: CaptureScheduler;
    let once = false;
    scheduler = createCaptureScheduler({
      store: {
        capture: () => {
          if (!once) {
            once = true;
            scheduler.enqueue(input("s2", "late"));
          }
          return captureStub();
        },
      },
      schedule: (flush) => queue.push(flush),
    });

    scheduler.enqueue(input("s1", "first"));
    queue.shift()!();

    expect(scheduler.stats().pending).toBe(1);
    expect(queue).toHaveLength(1);

    queue.shift()!();
    expect(scheduler.stats().captured).toBe(2);
  });
});
