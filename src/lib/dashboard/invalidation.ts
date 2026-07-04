import { revalidatePath, revalidateTag } from "next/cache.js";

export type ExecutiveDashboardModule =
  | "employees"
  | "vacancies"
  | "payroll"
  | "sales"
  | "expenses"
  | "contracts"
  | "probation"
  | "offers"
  | "recruitment"
  | "resignations"
  | "leave"
  | "operations";

// Cache tags for the dashboard data caches (unstable_cache):
//  - "sos-dashboard"  -> src/lib/sales/sos-dashboard.ts (getSosDashboard RPC fan-out)
//  - "smi-dashboard"  -> src/lib/sales-marketing-intelligence/service.ts (marketing ROI RPCs)
//  - "sos-reference"  -> shared SoS reference masters (products / brick centroids)
// Busting these after a validated import makes the dashboards reflect fresh data immediately
// instead of only after the 300s TTL. Kept in one place so every import/refresh path agrees.
export const SALES_DASHBOARD_CACHE_TAGS = [
  "sos-dashboard", "smi-dashboard", "sos-reference",
  // /admin/analytics/* caches (src/lib/analytics/service.ts) — SoS-derived, closing-derived,
  // and weekly-derived. Busted by the same sales/SoS import paths that already bust the above.
  "analytics-sos", "analytics-closing", "analytics-weekly",
] as const;

export function invalidateExecutiveDashboardCache(
  reason: string,
  modules: ExecutiveDashboardModule[] = [],
) {
  const uniqueModules = Array.from(new Set(modules));
  try {
    revalidatePath("/admin");
    revalidatePath("/overview");
    // A sales-affecting change also invalidates the cached SoS + Marketing-ROI dashboards and
    // their shared reference data; non-sales changes leave those caches to their own TTL.
    if (uniqueModules.includes("sales")) {
      for (const tag of SALES_DASHBOARD_CACHE_TAGS) revalidateTag(tag, "max");
    }
  } catch (error) {
    console.warn("Executive dashboard route revalidation failed.", {
      error: error instanceof Error ? error.message : String(error),
      modules: uniqueModules,
      reason,
    });
  }
}

// Invalidate the cached Source-of-Sales + Marketing-ROI dashboard reads and their shared
// reference data. Call this after any path that refreshes the SoS / marketing rollups
// (phx_finalize_sos_batch, phx_refresh_sos_fact_rollup, phx_refresh_marketing_roi_facts, ...).
// Best-effort: revalidateTag throws outside a request scope (e.g. a cron), so it's wrapped —
// a failed bust just means the data refreshes on the next TTL expiry rather than instantly.
export function invalidateSalesDashboardCache(reason: string) {
  try {
    for (const tag of SALES_DASHBOARD_CACHE_TAGS) revalidateTag(tag, "max");
  } catch (error) {
    console.warn("Sales dashboard cache tag revalidation failed.", {
      error: error instanceof Error ? error.message : String(error),
      reason,
    });
  }
}
