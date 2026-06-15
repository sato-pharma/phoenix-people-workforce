// Pure (framework-free) helpers shared by the page, the client dashboard, the data
// route, and the export route — so the filter encode/decode is canonical and never
// drifts between what the screen shows and what the export produces.

import type {
  ExpenseCommandFilters,
  ExpenseDatePreset,
  ExpenseSource,
} from "@/lib/outstation/expense-command-types";

const EGP = new Intl.NumberFormat("en-US", {
  currency: "EGP",
  maximumFractionDigits: 0,
  style: "currency",
});

const EGP_PRECISE = new Intl.NumberFormat("en-US", {
  currency: "EGP",
  maximumFractionDigits: 2,
  style: "currency",
});

/** Whole-EGP currency. */
export function egp(value: number | null | undefined): string {
  return EGP.format(Number.isFinite(value as number) ? (value as number) : 0);
}

export function egpPrecise(value: number | null | undefined): string {
  return EGP_PRECISE.format(Number.isFinite(value as number) ? (value as number) : 0);
}

/** Compact EGP for chart axes / tight chips (e.g. "EGP 12.3k"). */
export function compactEgp(value: number | null | undefined): string {
  const num = Number.isFinite(value as number) ? (value as number) : 0;
  const abs = Math.abs(num);
  if (abs >= 1_000_000) return `EGP ${(num / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `EGP ${(num / 1_000).toFixed(1)}k`;
  return `EGP ${Math.round(num)}`;
}

export function pct(value: number | null | undefined, fractionDigits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(fractionDigits)}%`;
}

/** Show a measurement, or an em-dash when it is genuinely absent (honest empty-state). */
export function orDash(value: number | null | undefined, format: (n: number) => string = (n) => String(n)): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) return "—";
  return format(value);
}

export function formatPeriodLabel(period: string): string {
  // period is "YYYY-MM"
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) return period;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const date = new Date(year, monthIndex, 1);
  if (Number.isNaN(date.getTime())) return period;
  return date.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

export function formatShortDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

const VALID_PRESETS: ExpenseDatePreset[] = ["all", "today", "7d", "30d", "90d", "month", "custom"];
const VALID_SOURCES: ExpenseSource[] = ["historical", "live", "manual"];

export const EXPENSE_DEFAULT_PRESET: ExpenseDatePreset = "all";

export const EXPENSE_PRESET_LABELS: Record<ExpenseDatePreset, string> = {
  all: "All time",
  today: "Today",
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
  month: "This month",
  custom: "Custom",
};

export const EXPENSE_SOURCE_LABELS: Record<ExpenseSource, string> = {
  historical: "Historical upload",
  live: "Employee submission",
  manual: "Admin manual entry",
};

/**
 * Decode filters from any "get one value by key" source. Works for both
 * URLSearchParams (data/export routes) and resolved Next searchParams records
 * (the server page) via a thin adapter.
 */
export function parseExpenseFilters(get: (key: string) => string | null): ExpenseCommandFilters {
  const presetRaw = get("preset");
  const preset = VALID_PRESETS.includes(presetRaw as ExpenseDatePreset)
    ? (presetRaw as ExpenseDatePreset)
    : EXPENSE_DEFAULT_PRESET;
  const sourceRaw = get("source");
  const source = VALID_SOURCES.includes(sourceRaw as ExpenseSource) ? (sourceRaw as ExpenseSource) : null;

  const clean = (value: string | null) => {
    const trimmed = (value ?? "").trim();
    return trimmed ? trimmed : null;
  };

  return {
    preset,
    from: clean(get("from")),
    to: clean(get("to")),
    region: clean(get("region")),
    line: clean(get("line")),
    employeeHrId: clean(get("employee")),
    source,
    status: clean(get("status")),
    transportation: clean(get("transport")),
    expenseType: clean(get("expenseType")),
  };
}

export function parseExpenseFiltersFromSearchParams(params: URLSearchParams): ExpenseCommandFilters {
  return parseExpenseFilters((key) => params.get(key));
}

export function parseExpenseFiltersFromRecord(
  record: Record<string, string | string[] | undefined>,
): ExpenseCommandFilters {
  return parseExpenseFilters((key) => {
    const value = record[key];
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  });
}

/** Encode filters to URLSearchParams (omitting empties + the default preset). */
export function expenseFiltersToParams(filters: ExpenseCommandFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.preset && filters.preset !== EXPENSE_DEFAULT_PRESET) params.set("preset", filters.preset);
  if (filters.preset === "custom") {
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
  }
  if (filters.region) params.set("region", filters.region);
  if (filters.line) params.set("line", filters.line);
  if (filters.employeeHrId) params.set("employee", filters.employeeHrId);
  if (filters.source) params.set("source", filters.source);
  if (filters.status) params.set("status", filters.status);
  if (filters.transportation) params.set("transport", filters.transportation);
  if (filters.expenseType) params.set("expenseType", filters.expenseType);
  return params;
}

export function expenseFiltersToQueryString(filters: ExpenseCommandFilters): string {
  return expenseFiltersToParams(filters).toString();
}

/** Number of non-default active filters (date preset excluded). */
export function countActiveExpenseFilters(filters: ExpenseCommandFilters): number {
  let count = 0;
  if (filters.preset && filters.preset !== "all") count += 1;
  if (filters.region) count += 1;
  if (filters.line) count += 1;
  if (filters.employeeHrId) count += 1;
  if (filters.source) count += 1;
  if (filters.status) count += 1;
  if (filters.transportation) count += 1;
  if (filters.expenseType) count += 1;
  return count;
}
