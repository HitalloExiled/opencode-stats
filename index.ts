/**
 * Stats plugin — server entry.
 *
 * The server is only responsible for capturing the composed system prompt:
 * the window cannot see the base prompt, the AGENTS.md instructions or the
 * blocks that notes/memory/plans push into `system`. The hook stores the last
 * capture per session in memory and the RPC serves it to the panel.
 *
 * Metrics and rate history are computed entirely in the GUI bundle.
 */

import { Plugin } from "@opencode/plugin";
import type { SessionContext } from "@opencode/plugin/promise/session";

import { createCaptureStore } from "./src/capture.js";
import { StatsRpc } from "./src/gui/contract.js";
import { createRpcHandlers } from "./src/rpc.js";

type Ctx = Plugin.Context;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The capture store is process-global, not per setup: a hot reload registers a
 * new RPC while an older route can still serve a window, and the context hook
 * that captures may belong to either generation. A shared store keeps the
 * prompt visible across reloads; the process exit reclaims it.
 */
const STORE_KEY = "__opencodeStatsCaptureStore__" as const;
const globals = globalThis as typeof globalThis & {
  __opencodeStatsCaptureStore__?: ReturnType<typeof createCaptureStore>;
};
const store = (globals[STORE_KEY] ??= createCaptureStore());

export default Plugin.define({
  id: "stats",
  async setup(ctx: Ctx) {
    const registrations = await Promise.all([
      ctx.session.hook("context", (event: SessionContext) => {
        try {
          store.capture({
            sessionID: String(event.sessionID),
            agent: String(event.agent),
            model: {
              providerID: String(event.model.providerID),
              id: String(event.model.id),
              ...(event.model.variant ? { variant: String(event.model.variant) } : {}),
            },
            system: event.system,
          });
        } catch (error) {
          // Never break a model request because the prompt viewer failed.
          console.error(`[stats] could not capture system prompt: ${errorText(error)}`);
        }
      }),
      ctx.rpc.register(StatsRpc, createRpcHandlers(store)),
    ]);

    return async () => {
      for (const registration of registrations) {
        await registration.dispose().catch(() => undefined);
      }
    };
  },
});
