/**
 * Line + area chart for the tok/s history.
 *
 * The turn range is a rolling 60-second window; the session range uses one
 * exact point per completed step over the session's time span. The chart is
 * plain SVG so the GUI bundle carries no chart dependency.
 */

import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";

import { formatRate } from "../format";
import {
  areaPath,
  linePath,
  normalizeSeries,
  stepPointIndices,
  type RateSample,
} from "../history";
import { useLocale, useT } from "./i18n";

export type ChartRange = "turn" | "session";

const CSS = `
.stats-chart { display: flex; flex-direction: column; gap: 6px; }
.stats-chart-head { display: flex; align-items: center; gap: 6px; }
.stats-chart-title { color: var(--v2-text-text-muted, #9b9b9b); font-size: 10px; font-weight: 700; letter-spacing: 0.55px; text-transform: uppercase; }
.stats-chart-spacer { flex: 1; }
.stats-chart-seg { display: inline-flex; padding: 2px; gap: 2px; border: 1px solid var(--v2-border-border-muted, #2c2c2c); background: var(--v2-background-bg-layer-02, #1a1a1a); border-radius: 7px; }
.stats-chart-seg button { appearance: none; border: 0; background: transparent; color: var(--v2-text-text-muted, #9b9b9b); font: inherit; font-size: 10px; padding: 3px 8px; border-radius: 5px; cursor: pointer; }
.stats-chart-seg button:hover { color: var(--v2-text-text-base, #e8e8e8); background: var(--v2-overlay-simple-overlay-hover, #262626); }
.stats-chart-seg button.is-active { color: var(--v2-text-text-base, #e8e8e8); background: var(--v2-overlay-simple-overlay-pressed, #303030); font-weight: 650; }
.stats-chart-svg { width: 100%; height: 108px; display: block; overflow: visible; }
.stats-chart-grid { stroke: var(--v2-border-border-muted, #2c2c2c); stroke-width: 1; stroke-dasharray: 2 4; }
.stats-chart-axis { fill: var(--v2-text-text-faint, #6e6e6e); font-family: var(--font-family-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif); font-size: 8px; }
.stats-chart-area { fill: var(--v2-icon-icon-accent, #4dc8b8); fill-opacity: 0.12; }
.stats-chart-line { fill: none; stroke: var(--v2-icon-icon-accent, #4dc8b8); stroke-width: 1.8; stroke-linejoin: round; stroke-linecap: round; }
.stats-chart-average { stroke: var(--v2-text-text-muted, #9b9b9b); stroke-width: 1; stroke-dasharray: 3 4; }
.stats-chart-average-label { fill: var(--v2-text-text-muted, #9b9b9b); font-family: var(--font-family-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif); font-size: 8px; }
.stats-chart-step { fill: var(--v2-icon-icon-accent, #4dc8b8); stroke: var(--v2-background-bg-layer-02, #1a1a1a); stroke-width: 1; }
.stats-chart-live { fill: var(--v2-icon-icon-accent, #4dc8b8); animation: stats-chart-pulse 1.4s ease-in-out infinite; }
@keyframes stats-chart-pulse { 0%, 100% { opacity: 0.35; transform: scale(0.85); transform-origin: center; } 50% { opacity: 1; transform: scale(1); } }
.stats-chart-empty { fill: var(--v2-text-text-faint, #6e6e6e); font-family: var(--font-family-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif); font-size: 9px; }
`;

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
  average: number | undefined;
  scaleMax: number;
  live: boolean;
  now: number;
  range: ChartRange;
  onRange: (range: ChartRange) => void;
}) {
  const t = useT();
  const locale = useLocale();

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
    props.range === "session" ? [...props.sessionSamples] : [...props.turnSamples],
  );

  const domain = createMemo(() => {
    const list = samples();
    const first = list[0]?.t;
    const last = list[list.length - 1]?.t;
    if (props.range === "session") {
      const t0 = first ?? props.now;
      const t1 = last ?? props.now;
      return { t0, t1: t1 > t0 ? t1 : t0 + 1000 };
    }
    const t1 = props.live ? Math.max(props.now, last ?? props.now) : (last ?? props.now);
    return { t0: t1 - 60_000, t1 };
  });

  const points = createMemo(() =>
    normalizeSeries(samples(), domain().t0, domain().t1, Math.max(1, props.scaleMax)),
  );

  const line = createMemo(() => linePath(points(), pw(), PH));
  const area = createMemo(() => areaPath(points(), pw(), PH));
  const stepPoints = createMemo(() => {
    const indices = new Set(stepPointIndices(points()));
    return points().filter((_, index) => indices.has(index));
  });

  const averageY = createMemo(() => {
    const average = props.average;
    if (average === undefined || !Number.isFinite(average) || props.scaleMax <= 0) return undefined;
    const ratio = Math.min(1, Math.max(0, average / props.scaleMax));
    return TOP + PH * (1 - ratio);
  });

  const grid = [0, 0.5, 1].map((ratio) => ({
    ratio,
    y: TOP + PH * (1 - ratio),
    label: formatRate(props.scaleMax * ratio, locale, 0),
  }));

  const lastPoint = createMemo(() => points()[points().length - 1]);

  const caption = () =>
    props.range === "session" ? t("stats.sessionRange") : t("stats.last60");

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
              classList={{ "is-active": props.range === "session" }}
              onClick={() => props.onRange("session")}
            >
              {t("stats.sessionRange")}
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
          <For each={grid}>
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
            {props.range === "session" ? t("stats.start") : t("stats.last60")}
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
              {t("stats.avg")} {formatRate(props.average, locale)}
            </text>
          </Show>
        </svg>
      </div>
    </>
  );
}
