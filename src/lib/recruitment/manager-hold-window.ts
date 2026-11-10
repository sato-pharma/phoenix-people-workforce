// Recruitment / ATS — how long a CV may stay in a manager's account: 45 days, then it goes back.
//
// The owner, 2026-10-06: *"collect all old CVs from the manager's accounts and make it stay in their
// account maximum 45 days. Then collect it back to the admin. Never a CV stay at a district manager
// account or any manager account more than 45 days."*
//
// ── ONE NUMBER, ONE COMPARISON, EVERY ROUTE ─────────────────────────────────────────────────────
//
// A CV reaches a manager three ways, and each has its own clock because each has its own moment of
// arrival:
//
//   • PUSHED — a recruiter sent it. The clock is `sent_at` on the send row, or `manager_notified_at`
//     on the candidate for the pre-2026-08-30 single-manager stamp. A CV the recruiter sends AGAIN
//     moves that row, so a re-send is a fresh 45 days — which is how an admin hands a CV back out.
//   • IN A DISTRICT FOLDER — derived from the area the applicant named or the place their CV
//     mentions. Nothing is stored, so the only honest clock is the day the CV ARRIVED (`created_at`),
//     or the day the applicant last said where they want to work (`preferences_declared_at`) when
//     that is later, because an applicant who comes back and updates their answer has re-applied.
//   • ON A REQUISITION HE OWNS — a hiring process, not an inbox. NOT governed here: an interview
//     already scheduled must not vanish on day 45.
//
// THE WINDOW IS READ, NEVER STORED. Every list a manager can open and every gate that lets him open
// a CV asks `isWithinManagerHold` at the moment he asks, so a CV is gone from his account the second
// its 45 days end — not whenever a nightly job next runs. The daily job (manager-hold-return.ts)
// does only the part a read cannot: it takes the CV's status back off "sent to manager" so the
// recruitment desk can act on it, and tells the desk what came back.
//
// FAILS CLOSED. A date that is missing or unreadable is NOT within the window: "never more than 45
// days" cannot be promised about a CV whose age is unknown, and the recruitment desk always has it.
//
// PURE — no database, no React. The portal imports `MANAGER_HOLD_DAYS` for the sentence it shows a
// manager, and a database import anywhere in this chain would drag the service-role client into the
// browser bundle (the reason stale-send-thresholds.ts was split out of stale-send-check.ts).

/** How many days a CV may sit in one manager's account. The owner's number, 2026-10-06. */
export const MANAGER_HOLD_DAYS = 45;

const DAY_MS = 86_400_000;

/** The oldest instant that is still inside the window — anything earlier has expired. */
export function managerHoldCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - MANAGER_HOLD_DAYS * DAY_MS);
}

/**
 * The same cutoff as an ISO string, for a database filter.
 *
 * Every query that applies the window does so as `column >= this`, and `isWithinManagerHold` below
 * compares with the same `>=` — so a row the database keeps and a row this function keeps are the
 * same row, to the millisecond. Two comparisons that disagree at the boundary would let a CV show on
 * one screen and be refused on the next.
 */
export function managerHoldCutoffIso(now: Date = new Date()): string {
  return managerHoldCutoff(now).toISOString();
}

/** Is a CV that reached this manager at `since` still inside his 45 days? Unreadable answers false. */
export function isWithinManagerHold(since: string | null | undefined, now: Date = new Date()): boolean {
  const at = Date.parse(String(since ?? ""));
  if (!Number.isFinite(at)) return false;
  return at >= managerHoldCutoff(now).getTime();
}

/** The instant a CV that reached a manager at `since` has to leave his account, or null if unreadable. */
export function managerHoldExpiresAt(since: string | null | undefined): string | null {
  const at = Date.parse(String(since ?? ""));
  if (!Number.isFinite(at)) return null;
  return new Date(at + MANAGER_HOLD_DAYS * DAY_MS).toISOString();
}

/**
 * Whole days a CV that reached a manager at `since` has left in his account, rounded UP — so the last
 * day reads "1 day", never "0 days" while it is still there. 0 once the window has closed; null when
 * the date is unreadable (the window fails closed, and no countdown is invented for it).
 */
export function managerHoldDaysLeft(since: string | null | undefined, now: Date = new Date()): number | null {
  const expires = Date.parse(String(managerHoldExpiresAt(since) ?? ""));
  if (!Number.isFinite(expires)) return null;
  const remaining = expires - now.getTime();
  return remaining <= 0 ? 0 : Math.ceil(remaining / DAY_MS);
}

/** Whole days since `since`, floored — "held 45 days" must not be true at 45 days minus a minute. */
export function managerHoldDaysHeld(since: string | null | undefined, now: Date = new Date()): number {
  const at = Date.parse(String(since ?? ""));
  if (!Number.isFinite(at)) return 0;
  const elapsed = now.getTime() - at;
  return elapsed <= 0 ? 0 : Math.floor(elapsed / DAY_MS);
}

/** What a district folder reads off a candidate — structural, so a fixture need not be a whole one. */
export type FolderHoldCandidate = {
  createdAt?: string | null;
  preferencesDeclaredAt?: string | null;
};

/**
 * The moment a CV started counting against a district folder: the LATER of the day it arrived and
 * the day the applicant last declared where they want to work. Null when neither is readable.
 *
 * The later of the two, never the earlier: measured 2026-10-06, 105 live CVs were older than 45 days
 * and 6 of those had had their preferences re-declared inside the window — applicants who came back.
 * Counting from arrival alone would take a person who applied again yesterday out of the folder they
 * just asked to be in.
 */
export function folderHoldAnchor(candidate: FolderHoldCandidate): string | null {
  let best: { at: number; raw: string } | null = null;
  for (const raw of [candidate.createdAt, candidate.preferencesDeclaredAt]) {
    const text = String(raw ?? "").trim();
    const at = Date.parse(text);
    if (!Number.isFinite(at)) continue;
    if (!best || at > best.at) best = { at, raw: text };
  }
  return best ? best.raw : null;
}

/** Is this CV still inside the 45 days a district folder may hold it? */
export function isWithinFolderHold(candidate: FolderHoldCandidate, now: Date = new Date()): boolean {
  return isWithinManagerHold(folderHoldAnchor(candidate), now);
}
