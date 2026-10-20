import { revalidatePath, revalidateTag } from "next/cache.js";

/**
 * The Closing-Matrix store-split overlay's tag (src/lib/sales/closing-store-split-net.ts) and the Company
 * Vacation Report's (src/lib/vacation/company-vacation-report.ts), declared HERE as bare strings and
 * re-exported by their owners, for the same reason as FINANCE_DASHBOARD_CACHE_TAG below. This module is
 * imported by the employee directory, which nearly every page and route reaches, and until 2026-10-17 it
 * took these two strings FROM their owners — so 79 modules of sales and vacation code (4 MB compiled)
 * rode into about 1,160 of the app's 1,616 pages and routes for two words. Never import a tag here.
 */
export const CLOSING_STORE_SPLIT_CACHE_TAG = "closing-store-split";
export const COMPANY_VACATION_REPORT_CACHE_TAG = "company-vacation-report";

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
] as const;

/**
 * The Finance Command Center's cache tag (src/lib/finance/command-center.ts reads it from here).
 *
 * Declared HERE rather than imported from the cache that owns it — the opposite of the two tags
 * above — for a build reason, not a stylistic one. This module is transitively reachable from a
 * client bundle (employee-directory -> crm/reads -> attendance -> monthly-attendance-summary), and
 * the finance service pulls automated-payroll -> payroll/service -> supabase/rls-server, which is
 * server-only. Importing the tag from there drags that whole chain into the browser build and
 * fails it outright. A bare string constant has no such gravity, so the dependency points the
 * other way.
 *
 * Deliberately NOT folded into SALES_DASHBOARD_CACHE_TAGS: nothing on that dashboard is
 * sales-derived, and the Finance Manager holds no `sales` grant at all. What moves its numbers is
 * payroll being confirmed, an expense being decided, and leave changing state — so it is busted by
 * those modules instead, all of which already call invalidateExecutiveDashboardCache today.
 */
export const FINANCE_DASHBOARD_CACHE_TAG = "finance-dashboard";

/**
 * The cache tag for the ONE unscoped, unfiltered read of every v2_vacation_requests row shared by
 * all vacation-report surfaces (src/lib/vacation/service.ts, loadAllVacationRequestRowsCached — the
 * cross-request cache that replaced the ~779/hour phx_vacation_report_rows RPC). Declared HERE as a
 * bare string for the same client-bundle reason as FINANCE_DASHBOARD_CACHE_TAG above: the vacation
 * service is server-only and importing a tag *from* it into any client-reachable module would drag
 * the whole chain into the browser build. Busted in the `leave` block below, so every one of the
 * vacation write paths that already calls invalidateExecutiveDashboardCache(reason, ['leave'])
 * refreshes this base read on the next request — the 60s TTL is only a self-healing backstop.
 */
export const VACATION_REPORT_ROWS_CACHE_TAG = "vacation-report-rows";

/** Modules whose changes move a figure on the Finance Command Center. */
const FINANCE_DASHBOARD_MODULES: ExecutiveDashboardModule[] = ["payroll", "expenses", "leave"];

/**
 * Modules whose changes move a seat in `au_v_org_tree` — a hire or seat edit, a resignation/decline
 * that vacates a seat, or a workflow (probation, contract renewal) that reseats someone. The CRM org
 * tree reads (src/lib/crm/org-placement-data.ts, src/lib/phoenix-crm/server/org.ts) cache that view
 * under the same "sos-reference" tag as the SoS reference masters, so every one of these write paths
 * already called this function with one of these modules — the tag just never got busted. Without
 * this the org tree only self-heals after its 300s TTL: a hire, an exit or a re-seat is invisible to
 * the CRM sync panel's scope resolution for up to five minutes.
 */
const ORG_TREE_MODULES: ExecutiveDashboardModule[] = ["employees", "vacancies", "resignations"];

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
      // Also bust the cross-request base read that every vacation-report surface shares. Every
      // vacation write already routes through here with ['leave'], so this one line gives complete
      // write-path coverage for the cached loadAllVacationRequestRowsCached rows.
      //
      // EXPIRED AT ONCE, NOT "max" (2026-10-20). In Next 16 `"max"` is stale-while-revalidate: the
      // next read is still served the OLD rows while a fresh copy loads behind it. The page's
      // router.refresh() after a save is that next read, so an HR edit of a request's dates came
      // back showing the old dates — three saves for VAC-0686 landed in the database and the screen
      // never moved. `{ expire: 0 }` makes the next read wait for the fresh rows (updateTag is the
      // same thing but only exists in Server Actions, and these writes are route handlers).
      revalidateTag(VACATION_REPORT_ROWS_CACHE_TAG, { expire: 0 });
    }
    // The Finance Command Center's numbers come from committed payroll, decided expenses and
    // leave steps. Without this its 300s TTL is the only thing between a confirmed payroll run
    // and the finance manager seeing it — on a landing page whose whole job is "what is waiting
    // on you", five minutes of staleness is five minutes of a queue he thinks he has cleared.
    if (uniqueModules.some((module) => FINANCE_DASHBOARD_MODULES.includes(module))) {
      revalidateTag(FINANCE_DASHBOARD_CACHE_TAG, "max");
    }
    // An organogram-affecting change also invalidates the cached org tree — it shares "sos-reference"
    // with the sales reference masters, so a hire, seat move or exit shows up immediately instead of
    // waiting out the cache's 300s TTL.
    if (uniqueModules.some((module) => ORG_TREE_MODULES.includes(module))) {
      revalidateTag("sos-reference", "max");
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
