/**
 * Cost + projection card.
 *
 * The chart is machine-wide: one provider at a time, cumulative spend over the
 * chosen day window, plus a straight projection from today with the window's
 * average daily cost as its slope. The optional budget is a horizontal cutoff;
 * when the projection crosses it, the card shows the date.
 *
 * `already spent` is a zero mark: the series starts at the instant it was set
 * (or at the window start when the mark is older) and every value includes it.
 *
 * All the math lives in `../cost`; this file only fetches the axis slices, maps
 * time and cost into pixels and renders. The data comes from `session.stats`
 * per slice, never from the app database.
 */

import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import { usePlugin } from "@opencode/plugin/gui";

import {
  addDays,
  averageDailyCost,
  COST_WINDOW_SIZES,
  costRanges,
  costScale,
  cumulativeSeries,
  dayWindow,
  formatCost,
  formatCostAxis,
  formatCostDate,
  formatCostInstant,
  limitCrossing,
  projectionSeries,
  spanDays,
} from "../cost";
import {
  clearCostCache,
  fetchCostRanges,
  providerDays,
  providerTotals,
  type CostRangeResult,
  type StatsClient,
} from "./cost-source";
import { costSettingsFor } from "./cost-settings";
import { useLocale, useT } from "./i18n";
import chartCss from "./chart.scss?inline";
import costCss from "./cost-chart.scss?inline";

const BASE_CSS = chartCss;
const CSS = costCss;

const W = 360;
const H = 150;
const LEFT = 42;
const RIGHT = 10;
const TOP = 10;
const BOTTOM = 20;
const PH = H - TOP - BOTTOM;
const MIN_WIDTH = LEFT + RIGHT + 24;

const WINDOWS = COST_WINDOW_SIZES;

/**
 * Pause before refetching after a new zero mark. Every keystroke in `already
 * spent` stamps one, and each mark moves the first slice, so waiting keeps the
 * last edit winning without a fetch per digit.
 */
const COST_MARK_DEBOUNCE_MS = 300;

/** Below this many days the daily dots are readable; above it they are noise. */
const MAX_DOTS = 15;

type Loaded = {
  /** Clock of the load, so the axis and the projection share one "now". */
  at: number;
  /** Provider the slices/baseline describe. */
  id: string | null;
  /** When the user informed `already spent`; the count starts here. */
  reset: number | undefined;
  /** The baseline captured for this load, in USD. */
  spent: number | undefined;
  /** First instant on the axis (the reset, or the window start). */
  start: number;
  /** Slices of the selected provider, from `start` to `at`. */
  buckets: CostRangeResult[];
  /** Whole-window slices, so the provider picker ranks the window. */
  totals: CostRangeResult[];
  /** Spending between the reset and the window start, per provider. */
  offset: Record<string, number>;
};

const numText = (value: number | undefined): string =>
  value === undefined || !Number.isFinite(value) ? "" : String(value);

const parseAmount = (raw: string): number | undefined => {
  const text = raw.trim().replace(",", ".");
  if (text === "") return undefined;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
};

export function CostChart(props: { client: StatsClient; active: boolean }) {
  const ctx = usePlugin();
  const t = useT();
  const locale = useLocale();
  const settings = costSettingsFor(ctx);

  const [loaded, setLoaded] = createSignal<Loaded | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [reload, setReload] = createSignal(0);

  let pending: { aborted: boolean } | undefined;
  onCleanup(() => {
    if (pending) pending.aborted = true;
  });

  const now = createMemo(() => loaded()?.at ?? Date.now());
  const windowCount = createMemo(
    () => loaded()?.totals.length || settings.window(),
  );

  const providers = createMemo(() => providerTotals(loaded()?.totals ?? []));

  const provider = createMemo(() => {
    const list = providers();
    const selected = settings.selected();
    if (selected && list.some((entry) => entry.id === selected)) return selected;
    return list[0]?.id;
  });

  // The zero mark of the loaded data, not of the settings: a spent edit only
  // reaches the chart when its slices arrive, so the baseline is never paired
  // with a window that still belongs to the previous mark.
  const reset = createMemo(() => loaded()?.reset);

  const series = createMemo(() => {
    const data = loaded();
    if (!data?.id) return undefined;
    const days = providerDays(data.buckets, data.id);
    const baseline = (data.spent ?? 0) + (data.offset[data.id] ?? 0);
    return cumulativeSeries(days, baseline, data.at);
  });

  const total = createMemo(() => series()?.total ?? 0);
  const current = createMemo(() => {
    const points = series()?.points ?? [];
    return points[points.length - 1]?.value ?? 0;
  });
  const average = createMemo(() => {
    const data = loaded();
    if (!data) return 0;
    return averageDailyCost(
      total(),
      spanDays(data.at, data.start, windowCount(), data.reset !== undefined),
    );
  });

  const limit = createMemo(() => {
    const id = provider();
    return id ? settings.limit(id) : undefined;
  });

  const crossing = createMemo(() =>
    limitCrossing(current(), limit(), average(), now()),
  );

  const projectionEnd = createMemo(() => {
    const cross = crossing();
    if (cross !== undefined) return Math.max(now(), cross);
    return addDays(now(), windowCount());
  });

  const projected = createMemo(() =>
    projectionSeries(
      { t: now(), value: current() },
      average(),
      projectionEnd(),
    ),
  );

  const domain = createMemo(() => ({
    t0: loaded()?.start ?? dayWindow(Date.now(), settings.window()).from,
    t1: Math.max(now(), projectionEnd()),
  }));

  const yMax = createMemo(() => {
    const values = [current(), ...projected().map((point) => point.value)];
    const budget = limit();
    if (budget !== undefined && budget > 0) values.push(budget);
    return costScale(values.length > 0 ? Math.max(...values) : 0);
  });

  // Measure the card and redraw at that width, like the other charts: scaling a
  // fixed viewBox would scale the labels too.
  const [width, setWidth] = createSignal(W);
  const pw = createMemo(() => Math.max(1, width() - LEFT - RIGHT));
  let host: HTMLElement | undefined;
  onMount(() => {
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next && next > 0) setWidth(Math.max(MIN_WIDTH, Math.round(next)));
    });
    observer.observe(host);
    onCleanup(() => observer.disconnect());
  });

  const xAt = (at: number): number => {
    const { t0, t1 } = domain();
    if (t1 <= t0) return LEFT;
    return LEFT + pw() * Math.min(1, Math.max(0, (at - t0) / (t1 - t0)));
  };
  const yAt = (value: number): number => {
    const max = yMax();
    if (!(max > 0) || !Number.isFinite(value)) return TOP + PH;
    return TOP + PH * (1 - Math.min(1, Math.max(0, value / max)));
  };

  const realPath = createMemo(() => {
    const points = series()?.points ?? [];
    return points
      .map((point, index) => `${index === 0 ? "M" : "L"}${xAt(point.t).toFixed(2)} ${yAt(point.value).toFixed(2)}`)
      .join(" ");
  });

  const realArea = createMemo(() => {
    const points = series()?.points ?? [];
    if (points.length < 2) return "";
    const first = points[0]!;
    const last = points[points.length - 1]!;
    return `${realPath()} L${xAt(last.t).toFixed(2)} ${(TOP + PH).toFixed(2)} L${xAt(first.t).toFixed(2)} ${(TOP + PH).toFixed(2)} Z`;
  });

  const projectionPath = createMemo(() => {
    const points = projected();
    return points
      .map((point, index) => `${index === 0 ? "M" : "L"}${xAt(point.t).toFixed(2)} ${yAt(point.value).toFixed(2)}`)
      .join(" ");
  });

  const grid = createMemo(() =>
    [0, 0.5, 1].map((ratio) => ({
      y: TOP + PH * (1 - ratio),
      label: formatCostAxis(yMax() * ratio, locale, yMax()),
    })),
  );

  const dayPoints = createMemo(() => {
    const points = series()?.points ?? [];
    if (windowCount() > MAX_DOTS || points.length < 2) return [];
    return points;
  });

  const crossingDate = createMemo(() => {
    const cross = crossing();
    return cross === undefined ? undefined : formatCostDate(cross, locale, true);
  });

  const crossed = createMemo(() => {
    const cross = crossing();
    return cross !== undefined && cross <= now();
  });

  const showCrossingLabel = createMemo(() => {
    const cross = crossing();
    if (cross === undefined) return false;
    return Math.abs(xAt(cross) - xAt(now())) > 46;
  });

  const summary = createMemo(() => {
    const budget = limit();
    if (budget === undefined || budget <= 0) return t("stats.costNoLimit");
    if (crossed()) return t("stats.costReached");
    if (crossing() === undefined) return t("stats.costUnreachable");
    return t("stats.costReaches", formatCostDate(crossing()!, locale, true));
  });

  const effectiveWindow = createMemo(() => {
    const width = settings.window();
    return (WINDOWS as readonly number[]).includes(width) ? width : WINDOWS[0]!;
  });

  // The draft text must survive typing a decimal point, so the inputs keep
  // their own string and only re-sync when the provider or the store changes.
  const [limitText, setLimitText] = createSignal("");
  const [spentText, setSpentText] = createSignal("");

  createEffect(
    on(
      () => [provider(), settings.ready()] as const,
      ([id]) => {
        if (!id) {
          setLimitText("");
          setSpentText("");
          return;
        }
        setLimitText(numText(untrack(() => settings.limit(id))));
        setSpentText(numText(untrack(() => settings.spent(id))));
      },
    ),
  );

  const commit = (id: string | undefined, key: "limit" | "spent", raw: string): void => {
    if (!id) return;
    const value = parseAmount(raw);
    if (key === "limit") settings.setLimit(id, value);
    else settings.setSpent(id, value);
  };

  const load = async (): Promise<void> => {
    if (pending) pending.aborted = true;
    const token = { aborted: false };
    pending = token;
    const at = Date.now();
    setLoading(true);
    setError(null);
    try {
      const size = settings.window();
      // The picker ranks the whole window, so its slices are always fetched.
      const windowPlan = costRanges(at, size);
      const totals = await fetchCostRanges(props.client, windowPlan.buckets, {
        signal: token,
        now: at,
      });
      if (token.aborted) return;

      const list = providerTotals(totals);
      const selected = settings.selected();
      const id =
        selected && list.some((entry) => entry.id === selected) ? selected : list[0]?.id;
      const spentAt = id ? settings.spentAt(id) : undefined;
      const spent = id ? settings.spent(id) : undefined;
      const plan = costRanges(at, size, spentAt);

      let offset: Record<string, number> = {};
      if (plan.offset) {
        const [slice] = await fetchCostRanges(props.client, [plan.offset], {
          signal: token,
          now: at,
        });
        if (token.aborted) return;
        offset = slice?.providers ?? {};
      }

      const reuse =
        plan.buckets.length === windowPlan.buckets.length &&
        plan.buckets.every((bucket, index) => {
          const other = windowPlan.buckets[index];
          return other !== undefined && bucket.from === other.from && bucket.to === other.to;
        });
      const buckets = reuse
        ? totals
        : await fetchCostRanges(props.client, plan.buckets, { signal: token, now: at });
      if (token.aborted) return;

      setLoaded({
        at,
        id: id ?? null,
        reset: spentAt,
        spent,
        start: plan.start,
        buckets,
        totals,
        offset,
      });
    } catch (cause) {
      if (token.aborted) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (pending === token) {
        pending = undefined;
        setLoading(false);
      }
    }
  };

  // Two keys instead of one: everything that changes the fetched window loads
  // at once, while a new zero mark (typed into `already spent`) waits for a
  // short pause. Each keystroke stamps a new mark, so loading per keypress
  // would fire one abortable fetch per digit.
  const baseKey = createMemo(() =>
    [
      props.active ? "1" : "0",
      settings.window(),
      settings.selected() ?? "",
      provider() ?? "",
      reload(),
    ].join("|"),
  );
  const markKey = createMemo(() => {
    const id = provider();
    return id ? String(settings.spentAt(id) ?? "") : "";
  });

  let markTimer: ReturnType<typeof setTimeout> | undefined;
  const clearMarkTimer = (): void => {
    if (markTimer) clearTimeout(markTimer);
    markTimer = undefined;
  };

  createEffect(
    on(
      () => [baseKey(), markKey()] as const,
      ([base], previous) => {
        const baseChanged = !previous || previous[0] !== base;
        if (!props.active) {
          clearMarkTimer();
          if (pending) pending.aborted = true;
          return;
        }
        if (baseChanged) {
          clearMarkTimer();
          void load();
          return;
        }
        clearMarkTimer();
        markTimer = setTimeout(() => {
          markTimer = undefined;
          void load();
        }, COST_MARK_DEBOUNCE_MS);
      },
    ),
  );
  onCleanup(clearMarkTimer);

  // Today's bucket goes stale while the panel stays open; the cache keeps past
  // days, so a periodic reload only re-reads today.
  let timer: ReturnType<typeof setInterval> | undefined;
  createEffect(
    on(
      () => props.active,
      (active) => {
        if (timer) {
          clearInterval(timer);
          timer = undefined;
        }
        if (!active) return;
        timer = setInterval(() => setReload((value) => value + 1), 60_000);
      },
    ),
  );
  onCleanup(() => {
    if (timer) clearInterval(timer);
  });

  const retry = (): void => {
    clearCostCache();
    setReload((value) => value + 1);
  };

  return (
    <>
      <style>{BASE_CSS}</style>
      <style>{CSS}</style>
      <section class="stats-card" ref={host}>
        <div class="stats-card-head">
          <h3 title={t("stats.costHint")}>{t("stats.costTitle")}</h3>
          <span class="stats-spacer" />
          <Show when={providers().length > 0}>
            <select
              class="stats-cost-select"
              aria-label={t("stats.costProvider")}
              value={provider() ?? ""}
              onChange={(event) => settings.select(event.currentTarget.value || null)}
            >
              <For each={providers()}>
                {(entry) => (
                  <option value={entry.id}>
                    {entry.id} · {formatCost(entry.cost, locale)}
                  </option>
                )}
              </For>
            </select>
          </Show>
          <div
            class="stats-token-view stats-cost-window"
            role="group"
            aria-label={t("stats.costWindow")}
          >
            <For each={WINDOWS}>
              {(size) => (
                <button
                  type="button"
                  classList={{ "is-active": effectiveWindow() === size }}
                  onClick={() => settings.setWindow(size)}
                  title={t("stats.costWindowOption", size)}
                >
                  {size}
                </button>
              )}
            </For>
          </div>
          <ctx.ui.Tooltip value={t("stats.refresh")}>
            <ctx.ui.IconButton
              icon="refresh"
              label={t("stats.refresh")}
              variant="ghost-muted"
              size="small"
              onClick={retry}
            />
          </ctx.ui.Tooltip>
        </div>

        <div class="stats-cost-fields">
          <label class="stats-cost-field">
            <span>{t("stats.costLimit")}</span>
            <ctx.ui.TextInput
              value={limitText()}
              onInput={(value) => {
                setLimitText(value);
                commit(provider(), "limit", value);
              }}
              label={t("stats.costLimit")}
              placeholder="0.00"
            />
          </label>
          <label class="stats-cost-field">
            <span>{t("stats.costSpent")}</span>
            <ctx.ui.TextInput
              value={spentText()}
              onInput={(value) => {
                setSpentText(value);
                commit(provider(), "spent", value);
              }}
              label={t("stats.costSpent")}
              placeholder="0.00"
            />
          </label>
        </div>

        <Show when={error()}>
          <div class="stats-banner is-error">
            <span>{t("stats.costError")}: {error()}</span>
            <span class="stats-spacer" />
            <ctx.ui.Button size="small" variant="contrast" onClick={retry}>
              {t("stats.costRetry")}
            </ctx.ui.Button>
          </div>
        </Show>

        <Show when={loading() && !loaded()}>
          <div class="stats-banner">
            <span class="stats-spinner" />
            <span>{t("stats.costLoading")}</span>
          </div>
        </Show>

        <Show when={loaded() && providers().length === 0}>
          <div class="stats-note">
            <span>{t("stats.costEmpty")}</span>
          </div>
        </Show>

        <Show when={provider()}>
          <div class="stats-cost-summary">
            <span class="stats-cost-stat">
              <span class="stats-cost-stat-key">{t("stats.costCurrent")}</span>
              <b>{formatCost(current(), locale)}</b>
            </span>
            <span class="stats-cost-stat">
              <span class="stats-cost-stat-key">{t("stats.costAverage")}</span>
              <b>{formatCost(average(), locale)}</b>
            </span>
            <span class="stats-cost-stat">
              <span class="stats-cost-stat-key">{t("stats.costProjection")}</span>
              <b classList={{ "is-warn": crossed() }}>{summary()}</b>
            </span>
          </div>

          <Show when={reset() !== undefined}>
            <div class="stats-note">
              <span>{t("stats.costSince", formatCostInstant(reset()!, locale))}</span>
            </div>
          </Show>

          <div class="stats-chart stats-cost-chart">
            <svg
              class="stats-chart-svg stats-cost-svg"
              viewBox={`0 0 ${width()} ${H}`}
              role="img"
              aria-label={`${t("stats.costTitle")}: ${summary()}`}
              preserveAspectRatio="none"
            >
              <For each={grid()}>
                {(row) => (
                  <>
                    <line
                      class="stats-chart-grid"
                      x1={LEFT}
                      x2={width() - RIGHT}
                      y1={row.y}
                      y2={row.y}
                    />
                    <text
                      class="stats-chart-axis"
                      x={LEFT - 4}
                      y={row.y + 3}
                      text-anchor="end"
                    >
                      {row.label}
                    </text>
                  </>
                )}
              </For>

              <Show when={limit() !== undefined && limit()! > 0}>
                <line
                  class="stats-cost-cutoff"
                  x1={LEFT}
                  x2={width() - RIGHT}
                  y1={yAt(limit()!)}
                  y2={yAt(limit()!)}
                />
                <text
                  class="stats-cost-cutoff-label"
                  x={width() - RIGHT}
                  y={Math.max(TOP + 8, yAt(limit()!) - 3)}
                  text-anchor="end"
                >
                  {t("stats.costLimit")} {formatCostAxis(limit()!, locale, yMax())}
                </text>
              </Show>

              <Show when={projectionPath().length > 0}>
                <path class="stats-cost-projection" d={projectionPath()} />
              </Show>

              <Show when={realPath().length > 0}>
                <path class="stats-cost-area" d={realArea()} />
                <path class="stats-cost-line" d={realPath()} />
              </Show>

              <For each={dayPoints()}>
                {(point) => (
                  <circle
                    class="stats-cost-dot"
                    cx={xAt(point.t)}
                    cy={yAt(point.value)}
                    r={1.6}
                  />
                )}
              </For>

              <line
                class="stats-cost-today"
                x1={xAt(now())}
                x2={xAt(now())}
                y1={TOP}
                y2={TOP + PH}
              />

              <Show when={crossing() !== undefined}>
                <line
                  class="stats-cost-crossing"
                  x1={xAt(crossing()!)}
                  x2={xAt(crossing()!)}
                  y1={TOP}
                  y2={TOP + PH}
                />
                <circle
                  class="stats-cost-crossing-dot"
                  cx={xAt(crossing()!)}
                  cy={yAt(crossed() ? current() : limit() ?? 0)}
                  r={2.8}
                />
              </Show>

              <text
                class="stats-chart-axis"
                x={LEFT}
                y={H - 4}
                text-anchor="start"
              >
                {formatCostDate(domain().t0, locale)}
              </text>
              <Show when={xAt(now()) - LEFT > 56}>
                <text
                  class="stats-chart-axis"
                  x={xAt(now())}
                  y={H - 4}
                  text-anchor="middle"
                >
                  {t("stats.costToday")}
                </text>
              </Show>
              <Show when={crossing() !== undefined && showCrossingLabel()}>
                <text
                  class="stats-cost-crossing-label"
                  x={xAt(crossing()!)}
                  y={H - 4}
                  text-anchor="middle"
                >
                  {crossingDate()}
                </text>
              </Show>
            </svg>
          </div>

          <div class="stats-note">
            <span>{t("stats.costNote")}</span>
          </div>
        </Show>
      </section>
    </>
  );
}