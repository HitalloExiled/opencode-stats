/**
 * Statistics tab: gauge, rate history, current turn and session totals.
 *
 * The window computes everything from `session.server.data` and the session
 * history; the server is only used for the system prompt tab. The full history
 * comes from `session.context` because the timeline keeps only the initial
 * window (~20 messages), merged with the live copy the timeline already holds.
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
import type { MountedSession } from "@opencode/plugin/gui";
import type { SessionMessageInfo } from "@opencode/client";

import { formatDuration, formatPercent, formatRate, formatTokens } from "../format";
import {
  analyzeSession,
  analyzeTurn,
  estimateLiveRate,
  findTurns,
  lastAssistantTurn,
  mergeMessages,
  stepMetrics,
  totalTokens,
  type ToolCall,
} from "../metrics";
import {
  createRingBuffer,
  niceScale,
  samplesForTurn,
  stepSamples,
  type RateSample,
} from "../history";
import { RateChart, type ChartRange } from "./chart";
import { Gauge } from "./gauge";
import { useLocale, useT } from "./i18n";
import { useObservability } from "./observability";

const CSS = `
.stats {
  --stats-input: #4b7cc9;
  --stats-output: var(--v2-icon-icon-accent, #4dc8b8);
  --stats-reason: #b49cff;
  --stats-cache: #7c7c7c;
  --stats-ok: var(--v2-text-text-success, #5fce7d);
  --stats-error: var(--v2-text-text-danger, #ef6b6b);
  --stats-run: var(--v2-text-text-info, #7db8ff);
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  color: var(--v2-text-text-base, #e8e8e8);
  font-family: var(--font-family-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  font-size: 12.5px;
  scrollbar-width: thin;
  scrollbar-color: var(--v2-border-border-strong, #3a3a3a) transparent;
}
.stats::-webkit-scrollbar { width: 10px; }
.stats::-webkit-scrollbar-thumb { background: var(--v2-border-border-strong, #303030); border-radius: 8px; border: 3px solid transparent; background-clip: padding-box; }
.stats-head { display: flex; align-items: center; gap: 8px; padding: 1px 2px 0; }
.stats-title { margin: 0; font-size: 13px; font-weight: 650; letter-spacing: 0.1px; }
.stats-scope { color: var(--v2-text-text-faint, #6e6e6e); font-size: 10.5px; margin-left: auto; display: inline-flex; align-items: center; gap: 5px; }
.stats-icon-btn { appearance: none; border: 1px solid transparent; background: transparent; color: var(--v2-text-text-faint, #6e6e6e); width: 25px; height: 25px; border-radius: 6px; display: grid; place-items: center; cursor: pointer; }
.stats-icon-btn:hover { background: var(--v2-overlay-simple-overlay-hover, #262626); color: var(--v2-text-text-base, #e8e8e8); border-color: var(--v2-border-border-muted, #2c2c2c); }
.stats-icon-btn:focus-visible { outline: 2px solid var(--v2-border-border-focus, #4c9aff); outline-offset: 1px; }
.stats-toggle { display: inline-flex; align-items: center; gap: 5px; height: 25px; padding: 0 9px; border-radius: 6px; border: 1px solid var(--v2-border-border-muted, #2c2c2c); background: var(--v2-background-bg-layer-02, #1a1a1a); color: var(--v2-text-text-muted, #9b9b9b); font: inherit; font-size: 10.5px; font-weight: 650; line-height: 1; cursor: pointer; transition: border-color 150ms, background 150ms, color 150ms; }
.stats-toggle:hover { color: var(--v2-text-text-base, #e8e8e8); border-color: var(--v2-border-border-strong, #3a3a3a); background: var(--v2-overlay-simple-overlay-hover, #262626); }
.stats-toggle:focus-visible { outline: 2px solid var(--v2-border-border-focus, #4c9aff); outline-offset: 1px; }
.stats-toggle:disabled { opacity: 0.55; cursor: default; }
.stats-toggle.is-on { color: var(--stats-error); border-color: color-mix(in srgb, var(--stats-error) 38%, transparent); background: color-mix(in srgb, var(--stats-error) 10%, transparent); }
.stats-toggle.is-on:hover { background: color-mix(in srgb, var(--stats-error) 17%, transparent); }
.stats-toggle.is-off { color: var(--stats-ok); border-color: color-mix(in srgb, var(--stats-ok) 38%, transparent); background: color-mix(in srgb, var(--stats-ok) 10%, transparent); }
.stats-toggle.is-off:hover { background: color-mix(in srgb, var(--stats-ok) 17%, transparent); }
.stats-card { border: 1px solid var(--v2-border-border-muted, #2c2c2c); background: var(--v2-background-bg-layer-02, #1a1a1a); border-radius: 10px; padding: 11px; display: flex; flex-direction: column; gap: 9px; }
.stats-card-head { display: flex; align-items: center; gap: 7px; min-height: 18px; }
.stats-card-head h3 { margin: 0; font-size: 10.5px; font-weight: 700; letter-spacing: 0.6px; text-transform: uppercase; color: var(--v2-text-text-faint, #6e6e6e); }
.stats-spacer { flex: 1; }
.stats-pill { display: inline-flex; align-items: center; gap: 5px; height: 19px; padding: 0 7px; border-radius: 999px; font-size: 10px; font-weight: 600; border: 1px solid var(--v2-border-border-muted, #2c2c2c); background: var(--v2-overlay-simple-overlay-pressed, #262626); color: var(--v2-text-text-muted, #9b9b9b); }
.stats-pill.is-live { color: var(--stats-run); background: color-mix(in srgb, var(--stats-run) 10%, transparent); border-color: color-mix(in srgb, var(--stats-run) 22%, transparent); }
.stats-pill-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--stats-run); animation: stats-pulse 1.4s ease-in-out infinite; }
@keyframes stats-pulse { 0%, 100% { opacity: 0.35; transform: scale(0.85); } 50% { opacity: 1; transform: scale(1); } }
.stats-hero { display: flex; align-items: center; gap: 8px; min-width: 0; }
.stats-gauge-wrap { flex: 0 0 146px; max-width: 146px; min-width: 0; }
.stats-hero-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-end; gap: 2px; text-align: right; }
.stats-model { max-width: 100%; color: var(--v2-text-text-muted, #9b9b9b); font-size: 11.5px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stats-agent { color: var(--v2-text-text-faint, #6e6e6e); font-family: var(--font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 9.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.stats-waiting { color: var(--stats-run); font-size: 9.5px; line-height: 1.3; }
.stats-quick { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
.stats-quick-cell { border: 1px solid var(--v2-border-border-muted, #2c2c2c); background: var(--v2-background-bg-layer-01, #191919); border-radius: 8px; padding: 6px 7px; display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.stats-quick-label { color: var(--v2-text-text-faint, #6e6e6e); font-size: 9px; font-weight: 650; letter-spacing: 0.5px; text-transform: uppercase; }
.stats-quick-value { color: var(--v2-text-text-base, #e8e8e8); font-size: 12.5px; font-weight: 650; font-variant-numeric: tabular-nums; white-space: nowrap; }
.stats-quick-value small { color: var(--v2-text-text-faint, #6e6e6e); font-size: 9.5px; font-weight: 500; }
.stats-metric { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border: 1px solid var(--v2-border-border-muted, #2c2c2c); background: var(--v2-background-bg-layer-01, #191919); border-radius: 8px; }
.stats-metric-lead { width: 23px; height: 23px; border-radius: 7px; display: grid; place-items: center; flex: none; }
.stats-metric-lead.is-reason { background: color-mix(in srgb, var(--stats-reason) 12%, transparent); color: var(--stats-reason); }
.stats-metric-lead.is-tool { background: color-mix(in srgb, var(--v2-text-text-warning, #f0b44c) 12%, transparent); color: var(--v2-text-text-warning, #f0b44c); }
.stats-metric-text { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.stats-metric-key { color: var(--v2-text-text-muted, #9b9b9b); font-size: 10.5px; font-weight: 600; }
.stats-metric-value { color: var(--v2-text-text-faint, #6e6e6e); font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stats-metric-value b { color: var(--v2-text-text-base, #e8e8e8); font-weight: 650; }
.stats-tool-list { display: flex; flex-direction: column; gap: 1px; max-height: 186px; overflow-y: auto; scrollbar-width: thin; }
.stats-tool-row { display: flex; align-items: center; gap: 7px; padding: 4px 6px; border-radius: 6px; font-size: 10.5px; color: var(--v2-text-text-muted, #9b9b9b); }
.stats-tool-row:hover { background: var(--v2-overlay-simple-overlay-hover, #262626); }
.stats-status { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.stats-status.is-ok { background: var(--stats-ok); }
.stats-status.is-error { background: var(--stats-error); }
.stats-status.is-running { background: var(--stats-run); animation: stats-pulse 1.2s ease-in-out infinite; }
.stats-tool-name { color: var(--v2-text-text-base, #e8e8e8); font-family: var(--font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 10.5px; flex: none; }
.stats-tool-detail { color: var(--v2-text-text-faint, #6e6e6e); font-family: var(--font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 9.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.stats-tool-duration { color: var(--v2-text-text-faint, #6e6e6e); font-variant-numeric: tabular-nums; font-size: 10px; flex: none; }
.stats-tool-duration.is-error { color: var(--stats-error); }
.stats-tool-duration.is-live { color: var(--stats-run); }
.stats-stat-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
.stats-stat { border: 1px solid var(--v2-border-border-muted, #2c2c2c); background: var(--v2-background-bg-layer-01, #191919); border-radius: 8px; padding: 7px 8px; }
.stats-stat-key { color: var(--v2-text-text-faint, #6e6e6e); font-size: 9.5px; font-weight: 650; letter-spacing: 0.45px; text-transform: uppercase; }
.stats-stat-value { color: var(--v2-text-text-base, #e8e8e8); font-size: 14.5px; font-weight: 680; font-variant-numeric: tabular-nums; margin-top: 1px; }
.stats-stat-value small { color: var(--v2-text-text-faint, #6e6e6e); font-size: 9.5px; font-weight: 500; }
.stats-token-head { display: flex; align-items: baseline; gap: 6px; color: var(--v2-text-text-faint, #6e6e6e); font-size: 10px; }
.stats-token-head b { color: var(--v2-text-text-base, #e8e8e8); font-weight: 650; font-size: 10.5px; }
.stats-token-bar { display: flex; height: 8px; border-radius: 999px; overflow: hidden; background: var(--v2-background-bg-layer-03, #2a2a2a); border: 1px solid var(--v2-border-border-muted, #303030); }
.stats-token-seg { height: 100%; min-width: 0; }
.stats-legend { display: flex; flex-wrap: wrap; gap: 8px; font-size: 9.5px; color: var(--v2-text-text-faint, #6e6e6e); }
.stats-legend-item { display: inline-flex; align-items: center; gap: 4px; }
.stats-legend-swatch { width: 7px; height: 7px; border-radius: 2px; }
.stats-legend b { color: var(--v2-text-text-muted, #9b9b9b); font-weight: 600; font-variant-numeric: tabular-nums; }
.stats-table { display: flex; flex-direction: column; gap: 3px; }
.stats-table-row { display: grid; grid-template-columns: minmax(0, 1fr) 50px auto; gap: 9px; align-items: center; padding: 3px 2px; font-size: 10.5px; }
.stats-table-name { color: var(--v2-text-text-muted, #9b9b9b); font-family: var(--font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stats-bar-mini { width: 50px; height: 4px; border-radius: 999px; background: var(--v2-background-bg-layer-03, #2a2a2a); overflow: hidden; }
.stats-bar-mini span { display: block; height: 100%; border-radius: 999px; background: var(--v2-text-text-warning, #f0b44c); }
.stats-table-count { color: var(--v2-text-text-faint, #6e6e6e); font-variant-numeric: tabular-nums; font-size: 10px; text-align: right; min-width: 22px; }
.stats-table-count b { color: var(--v2-text-text-muted, #9b9b9b); font-weight: 600; }
.stats-models { display: flex; flex-direction: column; gap: 5px; }
.stats-model-row { display: flex; align-items: center; gap: 7px; font-size: 10.5px; }
.stats-model-chip { width: 7px; height: 7px; border-radius: 2px; flex: none; background: var(--stats-output); }
.stats-model-name { color: var(--v2-text-text-muted, #9b9b9b); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stats-model-count { color: var(--v2-text-text-faint, #6e6e6e); font-variant-numeric: tabular-nums; font-size: 10px; margin-left: auto; }
.stats-note { color: var(--v2-text-text-faint, #6e6e6e); font-size: 9.5px; display: flex; align-items: center; gap: 6px; padding: 0 2px; }
.stats-banner { border: 1px solid var(--v2-border-border-muted, #2c2c2c); background: var(--v2-background-bg-layer-02, #1a1a1a); border-radius: 8px; padding: 7px 9px; color: var(--v2-text-text-muted, #9b9b9b); font-size: 10.5px; display: flex; align-items: center; gap: 7px; }
.stats-banner.is-error { color: var(--stats-error); border-color: color-mix(in srgb, var(--stats-error) 30%, transparent); background: color-mix(in srgb, var(--stats-error) 8%, transparent); }
.stats-spinner { width: 11px; height: 11px; border-radius: 50%; border: 1.5px solid var(--v2-border-border-strong, #3a3a3a); border-top-color: var(--stats-output); animation: stats-spin 0.8s linear infinite; }
@keyframes stats-spin { to { transform: rotate(360deg); } }
.stats-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 44px 16px; text-align: center; color: var(--v2-text-text-muted, #9b9b9b); }
.stats-empty svg { opacity: 0.5; }
.stats-empty .stats-action svg { opacity: 1; }
.stats-empty-title { font-weight: 600; font-size: 12.5px; }
.stats-empty-hint { color: var(--v2-text-text-faint, #6e6e6e); font-size: 11px; max-width: 260px; }
.stats-action { appearance: none; margin-top: 5px; border: 1px solid var(--v2-border-border-muted, #2c2c2c); background: var(--v2-background-bg-layer-02, #1a1a1a); color: var(--v2-text-text-base, #e8e8e8); border-radius: 7px; padding: 5px 11px; font: inherit; font-size: 10.5px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; }
.stats-action:hover { border-color: var(--v2-border-border-strong, #3a3a3a); background: var(--v2-overlay-simple-overlay-hover, #262626); }
.stats-action:disabled { opacity: 0.55; cursor: default; }
.stats-action:focus-visible { outline: 2px solid var(--v2-border-border-focus, #4c9aff); outline-offset: 1px; }
`;

const Icon = (props: { path: string; size?: number; fill?: string }) => (
  <svg
    width={props.size ?? 13}
    height={props.size ?? 13}
    viewBox="0 0 16 16"
    aria-hidden="true"
  >
    <path
      d={props.path}
      fill={props.fill ?? "none"}
      stroke={props.fill ? "none" : "currentColor"}
      stroke-width="1.3"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
);

const REFRESH = "M13.2 8a5.2 5.2 0 1 1-1.5-3.7M13.2 2.6v3.2H10";
const BRAIN =
  "M6.2 2.4a2 2 0 0 0-2 2 1.9 1.9 0 0 0-1.3 2.9 2 2 0 0 0 .4 2.7 2 2 0 0 0 1.9 2.2c.3.8 1 1.4 1.9 1.4.5 0 .9-.2 1.2-.5V3.1a1.7 1.7 0 0 0-2.1-.7Z M9.8 2.4a2 2 0 0 1 2 2 1.9 1.9 0 0 1 1.3 2.9 2 2 0 0 1-.4 2.7 2 2 0 0 1-1.9 2.2c-.3.8-1 1.4-1.9 1.4-.5 0-.9-.2-1.2-.5";
const TOOL =
  "M10.6 2.3a3.2 3.2 0 0 0-3.9 4.1l-4 4a1.4 1.4 0 0 0 2 2l4-4a3.2 3.2 0 0 0 4.1-3.9l-1.8 1.8-1.9-.2-.2-1.9 1.7-1.9Z";
const INFO = "M8 2.3A5.7 5.7 0 1 0 8 13.7 5.7 5.7 0 0 0 8 2.3Zm0 4.4v3.1M8 5.2v.1";
const CHART = "M2 13V9m4 4V5m4 8V2m4 11V7";
const PLAY = "M4.8 2.7 13 8l-8.2 5.3V2.7Z";
const STOP = "M4.5 4.5h7v7h-7z";

export function StatsView(props: { session: MountedSession }) {
  const t = useT();
  const locale = useLocale();
  const session = props.session;
  const data = session.server.data;
  const observability = useObservability(session);
  const enabled = observability.enabled;

  const loaded = createMemo(() =>
    session.id ? data.session.message.list(session.id) : ([] as SessionMessageInfo[]),
  );
  const status = createMemo(() => (session.id ? data.session.status(session.id) : "idle"));
  const running = createMemo(() => status() === "running");

  const [full, setFull] = createSignal<SessionMessageInfo[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [now, setNow] = createSignal(Date.now());
  const [range, setRange] = createSignal<ChartRange>("turn");
  const [scaleMax, setScaleMax] = createSignal(40);

  const messages = createMemo(() => mergeMessages(full(), loaded()));
  const turns = createMemo(() => findTurns(messages()));
  const lastTurn = createMemo(() => lastAssistantTurn(turns()));
  const turnMetrics = createMemo(() => {
    const turn = lastTurn();
    return turn ? analyzeTurn(turn, now(), running()) : undefined;
  });
  const sessionMetrics = createMemo(() => analyzeSession(messages()));
  const sessionSamples = createMemo(() => stepSamples(messages()));

  let buffer = createRingBuffer(300);
  const [liveSamples, setLiveSamples] = createSignal<RateSample[]>([]);
  let finalizedStep: string | undefined;
  let turnKey: string | undefined;

  createEffect(
    on(
      () => turnMetrics()?.promptID ?? "none",
      (key) => {
        if (key === turnKey) return;
        turnKey = key;
        buffer = createRingBuffer(300);
        finalizedStep = undefined;
        setLiveSamples([]);
      },
      { defer: true },
    ),
  );

  createEffect(() => {
    if (!enabled() || observability.hidden() || !running()) return;
    const timer = setInterval(() => {
      const time = Date.now();
      setNow(time);
      const turn = lastTurn();
      const last = turn?.assistants[turn.assistants.length - 1];
      if (!last || last.time.completed !== undefined) return;
      const estimate = estimateLiveRate(last, time);
      if (estimate === undefined) return;
      buffer.push({ t: time, value: estimate, kind: "live", stepID: String(last.id) });
      setLiveSamples(buffer.values());
    }, 1000);
    onCleanup(() => clearInterval(timer));
  });

  // Append the exact point as soon as a step completes.
  createEffect(() => {
    if (!enabled()) return;
    const turn = lastTurn();
    const last = turn?.assistants[turn.assistants.length - 1];
    if (!last || last.time.completed === undefined) return;
    const id = String(last.id);
    if (finalizedStep === id) return;
    finalizedStep = id;
    const step = stepMetrics(last);
    if (step.rate === undefined || last.time.streamed === undefined) return;
    buffer.push({ t: last.time.streamed, value: step.rate, kind: "step", stepID: id });
    setLiveSamples(buffer.values());
  });

  createEffect(() => {
    const values = [
      sessionMetrics().maxRate,
      sessionMetrics().rate,
      turnMetrics()?.liveRate,
      turnMetrics()?.rate,
      ...sessionSamples().map((sample) => sample.value),
      ...liveSamples().map((sample) => sample.value),
    ].filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value) && value > 0,
    );
    const observed = values.length > 0 ? Math.max(...values) : 0;
    const next = niceScale(observed);
    if (next > scaleMax()) setScaleMax(next);
  });

  let controller: AbortController | undefined;
  async function refreshFull(silent = false) {
    if (!session.id) return;
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    if (!silent) setLoading(true);
    try {
      const result = await session.server.client.session.context(
        { sessionID: session.id },
        { signal },
      );
      if (signal.aborted) return;
      setFull(result);
      setError(null);
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }

  onMount(() => {
    if (enabled()) void refreshFull();
  });
  createEffect(
    on(
      status,
      (next, previous) => {
        if (!enabled()) return;
        if (previous === "running" && next === "idle") void refreshFull(true);
      },
      { defer: true },
    ),
  );
  onCleanup(() => controller?.abort());

  const toggle = async (next: boolean) => {
    const result = await observability.setEnabled(next);
    if (!result) return;
    buffer = createRingBuffer(300);
    finalizedStep = undefined;
    setLiveSamples([]);
    if (next) void refreshFull();
  };

  const currentRate = createMemo(() => {
    const metrics = turnMetrics();
    if (!metrics) return undefined;
    if (metrics.liveRate !== undefined) return metrics.liveRate;
    const last = metrics.steps[metrics.steps.length - 1];
    return last?.rate ?? metrics.rate;
  });

  const averageRate = createMemo(() => {
    const metrics = sessionMetrics();
    if (metrics.rate !== undefined) return metrics.rate;
    const values = sessionSamples()
      .map((sample) => sample.value)
      .filter((value) => value > 0);
    if (values.length === 0) return undefined;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  });

  const isLiveRate = createMemo(() => turnMetrics()?.liveRate !== undefined);
  const turnSamples = createMemo(() => samplesForTurn(lastTurn(), liveSamples()));

  const reasoningShare = createMemo(() => {
    const metrics = turnMetrics();
    if (!metrics || metrics.outputTokens <= 0) return undefined;
    return (metrics.reasoningTokens / metrics.outputTokens) * 100;
  });

  const turnTools = createMemo(() => {
    const calls = turnMetrics()?.toolCalls ?? [];
    return {
      calls,
      ok: calls.filter((call) => call.status === "ok").length,
      error: calls.filter((call) => call.status === "error").length,
      running: calls.filter((call) => call.status === "running").length,
      totalMs: calls.reduce((sum, call) => sum + (call.durationMs ?? 0), 0),
    };
  });

  const tokenParts = createMemo(() => {
    const tokens = sessionMetrics().tokens;
    const entries = [
      { key: "input", value: tokens.input, color: "var(--stats-input)" },
      { key: "output", value: tokens.output, color: "var(--stats-output)" },
      { key: "reasoning", value: tokens.reasoning, color: "var(--stats-reason)" },
      { key: "cache", value: tokens.cache.read + tokens.cache.write, color: "var(--stats-cache)" },
    ];
    const total = entries.reduce((sum, entry) => sum + entry.value, 0);
    return { entries, total };
  });

  const maxToolCalls = createMemo(() =>
    Math.max(1, ...sessionMetrics().tools.map((tool) => tool.calls)),
  );

  const currency = createMemo(
    () => new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }),
  );

  const empty = createMemo(() => sessionMetrics().steps === 0);
  const modelLabel = createMemo(() => turnMetrics()?.model?.id ?? t("stats.unknownModel"));
  const toolSuccess = createMemo(() => {
    const metrics = sessionMetrics();
    const finished = metrics.toolCalls.filter((call) => call.status !== "running").length;
    if (finished === 0) return undefined;
    const ok = metrics.toolCalls.filter((call) => call.status === "ok").length;
    return (ok / finished) * 100;
  });

  const toolDuration = (call: ToolCall) => {
    if (call.durationMs !== undefined) return call.durationMs;
    if (call.startedAt !== undefined) return Math.max(0, now() - call.startedAt);
    return undefined;
  };

  return (
    <div class="stats">
      <style>{CSS}</style>

      <div class="stats-head">
        <h2 class="stats-title">{t("stats.title")}</h2>
        <span class="stats-scope">
          <Icon path={INFO} size={11} />
          {t("stats.activeContext")}
        </span>
        <button
          class="stats-toggle"
          classList={{ "is-on": enabled(), "is-off": !enabled() }}
          type="button"
          title={enabled() ? t("observability.disable") : t("observability.enable")}
          aria-label={enabled() ? t("observability.disable") : t("observability.enable")}
          aria-pressed={enabled()}
          disabled={observability.busy()}
          onClick={() => void toggle(!enabled())}
        >
          <Icon path={enabled() ? STOP : PLAY} size={11} fill="currentColor" />
          {enabled() ? t("observability.stop") : t("observability.start")}
        </button>
        <Show when={enabled()}>
          <button
            class="stats-icon-btn"
            type="button"
            title={t("stats.refresh")}
            aria-label={t("stats.refresh")}
            onClick={() => void refreshFull()}
          >
            <Icon path={REFRESH} size={14} />
          </button>
        </Show>
      </div>

      <Show when={!enabled()}>
        <div class="stats-empty">
          <Icon path={STOP} size={22} fill="currentColor" />
          <span class="stats-empty-title">{t("stats.disabled")}</span>
          <span class="stats-empty-hint">{t("stats.disabledHint")}</span>
          <button
            class="stats-action"
            type="button"
            disabled={observability.busy()}
            onClick={() => void toggle(true)}
          >
            <Icon path={PLAY} size={11} fill="currentColor" />
            {t("observability.start")}
          </button>
        </div>
      </Show>

      <Show when={enabled()}>
      <Show when={error()}>
        <div class="stats-banner is-error">
          <Icon path={INFO} size={12} />
          <span>{t("stats.historyError")}: {error()}</span>
        </div>
      </Show>

      <Show when={loading()}>
        <div class="stats-banner">
          <span class="stats-spinner" />
          <span>{t("stats.loading")}</span>
        </div>
      </Show>

      <Show
        when={!empty()}
        fallback={
          <div class="stats-empty">
            <Icon path={CHART} size={22} />
            <span class="stats-empty-title">{t("stats.empty")}</span>
            <span class="stats-empty-hint">{t("stats.emptyHint")}</span>
          </div>
        }
      >
        <section class="stats-card">
          <div class="stats-card-head">
            <h3>{running() ? t("stats.currentTurn") : t("stats.lastTurn")}</h3>
            <span class="stats-spacer" />
            <Show
              when={running()}
              fallback={<span class="stats-pill">{t("stats.lastTurn")}</span>}
            >
              <span class="stats-pill is-live">
                <span class="stats-pill-dot" />
                {t("stats.generating")}
              </span>
            </Show>
          </div>

          <div class="stats-hero">
            <div class="stats-gauge-wrap">
              <Gauge
                value={currentRate()}
                average={averageRate()}
                max={scaleMax()}
                live={isLiveRate()}
              />
            </div>
            <div class="stats-hero-meta">
              <span class="stats-model" title={modelLabel()}>{modelLabel()}</span>
              <span class="stats-agent">
                {turnMetrics()?.agent ?? "—"} · {turnMetrics()?.steps.length ?? 0} {t("stats.steps")}
              </span>
              <Show when={running() && currentRate() === undefined}>
                <span class="stats-waiting">{t("stats.waiting")}</span>
              </Show>
              <Show when={!running() && averageRate() !== undefined}>
                <span class="stats-agent">
                  {t("stats.avg")} {formatRate(averageRate(), locale)} {t("stats.rate")}
                </span>
              </Show>
            </div>
          </div>

          <div class="stats-quick">
            <div class="stats-quick-cell">
              <span class="stats-quick-label">{t("stats.duration")}</span>
              <span class="stats-quick-value">{formatDuration(turnMetrics()?.durationMs)}</span>
            </div>
            <div class="stats-quick-cell">
              <span class="stats-quick-label">{t("stats.output")}</span>
              <span class="stats-quick-value">
                {formatTokens(turnMetrics()?.outputTokens ?? 0, locale)}{" "}
                <small>{t("stats.tokens")}</small>
              </span>
            </div>
            <div class="stats-quick-cell">
              <span class="stats-quick-label">{t("stats.firstToken")}</span>
              <span class="stats-quick-value">{formatDuration(turnMetrics()?.firstTokenMs)}</span>
            </div>
          </div>

          <RateChart
            turnSamples={turnSamples()}
            sessionSamples={sessionSamples()}
            average={averageRate()}
            scaleMax={scaleMax()}
            live={running()}
            now={now()}
            range={range()}
            onRange={setRange}
          />

          <div class="stats-metric">
            <span class="stats-metric-lead is-reason">
              <Icon path={BRAIN} size={13} />
            </span>
            <span class="stats-metric-text">
              <span class="stats-metric-key">{t("stats.reasoning")}</span>
              <span class="stats-metric-value">
                <b>{formatTokens(turnMetrics()?.reasoningTokens ?? 0, locale)}</b> {t("stats.tokens")} ·{" "}
                <b>{formatDuration(turnMetrics()?.reasoningMs)}</b> ·{" "}
                <b>{formatPercent(reasoningShare(), locale)}</b> {t("stats.shareOfOutput")}
              </span>
            </span>
          </div>

          <div class="stats-metric">
            <span class="stats-metric-lead is-tool">
              <Icon path={TOOL} size={13} />
            </span>
            <span class="stats-metric-text">
              <span class="stats-metric-key">{t("stats.tools")}</span>
              <span class="stats-metric-value">
                <b>{turnTools().calls.length}</b> {t("stats.calls")} · <b>{turnTools().ok}</b>{" "}
                {t("tool.ok")} · <b>{turnTools().error}</b> {t("tool.error")} ·{" "}
                <b>{formatDuration(turnTools().totalMs)}</b>
              </span>
            </span>
          </div>

          <Show when={turnTools().calls.length > 0}>
            <div class="stats-tool-list">
              <For each={turnTools().calls}>
                {(call) => (
                  <div class="stats-tool-row">
                    <span class={`stats-status is-${call.status}`} />
                    <span class="stats-tool-name">{call.name}</span>
                    <Show when={call.detail}>
                      <span class="stats-tool-detail">{call.detail}</span>
                    </Show>
                    <span class="stats-spacer" />
                    <span
                      class="stats-tool-duration"
                      classList={{
                        "is-error": call.status === "error",
                        "is-live": call.status === "running",
                      }}
                    >
                      {call.durationMs !== undefined
                        ? formatDuration(call.durationMs)
                        : call.startedAt !== undefined
                          ? formatDuration(toolDuration(call))
                          : t("tool.running")}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </section>

        <section class="stats-card">
          <div class="stats-card-head">
            <h3>{t("stats.session")}</h3>
            <span class="stats-spacer" />
            <span class="stats-table-count">
              <b>{sessionMetrics().turns}</b> {t("stats.turns")} · <b>{sessionMetrics().steps}</b>{" "}
              {t("stats.steps")}
            </span>
          </div>

          <div class="stats-stat-grid">
            <div class="stats-stat">
              <div class="stats-stat-key">{t("stats.avgResponse")}</div>
              <div class="stats-stat-value">{formatDuration(sessionMetrics().averageStepMs)}</div>
            </div>
            <div class="stats-stat">
              <div class="stats-stat-key">{t("stats.avgTurn")}</div>
              <div class="stats-stat-value">{formatDuration(sessionMetrics().averageTurnMs)}</div>
            </div>
            <div class="stats-stat">
              <div class="stats-stat-key">{t("stats.avgRate")}</div>
              <div class="stats-stat-value">
                {formatRate(averageRate(), locale)}{" "}
                <small>{t("stats.rate")}</small>
              </div>
            </div>
            <div class="stats-stat">
              <div class="stats-stat-key">{t("stats.cost")}</div>
              <div class="stats-stat-value">
                {currency().format(sessionMetrics().cost)} <small>USD</small>
              </div>
            </div>
          </div>

          <div class="stats-token-head">
            <Icon path={CHART} size={12} />
            <span>{t("stats.tokens")}</span>
            <b>{formatTokens(totalTokens(sessionMetrics().tokens), locale)}</b>
            <span class="stats-spacer" />
            <span>{t("stats.tokenComposition")}</span>
          </div>
          <div class="stats-token-bar" role="img" aria-label={t("stats.tokenComposition")}>
            <For each={tokenParts().entries}>
              {(entry) => (
                <span
                  class="stats-token-seg"
                  style={{
                    width: `${tokenParts().total > 0 ? (entry.value / tokenParts().total) * 100 : 0}%`,
                    background: entry.color,
                  }}
                />
              )}
            </For>
          </div>
          <div class="stats-legend">
            <For each={tokenParts().entries}>
              {(entry) => (
                <span class="stats-legend-item">
                  <span class="stats-legend-swatch" style={{ background: entry.color }} />
                  {t(`stats.${entry.key}`)} <b>{formatTokens(entry.value, locale)}</b>
                </span>
              )}
            </For>
          </div>

          <div class="stats-metric">
            <span class="stats-metric-lead is-tool">
              <Icon path={TOOL} size={13} />
            </span>
            <span class="stats-metric-text">
              <span class="stats-metric-key">{t("stats.tools")}</span>
              <span class="stats-metric-value">
                <b>{sessionMetrics().toolCalls.length}</b> {t("stats.calls")} ·{" "}
                <b>{formatPercent(toolSuccess(), locale)}</b> {t("stats.successRate")} ·{" "}
                <b>
                  {formatDuration(
                    sessionMetrics().tools.length > 0
                      ? sessionMetrics().tools.reduce((sum, tool) => sum + tool.totalMs, 0) /
                          Math.max(
                            1,
                            sessionMetrics().tools.reduce(
                              (sum, tool) => sum + tool.ok + tool.error,
                              0,
                            ),
                          )
                      : undefined,
                  )}
                </b>{" "}
                {t("stats.avgDuration")}
              </span>
            </span>
          </div>

          <Show when={sessionMetrics().tools.length > 0}>
            <div class="stats-table">
              <For each={sessionMetrics().tools}>
                {(tool) => (
                  <div class="stats-table-row" title={`${tool.name}: ${tool.ok} ${t("tool.ok")} · ${tool.error} ${t("tool.error")}`}>
                    <span class="stats-table-name">{tool.name}</span>
                    <span class="stats-bar-mini">
                      <span style={{ width: `${(tool.calls / maxToolCalls()) * 100}%` }} />
                    </span>
                    <span class="stats-table-count">
                      <b>{tool.calls}</b>
                    </span>
                  </div>
                )}
              </For>
            </div>
          </Show>

          <Show when={sessionMetrics().models.length > 0}>
            <div class="stats-models">
              <For each={sessionMetrics().models}>
                {(model, index) => (
                  <div class="stats-model-row">
                    <span
                      class="stats-model-chip"
                      style={{ background: index() === 0 ? "var(--stats-output)" : "var(--stats-reason)" }}
                    />
                    <span class="stats-model-name" title={`${model.providerID}/${model.id}`}>
                      {model.label}
                    </span>
                    <span class="stats-model-count">
                      {model.steps} {t("stats.steps")} · {formatTokens(totalTokens(model.tokens), locale)}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </section>

        <div class="stats-note">
          <Icon path={INFO} size={11} />
          <span>{t("stats.note")}</span>
        </div>
      </Show>
      </Show>
    </div>
  );
}
