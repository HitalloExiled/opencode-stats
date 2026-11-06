/**
 * Observability switch tests — defaults, hydration, persistence and the
 * ordering between an explicit toggle and a late hydration.
 */

import { describe, expect, test } from "bun:test";

import {
  createObservability,
  type ObservabilityStorage,
} from "../src/observability";

function fakeStorage(initial?: boolean) {
  const values = new Map<string, unknown>();
  if (initial !== undefined) values.set("observability", initial);
  const writes: unknown[] = [];
  const storage = {
    get: async (key: string) => values.get(key),
    set: async (key: string, value: unknown) => {
      values.set(key, value);
      writes.push(value);
    },
  } as unknown as ObservabilityStorage;
  return { values, writes, storage };
}

function deps() {
  const states: boolean[] = [];
  let clears = 0;
  return {
    states,
    clears: () => clears,
    store: {
      clear() {
        clears += 1;
      },
    },
    scheduler: {
      setEnabled(value: boolean) {
        states.push(value);
      },
    },
  };
}

describe("createObservability", () => {
  test("starts enabled and hydrates the stored value", async () => {
    let clock = 5000;
    const fake = fakeStorage(false);
    const fakeDeps = deps();
    const observability = createObservability({
      storage: () => fake.storage,
      store: fakeDeps.store,
      scheduler: fakeDeps.scheduler,
      now: () => clock,
    });

    expect(observability.enabled).toBe(true);
    expect(observability.since).toBe(5000);

    clock = 6000;
    await observability.hydrate();

    expect(observability.enabled).toBe(false);
    expect(observability.since).toBe(6000);
    expect(fakeDeps.states).toEqual([false]);
    expect(fakeDeps.clears()).toBe(1);
  });

  test("persists an explicit toggle and clears captures on disable", async () => {
    const fake = fakeStorage(true);
    const fakeDeps = deps();
    const observability = createObservability({
      storage: () => fake.storage,
      store: fakeDeps.store,
      scheduler: fakeDeps.scheduler,
    });

    await observability.setEnabled(false);

    expect(observability.enabled).toBe(false);
    expect(fake.writes).toEqual([false]);
    expect(fake.values.get("observability")).toBe(false);
    expect(fakeDeps.states).toEqual([false]);
    expect(fakeDeps.clears()).toBe(1);

    await observability.setEnabled(true);
    expect(observability.enabled).toBe(true);
    expect(fake.writes).toEqual([false, true]);
    expect(fakeDeps.states).toEqual([false, true]);
    // Enabling does not destroy what was already captured.
    expect(fakeDeps.clears()).toBe(1);
  });

  test("keeps the in-memory value when persistence fails", async () => {
    const errors: unknown[] = [];
    const storage = {
      get: async () => undefined,
      set: async () => {
        throw new Error("storage offline");
      },
    } as unknown as ObservabilityStorage;
    const fakeDeps = deps();
    const observability = createObservability({
      storage: () => storage,
      store: fakeDeps.store,
      scheduler: fakeDeps.scheduler,
      onError: (error) => errors.push(error),
    });

    await observability.setEnabled(false);

    expect(observability.enabled).toBe(false);
    expect(errors).toHaveLength(1);
  });

  test("an explicit toggle wins over a late hydration", async () => {
    let resolveGet!: (value: unknown) => void;
    const gate = new Promise<unknown>((resolve) => {
      resolveGet = resolve;
    });
    const storage = {
      get: () => gate,
      set: async () => undefined,
    } as unknown as ObservabilityStorage;
    const fakeDeps = deps();
    const observability = createObservability({
      storage: () => storage,
      store: fakeDeps.store,
      scheduler: fakeDeps.scheduler,
    });

    const hydrating = observability.hydrate();
    await observability.setEnabled(true);
    resolveGet(false);
    await hydrating;

    expect(observability.enabled).toBe(true);
  });

  test("ignores missing and non-boolean stored values", async () => {
    const fake = fakeStorage();
    const fakeDeps = deps();
    const observability = createObservability({
      storage: () => fake.storage,
      store: fakeDeps.store,
      scheduler: fakeDeps.scheduler,
    });

    await observability.hydrate();
    expect(observability.enabled).toBe(true);
    expect(fakeDeps.states).toEqual([]);

    fake.values.set("observability", "off");
    await observability.hydrate();
    expect(observability.enabled).toBe(true);
  });
});
