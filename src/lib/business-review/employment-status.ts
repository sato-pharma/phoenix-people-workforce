// Business Review — what counts as a leaver.
//
// A resigned / terminated / exited occupant no longer holds their seat, so the review treats the seat
// as VACANT (owner, 2026-09-28: resigned reps must read vacant and be cleared by "Exclude vacant").
// One authority, deliberately pure and client-safe — imported by the seat builder and the area/DM
// vacancy check on the server AND by the people table in the browser, so the three can never drift.

/** True when an employment status means the person has left the company. */
export function isResignedStatus(status: string | null | undefined): boolean {
  return /resign|terminat|exit/i.test(status ?? "");
}
