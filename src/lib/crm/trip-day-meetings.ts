/**
 * A MEETING DAY IS A WORKED TRIP DAY — never "no field activity".
 *
 * Owner, 2026-11-07, on Weaam Gweed's 5 Oct 2026 trip to the Sheraton head office, whose only CRM
 * entry was a Meeting: "since meeting not field work do not flag as no field work, and especially
 * that the meeting and expense in Sheraton in head office". The trip had been stamped "no activity"
 * at its departure photo, before the meeting was saved, and the approver read "she did nothing" on
 * a day she spent in a meeting.
 *
 * So a recorded meeting accounts for its day. It is NOT a visit: it adds nothing to AM · PM ·
 * Pharmacies (the golden rule), to Regular or to Campaign, and no count of visits ever includes it.
 * It only stops the day reading as idle — in the live trip read, the stamp taken at the departure
 * photo, the morning re-read, the review screen and the idle-day deduction offered there.
 *
 * The meeting codes are the vendor's Meeting (-11), its undocumented twin (-19, owner ruling
 * 2026-09-21: the same activity) and Group Meeting (-2, which Phoenix CRM also serves a recorded
 * group meeting under). Other working codes (training, conference, admin work…) are deliberately
 * NOT widened into this: the owner's word was meetings.
 *
 * Pure, so the client review screen and the server reads share the one rule.
 */

import { MEETING_TYPE, VENDOR_MEETING_TYPE } from "@/lib/crm/visit-types";

/** Group Meeting — the vendor's own code, kept as its own activity in the visit-type filter. */
export const GROUP_MEETING_VISIT_TYPE = -2;

export const TRIP_DAY_MEETING_VISIT_TYPES: ReadonlySet<number> = new Set<number>([
  VENDOR_MEETING_TYPE,
  MEETING_TYPE,
  GROUP_MEETING_VISIT_TYPE,
]);

export function isMeetingVisitType(visitType: number | null | undefined): boolean {
  return typeof visitType === "number" && TRIP_DAY_MEETING_VISIT_TYPES.has(visitType);
}

/** A trip day is worked when it holds a field visit OR a recorded meeting. */
export function isWorkedTripDay(day: { meetings?: number | null; total: number }): boolean {
  return day.total > 0 || Number(day.meetings ?? 0) > 0;
}

/** The trip's verdict from its days — one definition for every reader. */
export function tripWorkloadMatch(days: ReadonlyArray<{ date: string; meetings?: number | null; total: number }>): {
  idleDates: string[];
  matchStatus: "matched" | "no_activity" | "partial";
  matchedDates: string[];
} {
  const matchedDates = days.filter(isWorkedTripDay).map((day) => day.date);
  const idleDates = days.filter((day) => !isWorkedTripDay(day)).map((day) => day.date);
  const matchStatus = matchedDates.length === 0 ? "no_activity" : idleDates.length > 0 ? "partial" : "matched";
  return { idleDates, matchStatus, matchedDates };
}
