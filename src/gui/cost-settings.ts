/**
 * Persisted settings for the cost projection chart.
 *
 * One global value for the whole app: the chart is machine-wide, so the
 * selected provider, the window size and each provider's budget (`limit`),
 * already-spent baseline (`spent`) and its timestamp (`spentAt`) survive panel
 * remounts, tab switches and window reloads. The storage schema keeps null for
 * "not informed", so an empty field never reads as zero.
 *
 * `spentAt` is the zero mark: the chart counts what the app spend from that
 * instant on, on top of `spent`. It is stamped only when the spent value
 * actually changes, so retyping the same number does not restart the count.
 *
 * The window keeps an authoritative local copy in a signal and writes through
 * to storage. Reading `Persisted.value` straight from the memos was not enough:
 * the host store did not push a re-render after a nested `update`, so typing a
 * new limit left the chart on the previously stored one.
 */

import { createEffect, createRoot, createSignal } from "solid-js";
import { Schema } from "effect";
import type { Context } from "@opencode/plugin/gui";

import { COST_WINDOW_DEFAULT, COST_WINDOW_SIZES } from "../cost";

const providerCostSchema = Schema.Struct({
  id: Schema.String,
  limit: Schema.NullOr(Schema.Number),
  spent: Schema.NullOr(Schema.Number),
  // Optional so values stored before the zero mark decode unchanged.
  spentAt: Schema.optional(Schema.NullOr(Schema.Number)),
});

const costSettingsSchema = Schema.Struct({
  selected: Schema.NullOr(Schema.String),
  window: Schema.Number,
  providers: Schema.Array(providerCostSchema),
});

export type ProviderCost = Schema.Schema.Type<typeof providerCostSchema>;

export type CostSettingsValue = Schema.Schema.Type<typeof costSettingsSchema>;

const INITIAL: CostSettingsValue = {
  selected: null,
  window: COST_WINDOW_DEFAULT,
  providers: [],
};

const normalizeAmount = (value: number | undefined): number | null =>
  value !== undefined && Number.isFinite(value) && value >= 0 ? value : null;

const emptyProvider = (id: string): ProviderCost => ({
  id,
  limit: null,
  spent: null,
  spentAt: null,
});

type ProviderPatch = {
  limit?: number | null;
  spent?: number | null;
  spentAt?: number | null;
};

/** Applies a partial patch, keeping `undefined` in the patch as "no change". */
const applyPatch = (entry: ProviderCost, patch: ProviderPatch): ProviderCost => ({
  id: entry.id,
  limit: patch.limit !== undefined ? patch.limit : entry.limit,
  spent: patch.spent !== undefined ? patch.spent : entry.spent,
  spentAt: patch.spentAt !== undefined ? patch.spentAt : (entry.spentAt ?? null),
});

/** Read/write access to the chart's settings, local-first and persisted. */
export type CostSettingsHandle = {
  /** The stored value has been applied to the local state. */
  ready(): boolean;
  selected(): string | null;
  window(): number;
  limit(providerID: string): number | undefined;
  spent(providerID: string): number | undefined;
  /** When `spent` was informed; the chart counts from here. */
  spentAt(providerID: string): number | undefined;
  select(providerID: string | null): void;
  setWindow(days: number): void;
  setLimit(providerID: string, value: number | undefined): void;
  setSpent(providerID: string, value: number | undefined): void;
};

const handles = new Map<Context, CostSettingsHandle>();

/** One handle per GUI context, so every view shares the same reactive state. */
export function costSettingsFor(ctx: Context): CostSettingsHandle {
  const cached = handles.get(ctx);
  if (cached) return cached;

  const persisted = ctx.storage.store("cost:settings", {
    schema: costSettingsSchema,
    initial: INITIAL,
  });

  const [value, setValue] = createSignal<CostSettingsValue>(INITIAL);
  const [loaded, setLoaded] = createSignal(false);
  let touched = false;

  const sync = (next: CostSettingsValue): void => {
    touched = true;
    setValue(next);
    persisted.set(next);
  };

  const seed = (): void => {
    if (loaded()) return;
    if (!persisted.ready()) return;
    setLoaded(true);
    // A queued write already applied locally; the stored value is stale.
    if (touched) return;
    const stored = persisted.value;
    if (stored) setValue(stored);
  };

  // On desktop the store loads after setup. Seed once it is ready, but never
  // overwrite an edit made before the load finished: `sync` marks it loaded.
  createRoot(() => {
    createEffect(() => {
      if (persisted.ready()) seed();
    });
  });
  seed();

  const current = (): CostSettingsValue => value();
  const entry = (id: string): ProviderCost | undefined =>
    current().providers.find((item) => item.id === id);

  const patch = (providerID: string, fields: ProviderPatch): void => {
    const base = current();
    const exists = base.providers.some((item) => item.id === providerID);
    const providers = exists
      ? base.providers.map((item) =>
          item.id === providerID ? applyPatch(item, fields) : item,
        )
      : [...base.providers, applyPatch(emptyProvider(providerID), fields)];
    sync({ ...base, providers });
  };

  const setSpent = (providerID: string, next: number | undefined): void => {
    const amount = normalizeAmount(next);
    const previous = entry(providerID)?.spent ?? null;
    if (amount === null) {
      if (previous === null) return;
      patch(providerID, { spent: null, spentAt: null });
      return;
    }
    // Same number: keep the zero mark. A legacy value without one gets stamped
    // now, so the count starts on the first edit that touches this field.
    if (previous === amount && (entry(providerID)?.spentAt ?? null) !== null) return;
    patch(providerID, { spent: amount, spentAt: Date.now() });
  };

  const handle: CostSettingsHandle = {
    ready: () => loaded(),
    selected: () => current().selected,
    window: () => current().window,
    limit: (providerID) => entry(providerID)?.limit ?? undefined,
    spent: (providerID) => entry(providerID)?.spent ?? undefined,
    spentAt: (providerID) => entry(providerID)?.spentAt ?? undefined,
    select: (providerID) => {
      sync({ ...current(), selected: providerID });
    },
    setWindow: (days) => {
      const next = (COST_WINDOW_SIZES as readonly number[]).includes(days)
        ? days
        : COST_WINDOW_DEFAULT;
      sync({ ...current(), window: next });
    },
    setLimit: (providerID, next) => patch(providerID, { limit: normalizeAmount(next) }),
    setSpent,
  };

  handles.set(ctx, handle);
  return handle;
}