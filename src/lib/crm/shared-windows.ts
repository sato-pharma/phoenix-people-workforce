import { bumpSharedReadGeneration } from "@/lib/cache/shared-read";

/**
 * The names of the two shared CRM window copies (`src/lib/crm/reads.ts`, `reuseRecentWindow`) and the one
 * call that drops them. Kept apart from the read door so a WRITE path — saving a Phoenix CRM visit — can
 * refresh the copies without importing the whole door.
 *
 * In-process only: a write on another process (the worker service's vendor sync) is caught by the copy's
 * 60 s lifetime instead, which is the freshness the owner chose on 2026-10-16.
 */
export const CRM_VISIT_WINDOWS = "crm:visit-windows";
export const CRM_CHECKIN_WINDOWS = "crm:checkin-windows";
/** The Phoenix CRM List's averaged check-in pins (`loadObservedPointsFor`, src/lib/crm/shared-customers.ts). */
export const CRM_OBSERVED_POINTS = "crm:observed-points";

/** Drops every shared CRM window copy, so the next dashboard read goes to the database. */
export function refreshSharedCrmWindows(reason: string): void {
  bumpSharedReadGeneration(CRM_VISIT_WINDOWS, reason);
  bumpSharedReadGeneration(CRM_CHECKIN_WINDOWS, reason);
  bumpSharedReadGeneration(CRM_OBSERVED_POINTS, reason);
}

/**
 * The Reps List's company-wide sharing roster (`loadContactRoster`, src/lib/crm/reps-list.ts): every open
 * doctor-list assignment, read only to spot a doctor who also sits on another rep's list. It was the
 * heaviest read on the database on 25 Oct 2026 — 14 parallel pages per rep opened, about 168 full reads
 * in seven hours on the 2 GB box that kept restarting under working-day load.
 */
export const CRM_CONTACT_ROSTER = "crm:contact-roster";

/**
 * The KPI panel's open assignments (`loadPanelRows`, src/lib/crm/rep-kpi-reports-data.ts): every open
 * `crm_contact_assignments` row — the roster's own table and filter, read for the AM · PM denominators
 * instead of the names. 14,440 rows on 1 Nov 2026, fetched as fifteen parallel OFFSET pages on every KPI
 * open — the heaviest statement on the database that day (5,488 pages, 154 s). Shared ONLY by a caller
 * that opts in with `reuseRecentWindow` (the display boards); the system audit reads it live.
 */
export const CRM_OPEN_ASSIGNMENTS = "crm:open-assignments";

/**
 * Drops the shared roster copy — called by every app path that applies a doctor-list change. The KPI
 * panel's copy goes with it: the same table, the same open-period filter, so a list change is visible on
 * the KPI boards at once too.
 */
export function refreshSharedContactRoster(reason: string): void {
  bumpSharedReadGeneration(CRM_CONTACT_ROSTER, reason);
  bumpSharedReadGeneration(CRM_OPEN_ASSIGNMENTS, reason);
}

/**
 * The Reps List's two whole-table reads that take nothing from the rep (1 Nov 2026, the speed root cause —
 * about 450 ms a request at Supabase's edge whatever the SQL costs, so the request count is the lever):
 * the mapped CRM region -> brick map (`loadRegionBrickMap`, src/lib/crm/reps-list.ts; 324 mapped rows) and
 * the trade counterparties (`loadTradeCounterparties`, src/lib/crm/contact-trade.ts; six whole-table reads
 * of the direct-order venues and marketing customers Phoenix has done business with). Both were read again
 * on every board open, by every viewer; each is now a shared copy (60 s), dropped at once by the app write
 * that changes it. Display reads both — the group headings and two counts beside a contact.
 */
export const CRM_REGION_BRICK_MAP = "crm:region-brick-map";
export const CRM_TRADE_COUNTERPARTIES = "crm:trade-counterparties";

/** Drops the shared region -> brick map — called by the two writes that map a CRM region to a brick. */
export function refreshSharedRegionBrickMap(reason: string): void {
  bumpSharedReadGeneration(CRM_REGION_BRICK_MAP, reason);
}

/** Drops the shared trade counterparties — called when a direct order or marketing request is submitted or decided. */
export function refreshSharedTradeCounterparties(reason: string): void {
  bumpSharedReadGeneration(CRM_TRADE_COUNTERPARTIES, reason);
}
