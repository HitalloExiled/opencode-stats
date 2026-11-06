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
  /** Bump when the store/scheduler/observability shape changes. */
  readonly version: number;
  readonly store: CaptureStore;
  readonly scheduler: CaptureScheduler;
  readonly observability: Observability;
  /** Binds the current setup's storage handle and re-reads the persisted switch. */
  bindStorage(storage: ObservabilityStorage | undefined): Promise<void>;
};

const KEY = "__opencodeStatsRuntime__" as const;
/**
 * The runtime survives hot reloads, so a plugin update that changes the store
 * shape must replace the instance: otherwise new handlers call methods the old
 * store never had (e.g. `peek`). Bump this whenever that contract changes.
 */
const RUNTIME_VERSION = 2;

type Globals = typeof globalThis & {
  __opencodeStatsRuntime__?: StatsRuntime;
};

export function statsRuntime(): StatsRuntime {
  const globals = globalThis as Globals;
  const existing = globals[KEY];
  if (existing?.version === RUNTIME_VERSION) return existing;
  // Drop the previous generation's work; any in-flight request recaptures with
  // the new hook, and the old hook is disposed by its own teardown.
  if (existing) {
    existing.scheduler.clear();
    existing.store.clear();
  }

  const store = createCaptureStore();
  const scheduler = createCaptureScheduler({ store });
  let storage: ObservabilityStorage | undefined;
  const observability = createObservability({
    storage: () => storage,
    store,
    scheduler,
  });

  const runtime: StatsRuntime = {
    version: RUNTIME_VERSION,
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
