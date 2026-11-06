/**
 * Compact tok/s strip for the session header (`session.header` slot).
 *
 * Shows the current/last turn's rate, duration, reasoning tokens and tool
 * calls. Clicking opens the Statistics tab. The live timer runs only while the
 * timeline is visible and the session is generating.
 */

import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { usePlugin } from "@opencode/plugin/gui";
import type { MountedSession } from "@opencode/plugin/gui";

import { formatDuration, formatRate, formatTokens } from "../format";
import { analyzeTurn, findTurns, lastAssistantTurn } from "../metrics";
import { useLocale, useT } from "./i18n";
import { useObservability } from "./observability";

const CSS = `
.stats-strip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 29px;
  padding: 0 10px;
  border: 1px solid var(--v2-border-border-muted, #2c2c2c);
  background: var(--v2-background-bg-layer-02, #202020);
  border-radius: 8px;
  color: var(--v2-text-text-muted, #9b9b9b);
  font-family: var(--font-family-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  transition: border-color 150ms, background 150ms, color 150ms;
}
.stats-strip:hover { border-color: var(--v2-border-border-strong, #3a3a3a); background: var(--v2-overlay-simple-overlay-hover, #262626); color: var(--v2-text-text-base, #e8e8e8); }
.stats-strip:focus-visible { outline: 2px solid var(--v2-border-border-focus, #4c9aff); outline-offset: 1px; }
.stats-strip-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--v2-icon-icon-accent, #4dc8b8); box-shadow: 0 0 0 3px color-mix(in srgb, var(--v2-icon-icon-accent, #4dc8b8) 14%, transparent); animation: stats-strip-pulse 1.4s ease-in-out infinite; }
@keyframes stats-strip-pulse { 0%, 100% { opacity: 0.35; transform: scale(0.85); } 50% { opacity: 1; transform: scale(1); } }
.stats-strip-icon { width: 12px; height: 12px; flex: none; opacity: 0.9; }
.stats-strip-rate { color: var(--v2-icon-icon-accent, #4dc8b8); font-weight: 650; font-variant-numeric: tabular-nums; }
.stats-strip-value { font-variant-numeric: tabular-nums; }
.stats-strip-sep { color: var(--v2-text-text-faint, #6e6e6e); }
`;

const Icon = (props: { path: string }) => (
  <svg class="stats-strip-icon" viewBox="0 0 16 16" aria-hidden="true">
    <path d={props.path} fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);

export function StatsStrip(props: { session: MountedSession; active: boolean }) {
  const ctx = usePlugin();
  const t = useT();
  const locale = useLocale();
  const observability = useObservability(props.session);

  const messages = createMemo(() =>
    props.session.id ? props.session.server.data.session.message.list(props.session.id) : [],
  );
  const running = createMemo(() =>
    props.session.id ? props.session.server.data.session.status(props.session.id) === "running" : false,
  );
  const lastTurn = createMemo(() => lastAssistantTurn(findTurns(messages())));

  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (!props.active || observability.hidden() || !running()) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    onCleanup(() => clearInterval(timer));
  });

  const turn = createMemo(() => {
    const current = lastTurn();
    return current ? analyzeTurn(current, now(), running()) : undefined;
  });

  const rate = createMemo(() => {
    const metrics = turn();
    if (!metrics) return undefined;
    if (metrics.liveRate !== undefined) return metrics.liveRate;
    return metrics.steps[metrics.steps.length - 1]?.rate ?? metrics.rate;
  });

  // The dot follows the turn, not the step: a tool execution between two
  // streaming steps must not flash the live indicator off.
  const live = createMemo(() => running() && rate() !== undefined);
  const tools = createMemo(() => turn()?.toolCalls.length ?? 0);
  const reasoning = createMemo(() => {
    const metrics = turn();
    if (!metrics) return 0;
    return metrics.reasoningTokens > 0 ? metrics.reasoningTokens : metrics.reasoningTextTokens;
  });
  const duration = createMemo(() => turn()?.durationMs);

  const open = () => {
    if (!props.session.id) return;
    ctx.layout.open(`${ctx.id}:stats`, props.session);
  };

  const title = () => {
    const value = formatRate(rate(), locale);
    const parts = [
      `${t("stats.rate")}: ${value}`,
      `${t("stats.duration")}: ${formatDuration(duration())}`,
      `${t("stats.reasoning")}: ${formatTokens(reasoning(), locale)}`,
      `${t("stats.tools")}: ${tools()}`,
    ];
    return `${t("header.open")} — ${parts.join(" · ")}`;
  };

  return (
    <Show when={observability.enabled() && turn() && turn()!.steps.length > 0}>
      <style>{CSS}</style>
      <button class="stats-strip" type="button" onClick={open} title={title()} aria-label={title()}>
        <Show when={live()}>
          <span class="stats-strip-dot" />
        </Show>
        <Icon path="M8.8 1.5 3.5 9h3.6l-.9 5.5L11.5 7H8l.8-5.5Z" />
        <span class="stats-strip-rate">
          {formatRate(rate(), locale)} {t("stats.rate")}
        </span>
        <span class="stats-strip-sep">·</span>
        <Icon path="M8 2.3A5.7 5.7 0 1 0 8 13.7 5.7 5.7 0 0 0 8 2.3Zm0 3v2.9l2.2 1.4" />
        <span class="stats-strip-value">{formatDuration(duration())}</span>
        <Show when={reasoning() > 0}>
          <span class="stats-strip-sep">·</span>
          <Icon path="M6.2 2.4a2 2 0 0 0-2 2 1.9 1.9 0 0 0-1.3 2.9 2 2 0 0 0 .4 2.7 2 2 0 0 0 1.9 2.2c.3.8 1 1.4 1.9 1.4.5 0 .9-.2 1.2-.5V3.1a1.7 1.7 0 0 0-2.1-.7Z" />
          <span class="stats-strip-value">{formatTokens(reasoning(), locale)}</span>
        </Show>
        <span class="stats-strip-sep">·</span>
        <Icon path="M10.6 2.3a3.2 3.2 0 0 0-3.9 4.1l-4 4a1.4 1.4 0 0 0 2 2l4-4a3.2 3.2 0 0 0 4.1-3.9l-1.8 1.8-1.9-.2-.2-1.9 1.7-1.9Z" />
        <span class="stats-strip-value">
          {tools()} {t("header.tools")}
        </span>
      </button>
    </Show>
  );
}
