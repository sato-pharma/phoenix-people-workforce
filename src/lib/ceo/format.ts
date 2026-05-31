/** Shared CEO formatting helpers (aggregate, presentational — no sensitive drilldown). */

export function formatEgp(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  if (Math.abs(safe) >= 1_000_000) return `EGP ${(safe / 1_000_000).toFixed(1)}M`;
  if (Math.abs(safe) >= 1_000) return `EGP ${(safe / 1_000).toFixed(0)}K`;
  return new Intl.NumberFormat("en-US", { currency: "EGP", maximumFractionDigits: 0, style: "currency" }).format(safe);
}

export function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString("en-US") : "0";
}

export function formatPercent(value: number, decimals = 0): string {
  return `${(Number.isFinite(value) ? value : 0).toFixed(decimals)}%`;
}

export function formatSignedPercent(value: number | null, decimals = 1): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(decimals)}%`;
}

export function formatDateShort(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "Africa/Cairo" }).format(date);
}

export function formatTimeShort(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "short", timeStyle: "short", timeZone: "Africa/Cairo" }).format(date);
}

export function formatBriefValue(value: number | null, format: "currency" | "percent" | "number"): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (format === "currency") return formatEgp(value);
  if (format === "percent") return formatPercent(value, 0);
  return formatNumber(value);
}
