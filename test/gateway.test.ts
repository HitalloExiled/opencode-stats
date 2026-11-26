/**
 * Gateway tests — base URL, payload parsing, cache and the key save rules.
 */

import { describe, expect, test } from "bun:test";
import type { Schema } from "effect";

import {
  createGateway,
  gatewayBaseURL,
  parseGatewayPayload,
  type GatewayFetch,
  type GatewayFetchResponse,
  type GatewayStorage,
} from "../src/gateway";

const storage = (
  initial: Record<string, unknown> = {},
): GatewayStorage & { values: Map<string, unknown> } => {
  const values = new Map<string, unknown>(Object.entries(initial));
  return {
    values,
    get: async (key: string) => values.get(key) as Schema.Json | undefined,
    set: async (key: string, value: Schema.Json) => {
      values.set(key, value);
    },
    remove: async (key: string) => {
      values.delete(key);
    },
  };
};

const providers = (baseURL: string | null = "https://litellm.example") => {
  const calls: string[] = [];
  return {
    calls,
    get: async (input: { providerID: string }) => {
      calls.push(input.providerID);
      return { data: { id: input.providerID, settings: baseURL ? { baseURL } : {} } };
    },
  };
};

const payload = (info: Record<string, unknown>) => ({ key: "sk-secret", info });

const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/** A gateway error with a text body, the way LiteLLM answers 403. */
const textResponse = (body: string, status: number) => ({
  ok: false,
  status,
  json: async () => JSON.parse(body),
  text: async () => body,
});

/** The real LiteLLM answer for a key whose `allowed_routes` blocks `/key/info`. */
const ROUTE_BLOCKED = JSON.stringify({
  detail:
    "Virtual key is not allowed to call this route. Only allowed to call routes: ['llm_api_routes']. Tried to call route: /key/info",
});

const fetchOf = (
  handler: (url: string, init?: { headers?: Record<string, string> }) => Promise<unknown>,
) => {
  const calls: Array<{ url: string; headers: Record<string, string> | undefined }> = [];
  const fetch: GatewayFetch = async (url, init) => {
    calls.push({ url, headers: init?.headers });
    return (await handler(url, init)) as GatewayFetchResponse;
  };
  return { fetch, calls };
};

describe("gatewayBaseURL", () => {
  test("reads settings.baseURL and trims the trailing slash", () => {
    expect(
      gatewayBaseURL({ data: { settings: { baseURL: "https://litellm.example/" } } }),
    ).toBe("https://litellm.example");
    expect(
      gatewayBaseURL({ data: { settings: { baseURL: "  https://x.test/api//  " } } }),
    ).toBe("https://x.test/api");
  });

  test("is undefined without a usable URL", () => {
    expect(gatewayBaseURL(undefined)).toBeUndefined();
    expect(gatewayBaseURL({ data: {} })).toBeUndefined();
    expect(gatewayBaseURL({ data: { settings: { baseURL: "   " } } })).toBeUndefined();
    expect(gatewayBaseURL({ data: { settings: { baseURL: 42 } } })).toBeUndefined();
  });
});

describe("parseGatewayPayload", () => {
  test("reads spend, budget and the reset in ISO", () => {
    const parsed = parseGatewayPayload(
      payload({
        spend: 12.5,
        max_budget: 100,
        budget_duration: "30d",
        budget_reset_at: "2026-12-01T00:00:00Z",
      }),
    );
    expect(parsed).toEqual({
      spend: 12.5,
      limit: 100,
      duration: "30d",
      resetsAt: Date.parse("2026-12-01T00:00:00Z"),
    });
  });

  test("null budget means unlimited", () => {
    expect(parseGatewayPayload(payload({ spend: "3.5", max_budget: null }))).toEqual({
      spend: 3.5,
      limit: null,
      duration: null,
      resetsAt: null,
    });
  });

  test("a numeric reset in seconds becomes milliseconds", () => {
    expect(parseGatewayPayload(payload({ spend: 1, budget_reset_at: 1_764_547_200 }))).toEqual({
      spend: 1,
      limit: null,
      duration: null,
      resetsAt: 1_764_547_200_000,
    });
  });

  test("rejects a payload without a spend", () => {
    expect(parseGatewayPayload(undefined)).toBeUndefined();
    expect(parseGatewayPayload({})).toBeUndefined();
    expect(parseGatewayPayload({ info: {} })).toBeUndefined();
    expect(parseGatewayPayload({ info: { spend: -1 } })).toBeUndefined();
  });
});

describe("gateway query", () => {
  test("reports a missing key without touching the network", async () => {
    const store = storage();
    const { fetch, calls } = fetchOf(async () => response(payload({ spend: 1 })));
    const gateway = createGateway({ storage: store, providers: providers(), fetch });

    expect(await gateway.query("insi")).toEqual({ status: "missingKey", hasKey: false });
    expect(calls.length).toBe(0);
  });

  test("reads the key's spend", async () => {
    const store = storage({ "gateway.key.insi": "sk-test" });
    const { fetch, calls } = fetchOf(async () =>
      response(payload({ spend: 7.25, max_budget: 50, budget_reset_at: "2026-12-01T00:00:00Z" })),
    );
    const gateway = createGateway({ storage: store, providers: providers(), fetch });

    expect(await gateway.query("insi")).toEqual({
      status: "ok",
      hasKey: true,
      spend: 7.25,
      limit: 50,
      duration: null,
      resetsAt: Date.parse("2026-12-01T00:00:00Z"),
    });
    expect(calls[0]?.url).toBe("https://litellm.example/key/info");
    expect(calls[0]?.headers?.Authorization).toBe("Bearer sk-test");
  });

  test("flags a rejected key", async () => {
    const store = storage({ "gateway.key.insi": "sk-dead" });
    const { fetch } = fetchOf(async () => response({}, 401));
    const gateway = createGateway({ storage: store, providers: providers(), fetch });

    const info = await gateway.query("insi");
    expect(info.status).toBe("error");
    expect(info.hasKey).toBe(true);
    expect(info.invalidKey).toBe(true);
  });

  test("a 403 that blocks /key/info is a route block, not a rejected key", async () => {
    const store = storage({ "gateway.key.insi": "sk-valid" });
    const { fetch } = fetchOf(async () => textResponse(ROUTE_BLOCKED, 403));
    const gateway = createGateway({ storage: store, providers: providers(), fetch });

    const info = await gateway.query("insi");
    expect(info.status).toBe("error");
    expect(info.hasKey).toBe(true);
    expect(info.routeBlocked).toBe(true);
    expect(info.invalidKey).toBeUndefined();
    // The detail the route returned is what the user sees.
    expect(info.message).toContain("llm_api_routes");
  });

  test("a plain 403 stays a rejected key", async () => {
    const store = storage({ "gateway.key.insi": "sk-dead" });
    const { fetch } = fetchOf(async () => textResponse('{"detail":"Invalid API key"}', 403));
    const gateway = createGateway({ storage: store, providers: providers(), fetch });

    const info = await gateway.query("insi");
    expect(info.invalidKey).toBe(true);
    expect(info.routeBlocked).toBeUndefined();
  });

  test("reports a network failure without throwing", async () => {
    const store = storage({ "gateway.key.insi": "sk-test" });
    const { fetch } = fetchOf(async () => {
      throw new Error("offline");
    });
    const gateway = createGateway({ storage: store, providers: providers(), fetch });

    const info = await gateway.query("insi");
    expect(info.status).toBe("error");
    expect(info.message).toBe("offline");
  });

  test("reports a provider without a base URL", async () => {
    const store = storage({ "gateway.key.insi": "sk-test" });
    const { fetch, calls } = fetchOf(async () => response(payload({ spend: 1 })));
    const gateway = createGateway({
      storage: store,
      providers: providers(null),
      fetch,
    });

    const info = await gateway.query("insi");
    expect(info.status).toBe("error");
    expect(info.message).toContain("base URL");
    expect(calls.length).toBe(0);
  });

  test("caches for the TTL and refreshes on demand", async () => {
    let now = 1_000;
    const store = storage({ "gateway.key.insi": "sk-test" });
    const { fetch, calls } = fetchOf(async () => response(payload({ spend: 2 })));
    const gateway = createGateway({
      storage: store,
      providers: providers(),
      fetch,
      now: () => now,
      cacheMs: 1_000,
    });

    await gateway.query("insi");
    await gateway.query("insi");
    expect(calls.length).toBe(1);

    now += 1_001;
    await gateway.query("insi");
    expect(calls.length).toBe(2);

    await gateway.query("insi", { fresh: true });
    expect(calls.length).toBe(3);
  });
});

describe("gateway keys", () => {
  test("stores a validated key and its spend", async () => {
    const store = storage();
    const { fetch, calls } = fetchOf(async () => response(payload({ spend: 4 })));
    const gateway = createGateway({ storage: store, providers: providers(), fetch });

    const saved = await gateway.setKey("insi", "  sk-new  ");
    expect(saved.status).toBe("ok");
    expect(store.values.get("gateway.key.insi")).toBe("sk-new");
    expect(calls[0]?.headers?.Authorization).toBe("Bearer sk-new");
    expect(saved.info).toEqual({
      status: "ok",
      hasKey: true,
      spend: 4,
      limit: null,
      duration: null,
      resetsAt: null,
    });
  });

  test("does not store a key the gateway rejects", async () => {
    const store = storage();
    const { fetch } = fetchOf(async () => response({}, 403));
    const gateway = createGateway({ storage: store, providers: providers(), fetch });

    const saved = await gateway.setKey("insi", "sk-bad");
    expect(saved.status).toBe("invalid");
    expect(saved.info.invalidKey).toBe(true);
    expect(store.values.has("gateway.key.insi")).toBe(false);
  });

  test("stores a valid key even when the gateway blocks the spend route", async () => {
    const store = storage();
    const { fetch } = fetchOf(async () => textResponse(ROUTE_BLOCKED, 403));
    const gateway = createGateway({ storage: store, providers: providers(), fetch });

    const saved = await gateway.setKey("insi", "sk-valid");
    expect(saved.status).toBe("unavailable");
    expect(saved.info.routeBlocked).toBe(true);
    expect(saved.info.hasKey).toBe(true);
    expect(store.values.get("gateway.key.insi")).toBe("sk-valid");
  });

  test("keeps a key the gateway could not validate", async () => {
    const store = storage();
    const { fetch } = fetchOf(async () => {
      throw new Error("offline");
    });
    const gateway = createGateway({ storage: store, providers: providers(), fetch });

    const saved = await gateway.setKey("insi", "sk-keep");
    expect(saved.status).toBe("unavailable");
    expect(store.values.get("gateway.key.insi")).toBe("sk-keep");
  });

  test("a blank key keeps the stored one", async () => {
    const store = storage({ "gateway.key.insi": "sk-old" });
    const { fetch } = fetchOf(async () => response(payload({ spend: 6 })));
    const gateway = createGateway({ storage: store, providers: providers(), fetch });

    const saved = await gateway.setKey("insi", "   ");
    expect(saved.status).toBe("ok");
    expect(store.values.get("gateway.key.insi")).toBe("sk-old");
    expect(saved.info.spend).toBe(6);
  });

  test("removing the key drops the cache and the stored value", async () => {
    const store = storage({ "gateway.key.insi": "sk-test" });
    const { fetch, calls } = fetchOf(async () => response(payload({ spend: 2 })));
    const gateway = createGateway({ storage: store, providers: providers(), fetch });

    expect(await gateway.query("insi")).toMatchObject({ status: "ok", spend: 2 });
    expect(await gateway.clearKey("insi")).toEqual({ status: "missingKey", hasKey: false });
    expect(store.values.has("gateway.key.insi")).toBe(false);

    expect(await gateway.query("insi")).toEqual({ status: "missingKey", hasKey: false });
    expect(calls.length).toBe(1);
  });

  test("a new key invalidates the cached spend", async () => {
    const store = storage({ "gateway.key.insi": "sk-old" });
    let spend = 2;
    const { fetch } = fetchOf(async () => response(payload({ spend })));
    const gateway = createGateway({ storage: store, providers: providers(), fetch });

    expect(await gateway.query("insi")).toMatchObject({ spend: 2 });
    spend = 9;
    const saved = await gateway.setKey("insi", "sk-new");
    expect(saved.info.spend).toBe(9);
    expect(await gateway.query("insi")).toMatchObject({ spend: 9 });
  });
});