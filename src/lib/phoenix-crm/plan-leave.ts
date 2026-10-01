/**
 * Phoenix CRM — a planned customer on a day HR approved the rep's leave.
 *
 * 🔴 OWNER, 2026-10-01: "fix missed visits on leave days in plan vs actual". A rep on approved leave
 * cannot keep a plan for a day he is away, yet every report that sets the plan against what happened
 * counted that day's planned customers as MISSED — plan against actual ("missed"), the daily plan
 * report ("Not visited") and the frequency report ("Missed 1"). A week of annual leave read as a week
 * of misses: a man accused of not working on the days HR gave him off.
 *
 * THE RULE, said once here and read by all three, so no screen can disagree with another:
 *   - planned, NOT visited, on a day HR approved his leave → ON LEAVE. Never missed, never "not
 *     visited", and out of every plan-kept figure: he could not have kept that plan.
 *   - planned and visited on that day → kept, exactly as on any other day. The visit happened.
 *
 * 🔴 LEAVE IS HR'S, NEVER INFERRED. It is approved requests of every type, read through the vacation
 * module (`server/leave-days.ts` → `loadApprovedLeaveDays`), and never derived from a gap in the
 * visits: a rep with no visit on a Tuesday is not on leave, and treating him as if he were would
 * excuse exactly the miss these reports exist to show.
 */

/** One territory on one Cairo calendar day — what a leave day is keyed by. */
export function leaveDayKey(seatId: string, day: string): string {
  return `${seatId}|${day}`;
}

/** The days HR approved leave for whoever holds each territory, as `leaveDayKey`s. */
export type LeaveDays = ReadonlySet<string>;

export const NO_LEAVE_DAYS: LeaveDays = new Set<string>();

export function isLeaveDay(leave: LeaveDays, seatId: string, day: string): boolean {
  return leave.has(leaveDayKey(seatId, day));
}

/** Of these days, the ones HR had this territory's rep on leave — for a report that reads one territory. */
export function leaveDatesFor(leave: LeaveDays, seatId: string, days: readonly string[]): Set<string> {
  return new Set(days.filter((day) => isLeaveDay(leave, seatId, day)));
}

/**
 * What a report says when HR's leave could not be read. Said, never a silent zero: without leave a
 * leave day's plan reads as misses again, which is the accusation the rule above exists to remove.
 */
export const LEAVE_UNREAD_NOTE =
  "HR's leave could not be read just now, so a customer planned on a leave day may show as missed. Reload in a minute.";
