/**
 * Stats server/GUI contract.
 *
 * The window talks to the server plugin over RPC for the system prompt and for
 * the cost gateway: the composed prompt exists only inside the server's session
 * context hook, and the gateway key is stored on the server and never returns
 * to the window (only the spend it exposes does).
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
  /** Bytes of the tool definitions sent alongside `system`. */
  toolBytes: number;
  hash: string;
  requestCount: number;
};

/** `unchanged` skips the full payload when the caller already has the hash. */
export type PromptResult =
  | { status: "missing" }
  | {
      status: "unchanged";
      hash: string;
      capturedAt: number;
      requestCount: number;
    }
  | { status: "capture"; capture: PromptCapture };

/** Process-wide state of the capture pipeline, served to the panel. */
export type ObservabilityStatus = {
  enabled: boolean;
  /** When the current state was applied. */
  since: number;
  /** Sessions kept in the capture store. */
  sessions: number;
  /** Bytes kept in the capture store. */
  bytes: number;
  /** Snapshots waiting for the deferred flush. */
  pending: number;
  captured: number;
  coalesced: number;
  batches: number;
  maxLagMs: number;
  lastProcessMs: number;
  maxProcessMs: number;
};

/**
 * The key's spend as the gateway reports it.
 *
 * `status:"ok"` is the only one that carries numbers; `missingKey` is the
 * normal "not configured" state and `error` means the gateway could not be
 * read (no base URL, a rejected key, a network failure). The key itself never
 * appears here: it lives on the server only.
 */
export type GatewayInfo = {
  status: "ok" | "missingKey" | "error";
  /** A key is stored for the provider, even if the query failed. */
  hasKey: boolean;
  /** USD spent by the key, as the gateway counts it. */
  spend?: number | undefined;
  /** The key's budget in USD; `null` when it has none. */
  limit?: number | null | undefined;
  /** When the key's budget window resets, epoch milliseconds. */
  resetsAt?: number | null | undefined;
  /** Budget window as the gateway reports it, e.g. `30d`. */
  duration?: string | null | undefined;
  /** Failure detail for the card and the modal. */
  message?: string | undefined;
  /** The gateway rejected the key (401/403). */
  invalidKey?: boolean | undefined;
  /**
   * The key is valid, but the gateway blocks the management route `/key/info`
   * (LiteLLM `allowed_routes`). The card treats it as an unavailable gateway
   * instead of a rejected key.
   */
  routeBlocked?: boolean | undefined;
};

/** Result of saving a key: validated, stored-unvalidated or rejected. */
export type GatewayKeySave = {
  status: "ok" | "missingKey" | "invalid" | "unavailable";
  info: GatewayInfo;
  message?: string | undefined;
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
  toolBytes: Schema.Number,
  hash: Schema.String,
  requestCount: Schema.Number,
});

const promptMissingSchema = Schema.Struct({
  status: Schema.Literal("missing"),
});

const promptUnchangedSchema = Schema.Struct({
  status: Schema.Literal("unchanged"),
  hash: Schema.String,
  capturedAt: Schema.Number,
  requestCount: Schema.Number,
});

const promptCaptureResultSchema = Schema.Struct({
  status: Schema.Literal("capture"),
  capture: promptCaptureSchema,
});

export const promptResultSchema = Schema.Union([
  promptMissingSchema,
  promptUnchangedSchema,
  promptCaptureResultSchema,
]);

export const observabilityStatusSchema = Schema.Struct({
  enabled: Schema.Boolean,
  since: Schema.Number,
  sessions: Schema.Number,
  bytes: Schema.Number,
  pending: Schema.Number,
  captured: Schema.Number,
  coalesced: Schema.Number,
  batches: Schema.Number,
  maxLagMs: Schema.Number,
  lastProcessMs: Schema.Number,
  maxProcessMs: Schema.Number,
});

export const gatewayInfoSchema = Schema.Struct({
  status: Schema.Union([
    Schema.Literal("ok"),
    Schema.Literal("missingKey"),
    Schema.Literal("error"),
  ]),
  hasKey: Schema.Boolean,
  spend: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.NullOr(Schema.Number)),
  resetsAt: Schema.optional(Schema.NullOr(Schema.Number)),
  duration: Schema.optional(Schema.NullOr(Schema.String)),
  message: optString,
  invalidKey: Schema.optional(Schema.Boolean),
  routeBlocked: Schema.optional(Schema.Boolean),
});

export const gatewayKeySaveSchema = Schema.Struct({
  status: Schema.Union([
    Schema.Literal("ok"),
    Schema.Literal("missingKey"),
    Schema.Literal("invalid"),
    Schema.Literal("unavailable"),
  ]),
  info: gatewayInfoSchema,
  message: optString,
});

const systemPromptInputSchema = Schema.Struct({
  sessionID: Schema.String,
  /** Hash the caller already holds; a match returns `unchanged` without parts. */
  ifNoneMatch: optString,
});

const gatewayInputSchema = Schema.Struct({
  providerID: Schema.String,
});

const gatewayKeyInputSchema = Schema.Struct({
  providerID: Schema.String,
  /** Blank keeps the stored key; removal is its own action. */
  key: Schema.String,
});

/* ------------------------------------------------------------------ */
/* The RPC                                                             */
/* ------------------------------------------------------------------ */

export const StatsRpc = Rpc.define({
  id: "opencode.stats",
  methods: {
    systemPrompt: {
      input: Schema.toStandardSchemaV1(systemPromptInputSchema),
      output: Schema.toStandardSchemaV1(promptResultSchema),
    },
    observability: {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(observabilityStatusSchema),
    },
    setObservability: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ enabled: Schema.Boolean })),
      output: Schema.toStandardSchemaV1(observabilityStatusSchema),
    },
    gateway: {
      input: Schema.toStandardSchemaV1(gatewayInputSchema),
      output: Schema.toStandardSchemaV1(gatewayInfoSchema),
    },
    setGatewayKey: {
      input: Schema.toStandardSchemaV1(gatewayKeyInputSchema),
      output: Schema.toStandardSchemaV1(gatewayKeySaveSchema),
    },
    clearGatewayKey: {
      input: Schema.toStandardSchemaV1(gatewayInputSchema),
      output: Schema.toStandardSchemaV1(gatewayInfoSchema),
    },
  },
  events: {},
});
