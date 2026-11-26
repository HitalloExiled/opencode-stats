/**
 * Persisted settings for the cost projection chart.
 *
 * One global value for the whole app: the chart is machine-wide, so the
 * selected provider, the window size and each provider's budget (`limit`),
 * already-spent baseline (`spent`), its zero mark (`spentAt`) and the last
 * recharge (`lastRecharge`) survive panel remounts, tab switches and window
 * reloads. The storage schema keeps null for "not informed", so an empty field
 * never reads as zero.
 *
 * `lastRecharge` is the cycle anchor: the chart measures from it, and a new
 * value starts a new cycle (the informed baseline applies at that instant and
 * the steps from before it are dropped). It is optional, so values stored before
 * it decode unchanged and fall back to `spentAt`.
 *
 * `spentAt` is the legacy zero mark: the chart counts what the app spent from
 * that instant on, on top of the baseline captured then. Editing the value later
 * does not move the mark or restart the count: the typed number is the **current
 * total**, so the edit is stored as a signed `adjustments` step at that instant
 * (typed minus what the chart was showing), and the stored `spent` moves by the
 * same delta to keep the baseline at the mark intact. The measured history is
 * never discarded, and the current total (and the forecast that starts from it)
 * lands exactly on the typed value.
 *
 * The window keeps an authoritative local copy in a signal and writes through
 * to storage. Reading `Persisted.value` straight from the memos was not enough:
 * the host store did not push a re-render after a nested `update`, so typing a
 * new limit left the chart on the previously stored one.
 */

import { createEffect, createRoot, createSignal } from "solid-js";
import { Schema } from "effect";
import type { Context } from "@opencode/plugin/gui";

import {
  adjustmentTotal,
  COST_WINDOW_DEFAULT,
  COST_WINDOW_SIZES,
  isLocalMidnight,
  sameLocalDay,
  type CostAdjustment,
  type CostConfig,
} from "../cost";

const adjustmentSchema = Schema.Struct({
  at: Schema.Number,
  delta: Schema.Number,
  // Optional so edits stored before the drawn value was recorded decode
  // unchanged; the chart then interpolates where the step goes.
  seen: Schema.optional(Schema.NullOr(Schema.Number)),
});

const providerCostSchema = Schema.Struct({
  id: Schema.String,
  limit: Schema.NullOr(Schema.Number),
  spent: Schema.NullOr(Schema.Number),
  // Optional so values stored before the zero mark decode unchanged.
  spentAt: Schema.optional(Schema.NullOr(Schema.Number)),
  // Optional so values stored before external edits decode unchanged.
  adjustments: Schema.optional(Schema.NullOr(Schema.Array(adjustmentSchema))),
  // Optional so values stored before the recharge anchor decode unchanged.
  lastRecharge: Schema.optional(Schema.NullOr(Schema.Number)),
  // Optional so values stored before the gateway decode unchanged. `gatewayBase`
  // is the key's spend at the top-up; `gatewayResetAt` lets the card notice a
  // budget window reset.
  gatewayBase: Schema.optional(Schema.NullOr(Schema.Number)),
  gatewayResetAt: Schema.optional(Schema.NullOr(Schema.Number)),
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
  adjustments: null,
  lastRecharge: null,
  gatewayBase: null,
  gatewayResetAt: null,
});

/** Key spend captured when the cycle started, from the gateway. */
export type GatewayCapture = {
  /** USD spent by the key at the top-up. */
  spend: number;
  /** The key's budget reset instant at the top-up, epoch ms. */
  resetsAt: number | null;
};

/**
 * The entry after one save of the config modal.
 *
 * A recharge on a different day starts a new cycle: its day (or the exact
 * instant, when the modal was opened from "I topped up") becomes the mark, the
 * typed `spent` is the baseline at that instant and the steps from before it are
 * dropped. Steps after it are kept and folded into `spent`, so the baseline
 * stays exactly what was typed.
 *
 * With the same recharge, an edited value is the **current total**: the step is
 * `typed − current`, so the chart lands exactly on the typed number instead of
 * adding the measured cost on top of it (the bug where 3.23 showed as 5.92). The
 * baseline and the mark never move, and an untouched field writes nothing.
 *
 * Without a recharge and without a stored value there is no cycle mark to keep:
 * the first informed value is the total **now**, so it is kept as a step over the
 * measured window instead of stamping a zero mark at this instant (which would
 * hide every measured day before today).
 *
 * The stored instant wins when the day is unchanged: the date field only knows
 * the day, so a value at midnight of the same day must not replace an exact
 * top-up instant.
 */
/**
 * Drops the edit history saved before `seen` existed.
 *
 * Those steps were computed from the stored `spent`, not from the total the card
 * drew, so replaying them bends the line through heights it never showed (the
 * "bounce"). The series end is `spent + measured` with or without them, so
 * dropping the whole legacy history removes the artificial steps and keeps the
 * current total. A later save starts a clean, `seen`-anchored history.
 */
export function cleanAdjustments(
  adjustments: readonly CostAdjustment[] | null | undefined,
): CostAdjustment[] | null {
  if (!adjustments || adjustments.length === 0) return null;
  const legacy = adjustments.some(
    (item) =>
      item.seen === undefined || item.seen === null || !Number.isFinite(item.seen),
  );
  return legacy ? null : [...adjustments];
}

export function applyCostConfig(
  source: ProviderCost,
  config: CostConfig,
  stamp: number,
  current?: number,
  spentTouched = true,
  gateway?: GatewayCapture,
): ProviderCost {
  // One-time migration: an edit from before `seen` existed cannot be placed on
  // the curve reliably. Any save rewrites it away, keeping `spent` (and so the
  // current total) untouched.
  const entry: ProviderCost = {
    ...source,
    adjustments: cleanAdjustments(source.adjustments),
  };
  const limit = normalizeAmount(config.limit ?? undefined);
  const spent = normalizeAmount(config.spent ?? undefined);
  const recharge = config.lastRecharge;
  const anchor = entry.lastRecharge ?? null;

  if (recharge === null) {
    // No recharge: an existing legacy mark keeps carrying the cycle, and a
    // gateway base from a previous cycle no longer applies. With no mark at all,
    // `editSpent` keeps the measured window instead of starting a cycle now.
    return {
      ...(spentTouched ? editSpent(entry, spent, stamp, current) : entry),
      limit,
      lastRecharge: null,
      gatewayBase: null,
      gatewayResetAt: null,
    };
  }

  const sameCycle =
    anchor !== null &&
    (anchor === recharge || (isLocalMidnight(recharge) && sameLocalDay(anchor, recharge)));

  if (!sameCycle) {
    const kept = (entry.adjustments ?? []).filter(
      (item) => Number.isFinite(item.at) && item.at >= recharge,
    );
    // A new cycle starts from the informed baseline (usually 0), so an untouched
    // field must not carry the previous cycle's total into it.
    const typed = spentTouched ? spent : null;
    // The typed value is the baseline at the recharge, so the surviving steps
    // are folded into it instead of being subtracted from it later.
    const total = typed === null && kept.length === 0 ? null : (typed ?? 0) + adjustmentTotal(kept);
    return {
      ...entry,
      limit,
      lastRecharge: recharge,
      spentAt: recharge,
      spent: total,
      adjustments: kept.length > 0 ? kept : null,
      // The gateway base is the key spend captured at this top-up; without a
      // gateway save it clears, so the card starts the cycle from zero.
      gatewayBase: gateway ? gateway.spend : null,
      gatewayResetAt: gateway ? gateway.resetsAt : null,
    };
  }

  // Same day: keep the stored instant, which is more precise than the field.
  // The base captured at the top-up stays; a limit edit must not move it.
  return {
    ...(spentTouched ? editSpent(entry, spent, stamp, current) : entry),
    limit,
  };
}

/** Compared against the delta, so a retyped value does not add a zero step. */
const SPENT_EPSILON = 1e-9;

/**
 * The `already spent` rules, without writing.
 *
 * With no informed value and no cycle mark, the typed number is the **total
 * now**, not a new zero mark: stamping `spentAt = now` would start the x axis at
 * this instant and hide every measured day before it. It is saved as a step over
 * the unmarked window instead — the baseline stays at zero, so the measured
 * history keeps its shape, and the running total lands on the typed value.
 *
 * A later value is the current total too: the step is `amount − current`, and the
 * stored value moves by the same delta so the baseline at the mark stays put.
 */
function editSpent(
  entry: ProviderCost,
  amount: number | null,
  stamp: number,
  current?: number,
): ProviderCost {
  const previous = entry.spent ?? null;
  const mark = entry.spentAt ?? null;
  const adjustments = entry.adjustments ?? [];
  const drawn =
    current !== undefined && Number.isFinite(current) ? current : undefined;

  if (amount === null) {
    if (previous === null && mark === null && adjustments.length === 0) return entry;
    return { ...entry, spent: null, spentAt: null, adjustments: null };
  }

  // First informed value on a fresh provider. With the drawn total in hand, the
  // value becomes a step so the measured window survives (no zero mark). Without
  // it, keep the legacy "this is the baseline now" rule.
  if (previous === null && mark === null) {
    if (drawn === undefined) {
      return { ...entry, spent: amount, spentAt: stamp, adjustments: null };
    }
    const delta = amount - drawn;
    if (!Number.isFinite(delta) || Math.abs(delta) < SPENT_EPSILON) return entry;
    return {
      ...entry,
      spent: delta,
      spentAt: null,
      adjustments: [{ at: stamp, delta, seen: drawn }],
    };
  }

  // A legacy mark without a stored value: the typed number is the baseline at
  // the mark, so the anchor and the measured history from it stay in place.
  if (previous === null) {
    return { ...entry, spent: amount, spentAt: mark, adjustments: null };
  }

  const before = drawn ?? previous;
  const delta = amount - before;
  if (!Number.isFinite(delta) || Math.abs(delta) < SPENT_EPSILON) return entry;
  // The step must be drawn where the card showed the curve, not at the cycle
  // baseline: a day is a single slice, so the measured value at the edit instant
  // is only known from the total the card drew. Recording it (minus the steps
  // already folded into that total) keeps the typed value from dropping to zero.
  const carried = adjustmentTotal(adjustments);
  const seen = drawn === undefined ? undefined : drawn - carried;
  // Later edits keep the mark and the measured history: one signed delta.
  return {
    ...entry,
    spent: previous + delta,
    adjustments: [
      ...adjustments,
      seen === undefined ? { at: stamp, delta } : { at: stamp, delta, seen },
    ],
  };
}

/** Options of one config save. */
export type ApplyCostOptions = {
  /** Instant of the save; defaults to now. */
  now?: number;
  /** Total currently drawn, so an edited `spent` pins exactly that number. */
  current?: number;
  /** The field was edited in this save; nothing is written when false. */
  spentTouched?: boolean;
  /** Gateway spend captured at the new cycle, when the key answered. */
  gateway?: GatewayCapture | null;
};

/** Read/write access to the chart's settings, local-first and persisted. */
export type CostSettingsHandle = {
  /** The stored value has been applied to the local state. */
  ready(): boolean;
  selected(): string | null;
  window(): number;
  limit(providerID: string): number | undefined;
  spent(providerID: string): number | undefined;
  /** When the current cycle started: the recharge, or the legacy zero mark. */
  spentAt(providerID: string): number | undefined;
  /** When the credits were last topped up; the chart measures from here. */
  lastRecharge(providerID: string): number | undefined;
  /** External edits to `spent`, up or down, each at its own instant. */
  adjustments(providerID: string): readonly CostAdjustment[];
  /** Key spend captured at the top-up, when the gateway provided it. */
  gatewayBase(providerID: string): number | undefined;
  /** The key's budget reset instant at the top-up. */
  gatewayResetAt(providerID: string): number | undefined;
  select(providerID: string | null): void;
  /** One atomic write for the whole config modal; nothing changes on failure. */
  applyConfig(providerID: string, config: CostConfig, options?: ApplyCostOptions): void;
  /** Drops the gateway base, for when the key is removed. */
  clearGateway(providerID: string): void;
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

  const applyConfig = (
    providerID: string,
    config: CostConfig,
    options: ApplyCostOptions = {},
  ): void => {
    const base = current();
    const existing = base.providers.find((item) => item.id === providerID);
    const next = applyCostConfig(
      existing ?? emptyProvider(providerID),
      config,
      options.now ?? Date.now(),
      options.current,
      options.spentTouched ?? true,
      options.gateway ?? undefined,
    );
    const providers = existing
      ? base.providers.map((item) => (item.id === providerID ? next : item))
      : [...base.providers, next];
    const days = (COST_WINDOW_SIZES as readonly number[]).includes(config.window)
      ? config.window
      : COST_WINDOW_DEFAULT;
    // One write for the whole modal: the entry and the window cannot land apart.
    sync({ ...base, providers, window: days });
  };

  const clearGateway = (providerID: string): void => {
    const base = current();
    const existing = base.providers.find((item) => item.id === providerID);
    if (!existing) return;
    if (
      (existing.gatewayBase === undefined || existing.gatewayBase === null) &&
      (existing.gatewayResetAt === undefined || existing.gatewayResetAt === null)
    ) {
      return;
    }
    const next = { ...existing, gatewayBase: null, gatewayResetAt: null };
    sync({
      ...base,
      providers: base.providers.map((item) => (item.id === providerID ? next : item)),
    });
  };

  const handle: CostSettingsHandle = {
    ready: () => loaded(),
    selected: () => current().selected,
    window: () => current().window,
    limit: (providerID) => entry(providerID)?.limit ?? undefined,
    spent: (providerID) => entry(providerID)?.spent ?? undefined,
    spentAt: (providerID) => entry(providerID)?.spentAt ?? undefined,
    lastRecharge: (providerID) => entry(providerID)?.lastRecharge ?? undefined,
    adjustments: (providerID) => entry(providerID)?.adjustments ?? [],
    gatewayBase: (providerID) => entry(providerID)?.gatewayBase ?? undefined,
    gatewayResetAt: (providerID) => entry(providerID)?.gatewayResetAt ?? undefined,
    select: (providerID) => {
      sync({ ...current(), selected: providerID });
    },
    applyConfig,
    clearGateway,
  };

  handles.set(ctx, handle);
  return handle;
}