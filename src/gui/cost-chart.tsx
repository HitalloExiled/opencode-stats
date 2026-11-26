/**
 * Cost + projection card.
 *
 * The chart is machine-wide: one provider at a time, cumulative spend since the
 * last top-up (`ultima recarga`), plus a straight projection from today with the
 * average daily cost measured since then. The optional budget is a horizontal
 * cutoff; when the projection crosses it, the card shows the date.
 *
 * `lastRecharge` anchors the cycle: the series starts there (or at the start of
 * the window when it is older, with the spending in between folded into the
 * baseline). Editing `already spent` does not move the anchor: each save is one
 * signed external step at its instant, so the measured history keeps its shape
 * and the running total — and the forecast that starts from it — follows the
 * edit. Every editable field lives in the config modal (`./cost-config`).
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
} from "solid-js";
import { usePlugin } from "@opencode/plugin/gui";

import {
  adjustmentTotal,
  applyCostAdjustments,
  averageDailyCost,
  axisEnd,
  baselineAtMark,
  clampStart,
  costRanges,
  costScale,
  cumulativeSeries,
  dayWindow,
  fitCheckpoints,
  forecastTicks,
  formatCost,
  formatCostAxis,
  formatCostDate,
  formatCostInstant,
  formatCostValue,
  formatPercent,
  formatRechargeDate,
  gatewayCycle,
  limitCrossing,
  monotoneCurve,
  percentOf,
  percentScale,
  projectionSeries,
  spanDays,
  type PlotPoint,
} from "../cost";
import {
  clearCostCache,
  fetchCostRanges,
  providerDays,
  providerTotals,
  type CostRangeResult,
  type StatsClient,
} from "./cost-source";
import { openCostConfig } from "./cost-config";
import { costSettingsFor } from "./cost-settings";
import { StatsRpc, type GatewayInfo } from "./contract";
import { useLocale, useT } from "./i18n";
import chartCss from "./chart.scss?inline";
import costCss from "./cost-chart.scss?inline";

const BASE_CSS = chartCss;
const CSS = costCss;

const W = 360;
const H = 164;
const LEFT = 44;
const RIGHT = 12;
const TOP = 10;
const BOTTOM = 26;
const PH = H - TOP - BOTTOM;
const MIN_WIDTH = LEFT + RIGHT + 24;
const DAY_MS = 86_400_000;

/** Unique ids for the per-instance gradient and hatch pattern. */
let instances = 0;

/** Beyond this the axis is clamped and the card says the top-up is older. */
const COST_START_MAX_DAYS = 90;

type Loaded = {
  /** Clock of the load, so the axis and the projection share one "now". */
  at: number;
  /** Provider the slices describe. */
  id: string | null;
  /** Start of the measured cycle: the top-up, or the legacy zero mark. */
  reset: number | undefined;
  /** First instant on the axis (the top-up, or the window start). */
  start: number;
  /** Slices of the selected provider, from `start` to `at`. */
  buckets: CostRangeResult[];
  /** Whole-window slices, so the provider picker ranks the window. */
  totals: CostRangeResult[];
  /** Spending between the top-up and the window start, per provider. */
  offset: Record<string, number>;
  /** The selected provider's gateway answer; null when it could not be read. */
  gateway: GatewayInfo | null;
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

  /** The selected provider's gateway answer, when this load fetched one. */
  const gateway = createMemo(() => loaded()?.gateway ?? null);

  /** Key spend folded into the base captured at the top-up. */
  const cycle = createMemo(() => {
    const data = loaded();
    const info = data?.gateway;
    if (!data?.id || !info || info.status !== "ok" || info.spend === undefined) {
      return undefined;
    }
    return gatewayCycle(
      info.spend,
      info.limit,
      info.resetsAt,
      settings.gatewayBase(data.id),
      settings.gatewayResetAt(data.id),
    );
  });

  const series = createMemo(() => {
    const data = loaded();
    if (!data?.id) return undefined;
    const days = providerDays(data.buckets, data.id);
    // The informed total and its edits are read live from the store: an edit
    // changes the value, not the fetched slices, so the history keeps its shape
    // and only the step (and the total/forecast after it) moves. With the
    // gateway connected, the key spend captured at the top-up is the baseline
    // and the manual edits are ignored; the key total is the truth.
    const keyed = cycle();
    const adjustments = keyed ? [] : settings.adjustments(data.id);
    const base = keyed
      ? keyed.base
      : baselineAtMark(settings.spent(data.id), adjustments);
    const baseline = base + (data.offset[data.id] ?? 0);
    const curve = cumulativeSeries(days, baseline, data.at);
    // Make the drawn line land on the key's total: the gateway may include
    // spending this machine did not measure (another client on the same key).
    const measured = baseline + curve.total + adjustmentTotal(adjustments);
    const steps = keyed
      ? [{ at: data.at, delta: keyed.spent - measured }]
      : adjustments;
    return { points: applyCostAdjustments(curve.points, steps), total: curve.total };
  });

  const total = createMemo(() => series()?.total ?? 0);
  const current = createMemo(() => {
    const keyed = cycle();
    if (keyed) return keyed.spent;
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
    const keyed = cycle();
    if (keyed && keyed.limit !== undefined) return keyed.limit;
    const id = provider();
    return id ? settings.limit(id) : undefined;
  });

  const crossing = createMemo(() =>
    limitCrossing(current(), limit(), average(), now()),
  );

  /** A positive limit is what switches the axis to percentage of the budget. */
  const budget = createMemo(() => {
    const value = limit();
    return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
  });

  /** First instant on the axis: the top-up (or the legacy mark), else the window. */
  const startAt = createMemo(
    () => loaded()?.start ?? dayWindow(Date.now(), settings.window()).from,
  );

  // The drawn future: a little past the crossing, capped at 90 days; without a
  // crossing in reach, a fixed 30-day horizon.
  const projectionEnd = createMemo(() =>
    axisEnd(current(), budget(), average(), now()),
  );

  const projected = createMemo(() =>
    projectionSeries(
      { t: now(), value: current() },
      average(),
      projectionEnd(),
    ),
  );

  /** The crossing is only drawn when the axis reaches it. */
  const crossingVisible = createMemo(() => {
    const cross = crossing();
    return cross !== undefined && cross <= projectionEnd();
  });

  const domain = createMemo(() => ({
    t0: startAt(),
    t1: Math.max(now(), projectionEnd()),
  }));

  // One scale for both modes: percentage of the limit (the 100% line always in
  // view, like the reference chart) or USD. `at` maps a USD value into axis
  // units, so the paths and the grid share the same mapping. The history peak is
  // included: a downward edit leaves earlier values above the current one.
  const yAxis = createMemo(() => {
    const values = [
      ...(series()?.points ?? []).map((point) => point.value),
      ...projected().map((point) => point.value),
      // The gateway total may sit above the locally measured curve.
      current(),
    ];
    const top = values.length > 0 ? Math.max(...values) : 0;
    const cap = budget();
    if (cap !== undefined) {
      const { max, ticks } = percentScale(Math.max(percentOf(top, cap), 100));
      return { percent: true, max, ticks, at: (value: number) => percentOf(value, cap) };
    }
    const max = costScale(top);
    return { percent: false, max, ticks: [0, max / 2, max], at: (value: number) => value };
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
  const yAtAxis = (value: number): number => {
    const max = yAxis().max;
    if (!(max > 0) || !Number.isFinite(value)) return TOP + PH;
    return TOP + PH * (1 - Math.min(1, Math.max(0, value / max)));
  };
  const yAt = (value: number): number => yAtAxis(yAxis().at(value));

  const plotPoints = createMemo<PlotPoint[]>(() =>
    (series()?.points ?? []).map((point) => ({ x: xAt(point.t), y: yAt(point.value) })),
  );

  const usagePath = createMemo(() => monotoneCurve(plotPoints()));

  const usageArea = createMemo(() => {
    const points = plotPoints();
    if (points.length < 2) return "";
    const first = points[0]!;
    const last = points[points.length - 1]!;
    const bottom = (TOP + PH).toFixed(2);
    return `${usagePath()}L${last.x.toFixed(2)} ${bottom}L${first.x.toFixed(2)} ${bottom}Z`;
  });

  const projectionPath = createMemo(() => {
    const points = projected();
    return points
      .map((point, index) => `${index === 0 ? "M" : "L"}${xAt(point.t).toFixed(2)} ${yAt(point.value).toFixed(2)}`)
      .join(" ");
  });

  /** End of the forecast: dot plus label, drawn only when the limit is in view. */
  const forecastEnd = createMemo(() => {
    const points = projected();
    if (points.length === 0 || !crossingVisible()) return undefined;
    const last = points[points.length - 1]!;
    const cap = budget();
    return {
      x: xAt(last.t),
      y: yAt(last.value),
      label:
        cap !== undefined
          ? formatPercent(last.value / cap, locale)
          : formatCost(last.value, locale),
    };
  });

  const grid = createMemo(() => {
    const axis = yAxis();
    return axis.ticks.map((tick) => ({
      y: yAtAxis(tick),
      label: axis.percent ? `${tick}%` : formatCostAxis(tick, locale, axis.max),
    }));
  });

  const ticks = createMemo(() => {
    // Today first, then one checkpoint every 10 days into the forecast, and the
    // hit date last: the axis answers "when does the budget end".
    const hit = crossingVisible() ? crossing() : undefined;
    const list = forecastTicks(now(), domain().t1, hit).map((tick) => ({
      x: xAt(tick.t),
      label: formatCostDate(tick.t, locale),
      current: tick.current,
      hit: tick.hit,
    }));
    // A short axis can put two labels on the same pixels; a colliding label
    // gives way, and the hit date never does.
    return fitCheckpoints(list);
  });

  const crossed = createMemo(() => {
    const cross = crossing();
    return cross !== undefined && cross <= now();
  });

  const summary = createMemo(() => {
    const cap = budget();
    if (cap === undefined) return t("stats.costNoLimit");
    if (crossed()) return t("stats.costReached");
    if (crossing() === undefined) return t("stats.costUnreachable");
    return t("stats.costBalanceEnds", formatCostDate(crossing()!, locale, true));
  });

  /** A key is stored but the gateway did not answer: the card uses the manual fields. */
  const gatewayWarning = createMemo(() => {
    const info = gateway();
    if (!info || info.status !== "error" || !info.hasKey) return undefined;
    if (info.invalidKey) return t("stats.costGatewayInvalid");
    if (info.routeBlocked) return t("stats.costGatewayRoute");
    return t("stats.costGatewayUnavailable", info.message ?? "—");
  });

  const uid = `stats-cost-${++instances}`;

  const currentLabel = createMemo(() => {
    const cap = budget();
    return cap !== undefined
      ? formatPercent(current() / cap, locale)
      : formatCost(current(), locale);
  });

  const limitMeta = createMemo(() => {
    const cap = budget();
    return cap !== undefined
      ? t("stats.costOfLimit", formatCost(current(), locale), formatCost(cap, locale))
      : t("stats.costNoLimit");
  });

  const averageLabel = createMemo(() => {
    const cap = budget();
    return cap !== undefined
      ? t("stats.costAverageLine", formatPercent(average() / cap, locale))
      : t("stats.costAverageLine", formatCost(average(), locale));
  });

  /** Pill behind the current date label; SVG has no text background. */
  const pillWidth = (label: string): number => Math.round(label.length * 4.8 + 12);

/** Centers a date label, clamped so the first and the last never clip. */
  const tickX = (tick: { x: number; label: string }): number => {
    const half = pillWidth(tick.label) / 2;
    return Math.min(Math.max(tick.x, LEFT + half), width() - RIGHT - half);
  };

  const anchor = createMemo(() => {
    const id = provider();
    if (!id) return undefined;
    return settings.lastRecharge(id) ?? settings.spentAt(id);
  });

  /** The top-up is older than the axis can reach: the series starts later. */
  const clampedDays = createMemo(() => {
    const start = settings.lastRecharge(provider() ?? "");
    if (start === undefined) return undefined;
    const days = Math.floor((now() - start) / DAY_MS);
    return days > COST_START_MAX_DAYS ? days : undefined;
  });

  /** "Top-up on 26/11/2026", or the legacy "Counting from <instant>". */
  const anchorNote = createMemo(() => {
    const start = anchor();
    if (start === undefined) return undefined;
    const recharge = provider() ? settings.lastRecharge(provider()!) : undefined;
    return recharge !== undefined
      ? t("stats.costSinceRecharge", formatRechargeDate(recharge, locale))
      : t("stats.costSince", formatCostInstant(start, locale));
  });

  /** Read-only recap of the configured values, under the legend. */
  const configSummary = createMemo(() => {
    const id = provider();
    if (!id) return "";
    const parts = [t("stats.costLimit"), formatCostValue(limit(), locale)];
    if (cycle() || settings.spent(id) !== undefined) {
      // The recap shows what the card draws now, not the internal baseline.
      parts.push(
        t("stats.costSpent"),
        formatCostValue(loaded() ? current() : settings.spent(id), locale),
      );
    }
    const recharge = settings.lastRecharge(id);
    if (recharge !== undefined) {
      parts.push(t("stats.costRecharge"), formatRechargeDate(recharge, locale));
    }
    const info = gateway();
    if (info?.status === "ok" && info.spend !== undefined) {
      parts.push(t("stats.costGateway"), formatCostValue(info.spend, locale));
    }
    return parts.join(" · ");
  });

  const refresh = (): void => {
    setReload((value) => value + 1);
  };

  const openConfig = (): void => {
    const id = provider();
    if (!id) return;
    openCostConfig({
      ctx,
      settings,
      providerID: id,
      // The field edits the total the card draws, so it starts there; before the
      // first load the stored value is the best available number.
      prefillSpent: loaded() ? current() : settings.spent(id),
      // Read at save time: the step is "typed minus what is drawn then", so an
      // edit saved after more cost accrued still lands on the typed number.
      current: () => current(),
      onSaved: refresh,
    });
  };

  const openRenew = (): void => {
    const id = provider();
    if (!id) return;
    // A top-up starts a new cycle at now, so the baseline is usually 0. The
    // cycle only moves when the modal is confirmed, and the exact instant is
    // kept while the field is untouched.
    openCostConfig({
      ctx,
      settings,
      providerID: id,
      prefillAt: Date.now(),
      prefillSpent: 0,
      current: () => current(),
      onSaved: refresh,
    });
  };

  /** The gateway answer never fails the card: a null value falls back to manual. */
  const readGateway = async (providerID: string): Promise<GatewayInfo | null> => {
    try {
      return await ctx.client.rpc(StatsRpc).gateway({ providerID });
    } catch {
      return null;
    }
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
      const spentAt = id
        ? clampStart(settings.lastRecharge(id) ?? settings.spentAt(id), at)
        : undefined;
      const plan = costRanges(at, size, spentAt);
      // Start the gateway read now so it overlaps the cost slices.
      const gatewayPromise = id ? readGateway(id) : Promise.resolve(null);

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
      const [buckets, gateway] = await Promise.all([
        reuse
          ? Promise.resolve(totals)
          : fetchCostRanges(props.client, plan.buckets, { signal: token, now: at }),
        gatewayPromise,
      ]);
      if (token.aborted) return;

      setLoaded({
        at,
        id: id ?? null,
        reset: spentAt,
        start: plan.start,
        buckets,
        totals,
        offset,
        gateway,
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

  // Everything that changes the fetched slices (window, provider, refresh, or a
// new/cleared zero mark) loads at once. Edits to `already spent` inside the same
// cycle do not appear here: they change the value, not the slices, and the
// series reads them live from the store.
  const baseKey = createMemo(() =>
    [
      props.active ? "1" : "0",
      settings.window(),
      settings.selected() ?? "",
      provider() ?? "",
      String(
        provider()
          ? (settings.lastRecharge(provider()!) ?? settings.spentAt(provider()!) ?? "")
          : "",
      ),
      reload(),
    ].join("|"),
  );

  createEffect(
    on(baseKey, () => {
      if (!props.active) {
        if (pending) pending.aborted = true;
        return;
      }
      void load();
    }),
  );

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
          <div class="stats-cost-kpi">
            <span class="stats-cost-kpi-key">{t("stats.costCurrent")}</span>
            <b class="stats-cost-kpi-value" classList={{ "is-warn": crossed() }}>
              {currentLabel()}
            </b>
            <span class="stats-cost-kpi-meta">{limitMeta()}</span>
            <span class="stats-spacer" />
            <span class="stats-cost-kpi-status" classList={{ "is-warn": crossed() }}>
              {summary()}
            </span>
          </div>

          <Show when={anchorNote()}>
            {(note) => (
              <div class="stats-note">
                <span>{note()}</span>
              </div>
            )}
          </Show>

          <Show when={clampedDays()}>
            {(days) => (
              <div class="stats-note is-warn">
                <span>{t("stats.costClamped", days())}</span>
              </div>
            )}
          </Show>

          <Show when={gatewayWarning()}>
            {(message) => (
              <div class="stats-note is-warn">
                <span>{message()}</span>
              </div>
            )}
          </Show>

          <div class="stats-chart stats-cost-chart">
            <svg
              class="stats-chart-svg stats-cost-svg"
              viewBox={`0 0 ${width()} ${H}`}
              role="img"
              aria-label={`${t("stats.costTitle")}: ${summary()}`}
              preserveAspectRatio="none"
            >
              <defs>
                <linearGradient id={`${uid}-area`} x1="0" y1="0" x2="0" y2="1">
                  <stop class="stats-cost-area-stop" offset="0%" stop-opacity="0.24" />
                  <stop class="stats-cost-area-stop" offset="100%" stop-opacity="0" />
                </linearGradient>
                <pattern
                  id={`${uid}-hatch`}
                  width="7"
                  height="7"
                  patternUnits="userSpaceOnUse"
                  patternTransform="rotate(45)"
                >
                  <line class="stats-cost-hatch-line" x1="0" y1="0" x2="0" y2="7" />
                </pattern>
              </defs>

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
                      x={LEFT - 5}
                      y={row.y + 3}
                      text-anchor="end"
                    >
                      {row.label}
                    </text>
                  </>
                )}
              </For>

              {/* Date checkpoints: a faint guide ties each labelled date to the
                  plot, so the axis reads as a timeline. Today and the hit date
                  already have their own vertical lines. */}
              <For each={ticks()}>
                {(tick) => (
                  <Show when={!tick.current && !tick.hit}>
                    <line
                      class="stats-cost-checkpoint"
                      x1={tick.x}
                      x2={tick.x}
                      y1={TOP}
                      y2={TOP + PH}
                    />
                  </Show>
                )}
              </For>

              <Show when={projected().length > 0}>
                <rect
                  class="stats-cost-hatch"
                  x={xAt(now())}
                  y={TOP}
                  width={Math.max(0, width() - RIGHT - xAt(now()))}
                  height={PH}
                  fill={`url(#${uid}-hatch)`}
                />
              </Show>

              <Show when={budget()}>
                {(cap) => (
                  <>
                    <line
                      class="stats-cost-cutoff"
                      x1={LEFT}
                      x2={width() - RIGHT}
                      y1={yAt(cap())}
                      y2={yAt(cap())}
                    />
                    <Show when={!yAxis().percent}>
                      <text
                        class="stats-cost-cutoff-label"
                        x={width() - RIGHT}
                        y={Math.max(TOP + 8, yAt(cap()) - 3)}
                        text-anchor="end"
                      >
                        {t("stats.costLimit")} {formatCostAxis(cap(), locale, yAxis().max)}
                      </text>
                    </Show>
                  </>
                )}
              </Show>

              <Show when={usagePath().length > 0}>
                <path class="stats-cost-area" d={usageArea()} fill={`url(#${uid}-area)`} />
                <path class="stats-cost-line" d={usagePath()} />
              </Show>

              <Show when={projectionPath().length > 0}>
                <path class="stats-cost-projection" d={projectionPath()} />
              </Show>

              <Show when={forecastEnd()}>
                {(end) => (
                  <>
                    <circle
                      class="stats-cost-end-dot"
                      cx={end().x}
                      cy={end().y}
                      r={2.6}
                    />
                    <text
                      class="stats-cost-end-label"
                      x={Math.min(end().x, width() - RIGHT)}
                      y={Math.max(TOP + 8, end().y - 6)}
                      text-anchor="end"
                    >
                      {end().label}
                    </text>
                  </>
                )}
              </Show>

              <line
                class="stats-cost-now"
                x1={xAt(now())}
                x2={xAt(now())}
                y1={TOP}
                y2={TOP + PH}
              />

              <Show when={crossingVisible()}>
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
                  cy={yAt(crossed() ? current() : budget() ?? 0)}
                  r={2.6}
                />
              </Show>

              <rect
                class="stats-cost-axis-band"
                x={LEFT}
                y={H - 22}
                width={Math.max(0, width() - LEFT - RIGHT)}
                height={18}
                rx={5}
              />

              <For each={ticks()}>
                {(tick) => (
                  <g>
                    <Show when={tick.current || tick.hit}>
                      <rect
                        class="stats-cost-tick-pill"
                        classList={{ "is-hit": tick.hit }}
                        x={tickX(tick) - pillWidth(tick.label) / 2}
                        y={H - 20}
                        width={pillWidth(tick.label)}
                        height={16}
                        rx={4}
                      />
                    </Show>
                    <text
                      class="stats-chart-axis stats-cost-tick"
                      classList={{
                        "is-current": tick.current && !tick.hit,
                        "is-hit": tick.hit,
                      }}
                      x={tickX(tick)}
                      y={H - 8}
                      text-anchor="middle"
                    >
                      {tick.label}
                    </text>
                  </g>
                )}
              </For>
            </svg>
          </div>

          <div class="stats-cost-footer">
            <span class="stats-cost-average">{averageLabel()}</span>
            <span class="stats-spacer" />
            <div class="stats-cost-legend">
              <span class="stats-cost-legend-item">
                <i class="stats-cost-swatch is-usage" />
                {t("stats.costLegendUsage")}
              </span>
              <Show when={projected().length > 0}>
                <span class="stats-cost-legend-item">
                  <i class="stats-cost-swatch is-forecast" />
                  {t("stats.costLegendForecast")}
                </span>
              </Show>
              <Show when={budget() !== undefined}>
                <span class="stats-cost-legend-item">
                  <i class="stats-cost-swatch is-limit" />
                  {t("stats.costLegendLimit")}
                </span>
              </Show>
            </div>
          </div>

          <div class="stats-cost-fields">
            <span class="stats-cost-field-value">{configSummary()}</span>
            <span class="stats-spacer" />
            <div class="stats-cost-actions">
              <ctx.ui.Button size="small" variant="ghost" onClick={openConfig}>
                {t("stats.costConfigure")}
              </ctx.ui.Button>
              <ctx.ui.Button size="small" variant="neutral" onClick={openRenew}>
                {t("stats.costRechargeAction")}
              </ctx.ui.Button>
            </div>
          </div>

          <div class="stats-note">
            <span>{t("stats.costNote")}</span>
          </div>
        </Show>
      </section>
    </>
  );
}