/**
 * Line + area chart for the tok/s history.
 *
 * The turn range spans the whole current/last turn; the session range draws a
 * sliding window of the last 3, 6 or 12 hours, anchored at the present, with
 * one exact point per completed step. The y axis and the average are derived
 * from the samples actually shown. The chart is plain SVG so the GUI bundle
 * carries no chart dependency.
 */

import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";

import { formatClock, formatRate } from "../format";
import {
  areaPath,
  averageValue,
  chartScale,
  linePath,
  maxValue,
  normalizeSeries,
  sampleDomain,
  stepPointIndices,
  windowDomain,
  type RateSample,
} from "../history";
import { useLocale, useT } from "./i18n";
import chartCss from "./chart.scss?inline";

export type ChartRange = "turn" | "3h" | "6h" | "12h";

/** Hours spanned by each sliding window, keyed by its range label. */
const WINDOW_HOURS: Record<Exclude<ChartRange, "turn">, number> = {
  "3h": 3,
  "6h": 6,
  "12h": 12,
};

const CSS = chartCss;

const W = 360;
const H = 108;
const LEFT = 28;
const RIGHT = 8;
const TOP = 8;
const BOTTOM = 18;
const PH = H - TOP - BOTTOM;
const MIN_WIDTH = LEFT + RIGHT + 24;

export function RateChart(props: {
  turnSamples: readonly RateSample[];
  sessionSamples: readonly RateSample[];
  live: boolean;
  range: ChartRange;
  onRange: (range: ChartRange) => void;
}) {
  const t = useT();
  const locale = useLocale();

  // The window slides with real time; the panel's clock only ticks while the
  // session is running, so the chart keeps its own to stay live when idle.
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });

  // Measure the card and redraw at that width. A fixed viewBox with
  // `width: 100%` scaled the whole drawing (text, strokes and dots) when the
  // panel resized, which looked like zooming instead of adapting.
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

  const samples = createMemo(() =>
    props.range === "turn" ? [...props.turnSamples] : [...props.sessionSamples],
  );

  const domain = createMemo(() =>
    props.range === "turn"
      ? sampleDomain(samples(), now())
      : windowDomain(now(), WINDOW_HOURS[props.range]!),
  );

  // The axis and the average describe what is actually drawn: the turn's
  // samples or the whole session. Counting points outside the domain would
  // keep the scale high after a fast stretch leaves the window.
  const visible = createMemo(() => {
    const { t0, t1 } = domain();
    return samples().filter(
      (sample) => sample.t >= t0 && sample.t <= t1 && Number.isFinite(sample.value),
    );
  });

  const scaleMax = createMemo(() => chartScale(maxValue(visible()) ?? 0));
  const average = createMemo(() => averageValue(visible()));

  const points = createMemo(() =>
    normalizeSeries(visible(), domain().t0, domain().t1, Math.max(1, scaleMax())),
  );

  const line = createMemo(() => linePath(points(), pw(), PH));
  const area = createMemo(() => areaPath(points(), pw(), PH));
  const stepPoints = createMemo(() => {
    const indices = new Set(stepPointIndices(points()));
    return points().filter((_, index) => indices.has(index));
  });

  const averageY = createMemo(() => {
    const value = average();
    if (value === undefined || !Number.isFinite(value) || scaleMax() <= 0) return undefined;
    const ratio = Math.min(1, Math.max(0, value / scaleMax()));
    return TOP + PH * (1 - ratio);
  });

  // Must be a memo: the scale follows the displayed window, so the labels have
  // to move with it. Reading `scaleMax()` once at setup froze the labels at
  // the initial 40 while the line and the average already used the new scale.
  const grid = createMemo(() =>
    [0, 0.5, 1].map((ratio) => ({
      ratio,
      y: TOP + PH * (1 - ratio),
      label: formatRate(scaleMax() * ratio, locale, 0),
    })),
  );

  const lastPoint = createMemo(() => points()[points().length - 1]);

  const caption = () =>
    props.range === "turn" ? t("stats.turnRange") : t(`stats.window${props.range}`);

  return (
    <>
      <style>{CSS}</style>
      <div class="stats-chart" ref={host}>
        <div class="stats-chart-head">
          <span class="stats-chart-title">{t("stats.history")}</span>
          <span class="stats-chart-spacer" />
          <div class="stats-chart-seg" role="group" aria-label={t("stats.history")}>
            <button
              type="button"
              classList={{ "is-active": props.range === "turn" }}
              onClick={() => props.onRange("turn")}
            >
              {t("stats.turnRange")}
            </button>
            <button
              type="button"
              classList={{ "is-active": props.range === "3h" }}
              onClick={() => props.onRange("3h")}
            >
              {t("stats.window3h")}
            </button>
            <button
              type="button"
              classList={{ "is-active": props.range === "6h" }}
              onClick={() => props.onRange("6h")}
            >
              {t("stats.window6h")}
            </button>
            <button
              type="button"
              classList={{ "is-active": props.range === "12h" }}
              onClick={() => props.onRange("12h")}
            >
              {t("stats.window12h")}
            </button>
          </div>
        </div>

        <svg
          class="stats-chart-svg"
          viewBox={`0 0 ${width()} ${H}`}
          role="img"
          aria-label={`${t("stats.history")}: ${caption()}`}
          preserveAspectRatio="none"
        >
          <For each={grid()}>
            {(row) => (
              <>
                <line class="stats-chart-grid" x1={LEFT} x2={width() - RIGHT} y1={row.y} y2={row.y} />
                <text class="stats-chart-axis" x={LEFT - 4} y={row.y + 3} text-anchor="end">
                  {row.label}
                </text>
              </>
            )}
          </For>

          <Show when={averageY() !== undefined}>
            <line
              class="stats-chart-average"
              x1={LEFT}
              x2={width() - RIGHT}
              y1={averageY()!}
              y2={averageY()!}
            />
          </Show>

          <g transform={`translate(${LEFT} ${TOP})`}>
            <Show when={points().length > 0}>
              <path class="stats-chart-area" d={area()} />
              <path class="stats-chart-line" d={line()} />
              <For each={stepPoints()}>
                {(point) => (
                  <circle class="stats-chart-step" cx={point.x * pw()} cy={(1 - point.y) * PH} r={2.1} />
                )}
              </For>
              <Show when={props.live && lastPoint()}>
                <circle
                  class="stats-chart-live"
                  cx={lastPoint()!.x * pw()}
                  cy={(1 - lastPoint()!.y) * PH}
                  r={2.6}
                />
              </Show>
            </Show>
          </g>

          <Show when={points().length === 0}>
            <text class="stats-chart-empty" x={width() / 2} y={TOP + PH / 2} text-anchor="middle">
              {t("stats.noSamples")}
            </text>
          </Show>

          <text class="stats-chart-axis" x={LEFT} y={H - 4} text-anchor="start">
            {props.range === "turn" ? t("stats.start") : formatClock(domain().t0, locale)}
          </text>
          <text class="stats-chart-axis" x={width() - RIGHT} y={H - 4} text-anchor="end">
            {t("stats.now")}
          </text>

          <Show when={averageY() !== undefined}>
            <text
              class="stats-chart-average-label"
              x={width() - RIGHT}
              y={Math.max(TOP + 8, averageY()! - 3)}
              text-anchor="end"
            >
              {t("stats.avg")} {formatRate(average(), locale)}
            </text>
          </Show>
        </svg>
      </div>
    </>
  );
}
