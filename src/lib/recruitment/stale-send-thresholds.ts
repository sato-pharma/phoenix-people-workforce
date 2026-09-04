// Recruitment / ATS — how long a CV may sit with a manager, as two plain numbers.
//
// Split out of stale-send-check.ts on 2026-09-04 and NOTHING ELSE MOVED. That module reaches the
// service-role Supabase client and the notification pipeline, so the screening work-queue rail —
// which is a "use client" component and needs the same three-day threshold to say "overdue" —
// could not import the number without dragging the whole database client into the browser bundle.
// The same split screening-link.ts was carved out of screening-queue.ts for, for the same reason.
//
// Re-exported from stale-send-check.ts, so every existing importer keeps resolving it from where it
// always did and there is still exactly ONE copy of each number in the repository.

/**
 * How long a CV may sit with a manager before that manager is nudged, and how long before the
 * recruitment desk is told the manager is not answering.
 *
 * Three days rather than one: a manager who is travelling or in the field should not be chased for
 * a CV that arrived yesterday, and an alert that fires on ordinary behaviour is one people learn to
 * ignore. Seven rather than fourteen: intake runs at roughly 13 CVs a day, so a fortnight of
 * silence is long enough for a candidate to accept another offer.
 *
 * THREE DAYS IS THE OWNER'S OWN CALL, NOT A DEFAULT TO TUNE. He was asked directly on 2026-08-28 —
 * before the first run fired, with the four managers it would reach named — and answered "no keep
 * 3 days". Do not raise it because it looks aggressive for a manager in the field; that is the
 * exact objection he was shown and overruled. Raising it needs him to say so.
 */
export const STALE_SEND_NUDGE_AFTER_DAYS = 3;
export const STALE_SEND_ESCALATE_AFTER_DAYS = 7;
