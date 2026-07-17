// One-time "fresh start" for probation emails (owner directive, 2026-07-17).
//
// When probation email was re-enabled after the medical-representatives-only scope fix, the owner
// required a CLEAN START — no catch-up / backfill emails. At that moment the module held 62 historical
// open Double-Visit days and several already-crossed Day-30/60/75 milestones; without this guard the
// first sweep would have blasted a wave of reminder/milestone emails for that history.
//
// Every probation email sweep (SLA reminders, milestone emails, weekly digest) ignores probation
// activity that predates this instant. Only Double-Visit days captured from here forward, and
// milestones crossed from here forward, ever notify. Dedup (notification_deliveries.idempotency_key)
// already stops re-sending anything sent before the pause; this guard additionally stops the NEW
// state-transition / never-sent reminders for pre-reset activity — which dedup would not have caught.
//
// This is a one-time reset marker: as the current cohort completes its 90 days and churns, the cutoff
// becomes moot. It is intentionally a constant (not config) so the reset instant is auditable in git.
export const PROBATION_EMAIL_FRESH_START_ISO = "2026-07-17T13:00:00Z";

const FRESH_START_MS = new Date(PROBATION_EMAIL_FRESH_START_ISO).getTime();

/** True if a timestamp (e.g. a DV-day's createdAt) is before the fresh-start cutoff → do not email. */
export function isBeforeProbationEmailFreshStart(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && t < FRESH_START_MS;
}

/** True if a calendar date (YYYY-MM-DD, e.g. a milestone-crossing date) is before the fresh-start day. */
export function isDateBeforeProbationEmailFreshStart(date: string | null | undefined): boolean {
  if (!date) return false;
  // Compare date-only against the cutoff's calendar date (both interpreted at UTC midnight).
  return date < PROBATION_EMAIL_FRESH_START_ISO.slice(0, 10);
}
