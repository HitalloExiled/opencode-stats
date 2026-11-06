/**
 * Deferred, coalesced capture pipeline.
 *
 * `session.context` runs inside the model-request path, so the hook must not
 * build prompt parts or hash megabytes of text there: any work done inline
 * delays the request and distorts the very metrics this plugin measures.
 *
 * The hook only snapshots the `system` array and calls `enqueue`. This
 * scheduler keeps the latest snapshot per session and drains the batch on the
 * next `setImmediate` tick. Classification, byte counting and SHA-256 all run
 * there, off the request path.
 *
 * Coalescing is per session: a new request in the same session replaces the
 * previous pending snapshot (the prompt viewer only shows the latest one). A
 * turn with several steps is separated by seconds, so different requests are
 * normally processed on their own tick.
 */

import type { CaptureStore } from "./capture.js";
import type { CaptureInput } from "./prompt.js";

export type CaptureSchedulerStats = {
  /** Snapshots processed by the store. */
  captured: number;
  /** Snapshots replaced by a newer one before the flush ran. */
  coalesced: number;
  /** Flushes that processed at least one snapshot. */
  batches: number;
  /** Enqueues rejected because observability was off. */
  dropped: number;
  /** Capture failures swallowed by the scheduler. */
  errors: number;
  /** Snapshots waiting for the next flush. */
  pending: number;
  /** Longest time between an enqueue and the start of its flush. */
  maxLagMs: number;
  /** Duration of the most recent flush. */
  lastProcessMs: number;
  /** Longest flush observed. */
  maxProcessMs: number;
  /** Clock of the most recent flush, or undefined before the first one. */
  lastFlushAt: number | undefined;
};

export type CaptureSchedulerOptions = {
  store: Pick<CaptureStore, "capture">;
  /** Defers the flush. Defaults to `setImmediate`; injectable for tests. */
  schedule?: ((flush: () => void) => void) | undefined;
  /** Injectable clock, for tests. */
  now?: (() => number) | undefined;
  /** Swallows capture failures; defaults to a console warning. */
  onError?: ((error: unknown) => void) | undefined;
};

export type CaptureScheduler = {
  /** Queues the latest snapshot for a session. Never throws. */
  enqueue(input: CaptureInput): void;
  /** Drains the pending batch synchronously. Used by tests and teardown. */
  flushNow(): void;
  /** Drops every pending snapshot. */
  clear(): void;
  /** Gates the pipeline; disabling drops what is still pending. */
  setEnabled(enabled: boolean): void;
  readonly enabled: boolean;
  stats(): CaptureSchedulerStats;
};

const defaultSchedule = (flush: () => void): void => {
  setImmediate(flush);
};

const defaultError = (error: unknown): void => {
  const text = error instanceof Error ? error.message : String(error);
  console.error(`[stats] capture pipeline failed: ${text}`);
};

export function createCaptureScheduler(
  options: CaptureSchedulerOptions,
): CaptureScheduler {
  const store = options.store;
  const schedule = options.schedule ?? defaultSchedule;
  const clock = options.now ?? Date.now;
  const onError = options.onError ?? defaultError;

  const pending = new Map<string, { input: CaptureInput; at: number }>();
  let scheduled = false;
  let enabled = true;

  let captured = 0;
  let coalesced = 0;
  let batches = 0;
  let dropped = 0;
  let errors = 0;
  let maxLagMs = 0;
  let lastProcessMs = 0;
  let maxProcessMs = 0;
  let lastFlushAt: number | undefined;

  const flush = (): void => {
    scheduled = false;
    if (pending.size === 0) return;
    if (!enabled) {
      dropped += pending.size;
      pending.clear();
      return;
    }

    const batch = Array.from(pending.values());
    pending.clear();
    const started = clock();
    batches += 1;

    for (const entry of batch) {
      // A disable that lands mid-flush stops the remaining work right away.
      if (!enabled) {
        dropped += 1;
        continue;
      }
      const lag = started - entry.at;
      if (lag > maxLagMs) maxLagMs = lag;
      try {
        store.capture(entry.input);
        captured += 1;
      } catch (error) {
        errors += 1;
        onError(error);
      }
    }

    const elapsed = Math.max(0, clock() - started);
    lastProcessMs = elapsed;
    if (elapsed > maxProcessMs) maxProcessMs = elapsed;
    lastFlushAt = clock();
  };

  const enqueue = (input: CaptureInput): void => {
    if (!enabled) {
      dropped += 1;
      return;
    }
    const sessionID = String(input.sessionID);
    if (pending.has(sessionID)) coalesced += 1;
    pending.set(sessionID, { input, at: clock() });
    if (scheduled) return;
    scheduled = true;
    try {
      schedule(flush);
    } catch (error) {
      scheduled = false;
      errors += 1;
      onError(error);
    }
  };

  return {
    enqueue,
    flushNow: flush,
    clear() {
      pending.clear();
    },
    setEnabled(next) {
      enabled = next;
      if (!next) {
        dropped += pending.size;
        pending.clear();
      }
    },
    get enabled() {
      return enabled;
    },
    stats() {
      return {
        captured,
        coalesced,
        batches,
        dropped,
        errors,
        pending: pending.size,
        maxLagMs,
        lastProcessMs,
        maxProcessMs,
        lastFlushAt,
      };
    },
  };
}
