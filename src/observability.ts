/**
 * Observability switch: the process-wide on/off state of the capture pipeline.
 *
 * The state must be readable synchronously inside `session.context` (the hook
 * cannot await before deciding to snapshot), while it is persisted through the
 * server plugin storage so it survives restarts and hot reloads. The pattern
 * mirrors the plans plugin's `locale` key: the server context has no storage
 * of its own beyond `ctx.storage`, which is plugin-scoped.
 *
 * `enabled` flips in memory first, so the next request is gated immediately;
 * the write follows in the background, serialized to keep rapid toggles in
 * order. Disabling clears the captured prompts and any queued snapshot, so the
 * panel cannot show stale data for a state the user turned off.
 */

import type { Schema } from "effect";

import type { CaptureStore } from "./capture.js";
import type { CaptureScheduler } from "./scheduler.js";

export type ObservabilityStorage = {
  get(key: string): Promise<Schema.Json | undefined>;
  set(key: string, value: Schema.Json): Promise<void>;
};

export type ObservabilityOptions = {
  /** Resolved per call: the runtime binds the storage handle on each setup. */
  storage: () => ObservabilityStorage | undefined;
  store: Pick<CaptureStore, "clear">;
  scheduler: Pick<CaptureScheduler, "setEnabled">;
  /** Injectable clock, for tests. */
  now?: (() => number) | undefined;
  /** Storage key inside the plugin namespace. Defaults to `observability`. */
  key?: string;
  /** Swallows storage failures; defaults to a console warning. */
  onError?: ((error: unknown) => void) | undefined;
};

export type Observability = {
  readonly enabled: boolean;
  /** When the current state was applied. */
  readonly since: number;
  /** Reads the persisted value once; explicit toggles win over hydration. */
  hydrate(): Promise<void>;
  /** Applies immediately, then persists. Never rejects. */
  setEnabled(enabled: boolean): Promise<void>;
};

const defaultError = (error: unknown): void => {
  const text = error instanceof Error ? error.message : String(error);
  console.error(`[stats] could not persist observability: ${text}`);
};

export function createObservability(options: ObservabilityOptions): Observability {
  const clock = options.now ?? Date.now;
  const key = options.key ?? "observability";
  const onError = options.onError ?? defaultError;

  let enabled = true;
  let since = clock();
  // Once the user toggles, a late hydration must not overwrite the choice.
  let touched = false;
  let writeChain: Promise<void> = Promise.resolve();

  const apply = (next: boolean): void => {
    enabled = next;
    since = clock();
    options.scheduler.setEnabled(next);
    if (!next) options.store.clear();
  };

  const hydrate = async (): Promise<void> => {
    const storage = options.storage();
    if (!storage) return;
    try {
      const value = await storage.get(key);
      if (touched) return;
      if (typeof value !== "boolean") return;
      if (value !== enabled) apply(value);
    } catch (error) {
      onError(error);
    }
  };

  const persist = (value: boolean): Promise<void> => {
    const storage = options.storage();
    if (!storage) return writeChain;
    writeChain = writeChain.then(async () => {
      try {
        await storage.set(key, value);
      } catch (error) {
        onError(error);
      }
    });
    return writeChain;
  };

  return {
    get enabled() {
      return enabled;
    },
    get since() {
      return since;
    },
    hydrate,
    async setEnabled(next) {
      touched = true;
      if (next !== enabled) apply(next);
      await persist(next);
    },
  };
}
