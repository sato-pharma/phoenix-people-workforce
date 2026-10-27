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

/** One row per mirror visit/check-in id the reconciliation DELETED, written before the delete runs.
 * This is the only place a deleted id survives: CRM_PARITY_WINDOWS_TABLE keeps counts, the sync-run
 * row keeps `rows_deleted`, and production has no point-in-time recovery — 1,879 rows left across
 * five nights in Sept/Oct 2026 with no id recorded anywhere. Service-role only; evidence, never
 * business data. */
export const CRM_SYNC_DELETIONS_TABLE = "ireports360_sync_deletions";

/** Manual crm_id -> hr_id identity resolutions (override tier of the identity waterfall). */
export const CRM_IDENTITY_RESOLUTIONS_TABLE = "ireports360_crm_identity_resolutions";

/** Manual CRM-region -> Phoenix-brick resolutions (see the Region Mapping admin tab). */
export const CRM_REGION_BRICK_RESOLUTIONS_TABLE = "ireports360_crm_region_brick_resolutions";

/** Manual CRM-customer/contact -> Phoenix-brick resolutions (see the Customer Mapping admin tab).
 * One level finer than CRM_REGION_BRICK_RESOLUTIONS_TABLE: a region groups many customers into one
 * rough locality, a customer mapping is the single most precise thing Phoenix can resolve. */
export const CRM_CUSTOMER_BRICK_RESOLUTIONS_TABLE = "ireports360_crm_customer_brick_resolutions";

/** Each agent's ASSIGNED contact list (PM / AM / Pharmacy), one row per (agent, contact, list).
 * The only table here NOT built from activity: it is scraped from the CRM's web app, because the
 * Reporting API has no contacts endpoint, and it is therefore the only place in Phoenix a doctor
 * who has never been planned or visited exists. See src/lib/crm/contacts-web-client.ts. */
export const CRM_CONTACTS_TABLE = "ireports360_contacts";

/** Synced PLAN entries — the rep's assigned doctor list (one row per planned call, keyed on
 * `crm_plan_entry_id`). The counterpart to CRM_VISITS_TABLE: that table holds what a rep DID,
 * this one holds what they were assigned. Deliberately NOT named after Phoenix's own
 * `weekly-planning` module, which is an unrelated in-app feature with a confusingly similar name. */
export const CRM_PLAN_ENTRIES_TABLE = "ireports360_plan_entries";

/** The one CRM cutover setting (a single row): the first day Phoenix's own visits and plans are the
 * record, and whether the vendor pulls have been stood down. See src/lib/crm/cutover.ts. */
export const CRM_CUTOVER_TABLE = "crm_cutover";

/** What the read door serves for VISITS: ireports360_visits before the cutover date, native visits on
 * and after it. Identical to CRM_VISITS_TABLE's rows while no date is set. Carries `exclusion_crm_id`
 * for the resigned-agent filter, because a native rep with no CRM id has a null agent_crm_id and
 * `null not in (…)` would drop him from every read. */
export const CRM_VISITS_UNIFIED_VIEW = "crm_visits_unified";

/** CHECK-INS on the same date split; a native visit with a captured GPS fix is its own check-in. */
export const CRM_CHECKINS_UNIFIED_VIEW = "crm_checkins_unified";

/** PLAN ENTRIES on the same date split; native ids are negative so they never meet a vendor id. The
 * plan VERIFICATION write path stays on CRM_PLAN_ENTRIES_TABLE — it writes back to the vendor. */
export const CRM_PLAN_ENTRIES_UNIFIED_VIEW = "crm_plan_entries_unified";

/** CRM_VISITS_UNIFIED_VIEW plus `has_checkin` and `regular_no_checkin`. A FLAG, never a recount: a
 * regular visit with no GPS check-in stays regular (owner decisions 1 and 7, 13 Sep). Replaces
 * `ireports360_visits_effective`, which reclassified such a visit as campaign. */
export const CRM_VISITS_CHECKIN_FLAGS_VIEW = "crm_visits_checkin_flags";

/** Phoenix's own CONTACT MASTER — one row per CRM contact, keyed on the CRM contact id, built from
 * the three read-only mirrors above. Unlike CRM_CONTACTS_TABLE it never forgets a contact. See
 * src/lib/crm/contact-master.ts. */
export const CRM_CONTACT_MASTER_TABLE = "crm_contacts";

/** Dated list membership: one row per (contact, agent, list, rep, grade) PERIOD; `effective_to` is
 * null while the contact is on that list today. The history CRM_CONTACTS_TABLE cannot keep. */
export const CRM_CONTACT_ASSIGNMENTS_TABLE = "crm_contact_assignments";

/** The SQL function that rebuilds both master tables from the mirrors. */
export const CRM_CONTACT_MASTER_REFRESH_RPC = "crm_contact_master_refresh";

/** A fingerprint of every input that refresh reads, plus the Cairo date — the housekeeping timer skips a
 * refresh whose stamp matches its last successful one (src/lib/crm/housekeeping-scheduler.ts). */
export const CRM_CONTACT_MASTER_INPUTS_STAMP_RPC = "crm_contact_master_inputs_stamp";
