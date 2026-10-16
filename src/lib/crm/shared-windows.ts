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

/** Drops every shared CRM window copy, so the next dashboard read goes to the database. */
export function refreshSharedCrmWindows(reason: string): void {
  bumpSharedReadGeneration(CRM_VISIT_WINDOWS, reason);
  bumpSharedReadGeneration(CRM_CHECKIN_WINDOWS, reason);
}
