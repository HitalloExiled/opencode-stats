/**
 * Server-side RPC handlers for the Stats panel.
 *
 * Only the system prompt crosses the RPC: it is built by the server and cannot
 * be reconstructed in the window. All metrics stay in the window.
 */

import type { RpcHandlers } from "@opencode/plugin/promise/rpc";

import { StatsRpc } from "./gui/contract.js";
import type { CaptureStore } from "./capture.js";

export function createRpcHandlers(store: CaptureStore): RpcHandlers<typeof StatsRpc> {
  return {
    systemPrompt: async (input) => {
      return store.get(String(input.sessionID));
    },
  };
}
