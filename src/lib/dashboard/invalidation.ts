import { revalidatePath, revalidateTag } from "next/cache.js";

import { CLOSING_STORE_SPLIT_CACHE_TAG } from "@/lib/sales/closing-store-split-net";
import { COMPANY_VACATION_REPORT_CACHE_TAG } from "@/lib/vacation/company-vacation-report";

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
    // A leave-affecting change (create/update/delete/decision on any v2_vacation_requests row,
    // from any of the 9+ call sites across the vacation workflow) must also bust the Company
    // Vacation Report's historical cache — otherwise a past-month status change can stay stale
    // there for up to HISTORICAL_REVALIDATE_SECONDS (6h). Previously only the CRM-signal approve
    // route busted this tag, so every other mutation path went stale silently.
    if (uniqueModules.includes("leave")) {
      revalidateTag(COMPANY_VACATION_REPORT_CACHE_TAG, "max");
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

// Busts the cached Closing-Matrix store-split overlay (src/lib/sales/closing-store-split-net.ts)
// after a validated monthly closing import or a publish/unpublish, so the Matrix and the employee
// portal pick up the new split immediately instead of waiting out its 1h TTL backstop. Best-effort,
// same reasoning as invalidateSalesDashboardCache above.
export function invalidateClosingStoreSplitCache(reason: string) {
  try {
    revalidateTag(CLOSING_STORE_SPLIT_CACHE_TAG, "max");
  } catch (error) {
    console.warn("Closing store-split cache tag revalidation failed.", {
      error: error instanceof Error ? error.message : String(error),
      reason,
    });
  }
}
