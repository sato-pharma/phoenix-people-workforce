// Analytics filter registry — typed config system for all analytics dashboards.
// Each filter descriptor drives the UI (label, type, options source) and the
// server-side query builder without hardcoding per-dashboard logic.

export type FilterType =
  | "single-select"
  | "multi-select"
  | "date-range"
  | "text-search"
  | "boolean";

export type FilterSource =
  | "static"          // options provided inline
  | "periods"         // loaded from analytics.dim_periods
  | "weeks"           // loaded from analytics.dim_weeks
  | "distributors"    // loaded from analytics.dim_distributors
  | "products"        // loaded from analytics.dim_products
  | "families"        // distinct families from dim_products
  | "lines"           // distinct lines from dim_products
  | "regions"         // loaded from analytics.dim_areas (distinct regions)
  | "areas"           // loaded from analytics.dim_areas
  | "employees"       // loaded from employee directory
  | "territories"     // distinct territories from closing_fact
  | "customers";       // loaded from analytics.sos_by_customer (period-scoped)

export type FilterDescriptor = {
  key: string;
  label: string;
  type: FilterType;
  source: FilterSource;
  staticOptions?: { value: string; label: string }[];
  placeholder?: string;
  multiple?: boolean;
  pipeline?: SalesPipeline | SalesPipeline[]; // which pipeline(s) this filter applies to
};

export type SalesPipeline = "sos" | "closing" | "weekly" | "all";

// ── Filter value types ────────────────────────────────────────────────────────

export type FilterValues = Record<string, string | string[] | boolean | null>;

export function getFilterValue(filters: FilterValues, key: string): string | null {
  const v = filters[key];
  if (Array.isArray(v)) return v[0] ?? null;
  if (typeof v === "string") return v || null;
  return null;
}

export function getFilterArray(filters: FilterValues, key: string): string[] {
  const v = filters[key];
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v) return [v];
  return [];
}

// (Removed getFilterMode: the analytics filter bar hardcodes include-mode and had zero callers of
// this helper. Exclude mode isn't supported by the analytics RPCs; if it's added later, reintroduce
// the reader alongside the code that actually consumes it rather than leaving a speculative export.)

// ── Parse URL search params into FilterValues ─────────────────────────────────

export function parseAnalyticsFilters(
  params: Record<string, string | string[] | undefined>,
  descriptors: FilterDescriptor[],
): FilterValues {
  const out: FilterValues = {};
  for (const d of descriptors) {
    const raw = params[d.key];
    if (raw === undefined || raw === null) continue;
    if (d.type === "multi-select" || d.multiple) {
      out[d.key] = Array.isArray(raw) ? raw : [raw];
    } else if (d.type === "boolean") {
      out[d.key] = raw === "true";
    } else {
      out[d.key] = Array.isArray(raw) ? raw[0] : raw;
    }
  }
  return out;
}

// ── Serialize FilterValues → URLSearchParams string ───────────────────────────

export function serializeFilters(filters: FilterValues): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) params.append(key, v);
    } else {
      params.set(key, String(value));
    }
  }
  return params.toString();
}
