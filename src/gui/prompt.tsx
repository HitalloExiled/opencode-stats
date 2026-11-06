/**
 * System prompt tab.
 *
 * The server captures the composed prompt on every request; this view reads
 * the latest capture over RPC and groups the parts into Fixed, Added and
 * Dynamic sources. Copying and saving are explicit actions; the prompt stays
 * local.
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
import type { MountedSession } from "@opencode/plugin/gui";

import { formatBytes, formatClock } from "../format";
import { StatsRpc, type PromptCapture, type PromptGroup, type PromptPart } from "./contract";
import { useLocale, useT } from "./i18n";
import { useObservability } from "./observability";

const CSS = `
.prompt { display: flex; flex-direction: column; gap: 10px; height: 100%; min-height: 0; overflow-y: auto; padding: 12px; color: var(--v2-text-text-base, #e8e8e8); font-family: var(--font-family-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif); font-size: 12.5px; scrollbar-width: thin; scrollbar-color: var(--v2-border-border-strong, #3a3a3a) transparent; }
.prompt::-webkit-scrollbar { width: 10px; }
.prompt::-webkit-scrollbar-thumb { background: var(--v2-border-border-strong, #303030); border-radius: 8px; border: 3px solid transparent; background-clip: padding-box; }
.prompt-head { display: flex; align-items: center; gap: 8px; padding: 1px 2px 0; }
.prompt-title { margin: 0; font-size: 13px; font-weight: 650; letter-spacing: 0.1px; }
.prompt-scope { color: var(--v2-text-text-faint, #6e6e6e); font-size: 10.5px; margin-left: auto; display: inline-flex; align-items: center; gap: 5px; }
.prompt-icon-btn { appearance: none; border: 1px solid transparent; background: transparent; color: var(--v2-text-text-faint, #6e6e6e); width: 25px; height: 25px; border-radius: 6px; display: grid; place-items: center; cursor: pointer; }
.prompt-icon-btn:hover { background: var(--v2-overlay-simple-overlay-hover, #262626); color: var(--v2-text-text-base, #e8e8e8); border-color: var(--v2-border-border-muted, #2c2c2c); }
.prompt-icon-btn:focus-visible { outline: 2px solid var(--v2-border-border-focus, #4c9aff); outline-offset: 1px; }
.prompt-summary { border: 1px solid var(--v2-border-border-muted, #2c2c2c); background: var(--v2-background-bg-layer-02, #1a1a1a); border-radius: 10px; padding: 9px 10px; display: flex; flex-direction: column; gap: 4px; }
.prompt-summary-top { display: flex; align-items: baseline; gap: 7px; flex-wrap: wrap; }
.prompt-summary-agent { color: var(--v2-text-text-muted, #9b9b9b); font-size: 11.5px; font-weight: 650; }
.prompt-summary-model { color: var(--v2-text-text-faint, #6e6e6e); font-family: var(--font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 9.5px; }
.prompt-summary-meta { color: var(--v2-text-text-faint, #6e6e6e); font-size: 10px; display: flex; flex-wrap: wrap; gap: 4px 10px; }
.prompt-summary-meta b { color: var(--v2-text-text-muted, #9b9b9b); font-weight: 600; }
.prompt-controls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.prompt-seg { display: inline-flex; padding: 2px; gap: 2px; border: 1px solid var(--v2-border-border-muted, #2c2c2c); background: var(--v2-background-bg-layer-02, #1a1a1a); border-radius: 7px; }
.prompt-seg button { appearance: none; border: 0; background: transparent; color: var(--v2-text-text-muted, #9b9b9b); font: inherit; font-size: 10px; padding: 3px 8px; border-radius: 5px; cursor: pointer; }
.prompt-seg button:hover { color: var(--v2-text-text-base, #e8e8e8); background: var(--v2-overlay-simple-overlay-hover, #262626); }
.prompt-seg button.is-active { color: var(--v2-text-text-base, #e8e8e8); background: var(--v2-overlay-simple-overlay-pressed, #303030); font-weight: 650; }
.prompt-search { flex: 1; min-width: 110px; border: 1px solid var(--v2-border-border-muted, #2c2c2c); background: var(--v2-background-bg-layer-01, #191919); color: var(--v2-text-text-base, #e8e8e8); border-radius: 7px; padding: 4px 8px; font: inherit; font-size: 10.5px; }
.prompt-search::placeholder { color: var(--v2-text-text-faint, #6e6e6e); }
.prompt-search:focus-visible { outline: 2px solid var(--v2-border-border-focus, #4c9aff); outline-offset: 0; }
.prompt-action { appearance: none; border: 1px solid var(--v2-border-border-muted, #2c2c2c); background: var(--v2-background-bg-layer-02, #1a1a1a); color: var(--v2-text-text-muted, #9b9b9b); border-radius: 7px; padding: 4px 9px; font: inherit; font-size: 10px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; }
.prompt-action:hover { color: var(--v2-text-text-base, #e8e8e8); border-color: var(--v2-border-border-strong, #3a3a3a); background: var(--v2-overlay-simple-overlay-hover, #262626); }
.prompt-action:focus-visible { outline: 2px solid var(--v2-border-border-focus, #4c9aff); outline-offset: 1px; }
.prompt-action.is-ok { color: var(--v2-text-text-success, #5fce7d); border-color: color-mix(in srgb, var(--v2-text-text-success, #5fce7d) 30%, transparent); }
.prompt-groups { display: flex; flex-direction: column; gap: 10px; }
.prompt-group { display: flex; flex-direction: column; gap: 4px; }
.prompt-group-head { display: flex; align-items: center; gap: 7px; padding: 0 2px; }
.prompt-group-title { color: var(--v2-text-text-faint, #6e6e6e); font-size: 9.5px; font-weight: 700; letter-spacing: 0.6px; text-transform: uppercase; }
.prompt-group-count { color: var(--v2-text-text-faint, #6e6e6e); font-size: 9.5px; }
.prompt-parts { display: flex; flex-direction: column; gap: 4px; }
.prompt-part { border: 1px solid var(--v2-border-border-muted, #2c2c2c); background: var(--v2-background-bg-layer-02, #1a1a1a); border-radius: 8px; overflow: hidden; }
.prompt-part.is-open { border-color: var(--v2-border-border-strong, #3a3a3a); }
.prompt-part-head { display: flex; align-items: center; gap: 4px; padding-right: 4px; }
.prompt-part-toggle { flex: 1; min-width: 0; display: flex; align-items: center; gap: 7px; padding: 7px 8px; border: 0; background: transparent; color: var(--v2-text-text-base, #e8e8e8); font: inherit; text-align: left; cursor: pointer; }
.prompt-part-toggle:hover { background: var(--v2-overlay-simple-overlay-hover, #262626); }
.prompt-part-toggle:focus-visible { outline: 2px solid var(--v2-border-border-focus, #4c9aff); outline-offset: -2px; }
.prompt-order { flex: none; min-width: 20px; height: 17px; padding: 0 4px; border-radius: 4px; background: var(--v2-overlay-simple-overlay-pressed, #262626); color: var(--v2-text-text-faint, #6e6e6e); font-family: var(--font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 9px; display: inline-flex; align-items: center; justify-content: center; }
.prompt-label { min-width: 0; font-size: 11px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.prompt-detail { flex: none; color: var(--v2-text-text-faint, #6e6e6e); font-family: var(--font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 9px; max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.prompt-bytes { flex: none; margin-left: auto; color: var(--v2-text-text-faint, #6e6e6e); font-size: 9.5px; font-variant-numeric: tabular-nums; }
.prompt-copy { flex: none; appearance: none; border: 1px solid transparent; background: transparent; color: var(--v2-text-text-faint, #6e6e6e); width: 22px; height: 22px; border-radius: 5px; display: grid; place-items: center; cursor: pointer; }
.prompt-copy:hover { color: var(--v2-text-text-base, #e8e8e8); background: var(--v2-overlay-simple-overlay-hover, #262626); border-color: var(--v2-border-border-muted, #2c2c2c); }
.prompt-copy.is-ok { color: var(--v2-text-text-success, #5fce7d); }
.prompt-part-body { border-top: 1px solid var(--v2-border-border-muted, #2c2c2c); padding: 8px; background: var(--v2-background-bg-layer-01, #171717); }
.prompt-pre { margin: 0; max-height: 280px; overflow: auto; white-space: pre-wrap; word-break: break-word; color: var(--v2-text-text-muted, #b0b0b0); font-family: var(--font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 10.5px; line-height: 1.5; }
.prompt-pre.is-full { max-height: 520px; }
.prompt-more { margin-top: 6px; appearance: none; border: 1px solid var(--v2-border-border-muted, #2c2c2c); background: transparent; color: var(--v2-text-text-muted, #9b9b9b); border-radius: 6px; padding: 3px 7px; font: inherit; font-size: 9.5px; cursor: pointer; }
.prompt-more:hover { color: var(--v2-text-text-base, #e8e8e8); border-color: var(--v2-border-border-strong, #3a3a3a); }
.prompt-full { display: flex; flex-direction: column; gap: 6px; }
.prompt-full-head { display: flex; align-items: center; gap: 7px; color: var(--v2-text-text-faint, #6e6e6e); font-size: 10px; }
.prompt-full-pre { margin: 0; border: 1px solid var(--v2-border-border-muted, #2c2c2c); background: var(--v2-background-bg-layer-01, #171717); border-radius: 8px; padding: 9px; max-height: 560px; overflow: auto; white-space: pre-wrap; word-break: break-word; color: var(--v2-text-text-muted, #b0b0b0); font-family: var(--font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 10.5px; line-height: 1.5; }
.prompt-banner { border: 1px solid var(--v2-border-border-muted, #2c2c2c); background: var(--v2-background-bg-layer-02, #1a1a1a); border-radius: 8px; padding: 7px 9px; color: var(--v2-text-text-muted, #9b9b9b); font-size: 10.5px; display: flex; align-items: center; gap: 7px; }
.prompt-banner.is-error { color: var(--v2-text-text-danger, #ef6b6b); border-color: color-mix(in srgb, var(--v2-text-text-danger, #ef6b6b) 30%, transparent); background: color-mix(in srgb, var(--v2-text-text-danger, #ef6b6b) 8%, transparent); }
.prompt-spinner { width: 11px; height: 11px; border-radius: 50%; border: 1.5px solid var(--v2-border-border-strong, #3a3a3a); border-top-color: var(--v2-icon-icon-accent, #4dc8b8); animation: prompt-spin 0.8s linear infinite; }
@keyframes prompt-spin { to { transform: rotate(360deg); } }
.prompt-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 44px 16px; text-align: center; color: var(--v2-text-text-muted, #9b9b9b); }
.prompt-empty svg { opacity: 0.5; }
.prompt-empty-title { font-weight: 600; font-size: 12.5px; }
.prompt-empty-hint { color: var(--v2-text-text-faint, #6e6e6e); font-size: 11px; max-width: 270px; }
.prompt-empty .prompt-action { margin-top: 4px; }
.prompt-privacy { color: var(--v2-text-text-faint, #6e6e6e); font-size: 9.5px; display: flex; align-items: center; gap: 6px; padding: 0 2px; }
`;

const REFRESH = "M13.2 8a5.2 5.2 0 1 1-1.5-3.7M13.2 2.6v3.2H10";
const COPY = "M5.5 5.5V3.2c0-.5.4-.9.9-.9h6.4c.5 0 .9.4.9.9v6.4c0 .5-.4.9-.9.9h-2.3M3.2 5.5h6.4c.5 0 .9.4.9.9v6.4c0 .5-.4.9-.9.9H3.2a.9.9 0 0 1-.9-.9V6.4c0-.5.4-.9.9-.9Z";
const CHECK = "m3.4 8.4 3 3 6.2-6.6";
const INFO = "M8 2.3A5.7 5.7 0 1 0 8 13.7 5.7 5.7 0 0 0 8 2.3Zm0 4.4v3.1M8 5.2v.1";
const DOC = "M4 1.8h5.1L12.2 5v9.2H4V1.8Zm5 0V5h3.2";
const DOWNLOAD = "M8 2.5v7.2m0 0 2.6-2.6M8 9.7 5.4 7.1M3 12.8h10";

const Icon = (props: { path: string; size?: number }) => (
  <svg width={props.size ?? 12} height={props.size ?? 12} viewBox="0 0 16 16" aria-hidden="true">
    <path
      d={props.path}
      fill="none"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
);

const PREVIEW_LIMIT = 4000;
const GROUPS: PromptGroup[] = ["fixed", "added", "dynamic"];
const FILTERS: Array<PromptGroup | "all"> = ["all", "fixed", "added", "dynamic"];

export function PromptView(props: { session: MountedSession }) {
  const ctx = usePlugin();
  const t = useT();
  const locale = useLocale();
  const session = props.session;
  const data = session.server.data;
  const observability = useObservability(session);
  const enabled = observability.enabled;

  const [capture, setCapture] = createSignal<PromptCapture | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [filter, setFilter] = createSignal<PromptGroup | "all">("all");
  const [mode, setMode] = createSignal<"source" | "full">("source");
  const [query, setQuery] = createSignal("");
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [fullExpanded, setFullExpanded] = createSignal<Set<string>>(new Set());
  const [copied, setCopied] = createSignal<string | null>(null);

  let controller: AbortController | undefined;

  async function load(silent = false) {
    if (!session.id || !enabled()) return;
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    if (!silent) setLoading(true);
    try {
      const rpc = session.server.client.rpc(StatsRpc);
      const result = await rpc.systemPrompt(
        { sessionID: session.id, ifNoneMatch: capture()?.hash },
        { location: { directory: session.directory }, signal },
      );
      if (signal.aborted) return;
      // `unchanged` keeps the parts already on screen; the refresh only needs
      // the new metadata, which it does not render separately.
      if (result.status === "capture") setCapture(result.capture);
      else if (result.status === "missing") setCapture(null);
      setError(null);
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }

  onMount(() => {
    if (enabled()) void load();
  });
  createEffect(
    on(
      () => (session.id ? data.session.status(session.id) : "idle"),
      (next, previous) => {
        if (!enabled()) return;
        if (previous === "running" && next === "idle") void load(true);
      },
      { defer: true },
    ),
  );
  onCleanup(() => controller?.abort());

  // Re-enabling from another view must refresh this tab, not leave stale parts.
  createEffect(
    on(
      enabled,
      (next, previous) => {
        if (next && previous === false) void load(true);
      },
      { defer: true },
    ),
  );

  const enable = async () => {
    const result = await observability.setEnabled(true);
    if (result) void load();
  };

  const labelFor = (part: PromptPart) => (part.labelKey ? t(part.labelKey) : part.label);
  const keyOf = (part: PromptPart) => `${part.order}:${part.key}`;

  const filtered = createMemo(() => {
    const parts = capture()?.parts ?? [];
    const needle = query().trim().toLowerCase();
    return parts.filter((part) => {
      if (filter() !== "all" && part.group !== filter()) return false;
      if (!needle) return true;
      return (
        part.key.toLowerCase().includes(needle) ||
        labelFor(part).toLowerCase().includes(needle) ||
        part.text.toLowerCase().includes(needle)
      );
    });
  });

  const grouped = createMemo(() => {
    const map = new Map<PromptGroup, PromptPart[]>();
    for (const group of GROUPS) map.set(group, []);
    for (const part of filtered()) map.get(part.group)?.push(part);
    return GROUPS.map((group) => ({ group, parts: map.get(group) ?? [] })).filter(
      (entry) => entry.parts.length > 0,
    );
  });

  const fullText = createMemo(() =>
    filtered()
      .map((part) => {
        const detail = part.detail ? ` · ${part.detail}` : "";
        return `# ${part.order} · ${labelFor(part)}${detail}\n${part.text}`;
      })
      .join("\n\n---\n\n"),
  );

  const toggle = (part: PromptPart) => {
    const key = keyOf(part);
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleFull = (part: PromptPart) => {
    const key = keyOf(part);
    setFullExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const copy = async (text: string, key: string) => {
    try {
      await ctx.system.copy(text);
      setCopied(key);
      setTimeout(() => setCopied((current) => (current === key ? null : current)), 1500);
      ctx.toast.show({ title: t("toast.copied"), variant: "success" });
    } catch {
      ctx.toast.show({ title: t("toast.copyFailed"), variant: "error" });
    }
  };

  const save = async () => {
    try {
      const saved = await ctx.system.save({
        name: t("prompt.saveName"),
        content: fullText(),
      });
      if (saved) ctx.toast.show({ title: t("toast.saved"), variant: "success" });
    } catch {
      ctx.toast.show({ title: t("toast.saveFailed"), variant: "error" });
    }
  };

  const body = (part: PromptPart) => {
    if (part.text.length <= PREVIEW_LIMIT) return part.text;
    const key = keyOf(part);
    if (fullExpanded().has(key)) return part.text;
    return `${part.text.slice(0, PREVIEW_LIMIT)}…`;
  };

  const hasMore = (part: PromptPart) => part.text.length > PREVIEW_LIMIT;

  const errorHint = createMemo(() => {
    const message = error();
    if (!message) return undefined;
    if (/not found|no such|unavailable|rpc|method/i.test(message)) return t("prompt.unavailable");
    return message;
  });

  return (
    <div class="prompt">
      <style>{CSS}</style>

      <div class="prompt-head">
        <h2 class="prompt-title">{t("prompt.title")}</h2>
        <span class="prompt-scope">
          <Icon path={INFO} size={11} />
          {t("prompt.scope")}
        </span>
        <Show when={enabled()}>
          <button
            class="prompt-icon-btn"
            type="button"
            title={t("prompt.refresh")}
            aria-label={t("prompt.refresh")}
            onClick={() => void load()}
          >
            <Icon path={REFRESH} size={14} />
          </button>
        </Show>
      </div>

      <Show when={!enabled()}>
        <div class="prompt-empty">
          <Icon path={INFO} size={22} />
          <span class="prompt-empty-title">{t("prompt.disabled")}</span>
          <span class="prompt-empty-hint">{t("prompt.disabledHint")}</span>
          <button
            class="prompt-action"
            type="button"
            disabled={observability.busy()}
            onClick={() => void enable()}
          >
            {t("observability.enable")}
          </button>
        </div>
      </Show>

      <Show when={enabled()}>
      <Show when={error()}>
        <div class="prompt-banner is-error">
          <Icon path={INFO} size={12} />
          <span>{t("prompt.error")}: {errorHint()}</span>
        </div>
      </Show>

      <Show when={loading()}>
        <div class="prompt-banner">
          <span class="prompt-spinner" />
          <span>{t("prompt.loading")}</span>
        </div>
      </Show>

      <Show
        when={capture()}
        fallback={
          <Show when={!loading()}>
            <div class="prompt-empty">
              <Icon path={DOC} size={22} />
              <span class="prompt-empty-title">{t("prompt.empty")}</span>
              <span class="prompt-empty-hint">{t("prompt.emptyHint")}</span>
            </div>
          </Show>
        }
      >
        {(current) => (
          <>
            <div class="prompt-summary">
              <div class="prompt-summary-top">
                <span class="prompt-summary-agent">{current().agent}</span>
                <span class="prompt-summary-model">
                  {current().model.providerID}/{current().model.id}
                  {current().model.variant ? `#${current().model.variant}` : ""}
                </span>
              </div>
              <div class="prompt-summary-meta">
                <span>
                  <b>{current().parts.length}</b> · {formatBytes(current().totalBytes, locale)}
                </span>
                <span>
                  {t("prompt.capturedAt", formatClock(current().capturedAt, locale))}
                </span>
                <span>{t("prompt.requests", current().requestCount)}</span>
              </div>
            </div>

            <div class="prompt-controls">
              <div class="prompt-seg" role="group" aria-label={t("prompt.filter")}>
                <For each={FILTERS}>
                  {(entry) => (
                    <button
                      type="button"
                      classList={{ "is-active": filter() === entry }}
                      onClick={() => setFilter(entry)}
                    >
                      {t(`prompt.${entry}`)}
                    </button>
                  )}
                </For>
              </div>
              <div class="prompt-seg" role="group" aria-label={t("prompt.title")}>
                <button
                  type="button"
                  classList={{ "is-active": mode() === "source" }}
                  onClick={() => setMode("source")}
                >
                  {t("prompt.bySource")}
                </button>
                <button
                  type="button"
                  classList={{ "is-active": mode() === "full" }}
                  onClick={() => setMode("full")}
                >
                  {t("prompt.fullText")}
                </button>
              </div>
              <button
                type="button"
                class="prompt-action"
                classList={{ "is-ok": copied() === "all" }}
                onClick={() => void copy(fullText(), "all")}
              >
                <Icon path={copied() === "all" ? CHECK : COPY} size={11} />
                {t("prompt.copyAll")}
              </button>
              <button type="button" class="prompt-action" onClick={() => void save()}>
                <Icon path={DOWNLOAD} size={11} />
                {t("prompt.save")}
              </button>
            </div>

            <div class="prompt-controls">
              <input
                class="prompt-search"
                type="search"
                value={query()}
                placeholder={t("prompt.searchPlaceholder")}
                aria-label={t("prompt.search")}
                onInput={(event) => setQuery(event.currentTarget.value)}
              />
            </div>

            <Show
              when={mode() === "source"}
              fallback={
                <div class="prompt-full">
                  <div class="prompt-full-head">
                    <Icon path={INFO} size={11} />
                    <span>{t("prompt.fullHint")}</span>
                  </div>
                  <pre class="prompt-full-pre">{fullText()}</pre>
                </div>
              }
            >
              <Show
                when={grouped().length > 0}
                fallback={<div class="prompt-banner">{t("prompt.noMatch")}</div>}
              >
                <div class="prompt-groups">
                  <For each={grouped()}>
                    {(entry) => (
                      <div class="prompt-group">
                        <div class="prompt-group-head">
                          <span class="prompt-group-title">{t(`prompt.${entry.group}`)}</span>
                          <span class="prompt-group-count">{entry.parts.length}</span>
                        </div>
                        <div class="prompt-parts">
                          <For each={entry.parts}>
                            {(part) => {
                              const key = keyOf(part);
                              const open = () => expanded().has(key);
                              return (
                                <div class="prompt-part" classList={{ "is-open": open() }}>
                                  <div class="prompt-part-head">
                                    <button
                                      type="button"
                                      class="prompt-part-toggle"
                                      aria-expanded={open()}
                                      onClick={() => toggle(part)}
                                    >
                                      <span class="prompt-order">#{part.order}</span>
                                      <span class="prompt-label">{labelFor(part)}</span>
                                      <Show when={part.detail}>
                                        <span class="prompt-detail">{part.detail}</span>
                                      </Show>
                                      <span class="prompt-bytes">{formatBytes(part.bytes, locale)}</span>
                                    </button>
                                    <button
                                      type="button"
                                      class="prompt-copy"
                                      classList={{ "is-ok": copied() === key }}
                                      title={t("prompt.copyPart")}
                                      aria-label={t("prompt.copyPart")}
                                      onClick={() => void copy(part.text, key)}
                                    >
                                      <Icon path={copied() === key ? CHECK : COPY} size={11} />
                                    </button>
                                  </div>
                                  <Show when={open()}>
                                    <div class="prompt-part-body">
                                      <pre class="prompt-pre">{body(part)}</pre>
                                      <Show when={hasMore(part)}>
                                        <button
                                          type="button"
                                          class="prompt-more"
                                          onClick={() => toggleFull(part)}
                                        >
                                          {fullExpanded().has(key)
                                            ? t("prompt.showLess")
                                            : t("prompt.showMore")}
                                        </button>
                                      </Show>
                                    </div>
                                  </Show>
                                </div>
                              );
                            }}
                          </For>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </>
        )}
      </Show>

      <div class="prompt-privacy">
        <Icon path={INFO} size={10} />
        <span>{t("prompt.privacy")}</span>
      </div>
      </Show>
    </div>
  );
}
