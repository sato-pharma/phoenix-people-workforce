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

/**
 * Every cache keyed on the achievement stamp (`loadAchievementCacheStamp`, src/lib/sales/vs-target.ts):
 * one month of achievement rows, the Business Review bundle and the admin sales metrics. The stamp
 * moves with actuals, targets, seats and the attribution config, and NOT with a Product Master price,
 * so a price edit reached those figures only when their time ran out (up to an hour for a month of
 * achievement). The tag is how a price edit reaches them at once.
 */
export const SALES_ACHIEVEMENT_STAMPED_CACHE_TAG = "sales-achievement-stamped";

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

/**
 * The reps' daily forecast's own tag (src/lib/phoenix-crm/server/daily-forecast.ts: the published CNS
 * closing it measures a rep against). A bare string here for the same reason as the tags above. It
 * was tagged only "sos-reference", which nothing that moves a closing busts: a publish, an unpublish
 * or a target save left the forecast on the old closing for its whole 10-minute TTL (cache audit,
 * 2026-10-26). Busted by invalidateCrmDailyForecastCache below.
 */
export const CRM_DAILY_FORECAST_CACHE_TAG = "phoenix-crm-daily-forecast";

/**
 * My map's landing snapshot (src/lib/phoenix-crm/server/my-map.ts): the counts and the sampled pins on the
 * rep's, the district manager's, the regional and the national manager's landing card. A bare string here for
 * the same reason as the tags above. Busted by invalidateMyMapSnapshotCache when a customer is validated or a
 * held place is decided, the two paths that add or retire a pin; the 60-second TTL is the backstop.
 */
export const MY_MAP_SNAPSHOT_CACHE_TAG = "phoenix-crm-my-map-snapshot";

/**
 * Whether a person has "My email" connected (src/lib/personal-mailbox/service.ts, personalMailboxConnected),
 * which the portal and admin shells read on every render to decide whether the envelope checks the
 * mailbox at all (1 Nov 2026). A bare string here for the same reason as the tags above. Busted by
 * invalidatePersonalMailboxConnectionCache on connect, disconnect, a new hire's connection, a refused
 * password and the departed-mailbox purge; the 5-minute TTL is the backstop.
 */
export const PERSONAL_MAILBOX_CONNECTION_CACHE_TAG = "personal-mailbox-connection";

/**
 * Whether a person has an ACTIVE fingerprint device mapping (src/lib/attendance/device-user-mapping.ts,
 * employeeHasActiveDeviceMapping), which the portal shell asks on every render to show or hide the
 * Attendance Analytics row (1 Nov 2026, the speed root cause: one uncached count per page view). A bare
 * string here for the same reason as the tags above. Busted by invalidateDeviceMappingCache from the one
 * write that changes it, saveAttendanceDeviceUserMapping; the 10-minute TTL is the backstop.
 */
export const DEVICE_MAPPING_CACHE_TAG = "attendance-device-mapping";

/**
 * The Phoenix Ranks board and profiles (src/lib/rep-ranks/server/read.ts), remembered for an hour per
 * window and audience (2 Nov 2026, the speed root cause, Stage 2: the board read ~3,000 standings rows
 * and every title on every open). The standings change only when the nightly compute writes them, and
 * that one writer (rebuildWindows in compute.ts) drops this tag when it finishes.
 */
export const REP_RANKS_CACHE_TAG = "rep-ranks";

/**
 * The Weekly Stock payload (src/lib/sales/weekly/stock-dashboard-service.ts), remembered for five
 * minutes per viewer SCOPE and filters (2 Nov 2026, the speed root cause, Stage 2: 12.9 s of server
 * render per open on production). Dropped by every weekly write path through bumpWeeklyRowsGeneration
 * (upload, delete, retag, alias heal, the admin reset) and by a Product Master price edit through
 * invalidatePriceDependentSalesCaches, since a stock value is units at the factory price.
 */
export const WEEKLY_STOCK_CACHE_TAG = "weekly-stock-payload";

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
    // "/overview" is not revalidated: it is force-dynamic and only redirects to the role's landing page,
    // so it holds nothing to refresh (2026-10-26 cache audit, P3).
    revalidatePath("/admin");
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
      revalidateTag(COMPANY_VACATION_REPORT_CACHE_TAG, { expire: 0 });
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
    // Expired at once (cache audit, 2026-10-26): "max" is stale-while-revalidate, so the finance
    // manager's own refresh after a decision was still served the queue from before it.
    if (uniqueModules.some((module) => FINANCE_DASHBOARD_MODULES.includes(module))) {
      revalidateTag(FINANCE_DASHBOARD_CACHE_TAG, { expire: 0 });
    }
    // An organogram-affecting change also invalidates the cached org tree — it shares "sos-reference"
    // with the sales reference masters, so a hire, seat move or exit shows up immediately instead of
    // waiting out the cache's 300s TTL. Expired at once, not "max": the HR screen that just saved a
    // hire re-reads the tree straight away, and "max" served it the tree from before the save.
    if (uniqueModules.some((module) => ORG_TREE_MODULES.includes(module))) {
      revalidateTag("sos-reference", { expire: 0 });
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

/**
 * Expires the reps' daily forecast at once, after a closing is published or unpublished or a month's
 * targets are saved or dropped. `{ expire: 0 }`, not "max": a rep opening the forecast right after a
 * publish must get the published month, not one more read of the old one. Best-effort, as below.
 */
export function invalidateCrmDailyForecastCache(reason: string) {
  try {
    revalidateTag(CRM_DAILY_FORECAST_CACHE_TAG, { expire: 0 });
  } catch (error) {
    console.warn("CRM daily forecast cache tag revalidation failed.", {
      error: error instanceof Error ? error.message : String(error),
      reason,
    });
  }
}

/** A pin was added or retired: every My map landing card reads again on its next render. */
export function invalidateMyMapSnapshotCache(reason: string) {
  try {
    revalidateTag(MY_MAP_SNAPSHOT_CACHE_TAG, { expire: 0 });
  } catch (error) {
    console.warn("My map snapshot cache tag revalidation failed.", {
      error: error instanceof Error ? error.message : String(error),
      reason,
    });
  }
}

/** A device mapping was saved: every shell asks again whether that person is enrolled on the device. */
export function invalidateDeviceMappingCache(reason: string) {
  try {
    revalidateTag(DEVICE_MAPPING_CACHE_TAG, { expire: 0 });
  } catch (error) {
    console.warn("Device mapping cache tag revalidation failed.", {
      error: error instanceof Error ? error.message : String(error),
      reason,
    });
  }
}

/** The nightly compute wrote new standings: the board and every profile read them again on the next open. */
export function invalidateRepRanksCache(reason: string) {
  try {
    revalidateTag(REP_RANKS_CACHE_TAG, { expire: 0 });
  } catch (error) {
    console.warn("Rep ranks cache tag revalidation failed.", {
      error: error instanceof Error ? error.message : String(error),
      reason,
    });
  }
}

/** Weekly rows were written: every Weekly Stock open rebuilds its payload. Expired at once, so the uploader's own next screen shows the upload. */
export function invalidateWeeklyStockCache(reason: string) {
  try {
    revalidateTag(WEEKLY_STOCK_CACHE_TAG, { expire: 0 });
  } catch (error) {
    console.warn("Weekly stock cache tag revalidation failed.", {
      error: error instanceof Error ? error.message : String(error),
      reason,
    });
  }
}

/** A mailbox was connected, dropped or refused: every shell reads the connection again on its next render. */
export function invalidatePersonalMailboxConnectionCache(reason: string) {
  try {
    revalidateTag(PERSONAL_MAILBOX_CONNECTION_CACHE_TAG, { expire: 0 });
  } catch (error) {
    console.warn("Personal mailbox connection cache tag revalidation failed.", {
      error: error instanceof Error ? error.message : String(error),
      reason,
    });
  }
}

/**
 * Expires the Finance Command Center at once, for a write it counts that no module of
 * invalidateExecutiveDashboardCache names: a marketing request decision and a direct order's status or
 * booked month. Those writes busted nothing, so the finance landing kept an order or a request
 * "waiting on you" for up to its 300s TTL after it was decided (cache audit, 2026-10-26).
 * Best-effort, as below.
 */
export function invalidateFinanceDashboardCache(reason: string) {
  try {
    revalidateTag(FINANCE_DASHBOARD_CACHE_TAG, { expire: 0 });
  } catch (error) {
    console.warn("Finance dashboard cache tag revalidation failed.", {
      error: error instanceof Error ? error.message : String(error),
      reason,
    });
  }
}

/**
 * Expires the Company Vacation Report's caches at once, for a write that moves the holiday calendar
 * (a confirmed observed-date override). Leave writes reach the same tag through the `leave` block of
 * invalidateExecutiveDashboardCache; a holiday-calendar save is not a leave write, so it never did,
 * and the report kept counting a re-dated Eid on its old day for up to six hours (cache audit,
 * 2026-10-26). Best-effort, as below.
 */
export function invalidateCompanyVacationReportCache(reason: string) {
  try {
    revalidateTag(COMPANY_VACATION_REPORT_CACHE_TAG, { expire: 0 });
  } catch (error) {
    console.warn("Company vacation report cache tag revalidation failed.", {
      error: error instanceof Error ? error.message : String(error),
      reason,
    });
  }
}

/**
 * Expires the sales caches whose keys do not see a Product Master price — the Closing-Matrix
 * store-split overlay and everything keyed on the achievement stamp — for a write to the master
 * data (a price, a product, a brick). Their keys carry the month and the attribution inputs, never
 * the factory price or its history, so a price edit took up to an hour to show on the unpublished
 * month (cache audit, 2026-10-26). Published months were never at risk: the publish gate recomputes
 * without the cache. `{ expire: 0 }` so the editor's next screen already shows the new price; nothing
 * on the master-data routes busts these tags with "max" afterwards, which would undo it.
 * Best-effort, as below.
 */
export function invalidateAchievementStampedCaches(reason: string) {
  try {
    revalidateTag(SALES_ACHIEVEMENT_STAMPED_CACHE_TAG, { expire: 0 });
  } catch (error) {
    console.warn("Achievement-stamped cache tag revalidation failed.", {
      error: error instanceof Error ? error.message : String(error),
      reason,
    });
  }
}

export function invalidatePriceDependentSalesCaches(reason: string) {
  // Weekly Stock joins them (2 Nov 2026): its values are units at the factory price, and its payload is remembered.
  for (const tag of [CLOSING_STORE_SPLIT_CACHE_TAG, SALES_ACHIEVEMENT_STAMPED_CACHE_TAG, WEEKLY_STOCK_CACHE_TAG]) {
    try {
      revalidateTag(tag, { expire: 0 });
    } catch (error) {
      console.warn("Price-dependent sales cache tag revalidation failed.", {
        error: error instanceof Error ? error.message : String(error),
        reason,
        tag,
      });
    }
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
