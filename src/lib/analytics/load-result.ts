// A dashboard data load that is allowed to fail without taking the page down — but that must never
// be mistaken for "there were no sales".
//
// The analytics dashboards used to write `loadX(filters).catch(() => [])`. An RPC error, a 45s
// statement timeout, or a signature mismatch therefore rendered as a confident EGP 0 that was
// indistinguishable from a genuine zero — and on the SoS dashboard it was then cached for 300s.
// Three of those call sites were prior-period loads, so a failure produced a fake growth %.
//
// This mirrors the convention already established for empty result sets in src/lib/sales/metrics.ts
// (`null` = unavailable, `0` = a real zero, rendered as "—" by analytics-data-table.tsx and pinned by
// tests/sales-null-vs-zero.test.ts) and extends it to FAILED loads, which that convention never
// covered.

import type { AnalyticsDimensions } from "./service";

export type LoadResult<T> = {
  data: T;
  /** True only when the load threw. Never inferred from an empty `data`. */
  failed: boolean;
};

/**
 * Run a dashboard load, returning `fallback` and `failed: true` if it throws.
 *
 * Callers must render an error state when `failed` is true instead of presenting `fallback` as
 * fact. `label` is logged so a failure is diagnosable from the server logs.
 */
export async function loadOrFail<T>(
  label: string,
  load: () => Promise<T>,
  fallback: T,
): Promise<LoadResult<T>> {
  try {
    return { data: await load(), failed: false };
  } catch (error) {
    console.error(`[analytics] load failed: ${label}`, error);
    return { data: fallback, failed: true };
  }
}

/** True when any load on the page failed — drives a single page-level error banner. */
export function anyFailed(...results: { failed: boolean }[]): boolean {
  return results.some((r) => r.failed);
}

/**
 * A `.catch()` handler that records the failure instead of hiding it.
 *
 * Drop-in for the `.catch(() => [])` this replaces, so the surrounding `Promise.all` destructuring
 * is untouched — but the page now knows the panel is incomplete and renders AnalyticsErrorState
 * rather than presenting the fallback as fact.
 *
 *     const analyticsFailures: string[] = [];
 *     const rows = await loadSosByArea(f).catch(trackFailure(analyticsFailures, "Sales by area", []));
 */
export function trackFailure<T>(failures: string[], label: string, fallback: T) {
  return (error: unknown): T => {
    console.error(`[analytics] load failed: ${label}`, error);
    failures.push(label);
    return fallback;
  };
}

/**
 * Empty filter dimensions.
 *
 * The fallback for a failed `loadAnalyticsDimensions` used to be `demoAnalyticsDimensions()`, which
 * put fabricated values ("Demo Distributor A", demo periods) into the filter dropdowns of a LIVE
 * dashboard. Demo fixtures must be reachable only through the explicit demo flag
 * (src/lib/analytics/demo-mode.ts), never through a catch.
 */
export function emptyAnalyticsDimensions(): AnalyticsDimensions {
  return {
    periods: [],
    weeks: [],
    distributors: [],
    lines: [],
    families: [],
    regions: [],
    areas: [],
    products: [],
  };
}
