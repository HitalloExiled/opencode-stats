/**
 * LiteLLM gateway spend.
 *
 * The cost card can read the key's real spend from the gateway that serves the
 * provider (`GET {baseURL}/key/info`) instead of relying only on the manual
 * "already spent" field. The key is typed in the config modal and stored on the
 * **server** under this plugin's storage; it is used only by the fetch here and
 * never returns to the window (the RPC carries spend, not credentials).
 *
 * The endpoint is LiteLLM-shaped: `info.spend` (USD), `info.max_budget` (null
 * when unlimited), `info.budget_duration` and `info.budget_reset_at`. The base
 * URL comes from the provider's own settings (`settings.baseURL`), so the panel
 * follows whatever provider the user selected.
 *
 * Everything is injectable (storage, provider lookup, fetch, clock) so the
 * parsing, the cache and the save rules are testable without a gateway.
 */

import type { Schema } from "effect";

import type { GatewayInfo, GatewayKeySave } from "./gui/contract.js";

const KEY_PREFIX = "gateway.key.";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CACHE_MS = 30_000;

/** The slice of the plugin storage the gateway needs. */
export type GatewayStorage = {
  get(key: string): Promise<Schema.Json | undefined>;
  set(key: string, value: Schema.Json): Promise<void>;
  remove(key: string): Promise<void>;
};

/** `ctx.provider`: the HTTP provider lookup of the server. */
export type GatewayProviders = {
  get(input: {
    providerID: string;
    location?: { directory?: string };
  }): Promise<unknown>;
};

/** The response slice the gateway reads from `fetch`. */
export type GatewayFetchResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  /** Error bodies are read as text first so a non-JSON page still has a hint. */
  text?(): Promise<string>;
};

export type GatewayFetch = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<GatewayFetchResponse>;

export type GatewayQueryOptions = {
  /** Ignore the cache (used right after a key change). */
  fresh?: boolean;
};

export type Gateway = {
  query(providerID: string, options?: GatewayQueryOptions): Promise<GatewayInfo>;
  setKey(providerID: string, key: string): Promise<GatewayKeySave>;
  clearKey(providerID: string): Promise<GatewayInfo>;
};

export type GatewayOptions = {
  storage: GatewayStorage;
  providers: GatewayProviders;
  fetch?: GatewayFetch;
  now?: () => number;
  timeoutMs?: number;
  cacheMs?: number;
  /** Location sent with the provider lookup. */
  directory?: string;
};

/** What one `/key/info` answer carries. */
export type GatewaySpend = {
  spend: number;
  limit: number | null;
  resetsAt: number | null;
  duration: string | null;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Epoch milliseconds from a number (seconds or ms) or an ISO string. */
function asTimestamp(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    // LiteLLM sometimes exposes seconds; anything past 2001 is already ms.
    return value > 0 && value < 1e12 ? Math.round(value * 1000) : value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Reads the provider's `settings.baseURL`, without the trailing slash. */
export function gatewayBaseURL(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const data = (result as { data?: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  const settings = (data as { settings?: unknown }).settings;
  if (!settings || typeof settings !== "object") return undefined;
  const raw = (settings as Record<string, unknown>).baseURL;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  return trimmed.replace(/\/+$/, "");
}

/** Normalizes a `/key/info` payload; `undefined` when it is not that shape. */
export function parseGatewayPayload(payload: unknown): GatewaySpend | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const info = (payload as { info?: unknown }).info;
  if (!info || typeof info !== "object") return undefined;
  const record = info as Record<string, unknown>;
  const spend = asNumber(record.spend);
  if (spend === undefined || spend < 0) return undefined;
  const budget = record.max_budget;
  const limit =
    budget === null || budget === undefined ? null : (asNumber(budget) ?? null);
  const duration =
    typeof record.budget_duration === "string" && record.budget_duration.trim() !== ""
      ? record.budget_duration.trim()
      : null;
  return { spend, limit, resetsAt: asTimestamp(record.budget_reset_at), duration };
}

type Probe =
  | { kind: "ok"; data: GatewaySpend }
  | { kind: "invalid"; message: string }
  | { kind: "error"; message: string; routeBlocked?: boolean };

/** Longest gateway detail kept in a message: enough to diagnose, short to show. */
const MAX_DETAIL = 200;

const truncate = (text: string): string => {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > MAX_DETAIL ? `${clean.slice(0, MAX_DETAIL - 1)}…` : clean;
};

/** A readable detail out of a gateway error body (JSON `detail` or plain text). */
export function gatewayErrorDetail(body: unknown): string | undefined {
  if (typeof body === "string") {
    const text = body.trim();
    return text === "" ? undefined : truncate(text);
  }
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  for (const key of ["detail", "message", "error", "error_message"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return truncate(value);
  }
  return undefined;
}

/**
 * LiteLLM answers 403 when a virtual key is valid but its `allowed_routes` does
 * not include the management route. That is not a bad key: the chat calls still
 * work, so the card must warn instead of asking for the key again.
 */
export function isRouteBlocked(detail: string | undefined): boolean {
  if (!detail) return false;
  return /allowed_routes|not allowed to call (?:this|the) route|route .*not (?:allowed|permitted)|not permitted to call/i.test(
    detail,
  );
}

/** Reads the body of a 401/403 without letting a bad body hide the status. */
async function readErrorDetail(
  response: GatewayFetchResponse,
): Promise<string | undefined> {
  const text =
    typeof response.text === "function"
      ? await response.text().catch(() => "")
      : "";
  if (text.trim() !== "") {
    try {
      return gatewayErrorDetail(JSON.parse(text)) ?? gatewayErrorDetail(text);
    } catch {
      return gatewayErrorDetail(text);
    }
  }
  // Test doubles (and a few gateways) only expose `json`.
  try {
    return gatewayErrorDetail(await response.json());
  } catch {
    return undefined;
  }
}

async function probe(
  fetchImpl: GatewayFetch,
  baseURL: string,
  key: string,
  timeoutMs: number,
): Promise<Probe> {
  let signal: AbortSignal | undefined;
  try {
    signal =
      typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(timeoutMs)
        : undefined;
  } catch {
    signal = undefined;
  }

  try {
    const response = await fetchImpl(`${baseURL}/key/info`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
    if (response.status === 401 || response.status === 403) {
      const detail = await readErrorDetail(response);
      // A valid key blocked from `/key/info` is an unavailable gateway, not a
      // rejected key: storing it still lets the gateway spend be read later.
      if (isRouteBlocked(detail)) {
        return { kind: "error", message: detail!, routeBlocked: true };
      }
      return { kind: "invalid", message: detail ?? `HTTP ${response.status}` };
    }
    if (!response.ok) {
      return { kind: "error", message: `HTTP ${response.status}` };
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { kind: "error", message: "Invalid JSON from the gateway." };
    }
    const data = parseGatewayPayload(payload);
    if (!data) return { kind: "error", message: "Unexpected gateway payload." };
    return { kind: "ok", data };
  } catch (cause) {
    return { kind: "error", message: messageOf(cause) };
  }
}

const defaultFetch: GatewayFetch = (url, init) =>
  (globalThis.fetch as unknown as GatewayFetch)(url, init);

export function createGateway(options: GatewayOptions): Gateway {
  const clock = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetch ?? defaultFetch;

  const cache = new Map<string, { at: number; info: GatewayInfo }>();
  const inflight = new Map<string, Promise<GatewayInfo>>();
  /**
   * A key change bumps the provider's generation, so a fetch that started with
   * the previous key cannot write its answer back into the cache.
   */
  const generation = new Map<string, number>();

  const storageKey = (providerID: string): string => `${KEY_PREFIX}${providerID}`;
  const bump = (providerID: string): void => {
    generation.set(providerID, (generation.get(providerID) ?? 0) + 1);
  };

  async function storedKey(providerID: string): Promise<string | undefined> {
    try {
      const raw = await options.storage.get(storageKey(providerID));
      return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  async function baseURL(providerID: string): Promise<string | undefined> {
    try {
      const result = await options.providers.get({
        providerID,
        ...(options.directory ? { location: { directory: options.directory } } : {}),
      });
      return gatewayBaseURL(result);
    } catch {
      return undefined;
    }
  }

  async function load(providerID: string): Promise<GatewayInfo> {
    const key = await storedKey(providerID);
    if (!key) return { status: "missingKey", hasKey: false };
    const base = await baseURL(providerID);
    if (!base) {
      return {
        status: "error",
        hasKey: true,
        message: "This provider has no base URL.",
      };
    }
    const result = await probe(fetchImpl, base, key, timeoutMs);
    if (result.kind === "ok") {
      return { status: "ok", hasKey: true, ...result.data };
    }
    return {
      status: "error",
      hasKey: true,
      ...(result.kind === "invalid" ? { invalidKey: true } : {}),
      ...(result.kind === "error" && result.routeBlocked ? { routeBlocked: true } : {}),
      message: result.message,
    };
  }

  async function read(providerID: string, fresh: boolean): Promise<GatewayInfo> {
    if (!fresh) {
      const hit = cache.get(providerID);
      if (hit && clock() - hit.at < cacheMs) return hit.info;
    }
    const pending = inflight.get(providerID);
    if (pending) return pending;

    const seen = generation.get(providerID) ?? 0;
    const task = (async () => {
      const info = await load(providerID);
      if ((generation.get(providerID) ?? 0) === seen) {
        cache.set(providerID, { at: clock(), info });
      }
      return info;
    })();
    inflight.set(providerID, task);
    try {
      return await task;
    } finally {
      if (inflight.get(providerID) === task) inflight.delete(providerID);
    }
  }

  async function store(providerID: string, key: string): Promise<void> {
    bump(providerID);
    await options.storage.set(storageKey(providerID), key);
    cache.delete(providerID);
  }

  return {
    query(providerID, queryOptions = {}) {
      return read(providerID, queryOptions.fresh ?? false);
    },

    async setKey(providerID, rawKey) {
      const key = rawKey.trim();
      if (key === "") {
        const info = await read(providerID, true);
        if (!info.hasKey) return { status: "missingKey", info };
        return { status: info.status === "ok" ? "ok" : "unavailable", info };
      }

      const base = await baseURL(providerID);
      if (!base) {
        const message = "This provider has no base URL.";
        try {
          await store(providerID, key);
        } catch (cause) {
          return {
            status: "unavailable",
            info: { status: "error", hasKey: false, message: messageOf(cause) },
            message: messageOf(cause),
          };
        }
        return {
          status: "unavailable",
          info: { status: "error", hasKey: true, message },
          message,
        };
      }

      const result = await probe(fetchImpl, base, key, timeoutMs);
      if (result.kind === "invalid") {
        const existing = await storedKey(providerID);
        return {
          status: "invalid",
          info: {
            status: "error",
            hasKey: existing !== undefined,
            invalidKey: true,
            message: result.message,
          },
          message: result.message,
        };
      }

      try {
        await store(providerID, key);
      } catch (cause) {
        return {
          status: "unavailable",
          info: { status: "error", hasKey: false, message: messageOf(cause) },
          message: messageOf(cause),
        };
      }

      if (result.kind === "ok") {
        const info: GatewayInfo = { status: "ok", hasKey: true, ...result.data };
        cache.set(providerID, { at: clock(), info });
        return { status: "ok", info };
      }
      const info: GatewayInfo = {
        status: "error",
        hasKey: true,
        ...(result.routeBlocked ? { routeBlocked: true } : {}),
        message: result.message,
      };
      cache.set(providerID, { at: clock(), info });
      return { status: "unavailable", info, message: result.message };
    },

    async clearKey(providerID) {
      bump(providerID);
      try {
        await options.storage.remove(storageKey(providerID));
      } catch {
        // The cache is still dropped, so the next read reports the key as gone.
      }
      cache.delete(providerID);
      return { status: "missingKey", hasKey: false };
    },
  };
}