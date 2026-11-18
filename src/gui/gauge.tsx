/**
 * Radial tok/s gauge.
 *
 * A hand-drawn SVG semicircle: track, value arc, a tick for the session
 * average and the current value in the center. The scale is supplied by the
 * panel and only grows during a session, so the arc never jumps.
 */

import { createMemo } from "solid-js";

import { formatRate } from "../format";
import { useLocale, useT } from "./i18n";
import gaugeCss from "./gauge.scss?inline";

const CSS = gaugeCss;

const CX = 80;
const CY = 78;
const R = 60;
const ARC = `M ${CX - R} ${CY} A ${R} ${R} 0 0 1 ${CX + R} ${CY}`;

export function Gauge(props: {
  value: number | undefined;
  average: number | undefined;
  max: number;
}) {
  const t = useT();
  const locale = useLocale();

  const ratio = createMemo(() => {
    const value = props.value;
    if (value === undefined || !Number.isFinite(value) || props.max <= 0) return 0;
    return Math.min(1, Math.max(0, value / props.max));
  });

  const avgRatio = createMemo(() => {
    const average = props.average;
    if (average === undefined || !Number.isFinite(average) || props.max <= 0) return undefined;
    return Math.min(1, Math.max(0, average / props.max));
  });

  const point = (ratioValue: number) => {
    const theta = Math.PI * (1 - ratioValue);
    return {
      x: CX + R * Math.cos(theta),
      y: CY - R * Math.sin(theta),
    };
  };

  const avgTick = createMemo(() => {
    const value = avgRatio();
    if (value === undefined) return undefined;
    const theta = Math.PI * (1 - value);
    const inner = R - 9;
    const outer = R + 9;
    return {
      x1: CX + inner * Math.cos(theta),
      y1: CY - inner * Math.sin(theta),
      x2: CX + outer * Math.cos(theta),
      y2: CY - outer * Math.sin(theta),
    };
  });

  const dot = createMemo(() => (props.value === undefined ? undefined : point(ratio())));

  const label = () => {
    const value = props.value;
    const rate = formatRate(value, locale);
    const avg = formatRate(props.average, locale);
    return `${t("stats.rate")}: ${rate}, ${t("stats.avg")}: ${avg}, ${t("stats.max")}: ${formatRate(props.max, locale, 0)}`;
  };

  return (
    <>
      <style>{CSS}</style>
      <svg
        class="stats-gauge"
        viewBox="0 0 160 100"
        role="img"
        aria-label={label()}
        preserveAspectRatio="xMidYMid meet"
      >
        <path class="stats-gauge-track" d={ARC} pathLength={100} />
        <path
          class="stats-gauge-value"
          d={ARC}
          pathLength={100}
          style={{ "stroke-dasharray": `${ratio() * 100} 100` }}
        />
        {avgTick() && (
          <line
            class="stats-gauge-avg"
            x1={avgTick()!.x1}
            y1={avgTick()!.y1}
            x2={avgTick()!.x2}
            y2={avgTick()!.y2}
          />
        )}
        {dot() && <circle class="stats-gauge-dot" cx={dot()!.x} cy={dot()!.y} r={3.2} />}
        <text class="stats-gauge-number" x={CX} y={70} text-anchor="middle">
          {props.value === undefined ? "—" : formatRate(props.value, locale)}
        </text>
        <text class="stats-gauge-unit" x={CX} y={86} text-anchor="middle">
          {t("stats.rate")}
        </text>
        <text class="stats-gauge-edge" x={CX - R - 2} y={96} text-anchor="middle">
          0
        </text>
        <text class="stats-gauge-edge" x={CX + R + 2} y={96} text-anchor="middle">
          {formatRate(props.max, locale, 0)}
        </text>
        {props.average !== undefined && (
          <text class="stats-gauge-avg-label" x={CX} y={96} text-anchor="middle">
            {t("stats.avg")} {formatRate(props.average, locale)}
          </text>
        )}
      </svg>
    </>
  );
}
