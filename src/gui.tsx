/**
 * Stats GUI — the `./gui-experimental` entry.
 *
 * The panel reads metrics from the live session data and the system prompt
 * over the server plugin's RPC (`StatsRpc`).
 */

import { Plugin } from "@opencode/plugin/gui";
import { setup } from "./gui/setup";

const definition = Plugin.define({
  stores: {},
  setup,
});

export default definition;
export type Definition = typeof definition;
