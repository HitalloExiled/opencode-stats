/**
 * Context growth chart.
 *
 * One point per request: the prompt size the provider reported (uncached input
 * plus the cached prefix). Completed compactions become vertical checkpoints so
 * the reset is visible without opening the context composition card.
 *
 * Context is drawn from the transcript, not from the capture store: metrics and
 * history live in the window. The geometry is the same pure SVG path code the
 * rate chart uses.
 */

import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";

import { formatNumber, formatPercent, formatTokens } from "../format";
import {
  accumulatedTokens,
  areaPath,
  linePath,
  maxValue,
  normalizeSeries,
  sampleDomain,
  tokenScale,
  type CompactionCheckpoint,
  type ContextSample,
} from "../history";
import { useLocale, useT } from "./i18n";
import chartCss from "./chart.scss?inline";
import contextCss from "./context-chart.scss?inline";

const BASE_CSS = chartCss;
const CSS = contextCss;

const W = 360;
const H = 116;
const LEFT = 34;
const RIGHT = 8;
const TOP = 10;
const BOTTOM = 18;
const PH = H - TOP - BOTTOM;
const MIN_WIDTH = LEFT + RIGHT + 24;

/** Above this count the per-request dots would be noise; the line carries it. */
const MAX_DOTS = 120;

export function ContextChart(props: {
  samples: readonly ContextSample[];
  checkpoints: readonly CompactionCheckpoint[];
  /** Context window of the model, for the last-value percentage. */
  limit?: number | undefined;
  now: number;
}) {
  const t = useT();
  const locale = useLocale();

  // Same responsive approach as the rate chart: measure the card and redraw at
  // that width instead of scaling a fixed viewBox (which scales the text too).
  const [width, setWidth] = createSignal(W);
  const pw = createMemo(() => Math.max(1, width() - LEFT - RIGHT));
  let host: HTMLDivElement | undefined;
  onMount(() => {
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next && next > 0) setWidth(Math.max(MIN_WIDTH, Math.round(next)));
    });
    observer.observe(host);
    onCleanup(() => observer.disconnect());
  });

  // A compaction can be newer than the last request (the marker would fall
  // outside the edge); extend the right edge so the just-created checkpoint
  // still shows.
  const domain = createMemo(() => {
    const base = sampleDomain(props.samples, props.now);
    const latest = props.checkpoints.reduce(
      (max, checkpoint) =>
        Number.isFinite(checkpoint.t) && checkpoint.t > max ? checkpoint.t : max,
      base.t1,
    );
    return { t0: base.t0, t1: latest > base.t0 ? latest : base.t0 + 1000 };
  });

  const visible = createMemo(() => {
    const { t0, t1 } = domain();
    return props.samples.filter(
      (sample) => sample.t >= t0 && sample.t <= t1 && Number.isFinite(sample.value),
    );
  });

  const scaleMax = createMemo(() => tokenScale(maxValue(visible()) ?? 0));
  const points = createMemo(() =>
    normalizeSeries(visible(), domain().t0, domain().t1, Math.max(1, scaleMax())),
  );

  const line = createMemo(() => linePath(points(), pw(), PH));
  const area = createMemo(() => areaPath(points(), pw(), PH));
  const last = createMemo(() => visible()[visible().length - 1]);
  const dots = createMemo(() => points().length <= MAX_DOTS);
  // Session-wide total: it never resets at a compaction, so it measures how
  // much context the model was sent overall.
  const accumulated = createMemo(() => accumulatedTokens(props.samples));

  const lastShare = createMemo(() => {
    const limit = props.limit;
    const sample = last();
    if (limit === undefined || limit <= 0 || !sample) return undefined;
    return (sample.value / limit) * 100;
  });

  const marks = createMemo(() => {
    const { t0, t1 } = domain();
    const span = t1 - t0;
    if (span <= 0) return [];
    return props.checkpoints
      .filter((checkpoint) => checkpoint.t >= t0 && checkpoint.t <= t1)
      .map((checkpoint) => ({
        checkpoint,
        x: Math.min(1, Math.max(0, (checkpoint.t - t0) / span)),
      }));
  });

  const grid = createMemo(() =>
    [0, 0.5, 1].map((ratio) => ({
      ratio,
      y: TOP + PH * (1 - ratio),
      label: formatTokens(scaleMax() * ratio, locale),
    })),
  );

  const checkpointLabel = (checkpoint: CompactionCheckpoint): string =>
    checkpoint.reason === "manual"
      ? t("stats.checkpointManual")
      : t("stats.checkpointAuto");

  const checkpointTitle = (checkpoint: CompactionCheckpoint): string => {
    const label = checkpointLabel(checkpoint);
    if (checkpoint.before === undefined || checkpoint.after === undefined) return label;
    return `${label} · ${t(
      "stats.checkpointRange",
      formatTokens(checkpoint.before, locale),
      formatTokens(checkpoint.after, locale),
    )}`;
  };

  const ariaLabel = createMemo(
    () => `${t("stats.contextGrowth")}: ${t("stats.checkpoints", marks().length)}`,
  );

  return (
    <>
      <style>{BASE_CSS}</style>
      <style>{CSS}</style>
      <div class="stats-chart stats-context-chart" ref={host}>
        <div class="stats-chart-head">
          <span class="stats-chart-title" title={t("stats.contextGrowthHint")}>
            {t("stats.contextGrowth")}
          </span>
          <span class="stats-chart-spacer" />
          <Show when={marks().length > 0}>
            <span class="stats-context-count">
              <span class="stats-context-count-dot" />
              {t("stats.checkpoints", marks().length)}
            </span>
          </Show>
          <Show when={last()}>
            <span
              class="stats-context-last"
              title={
                lastShare() !== undefined
                  ? t("stats.contextUsage", formatPercent(lastShare(), locale))
                  : undefined
              }
            >
              {formatTokens(last()!.value, locale)} {t("stats.tokens")}
            </span>
          </Show>
          <Show when={accumulated() > 0}>
            <span
              class="stats-context-total"
              title={`${t("stats.contextAccumulatedHint")} · ${formatNumber(accumulated(), locale)}`}
            >
              {t("stats.contextAccumulated", formatTokens(accumulated(), locale))}
            </span>
          </Show>
        </div>

        <svg
          class="stats-chart-svg stats-context-svg"
          viewBox={`0 0 ${width()} ${H}`}
          role="img"
          aria-label={ariaLabel()}
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
                <text class="stats-chart-axis" x={LEFT - 4} y={row.y + 3} text-anchor="end">
                  {row.label}
                </text>
              </>
            )}
          </For>

          <g transform={`translate(${LEFT} ${TOP})`}>
            <Show when={points().length > 0}>
              <path class="stats-chart-area" d={area()} />
              <path class="stats-chart-line" d={line()} />
              <Show when={dots()}>
                <For each={points()}>
                  {(point) => (
                    <circle
                      class="stats-context-point"
                      cx={point.x * pw()}
                      cy={(1 - point.y) * PH}
                      r={1.5}
                    />
                  )}
                </For>
              </Show>
              <For each={marks()}>
                {(mark) => (
                  <g>
                    <title>{checkpointTitle(mark.checkpoint)}</title>
                    <line
                      class="stats-context-checkpoint"
                      x1={mark.x * pw()}
                      x2={mark.x * pw()}
                      y1={0}
                      y2={PH}
                    />
                    <circle
                      class="stats-context-checkpoint-dot"
                      cx={mark.x * pw()}
                      cy={0}
                      r={2.4}
                    />
                  </g>
                )}
              </For>
            </Show>
          </g>

          <Show when={points().length === 0}>
            <text
              class="stats-chart-empty"
              x={width() / 2}
              y={TOP + PH / 2}
              text-anchor="middle"
            >
              {t("stats.noContextSamples")}
            </text>
          </Show>

          <text class="stats-chart-axis" x={LEFT} y={H - 4} text-anchor="start">
            {t("stats.start")}
          </text>
          <text class="stats-chart-axis" x={width() - RIGHT} y={H - 4} text-anchor="end">
            {t("stats.now")}
          </text>
        </svg>
      </div>
    </>
  );
}
