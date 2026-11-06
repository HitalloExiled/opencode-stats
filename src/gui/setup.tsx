/**
 * Window-side registration for the Stats panel.
 *
 * One side panel with two tabs:
 *  - `stats`  — gauge, history and metrics (always listed, pinned);
 *  - `prompt` — the captured system prompt (opened from the command palette
 *               or the session panel menu, closable like a normal tab).
 */

import { createMemo, Match, Show, Switch } from "solid-js";
import type {
  Panel as PanelType,
  PanelTab,
  SessionPanelMenuItem,
  SetupContext,
} from "@opencode/plugin/gui";
import { Command, MenuItem, Panel } from "@opencode/plugin/gui";

import { PromptView } from "./prompt";
import {
  observabilityEnabled,
  refreshObservability,
  setObservability,
} from "./observability";
import { StatsView } from "./stats";

export const statsTabID = "stats";
export const promptTabID = "prompt";

export function setup(ctx: SetupContext<never>): void {
  // `usePlugin()` only works inside contributions, not in setup; read the
  // locale from the setup context directly instead.
  const text = (pt: string, en: string): string =>
    (ctx.locale.locale() ?? "").toLowerCase().startsWith("pt") ? pt : en;

  const statsTab = createMemo<PanelTab>(() => ({
    id: statsTabID,
    title: text("Estatísticas", "Statistics"),
    closable: "compact",
    fallback: true,
  }));

  const promptTab = createMemo<PanelTab>(() => ({
    id: promptTabID,
    title: text("Prompt do sistema", "System prompt"),
    closable: "compact",
  }));

  const panel: PanelType = {
    id: "stats",
    region: "side",
    mobile: { title: text("Estatísticas", "Statistics"), order: 50, kind: "menu", icon: "window-analytics" },
    closed: () => ({ icon: "window-analytics" }),
    list: (input) => {
      const tabs: PanelTab[] = [];
      if (input.open.includes(statsTabID)) tabs.push(statsTab());
      if (input.open.includes(promptTabID)) tabs.push(promptTab());
      return tabs;
    },
    render: (props) => (
      <Show when={props.session.key} keyed>
        {(_key) => (
          <Switch fallback={<StatsView session={props.session} />}>
            <Match when={props.tab.id === promptTabID}>
              <PromptView session={props.session} />
            </Match>
          </Switch>
        )}
      </Show>
    ),
  };
  ctx.add(Panel, () => panel);

  const openStats = () => {
    const session = ctx.sessions.current();
    if (session) ctx.layout.open(`${ctx.id}:${statsTabID}`, session);
  };

  const openPrompt = () => {
    const session = ctx.sessions.current();
    if (session) ctx.layout.open(`${ctx.id}:${promptTabID}`, session);
  };

  const toggleObservability = async () => {
    const session = ctx.sessions.current();
    if (!session) {
      ctx.toast.show({
        title: text("Abra uma sessão primeiro", "Open a session first"),
        variant: "error",
      });
      return;
    }
    // The switch is server state and may have changed from another window.
    await refreshObservability(session);
    const result = await setObservability(session, !observabilityEnabled());
    const title = !result
      ? text("Não foi possível alterar a observabilidade", "Could not change observability")
      : result.enabled
        ? text("Observabilidade ativada", "Observability enabled")
        : text("Observabilidade desativada", "Observability disabled");
    ctx.toast.show({ title, variant: result ? "success" : "error" });
  };

  ctx.add(Command, () => ({
    id: "open-stats",
    get title() {
      return text("Abrir Estatísticas", "Open Statistics");
    },
    get description() {
      return text(
        "Abre a aba de Estatísticas no painel lateral",
        "Opens the Statistics tab in the side panel",
      );
    },
    bind: "mod+shift+s",
    group: "general",
    run: openStats,
  }));

  ctx.add(Command, () => ({
    id: "open-prompt",
    get title() {
      return text("Abrir prompt do sistema", "Open System prompt");
    },
    get description() {
      return text(
        "Abre a aba do prompt do sistema no painel lateral",
        "Opens the System prompt tab in the side panel",
      );
    },
    bind: "mod+shift+i",
    group: "general",
    run: openPrompt,
  }));

  ctx.add(Command, () => ({
    id: "toggle-observability",
    get title() {
      return observabilityEnabled()
        ? text("Desativar observabilidade", "Disable observability")
        : text("Ativar observabilidade", "Enable observability");
    },
    get description() {
      return text(
        "Pausa ou retoma a captura de métricas e do prompt do sistema",
        "Pauses or resumes metrics and system prompt capture",
      );
    },
    group: "general",
    run: () => void toggleObservability(),
  }));

  ctx.add(MenuItem, (): SessionPanelMenuItem => ({
    menu: "session.panel",
    id: "observability",
    get title() {
      return observabilityEnabled()
        ? text("Desativar observabilidade", "Disable observability")
        : text("Ativar observabilidade", "Enable observability");
    },
    get icon() {
      return observabilityEnabled() ? "outline-eye" : "outline-eye-slash";
    },
    run: () => void toggleObservability(),
  }));

  ctx.add(MenuItem, (): SessionPanelMenuItem => ({
    menu: "session.panel",
    id: "stats",
    get title() {
      return text("Estatísticas", "Statistics");
    },
    icon: "window-analytics",
    run: openStats,
  }));

  ctx.add(MenuItem, (): SessionPanelMenuItem => ({
    menu: "session.panel",
    id: "prompt",
    get title() {
      return text("Prompt do sistema", "System prompt");
    },
    icon: "file-document",
    run: openPrompt,
  }));
}
