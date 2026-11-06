/**
 * Locale-aware formatting for rates, durations, tokens and sizes.
 *
 * Numbers use the interface locale so PT-BR gets `1,2 mil` and EN-US gets
 * `1.2K`; durations stay short and unit-suffixed in both languages.
 */

export function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
}

export function formatRate(value: number | undefined, locale: string, digits = 1): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export function formatTokens(value: number, locale: string): string {
  if (!Number.isFinite(value)) return "0";
  if (value < 1000) return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: value >= 100_000 ? 0 : 1,
  })
    .format(value)
    .toLocaleLowerCase(locale);
}

export function formatBytes(value: number, locale: string): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return `${formatNumber(value, locale)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatPercent(value: number | undefined, locale: string, digits = 0): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return `${new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value)}%`;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) {
    const seconds = ms / 1000;
    return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
  }
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}h ${String(rest).padStart(2, "0")}m`;
}

export function formatClock(epoch: number, locale: string): string {
  if (!Number.isFinite(epoch)) return "—";
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(epoch));
}
