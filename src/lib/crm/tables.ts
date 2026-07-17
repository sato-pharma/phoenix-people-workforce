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

/** Manual crm_id -> hr_id identity resolutions (override tier of the identity waterfall). */
export const CRM_IDENTITY_RESOLUTIONS_TABLE = "ireports360_crm_identity_resolutions";
