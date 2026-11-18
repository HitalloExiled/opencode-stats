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
import headerCss from "./header.scss?inline";

const CSS = headerCss;

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
