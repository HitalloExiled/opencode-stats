/**
 * Server-side RPC handlers for the Stats panel.
 *
 * Only the system prompt and the observability switch cross the RPC: the
 * composed prompt is built by the server and cannot be reconstructed in the
 * window, and the switch has to gate the server hook. All metrics stay in the
 * window.
 */

import type { RpcHandlers } from "@opencode/plugin/promise/rpc";

import {
  StatsRpc,
  type ObservabilityStatus,
  type PromptResult,
} from "./gui/contract.js";
import type { StatsRuntime } from "./runtime.js";

function status(runtime: StatsRuntime): ObservabilityStatus {
  const scheduler = runtime.scheduler.stats();
  return {
    enabled: runtime.observability.enabled,
    since: runtime.observability.since,
    sessions: runtime.store.size,
    bytes: runtime.store.bytes,
    pending: scheduler.pending,
    captured: scheduler.captured,
    coalesced: scheduler.coalesced,
    batches: scheduler.batches,
    maxLagMs: scheduler.maxLagMs,
    lastProcessMs: scheduler.lastProcessMs,
    maxProcessMs: scheduler.maxProcessMs,
  };
}

export function createRpcHandlers(runtime: StatsRuntime): RpcHandlers<typeof StatsRpc> {
  return {
    systemPrompt: async (input): Promise<PromptResult> => {
      const capture = runtime.store.peek(String(input.sessionID));
      if (!capture) return { status: "missing" };
      if (input.ifNoneMatch && input.ifNoneMatch === capture.hash) {
        return {
          status: "unchanged",
          hash: capture.hash,
          capturedAt: capture.capturedAt,
          requestCount: capture.requestCount,
        };
      }
      return { status: "capture", capture };
    },
    observability: async () => status(runtime),
    setObservability: async (input) => {
      await runtime.observability.setEnabled(Boolean(input.enabled));
      return status(runtime);
    },
  };
}
