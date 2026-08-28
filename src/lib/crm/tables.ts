/**
 * Canonical table names for the CRM (iReports360) mirror.
 *
 * These are the ONLY places the raw table-name strings should appear. Every CRM
 * read/write in `src/lib/crm/` references these constants, and the single-source
 * guardrail test forbids `.from("ireports360_*")` string literals outside this
 * domain — so this file is the one spot that knows the physical table names.
 */

/** Synced field-visit records (one row per CRM visit, keyed on `crm_visit_id`). */
export const CRM_VISITS_TABLE = "ireports360_visits";

/** Synced GPS check-in records (one row per CRM check-in, keyed on `crm_checkin_id`). */
export const CRM_CHECKINS_TABLE = "ireports360_checkins";

/** One row per sync attempt (cron / manual backfill), success or failure. */
export const CRM_SYNC_RUNS_TABLE = "ireports360_visits_sync_runs";

/** One row per 30-day history window, holding the LATEST parity verification of that window against
 * the CRM (see `src/lib/crm/parity.ts`). Keyed on the window's start date, so it is a running state
 * table rather than a log — what each check actually did is recorded in CRM_SYNC_RUNS_TABLE. */
export const CRM_PARITY_WINDOWS_TABLE = "ireports360_parity_windows";

/** Manual crm_id -> hr_id identity resolutions (override tier of the identity waterfall). */
export const CRM_IDENTITY_RESOLUTIONS_TABLE = "ireports360_crm_identity_resolutions";

/** Manual CRM-region -> Phoenix-brick resolutions (see the Region Mapping admin tab). */
export const CRM_REGION_BRICK_RESOLUTIONS_TABLE = "ireports360_crm_region_brick_resolutions";

/** Manual CRM-customer/contact -> Phoenix-brick resolutions (see the Customer Mapping admin tab).
 * One level finer than CRM_REGION_BRICK_RESOLUTIONS_TABLE: a region groups many customers into one
 * rough locality, a customer mapping is the single most precise thing Phoenix can resolve. */
export const CRM_CUSTOMER_BRICK_RESOLUTIONS_TABLE = "ireports360_crm_customer_brick_resolutions";

/** Synced PLAN entries — the rep's assigned doctor list (one row per planned call, keyed on
 * `crm_plan_entry_id`). The counterpart to CRM_VISITS_TABLE: that table holds what a rep DID,
 * this one holds what they were assigned. Deliberately NOT named after Phoenix's own
 * `weekly-planning` module, which is an unrelated in-app feature with a confusingly similar name. */
export const CRM_PLAN_ENTRIES_TABLE = "ireports360_plan_entries";
