/**
 * Shared observability state for the GUI.
 *
 * The switch lives on the server (it gates the context hook), so every view
 * reads it over RPC. The state is process-wide, not per session: `StatsView`,
 * `StatsStrip` and `PromptView` share one signal instead of each keeping a
 * copy that could drift after a toggle.
 *
 * The document visibility signal lets the samplers and the header timer stop
 * while the window is hidden: a background window must not keep polling.
 */

import { createSignal, onMount } from "solid-js";
import type { MountedSession } from "@opencode/plugin/gui";

import { StatsRpc, type ObservabilityStatus } from "./contract";

const [status, setStatus] = createSignal<ObservabilityStatus | null>(null);
const [busy, setBusy] = createSignal(false);
const [hidden, setHidden] = createSignal(false);

let listening = false;
let inflight: Promise<void> | undefined;
let inflightDirectory: string | undefined;

/**
 * The server tsconfig has no DOM lib and still compiles this file, so read the
 * document structurally instead of relying on the global identifier.
 */
type DocumentLike = {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
};

function currentDocument(): DocumentLike | undefined {
  return (globalThis as { document?: DocumentLike }).document;
}

function ensureVisibility(): void {
  const doc = currentDocument();
  if (listening || !doc) return;
  listening = true;
  setHidden(doc.visibilityState === "hidden");
  doc.addEventListener("visibilitychange", () => {
    setHidden(doc.visibilityState === "hidden");
  });
}

function options(session: MountedSession) {
  return { location: { directory: session.directory } };
}

/** Reads the server switch. Coalesces concurrent callers on the same directory. */
export function refreshObservability(session: MountedSession): Promise<void> {
  if (!session.id) return Promise.resolve();
  if (inflight && inflightDirectory === session.directory) return inflight;
  inflightDirectory = session.directory;
  inflight = (async () => {
    try {
      const result = await session.server.client
        .rpc(StatsRpc)
        .observability({}, options(session));
      setStatus(result);
    } catch {
      // Keep the last known status; the panel still works with it.
    } finally {
      inflight = undefined;
      inflightDirectory = undefined;
    }
  })();
  return inflight;
}

/** Flips the switch and returns the new status (or null on failure). */
export async function setObservability(
  session: MountedSession,
  enabled: boolean,
): Promise<ObservabilityStatus | null> {
  if (!session.id || busy()) return null;
  setBusy(true);
  try {
    const result = await session.server.client
      .rpc(StatsRpc)
      .setObservability({ enabled }, options(session));
    setStatus(result);
    return result;
  } catch {
    return null;
  } finally {
    setBusy(false);
  }
}

/** Synchronous read for callers outside a component (commands, menu items). */
export const observabilityEnabled = () => status()?.enabled ?? true;

export function useObservability(session: MountedSession) {
  ensureVisibility();
  onMount(() => {
    void refreshObservability(session);
  });
  return {
    busy,
    hidden,
    /** Optimistic default: the pipeline starts enabled until storage says otherwise. */
    enabled: () => status()?.enabled ?? true,
    setEnabled: (enabled: boolean) => setObservability(session, enabled),
  };
}
