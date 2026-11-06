/**
 * Stats plugin — server entry.
 *
 * The server is only responsible for capturing the composed system prompt:
 * the window cannot see the base prompt, the AGENTS.md instructions or the
 * blocks that notes/memory/plans push into `system`.
 *
 * Capture is deliberately non-blocking. The `context` hook covers normal agent
 * steps and the `compaction` hook covers the summarization request (the server
 * routes it through a separate hook, so `context` never sees it). Both only
 * snapshot the `system` array and hand it to the global scheduler; building
 * parts, counting bytes and hashing run on a later tick. Doing that work inline
 * would delay the request and distort the tok/s metrics this plugin measures.
 *
 * Metrics and rate history are computed entirely in the GUI bundle.
 */

import { Plugin } from "@opencode/plugin";
import type {
  SessionCompaction,
  SessionContext,
} from "@opencode/plugin/promise/session";

import { StatsRpc } from "./src/gui/contract.js";
import { createRpcHandlers } from "./src/rpc.js";
import { statsRuntime } from "./src/runtime.js";

type Ctx = Plugin.Context;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Store, scheduler and switch are process-global (see `src/runtime.ts`) so a
 * hot reload keeps one queue and one switch across generations.
 */
const runtime = statsRuntime();

/**
 * Snapshots one model request's system array. Shared by the `context` hook
 * (normal agent steps) and the `compaction` hook (the summarization request
 * uses its own hook on the server, so `context` alone never sees it).
 */
function capture(event: SessionContext): void {
  if (!runtime.observability.enabled) return;
  try {
    runtime.scheduler.enqueue({
      sessionID: String(event.sessionID),
      agent: String(event.agent),
      model: {
        providerID: String(event.model.providerID),
        id: String(event.model.id),
        ...(event.model.variant ? { variant: String(event.model.variant) } : {}),
      },
      // Shallow copy only: the array is cheap, the strings are immutable.
      system: event.system.slice(),
    });
  } catch (error) {
    // Never break a model request because the prompt viewer failed.
    console.error(`[stats] could not queue system prompt: ${errorText(error)}`);
  }
}

export default Plugin.define({
  id: "stats",
  async setup(ctx: Ctx) {
    // Hydration is async because storage is async; the hook keeps its
    // synchronous default (enabled) until the stored value arrives. A stored
    // `false` clears whatever was captured in the meantime.
    void runtime.bindStorage(ctx.storage).catch((error: unknown) => {
      console.error(`[stats] could not read observability: ${errorText(error)}`);
    });

    const registrations = await Promise.all([
      ctx.session.hook("context", capture),
      ctx.session.hook("compaction", (event: SessionCompaction) => {
        // A previous hook supplied the summary, so no model request is made
        // and there is no system prompt to capture.
        if (event.result) return;
        capture(event);
      }),
      ctx.rpc.register(StatsRpc, createRpcHandlers(runtime)),
    ]);

    return async () => {
      for (const registration of registrations) {
        await registration.dispose().catch(() => undefined);
      }
    };
  },
});
