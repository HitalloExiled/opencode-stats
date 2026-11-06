/**
 * Stats server/GUI contract.
 *
 * The window talks to the server plugin over RPC only for the system prompt:
 * the composed prompt exists only inside the server's session context hook, so
 * the server captures it per session and serves the last capture here.
 *
 * Metrics and rate history are computed in the window from
 * `session.server.data`; they do not cross this contract.
 */

import { Rpc } from "@opencode/schema/rpc";
import { Schema } from "effect";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type PromptGroup = "fixed" | "added" | "dynamic";

export type PromptSource = "base" | "core" | "instructions" | "api" | "plugin";

export type PromptPart = {
  /** 1-based position in the request's system array. */
  order: number;
  /** Stable key: `base`, `core/instructions`, `api/<key>`, `plugin/<tag>`. */
  key: string;
  /** Neutral fallback label; the GUI translates `labelKey` when present. */
  label: string;
  /** Translation key for known sources. */
  labelKey?: string | undefined;
  /** Extra detail such as the `api/` key. */
  detail?: string | undefined;
  group: PromptGroup;
  source: PromptSource;
  text: string;
  bytes: number;
};

export type PromptModel = {
  providerID: string;
  id: string;
  variant?: string | undefined;
};

export type PromptCapture = {
  sessionID: string;
  capturedAt: number;
  agent: string;
  model: PromptModel;
  parts: readonly PromptPart[];
  totalBytes: number;
  hash: string;
  requestCount: number;
};

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const optString = Schema.optional(Schema.String);

export const promptPartSchema = Schema.Struct({
  order: Schema.Number,
  key: Schema.String,
  label: Schema.String,
  labelKey: optString,
  detail: optString,
  group: Schema.Union([
    Schema.Literal("fixed"),
    Schema.Literal("added"),
    Schema.Literal("dynamic"),
  ]),
  source: Schema.Union([
    Schema.Literal("base"),
    Schema.Literal("core"),
    Schema.Literal("instructions"),
    Schema.Literal("api"),
    Schema.Literal("plugin"),
  ]),
  text: Schema.String,
  bytes: Schema.Number,
});

export const promptModelSchema = Schema.Struct({
  providerID: Schema.String,
  id: Schema.String,
  variant: optString,
});

export const promptCaptureSchema = Schema.Struct({
  sessionID: Schema.String,
  capturedAt: Schema.Number,
  agent: Schema.String,
  model: promptModelSchema,
  parts: Schema.Array(promptPartSchema),
  totalBytes: Schema.Number,
  hash: Schema.String,
  requestCount: Schema.Number,
});

/* ------------------------------------------------------------------ */
/* The RPC                                                             */
/* ------------------------------------------------------------------ */

export const StatsRpc = Rpc.define({
  id: "opencode.stats",
  methods: {
    systemPrompt: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.String })),
      output: Schema.toStandardSchemaV1(Schema.NullOr(promptCaptureSchema)),
    },
  },
  events: {},
});
