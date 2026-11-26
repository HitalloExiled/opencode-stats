/**
 * Cost data source for the projection chart.
 *
 * Every visible slice of the x axis is one `session.stats` call with an exact
 * millisecond range: a whole local day, the sliver from the zero mark to the
 * end of its day, or the start of today up to now. Omitting `project`
 * aggregates the whole machine (validated against the running server: the sum
 * of the per-project calls matches the no-project call), and `models[]` carries
 * each model's provider, so one call yields the slice's cost and its
 * per-provider split.
 *
 * Slices that ended before today are immutable and cached forever; a slice that
 * reaches today changes while the session runs, so it expires after
 * `COST_TODAY_TTL_MS`. Any change to the provider costs calls
 * `clearCostCache` (the refresh button, and every edit of `already spent`).
 * Calls are cheap (4–28 ms in practice) and the pool keeps at most four in
 * flight.
 *
 * Abort is cooperative: the module never passes the controller to the client
 * (the server tsconfig has no DOM lib), so it stops between calls and the
 * caller discards results when its own signal is aborted.
 */

import { dayKey, startOfLocalDay, type CostDay } from "../cost";

/** Input accepted by the client's `session.stats`. */
type StatsInput = {
  from: number;
  to: number;
  timezone?: string;
  tools?: "none";
};

/** The slice of `session.stats` the chart reads. */
type StatsResult = {
  cost: number;
  models: ReadonlyArray<{
    model: { providerID: string };
    cost: number;
  }>;
};

/** The slice of the promise client the source needs. */
export type StatsClient = {
  session: {
    stats(input: StatsInput): Promise<StatsResult>;
  };
};

/** A cooperative abort signal (no DOM lib in the server typecheck). */
export type AbortLike = {
  readonly aborted: boolean;
};

export type CostFetchOptions = {
  readonly signal?: AbortLike | undefined;
  /** Clock for the cache TTL; defaults to `Date.now()`. */
  readonly now?: number | undefined;
};

/** One slice of the x axis to fetch, in epoch milliseconds. */
export type CostRangeInput = {
  from: number;
  to: number;
};

/** One fetched slice, in the shape the series consumes. */
export type CostRangeResult = {
  from: number;
  to: number;
  /** Slice start; the series point sits here. */
  t: number;
  /** Local `YYYY-MM-DD` of `from`. */
  date: string;
  /** Total cost of the slice, in USD. */
  cost: number;
  /** Cost per provider, in USD. Providers without spending are absent. */
  providers: Record<string, number>;
  /** Whether the value came from the cache. */
  cached: boolean;
};

/** Providers seen in the window, sorted by cost (descending). */
export type ProviderTotal = {
  id: string;
  cost: number;
};

/** Maximum requests in flight while filling the window. */
export const COST_FETCH_CONCURRENCY = 4;

/** How long a slice that reaches today stays valid. */
export const COST_TODAY_TTL_MS = 30_000;

/** How many slices stay cached; older ones drop first. */
const CACHE_LIMIT = 128;

type CachedRange = {
  at: number;
  cost: number;
  providers: Record<string, number>;
};

const cache = new Map<string, CachedRange>();

/** Drops every cached slice, so the next fetch rebuilds the window. */
export function clearCostCache(): void {
  cache.clear();
}

/** Browser timezone name, when the runtime has one. */
export function localTimeZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone ? String(zone) : undefined;
  } catch {
    return undefined;
  }
}

async function runPool<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), tasks.length) },
    async () => {
      for (;;) {
        const index = next++;
        const task = tasks[index];
        if (!task) return;
        results[index] = await task();
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function trimCache(): void {
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) return;
    cache.delete(oldest);
  }
}

function toResult(range: CostRangeInput, cached: CachedRange, hit: boolean): CostRangeResult {
  return {
    from: range.from,
    to: range.to,
    t: range.from,
    date: dayKey(range.from),
    cost: cached.cost,
    providers: { ...cached.providers },
    cached: hit,
  };
}

function abortError(): Error {
  const error = new Error("cost window aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Fetches the given slices. Slices must come from `costRanges` so their
 * boundaries line up with the chart's x axis.
 */
export async function fetchCostRanges(
  client: StatsClient,
  ranges: readonly CostRangeInput[],
  options: CostFetchOptions = {},
): Promise<CostRangeResult[]> {
  if (ranges.length === 0) return [];
  const now = options.now ?? Date.now();
  const today = startOfLocalDay(now);
  const timezone = localTimeZone();
  const signal = options.signal;

  const tasks = ranges.map((range) => async (): Promise<CostRangeResult> => {
    if (signal?.aborted) throw abortError();
    const key = `${range.from}|${range.to}`;
    const hit = cache.get(key);
    const immutable = range.to < today;
    if (hit && (immutable || now - hit.at < COST_TODAY_TTL_MS)) {
      return toResult(range, hit, true);
    }

    const result = await client.session.stats({
      from: range.from,
      to: range.to,
      ...(timezone ? { timezone } : {}),
      tools: "none",
    });
    if (signal?.aborted) throw abortError();

    const providers: Record<string, number> = {};
    for (const entry of result.models) {
      const id = String(entry.model.providerID);
      const cost = Number(entry.cost);
      if (!Number.isFinite(cost) || cost === 0) continue;
      providers[id] = (providers[id] ?? 0) + cost;
    }
    const total = Number(result.cost);
    const value: CachedRange = {
      at: now,
      cost: Number.isFinite(total) ? total : 0,
      providers,
    };
    cache.set(key, value);
    trimCache();
    return toResult(range, value, false);
  });

  return runPool(tasks, COST_FETCH_CONCURRENCY);
}

/** Providers present in the slices, most expensive first. */
export function providerTotals(
  results: readonly { providers: Record<string, number> }[],
): ProviderTotal[] {
  const totals = new Map<string, number>();
  for (const slice of results) {
    for (const [id, cost] of Object.entries(slice.providers)) {
      totals.set(id, (totals.get(id) ?? 0) + cost);
    }
  }
  return Array.from(totals, ([id, cost]) => ({ id, cost })).sort(
    (left, right) => right.cost - left.cost || left.id.localeCompare(right.id),
  );
}

/** One provider's cost per slice, aligned with `results`. */
export function providerDays(
  results: readonly { date: string; t: number; providers: Record<string, number> }[],
  providerID: string,
): CostDay[] {
  return results.map((slice) => ({
    date: slice.date,
    t: slice.t,
    cost: slice.providers[providerID] ?? 0,
  }));
}