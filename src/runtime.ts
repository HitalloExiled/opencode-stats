/**
 * Process-global stats runtime: capture store, scheduler and observability.
 *
 * A hot reload registers a new RPC while an older route can still serve a
 * window, and the context hook that captures may belong to either generation.
 * Keeping the three objects on `globalThis` means every generation shares one
 * queue and one switch; a per-setup runtime would leak work from the previous
 * generation and could capture while the switch is off.
 *
 * The process exit reclaims the objects. Teardown intentionally does not clear
 * them: only the user's disable action does.
 */

import { createCaptureStore, type CaptureStore } from "./capture.js";
import {
  createObservability,
  type Observability,
  type ObservabilityStorage,
} from "./observability.js";
import { createCaptureScheduler, type CaptureScheduler } from "./scheduler.js";

export type StatsRuntime = {
  readonly store: CaptureStore;
  readonly scheduler: CaptureScheduler;
  readonly observability: Observability;
  /** Binds the current setup's storage handle and re-reads the persisted switch. */
  bindStorage(storage: ObservabilityStorage | undefined): Promise<void>;
};

const KEY = "__opencodeStatsRuntime__" as const;

type Globals = typeof globalThis & {
  __opencodeStatsRuntime__?: StatsRuntime;
};

export function statsRuntime(): StatsRuntime {
  const globals = globalThis as Globals;
  const existing = globals[KEY];
  if (existing) return existing;

  const store = createCaptureStore();
  const scheduler = createCaptureScheduler({ store });
  let storage: ObservabilityStorage | undefined;
  const observability = createObservability({
    storage: () => storage,
    store,
    scheduler,
  });

  const runtime: StatsRuntime = {
    store,
    scheduler,
    observability,
    async bindStorage(next) {
      storage = next;
      await observability.hydrate();
    },
  };
  globals[KEY] = runtime;
  return runtime;
}
