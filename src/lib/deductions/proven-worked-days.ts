/**
 * EVERY SOURCE THAT PROVES A DAY WAS WORKED, IN ONE MAP — what the connectors actually consult.
 *
 * Owner, 2026-10-12: *"you must also check the phoenix crm before deciding a deduction check every
 * source throughout everywhere to confirm u give acurate data bec this is people money its a
 * deduction"*, then, the same session, *"check outstation trips as a deduction source too"*.
 *
 * Three sources answer here, for the same reason: each describes work the counting doors cannot see.
 *
 *   1. **Phoenix CRM** — `phoenix-worked-days.ts`. `crm_visits_unified` inner-joins its Phoenix
 *      branch to a STARTED team, so an unstarted team's real visits reach no reader.
 *      14 days / 7,193.54 EGP on production, October 2026.
 *   2. **Outstation trips** — `@/lib/outstation/trip-work-evidence`. Nothing in any deduction path
 *      read the trip tables at all, so a travel day with no doctor to visit and no office device to
 *      punch read as a day nobody worked. 62 chargeable days / 69,667.47 EGP, 1 Sep – 12 Oct 2026.
 *      His ruling on which states count: **any trip not rejected.**
 *   3. **A manager's own single visits** — `loadManagerOwnVisitDays`, through the manager-plan adapter.
 *      Since 2026-10-16 a district manager's own visit is written to a table of its own and no longer
 *      to `phoenix_crm_visits`, so source 1 cannot see it either: a manager who spent the day on his
 *      own single visits had no record anywhere a deduction reader looks. Measured on production
 *      2026-10-19 — two district managers, no CRM row, no punch, no vacation, no trip. Owner the same
 *      day, asked in so many words whether it should count on the calendar and in the deduction:
 *      **count it on both.**
 *
 * Accounts: `docs/deductions-phoenix-work-evidence.md`, `docs/deductions-outstation-trip-days.md`.
 *
 * 🔴 **THE ONE RULE BOTH SOURCES SHARE: THIS ONLY EVER REMOVES A DAY.** It is read where a connector
 * has already decided to charge, never where one decides whether a person has any signal at all.
 * Feeding `anySignal`, `hasAnySignalThisMonth` or `firstSignalByPerson` would drag somebody whose
 * only evidence all month is a trip or a Phoenix visit INTO the charge, by his own proof of work.
 *
 * FAILS CLOSED: every loader throws and nothing here catches. A silent "no evidence" is a charge.
 */

import {
  describeOutstationTripDay,
  loadOutstationTripDays,
  type OutstationTripDay,
} from "@/lib/outstation/trip-work-evidence.ts";
import {
  loadPhoenixWorkedDays,
  phoenixWorkedDayKey,
  phoenixWorkedDayReason,
  type PhoenixWorkedDays,
} from "@/lib/deductions/phoenix-worked-days.ts";
import {
  describeManagerOwnVisitDay,
  loadManagerOwnVisitDays,
  type ManagerOwnVisitDay,
} from "@/lib/phoenix-crm/server/manager-plan-readers.ts";

/**
 * The suppression map every connector reads.
 *
 * Structurally a `PhoenixWorkedDays` plus the trip reasons, so every call site that already asks
 * `.keys.has(...)` keeps working and `phoenixWorkedDayReason` keeps answering for a Phoenix day.
 */
export type ProvenWorkedDays = PhoenixWorkedDays & {
  /** `${compact}:${date}` -> the reason line, for days proved by something other than Phoenix CRM. */
  reasons: ReadonlyMap<string, string>;
};

/** Fold trip days and a manager's own single visits onto a Phoenix suppression map. Pure, so the merge order is pinned by a test. */
export function selectProvenWorkedDays(input: {
  phoenix: PhoenixWorkedDays;
  trips: readonly OutstationTripDay[];
  managerOwnVisits?: readonly ManagerOwnVisitDay[];
}): ProvenWorkedDays {
  const keys = new Set<string>(input.phoenix.keys);
  const reasons = new Map<string, string>();
  for (const trip of input.trips) {
    const key = phoenixWorkedDayKey(trip.hrId, trip.date);
    if (!key) continue;
    keys.add(key);
    // First writer wins: the fold already ranked an accepted trip above a pending one for the day.
    if (!reasons.has(key)) reasons.set(key, describeOutstationTripDay(trip));
  }
  // Last of the three, so a day a trip already explains keeps the trip's reason. The day is suppressed
  // either way — only the line a connector prints beside it is decided here.
  for (const day of input.managerOwnVisits ?? []) {
    const key = phoenixWorkedDayKey(day.hrId, day.date);
    if (!key) continue;
    keys.add(key);
    if (!reasons.has(key)) reasons.set(key, describeManagerOwnVisitDay(day));
  }
  return { evidence: input.phoenix.evidence, keys, reasons };
}

/** Every provably worked day in the window, from every source, keyed for the connectors. */
export async function loadProvenWorkedDays(input: { end: string; start: string }): Promise<ProvenWorkedDays> {
  const [phoenix, trips, managerOwnVisits] = await Promise.all([
    loadPhoenixWorkedDays(input),
    loadOutstationTripDays(input),
    loadManagerOwnVisitDays({ end: input.end, start: input.start }),
  ]);
  return selectProvenWorkedDays({ managerOwnVisits, phoenix, trips });
}

/** The reason line a suppressed day carries into a connector's evidence — Phoenix first, then trips. */
export function provenWorkedDayReason(worked: ProvenWorkedDays, key: string): string | null {
  return phoenixWorkedDayReason(worked, key) ?? worked.reasons.get(key) ?? null;
}
