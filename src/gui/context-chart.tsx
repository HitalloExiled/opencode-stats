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
  areaPath,
  checkpointIndex,
  linePath,
  maxValue,
  normalizeByIndex,
  requestWindow,
  requestWindowCheckpoints,
  tokenScale,
  CONTEXT_WINDOW_DEFAULT,
  CONTEXT_WINDOW_SIZES,
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
  /**
   * The whole session's samples; the chart applies the request-count sliding
   * window itself (the x axis plots request index, not time, so the window
   * is a count too — the caller does not pre-cut it).
   */
  samples: readonly ContextSample[];
  checkpoints: readonly CompactionCheckpoint[];
  /**
   * Session-wide total shown in the header. Always the full series, so it
   * never changes when the window selector narrows what is drawn.
   */
  accumulated: number;
  /** Context window of the model, for the last-value percentage. */
  limit?: number | undefined;
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

  // How many requests the x axis shows; the user can widen/narrow it.
  const [windowSize, setWindowSize] = createSignal<number>(CONTEXT_WINDOW_DEFAULT);

  const visible = createMemo(() => requestWindow(props.samples, windowSize()));
  const windowedMarks = createMemo(() => requestWindowCheckpoints(props.checkpoints, visible()));

  const scaleMax = createMemo(() => tokenScale(maxValue(visible()) ?? 0));
  const points = createMemo(() => normalizeByIndex(visible(), Math.max(1, scaleMax())));

  const line = createMemo(() => linePath(points(), pw(), PH));
  const area = createMemo(() => areaPath(points(), pw(), PH));
  const last = createMemo(() => visible()[visible().length - 1]);
  const dots = createMemo(() => points().length <= MAX_DOTS);

  const lastShare = createMemo(() => {
    const limit = props.limit;
    const sample = last();
    if (limit === undefined || limit <= 0 || !sample) return undefined;
    return (sample.value / limit) * 100;
  });

  const marks = createMemo(() => {
    const windowed = visible();
    const last = windowed.length - 1;
    if (last < 0) return [];
    return windowedMarks().map((checkpoint) => ({
      checkpoint,
      x: last > 0 ? Math.min(1, Math.max(0, checkpointIndex(checkpoint, windowed) / last)) : 0,
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
    () =>
      `${t("stats.contextGrowth")}: ${t("stats.contextRequests", visible().length)}, ${t(
        "stats.checkpoints",
        marks().length,
      )}`,
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
          <Show when={visible().length > 0}>
            <span class="stats-context-requests">{t("stats.contextRequests", visible().length)}</span>
          </Show>
          <div class="stats-token-view stats-context-window" role="group" aria-label={t("stats.contextWindowSize")}>
            <For each={CONTEXT_WINDOW_SIZES}>
              {(size) => (
                <button
                  type="button"
                  classList={{ "is-active": windowSize() === size }}
                  onClick={() => setWindowSize(size)}
                  title={t("stats.contextWindowSizeOption", size)}
                >
                  {size}
                </button>
              )}
            </For>
          </div>
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
          <Show when={props.accumulated > 0}>
            <span
              class="stats-context-total"
              title={`${t("stats.contextAccumulatedHint")} · ${formatNumber(props.accumulated, locale)}`}
            >
              {t("stats.contextAccumulated", formatTokens(props.accumulated, locale))}
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

          <Show when={points().length > 0}>
            <text class="stats-chart-axis" x={LEFT} y={H - 4} text-anchor="start">
              {t("stats.contextFirstRequest")}
            </text>
            <text class="stats-chart-axis" x={width() - RIGHT} y={H - 4} text-anchor="end">
              {t("stats.contextLastRequest")}
            </text>
          </Show>
        </svg>
      </div>
    </>
  );
}
