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

/**
 * The Reps List's company-wide sharing roster (`loadContactRoster`, src/lib/crm/reps-list.ts): every open
 * doctor-list assignment, read only to spot a doctor who also sits on another rep's list. It was the
 * heaviest read on the database on 25 Oct 2026 — 14 parallel pages per rep opened, about 168 full reads
 * in seven hours on the 2 GB box that kept restarting under working-day load.
 */
export const CRM_CONTACT_ROSTER = "crm:contact-roster";

/** Drops the shared roster copy — called by every app path that applies a doctor-list change. */
export function refreshSharedContactRoster(reason: string): void {
  bumpSharedReadGeneration(CRM_CONTACT_ROSTER, reason);
}
