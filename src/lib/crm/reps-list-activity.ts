// ─────────────────────────────────────────────────────────────────────────────
// Reps List — what actually happened to each contact on the rep's list.
//
// PURE. It takes the doctor rows `rep-doctor-lists.ts` already produces and
// re-keys them by contact, so the Reps List board can print a status beside
// every name. There is no database import here on purpose: "this rep never
// visited this doctor" is an accusation, and it has to be verifiable without one.
//
// ## Why this module exists at all
//
// The statuses below are NOT new measures. `rep-doctor-lists.ts` has computed
// every one of them since the 2026-08-28 rebuild, and the KPIs board consumes
// them — but only as COUNTS (`missedDoctors: number`). The board that printed the
// names was retired with that rebuild and nothing replaced it, so a manager could
// read "68% coverage, 32 missed" and had no way anywhere in Phoenix to find out
// WHICH 32. Measured on production for August 2026: 2,865 of 9,542 assigned
// rep-contact pairs (30.0%) went the whole month without a visit, across 69 reps.
// This module is the join that turns that number back into names.
//
// ## The one status that is this board's own
//
// `rep-doctor-lists.ts` builds its rows from the PLAN and the VISITS. Reps List
// builds its rows from the CRM's own CONTACT LIST, which is a strict superset: a
// contact nobody planned and nobody visited has no doctor row at all, because
// neither half of that join ever mentions them. Those contacts are precisely the
// ones the owner asked to surface — assigned, and then nothing — so the absence
// of a row is a FINDING here, not missing data, and it is named `untouched`
// rather than being folded into `missed`.
//
// Keeping them apart matters for what a manager does next. `missed` is a doctor
// the rep planned and has not reached yet, which is a question for the rep.
// `untouched` is a doctor nobody even planned, which is usually a question about
// the plan. Collapsing the two would hide the second inside the first.
//
// Every other status is `RepDoctorFrequencyStatus` verbatim, re-exported rather
// than restated, so this board and the KPIs board can never disagree about what
// "behind plan" means.
// ─────────────────────────────────────────────────────────────────────────────

import type { RepDoctorFrequencyStatus, RepDoctorListDoctorRow } from "@/lib/crm/rep-doctor-lists";

/**
 * What happened to one contact in the window.
 *
 * The six inherited members are `RepDoctorFrequencyStatus`, unchanged. `untouched` is this board's
 * own — see the header on why it cannot come from the plan/visits join.
 */
export type RepsListActivityStatus = RepDoctorFrequencyStatus | "untouched";

export type RepsListActivity = {
  /** Type-0 visits to this contact inside the window, burst-duplicates already collapsed. */
  visits: number;
  /** Plan entries for this contact in the window. 0 means the contact was never planned. */
  plannedCalls: number;
  /**
   * Of `plannedCalls`, those falling on days that have already happened — the number `visits` is
   * actually compared against. Equals `plannedCalls` once the month is complete.
   */
  plannedCallsToDate: number;
  /** `visits - plannedCallsToDate`. Signed: negative is behind, positive is over, 0 is on plan. */
  delta: number;
  /** Last type-0 visit inside the window, or null when there was none. */
  lastVisitDate: string | null;
  status: RepsListActivityStatus;
};

/**
 * The status a contact carries when the plan/visits join produced no row for it.
 *
 * A frozen singleton rather than a fresh object per call: this is by far the commonest answer on the
 * board (30% of production rows in August 2026), and a caller that mutated a shared one would
 * corrupt every other row at once. Freezing makes that a throw instead of a silent corruption.
 */
export const UNTOUCHED_ACTIVITY: RepsListActivity = Object.freeze({
  delta: 0,
  lastVisitDate: null,
  plannedCalls: 0,
  plannedCallsToDate: 0,
  status: "untouched",
  visits: 0,
});

/**
 * contactCrmId -> that contact's activity.
 *
 * The caller must already have narrowed `doctors` to ONE rep. `rep-doctor-lists.ts` keys its rows by
 * (agent, contact), so across several reps the same contact id appears more than once and the last
 * one would silently win — a doctor shared between two reps would then be shown carrying the other
 * rep's visits. `loadRepsListActivity` passes the rep filter for exactly this reason; the assertion
 * below makes a caller that forgets it fail loudly rather than quietly mis-attribute.
 */
export function buildRepsListActivityIndex(
  doctors: readonly RepDoctorListDoctorRow[],
): Map<number, RepsListActivity> {
  const index = new Map<number, RepsListActivity>();
  for (const doctor of doctors) {
    if (index.has(doctor.contactCrmId)) {
      throw new Error(
        `buildRepsListActivityIndex: contact ${doctor.contactCrmId} appears twice — narrow the doctor rows to one rep first.`,
      );
    }
    index.set(doctor.contactCrmId, {
      delta: doctor.frequencyDelta,
      lastVisitDate: doctor.lastVisitDate,
      plannedCalls: doctor.plannedCalls,
      plannedCallsToDate: doctor.plannedCallsToDate,
      status: doctor.frequencyStatus,
      visits: doctor.visits,
    });
  }
  return index;
}

/**
 * One contact's activity, or the untouched default.
 *
 * `undefined` index means the activity could not be read at all — a plan mirror that is missing, or
 * a rep with no CRM account. That is NOT the same as "nothing happened", so it answers `null` and
 * the board says the column is unavailable rather than accusing 84 doctors of being ignored.
 */
export function activityForContact(
  index: ReadonlyMap<number, RepsListActivity> | null | undefined,
  contactCrmId: number,
): RepsListActivity | null {
  if (!index) return null;
  return index.get(contactCrmId) ?? UNTOUCHED_ACTIVITY;
}

/**
 * The word on the chip. Short enough for a 21% column; never an abbreviation or a code.
 *
 * BELOW / EXACT / ABOVE ARE THE OWNER'S OWN THREE WORDS, given verbatim on 2026-09-02 ("change vocab
 * to below exact above"). They are not a restyling: they are the vocabulary the frequency rule is
 * actually stated in — three calls asked for and three made is EXACT, and anything either side of
 * that is a deviation. `kpis-board-view.tsx` already heads its columns with the same three, so this
 * board now says what that one says. Do not "improve" them back into "On plan / Over plan / Behind
 * plan": those phrases quietly imply that one direction is a pass and the other a failure, which is
 * the exact reading the owner's rule refuses.
 *
 * The four statuses outside that triad keep their own words — they are not points on the same scale.
 */
export const ACTIVITY_LABEL: Record<RepsListActivityStatus, string> = {
  missed: "Missed",
  not_due: "Not due yet",
  off_plan: "Off plan",
  on_plan: "Exact",
  over: "Above",
  under: "Below",
  untouched: "No activity",
};

/**
 * The full sentence — the export column, and the chip's `title`.
 *
 * Spelled out rather than derived from the label, because a spreadsheet is read away from the board
 * and "Missed" alone does not say missed WHAT. An export must match the screen (owner's standing
 * rule); it does not have to be as terse as the screen.
 */
export const ACTIVITY_MEANING: Record<RepsListActivityStatus, string> = {
  missed: "On the plan and not visited yet",
  not_due: "On the plan, and every planned day is still ahead",
  off_plan: "Visited, but never on the plan",
  on_plan: "Visited exactly as many times as the plan asked for",
  over: "Visited more times than the plan asked for",
  under: "Visited, but fewer times than the plan asked for",
  untouched: "Not on the plan and not visited",
};

/**
 * Tailwind classes for the chip.
 *
 * EXACT IS THE ONLY GREEN. Over-visiting is a DEVIATION and not a win — the owner's ruling, and the
 * reason the retired Doctor Coverage board was wrong — so `over` ("Above") gets its own colour
 * rather than sharing either the green of an exact match or the amber of falling short.
 *
 * Violet is deliberately unused: this board already paints a whole row violet for a shared customer,
 * and a chip in the same hue would read as part of that signal.
 */
export const ACTIVITY_CLASS: Record<RepsListActivityStatus, string> = {
  missed: "bg-rose-50 text-rose-700 ring-rose-200",
  not_due: "bg-slate-50 text-slate-500 ring-slate-200",
  off_plan: "bg-slate-50 text-slate-600 ring-slate-300",
  on_plan: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  over: "bg-sky-50 text-sky-700 ring-sky-200",
  under: "bg-amber-50 text-amber-800 ring-amber-200",
  untouched: "bg-rose-50 text-rose-700 ring-rose-200",
};

/**
 * "2 of 3", or "2 visits" when nothing was planned.
 *
 * The denominator is `plannedCallsToDate`, NOT `plannedCalls`: mid-month, comparing a rep's work
 * against calls he is not yet due to make reads as failure on every row. Once the month is complete
 * the two are equal and the distinction disappears.
 *
 * Returns null when there is nothing to count on either side — an untouched contact's chip says
 * everything already, and "0 of 0" beside it would be noise.
 */
export function activityCountLabel(activity: RepsListActivity): string | null {
  if (activity.plannedCallsToDate > 0) return `${activity.visits} of ${activity.plannedCallsToDate}`;
  if (activity.visits > 0) return `${activity.visits} ${activity.visits === 1 ? "visit" : "visits"}`;
  return null;
}

/** Every status, in the order the filter offers them: the two that need action, then the rest. */
export const ACTIVITY_FILTER_ORDER: readonly RepsListActivityStatus[] = [
  "untouched",
  "missed",
  "under",
  "on_plan",
  "over",
  "off_plan",
  "not_due",
];

/**
 * The two statuses that mean "nobody has been here this month".
 *
 * Shared by the tile, the filter and the export so the board cannot count one population and offer
 * another. `not_due` is deliberately NOT in here: a doctor planned for next Tuesday has not been
 * neglected, and counting him as such would put a manager on the phone about nothing.
 */
export const UNVISITED_STATUSES: ReadonlySet<RepsListActivityStatus> = new Set<RepsListActivityStatus>([
  "untouched",
  "missed",
]);

/** How many of these contacts went unvisited in the window — the tile's number. */
export function countUnvisited(activities: readonly (RepsListActivity | null)[]): number {
  return activities.filter((activity) => activity != null && UNVISITED_STATUSES.has(activity.status)).length;
}
