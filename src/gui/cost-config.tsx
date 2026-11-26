/**
 * Config modal for the cost card.
 *
 * Every editable field lives here — limit, already spent, last top-up, the
 * window and the gateway key — so the card itself stays read-only. Nothing is
 * written while typing: `Salvar` validates the whole draft at once and, only
 * when every field passes, hands one `CostConfig` to `applyConfig`, which
 * stores it in a single write. Invalid fields stay marked below the input and
 * the dialog stays open.
 *
 * The gateway key is a `password` field; it is sent to the server, stored there
 * and never read back (the RPC returns spend, not the key). A blank field keeps
 * the stored key, and `Remover` clears it. When the gateway answers, the "already
 * spent" field is disabled: the total comes from the key.
 */

import { createSignal, onMount, Show } from "solid-js";
import type { Context } from "@opencode/plugin/gui";
import { DateInput, formatDateValue } from "opencode-shared/gui";

import {
  COST_WINDOW_SIZES,
  formatCostValue,
  validateCostConfig,
  type CostField,
  type CostFieldError,
} from "../cost";
import { StatsRpc, type GatewayInfo } from "./contract";
import type { CostSettingsHandle } from "./cost-settings";
import { useLocale, useT } from "./i18n";
import configCss from "./cost-config.scss?inline";

const CSS = configCss;
const WINDOWS = COST_WINDOW_SIZES;

export type CostConfigInput = {
  ctx: Context;
  settings: CostSettingsHandle;
  providerID: string;
  /** Opened from "I topped up": the date starts filled with this instant. */
  prefillAt?: number;
  /** Total the card is drawing now, so the field starts on the visible number. */
  prefillSpent?: number;
  /**
   * Read at save time: the total the card is drawing then. The modal can stay
   * open while spending accrues, so the step is computed from the live number,
   * not from the snapshot the field started on.
   */
  current?: (() => number | undefined) | undefined;
  /** Runs after a successful save, so the card refetches the gateway. */
  onSaved?: (() => void) | undefined;
};

/** Opens the modal above the panel; the card calls this from its two actions. */
export function openCostConfig(input: CostConfigInput): void {
  input.ctx.dialogs.open((dialog) => (
    <CostConfigDialog {...input} close={() => dialog.close()} />
  ));
}

/** Editable amounts are shown the way the field parses them back (12,50). */
const amountText = (value: number | undefined, locale: string): string => {
  if (value === undefined || !Number.isFinite(value)) return "";
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);
};

function CostConfigDialog(props: CostConfigInput & { close: () => void }) {
  const t = useT();
  const locale = useLocale();
  const settings = props.settings;

  const [limit, setLimit] = createSignal(
    amountText(settings.limit(props.providerID), locale),
  );
  const [spent, setSpent] = createSignal(
    amountText(props.prefillSpent ?? settings.spent(props.providerID), locale),
  );
  // The date field is a native `<input type="date">` (the host kit has no date
  // picker), so it holds the local `aaaa-mm-dd` its value uses. The exact
  // instant of a prefill is kept while the field is untouched; picking or typing
  // a day (even the same one) switches to midnight of that day.
  const [recharge, setRecharge] = createSignal(
    formatDateValue(props.prefillAt ?? settings.lastRecharge(props.providerID)),
  );
  const today = formatDateValue(Date.now());
  const [days, setDays] = createSignal(settings.window());
  const [errors, setErrors] = createSignal<Partial<Record<CostField, CostFieldError>>>({});

  const [rechargeEdited, setRechargeEdited] = createSignal(false);
  const [spentTouched, setSpentTouched] = createSignal(false);

  // Gateway: the key is write-only (it never comes back), so the modal only
  // keeps the typed value and the spend the server reports.
  const [key, setKey] = createSignal("");
  const [gateway, setGateway] = createSignal<GatewayInfo | null>(null);
  const [gatewayError, setGatewayError] = createSignal<string | null>(null);
  const [keyError, setKeyError] = createSignal<string | null>(null);
  const [gatewayBusy, setGatewayBusy] = createSignal(false);
  const [saving, setSaving] = createSignal(false);

  let limitBox: HTMLDivElement | undefined;
  let spentBox: HTMLDivElement | undefined;
  let rechargeBox: HTMLDivElement | undefined;
  let keyBox: HTMLDivElement | undefined;

  const message = (error: CostFieldError): string =>
    error === "invalidMoney"
      ? t("stats.costErrorMoney")
      : error === "futureDate"
        ? t("stats.costErrorFuture")
        : t("stats.costErrorDate");

  const focusFirst = (found: Partial<Record<CostField, CostFieldError>>): void => {
    const box = found.limit ? limitBox : found.spent ? spentBox : found.lastRecharge ? rechargeBox : undefined;
    queueMicrotask(() => box?.querySelector("input")?.focus());
  };

  const focusKey = (): void => {
    queueMicrotask(() => keyBox?.querySelector("input")?.focus());
  };

  const readGateway = async (): Promise<GatewayInfo | null> => {
    setGatewayBusy(true);
    try {
      const info = await props.ctx.client
        .rpc(StatsRpc)
        .gateway({ providerID: props.providerID });
      setGateway(info);
      setGatewayError(null);
      return info;
    } catch (cause) {
      setGatewayError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      setGatewayBusy(false);
    }
  };

  onMount(() => {
    void readGateway();
  });

  const gatewayActive = (): boolean => gateway()?.status === "ok";

  const gatewayLimit = (): number | undefined => {
    const value = gateway()?.limit;
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };

  const gatewayStatus = (): string => {
    if (keyError()) return keyError()!;
    if (gatewayError()) return t("stats.costGatewayUnavailable", gatewayError()!);
    const info = gateway();
    if (!info) return gatewayBusy() ? t("stats.costGatewayLoading") : "";
    if (!info.hasKey) return t("stats.costGatewayMissing");
    if (info.status === "ok") {
      return t("stats.costGatewayConnected", formatCostValue(info.spend, locale));
    }
    if (info.invalidKey) return t("stats.costGatewayInvalid");
    if (info.routeBlocked) return t("stats.costGatewayRoute");
    return t("stats.costGatewayUnavailable", info.message ?? "—");
  };

  const removeKey = async (): Promise<void> => {
    if (gatewayBusy()) return;
    setGatewayBusy(true);
    try {
      const info = await props.ctx.client
        .rpc(StatsRpc)
        .clearGatewayKey({ providerID: props.providerID });
      setGateway(info);
      setGatewayError(null);
      setKeyError(null);
      setKey("");
      settings.clearGateway(props.providerID);
      props.onSaved?.();
    } catch (cause) {
      setGatewayError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setGatewayBusy(false);
    }
  };

  const save = async (): Promise<void> => {
    if (saving()) return;
    const result = validateCostConfig(
      {
        limit: limit(),
        spent: spent(),
        lastRecharge: recharge(),
        window: days(),
      },
      Date.now(),
    );
    if (!result.ok) {
      setErrors(result.errors);
      focusFirst(result.errors);
      return;
    }

    setSaving(true);
    try {
      // A very quick save must not lose the gateway base: the initial read may
      // still be in flight when the dialog opens.
      if (gateway() === null && gatewayBusy()) await readGateway();
      let info = gateway();
      const typedKey = key().trim();
      if (typedKey !== "") {
        const saved = await props.ctx.client
          .rpc(StatsRpc)
          .setGatewayKey({ providerID: props.providerID, key: typedKey });
        info = saved.info;
        setGateway(info);
        if (saved.status === "invalid") {
          setKeyError(t("stats.costGatewayInvalid"));
          // The old key (if any) is still stored; restore its spend.
          void readGateway();
          focusKey();
          return;
        }
        if (saved.status === "unavailable" && !saved.info.hasKey) {
          setGatewayError(saved.message ?? "—");
          return;
        }
        setKey("");
        setKeyError(null);
        setGatewayError(
          saved.status === "unavailable" ? (saved.message ?? "—") : null,
        );
      }

      const value =
        props.prefillAt !== undefined && !rechargeEdited() && recharge().trim() !== ""
          ? { ...result.value, lastRecharge: props.prefillAt }
          : result.value;
      const capture =
        info?.status === "ok" && info.spend !== undefined
          ? { spend: info.spend, resetsAt: info.resetsAt ?? null }
          : undefined;
      settings.applyConfig(props.providerID, value, {
        // Read at save time: the card may have drawn more cost since the modal
        // opened, and the step is "typed minus what is drawn now".
        current: props.current?.() ?? props.prefillSpent,
        spentTouched: spentTouched(),
        gateway: capture,
      });
      props.onSaved?.();
      props.close();
    } catch (cause) {
      setGatewayError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const rechargeFilled = (): boolean => recharge().trim() !== "";

  return (
    <props.ctx.ui.Dialog
      title={t("stats.costConfig")}
      description={t("stats.costConfigHint")}
      size="fit"
      footer={
        <div class="stats-cost-config-actions">
          <props.ctx.ui.Button size="small" variant="ghost" onClick={props.close}>
            {t("stats.costCancel")}
          </props.ctx.ui.Button>
          <props.ctx.ui.Button
            size="small"
            variant="contrast"
            busy={saving()}
            disabled={saving()}
            onClick={() => void save()}
          >
            {t("stats.costSave")}
          </props.ctx.ui.Button>
        </div>
      }
    >
      <style>{CSS}</style>
      <div class="stats-cost-config">
        <div class="stats-cost-config-field" ref={limitBox}>
          <span class="stats-cost-config-label">{t("stats.costLimit")}</span>
          <props.ctx.ui.TextInput
            value={limit()}
            onInput={(value) => {
              setLimit(value);
              setErrors((current) => ({ ...current, limit: undefined }));
            }}
            label={t("stats.costLimit")}
            placeholder="0.00"
            size="large"
            invalid={errors().limit !== undefined}
            autofocus
            onSubmit={save}
          />
          <Show when={gatewayLimit()}>
            {(cap) => (
              <span class="stats-cost-config-hint">
                {t("stats.costGatewayLimitHint", formatCostValue(cap(), locale))}
              </span>
            )}
          </Show>
          <Show when={errors().limit}>
            {(error) => (
              <p class="stats-cost-config-error" role="alert">
                {message(error())}
              </p>
            )}
          </Show>
        </div>

        <div class="stats-cost-config-field" ref={spentBox}>
          <span class="stats-cost-config-label">{t("stats.costSpent")}</span>
          <props.ctx.ui.TextInput
            value={spent()}
            onInput={(value) => {
              setSpent(value);
              setSpentTouched(true);
              setErrors((current) => ({ ...current, spent: undefined }));
            }}
            label={t("stats.costSpent")}
            placeholder="0.00"
            size="large"
            disabled={gatewayActive()}
            invalid={errors().spent !== undefined}
            onSubmit={save}
          />
          <span class="stats-cost-config-hint">
            {gatewayActive()
              ? t("stats.costSpentGatewayHint")
              : t("stats.costSpentHint")}
          </span>
          <Show when={errors().spent}>
            {(error) => (
              <p class="stats-cost-config-error" role="alert">
                {message(error())}
              </p>
            )}
          </Show>
        </div>

        <div class="stats-cost-config-field" ref={rechargeBox}>
          <span class="stats-cost-config-label">{t("stats.costRecharge")}</span>
          <DateInput
            value={recharge()}
            onInput={(value) => {
              setRecharge(value);
              setRechargeEdited(true);
              setErrors((current) => ({ ...current, lastRecharge: undefined }));
            }}
            label={t("stats.costRecharge")}
            max={today}
            size="large"
            invalid={errors().lastRecharge !== undefined}
            onSubmit={save}
          />
          <span class="stats-cost-config-hint">
            {props.prefillAt !== undefined
              ? t("stats.costRechargeNowHint")
              : t("stats.costRechargeHint")}
          </span>
          <Show when={errors().lastRecharge}>
            {(error) => (
              <p class="stats-cost-config-error" role="alert">
                {message(error())}
              </p>
            )}
          </Show>
        </div>

        <div class="stats-cost-config-field">
          <span class="stats-cost-config-label">{t("stats.costWindow")}</span>
          <props.ctx.ui.Menu
            label={t("stats.costWindowOption", days())}
            trigger="button"
            disabled={rechargeFilled()}
            items={WINDOWS.map((size) => ({
              label: t("stats.costWindowOption", size),
              onSelect: () => setDays(size),
            }))}
          />
          <Show when={rechargeFilled()}>
            <span class="stats-cost-config-hint">{t("stats.costWindowLocked")}</span>
          </Show>
        </div>

        <div class="stats-cost-config-section" ref={keyBox}>
          <div class="stats-cost-config-section-head">
            <span class="stats-cost-config-label">{t("stats.costGateway")}</span>
            <Show when={gateway()?.hasKey}>
              <props.ctx.ui.Button
                size="small"
                variant="ghost"
                disabled={gatewayBusy()}
                onClick={() => void removeKey()}
              >
                {t("stats.costGatewayRemove")}
              </props.ctx.ui.Button>
            </Show>
          </div>
          <span class="stats-cost-config-hint">{t("stats.costGatewayHint")}</span>
          <props.ctx.ui.TextInput
            value={key()}
            onInput={(value) => {
              setKey(value);
              setKeyError(null);
            }}
            label={t("stats.costGatewayKey")}
            placeholder={t("stats.costGatewayKeyPlaceholder")}
            type="password"
            size="large"
            disabled={gatewayBusy()}
            invalid={keyError() !== null}
            onSubmit={() => void save()}
          />
          <span class="stats-cost-config-hint">{gatewayStatus()}</span>
          <Show when={keyError()}>
            {(error) => (
              <p class="stats-cost-config-error" role="alert">
                {error()}
              </p>
            )}
          </Show>
        </div>
      </div>
    </props.ctx.ui.Dialog>
  );
}