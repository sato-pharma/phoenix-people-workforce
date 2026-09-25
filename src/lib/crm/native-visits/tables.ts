/**
 * Table names for native (Phoenix-entered) visits.
 *
 * The pilot's own visit, plan and roster tables are retired (2026-09-25, once nothing read or wrote
 * them any more) — crm_native_visit_pilots stays in the database, unread, as pilot history, exactly
 * as the pilot's own original migration intended, but nothing in the app names it any more either.
 *
 * Kept apart from src/lib/crm/tables.ts on purpose: that file names the read-only vendor mirror, and
 * this one is for what Phoenix itself writes.
 */

// Working on an approved vacation day (phase 6, rule 9).
export const CRM_NATIVE_VISIT_VACATION_DAY_REQUESTS_TABLE = "crm_native_visit_vacation_day_requests";
export const CRM_NATIVE_VISIT_VACATION_DAY_REQUEST_EVENTS_TABLE = "crm_native_visit_vacation_day_request_events";
