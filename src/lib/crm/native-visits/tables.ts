/**
 * Table names for native (Phoenix-entered) visits — the pilot.
 *
 * Kept apart from src/lib/crm/tables.ts on purpose: that file names the read-only vendor mirror, and
 * tests/crm-native-visits.test.ts fails if any file outside src/lib/crm/native-visits/ references
 * these constants. Until the cutover no report, KPI, deduction, probation count or payroll input may
 * read a native row — the same visit also exists in the vendor feed, so reading both double-counts.
 */

export const CRM_NATIVE_VISIT_PILOTS_TABLE = "crm_native_visit_pilots";
export const CRM_NATIVE_VISITS_TABLE = "crm_native_visits";
export const CRM_NATIVE_VISIT_PARTNERS_TABLE = "crm_native_visit_partners";
export const CRM_NATIVE_VISIT_EVENTS_TABLE = "crm_native_visit_events";

// Native rep plans (phase 4). Same rule: nothing outside this folder names them before cutover.
export const CRM_NATIVE_PLANS_TABLE = "crm_native_plans";
export const CRM_NATIVE_PLAN_ITEMS_TABLE = "crm_native_plan_items";
export const CRM_NATIVE_PLAN_EVENTS_TABLE = "crm_native_plan_events";

// Working on an approved vacation day (phase 6, rule 9). Same rule.
export const CRM_NATIVE_VISIT_VACATION_DAY_REQUESTS_TABLE = "crm_native_visit_vacation_day_requests";
export const CRM_NATIVE_VISIT_VACATION_DAY_REQUEST_EVENTS_TABLE = "crm_native_visit_vacation_day_request_events";
