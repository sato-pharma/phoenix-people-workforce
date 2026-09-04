// Recruitment / ATS — which open seat each CV belongs to, and how many are waiting on each.
//
// WHY THIS EXISTS. A recruiter works one vacancy at a time: "screen the Office Coordinator pile",
// not "screen 555 people". The module had every part of that answer and no place that joined them
// up — `ats_applications` links a candidate to a requisition, but production carries 7 applications
// against 555 candidates, so a vacancy rail built on applications would report almost every open
// seat as having nobody.
//
// SO THE JOIN IS THE ONE THE MODULE ALREADY TRUSTS, not a second one invented here.
//
//   1. `sentFor.vacancyId` — the recruiter picked that seat when sending the CV. A stated fact.
//   2. `suggestPositions()` — the same function that pre-fills the send picker with "Looks like
//      this one". It filters by job family and ranks by place, and it deliberately returns NOTHING
//      rather than guessing between 39 medical-rep seats on a title alone.
//
// Reusing (2) is the whole point. The alternative was a second title-matching rule living here,
// which would mean the rail and the picker could disagree about which seat a CV is for — and the
// recruiter would have no way to tell which of the two was lying.
//
// A CANDIDATE CAN COUNT TOWARD SEVERAL SEATS, and that is honest rather than sloppy: a Nasr City
// medical rep whose address names the area matches both Nasr City seats, on two different lines,
// and telling them apart is a decision only a person makes. The counts are pile sizes, never a
// partition — the rail says "waiting on this seat", it never says "of 555, this many are here".
//
// A CANDIDATE MATCHING NOTHING IS NOT LOST. They are in "Everyone", which is always offered, and
// no vacancy filter is applied by default. A rail that silently hid the 300 people no open seat
// claims would be worse than no rail.
//
// PURE. The candidate list is a client component; a database import in this chain would drag the
// service-role client into the browser bundle.

import { suggestPositions, type SuggestionInput } from "@/lib/recruitment/position-suggestion";
import type { VacancyOption } from "@/lib/recruitment/vacancy-options";

/** Everything the attribution needs off one candidate. Structural, so a fixture is five fields. */
export type VacancyApplicantInput = SuggestionInput & {
  /** The seat the recruiter actually picked at send time, when they picked one. Outranks the read. */
  sentForVacancyId?: number | null;
};

/**
 * How many CVs are waiting on one seat, split the three ways the rail reports.
 *
 * `unreviewed` and `recommended` are the two figures a recruiter picks a vacancy on, and
 * `managerReview` is the one that says work has already left the desk. All three count the SAME
 * pile, so they overlap — a new field-force CV is both unreviewed and recommended.
 */
export type VacancyApplicantStats = {
  vacancyId: number;
  applicants: number;
  unreviewed: number;
  recommended: number;
  managerReview: number;
};

/** What the tally needs to know about each candidate's state, beyond who they are. */
export type VacancyApplicantState = {
  unreviewed: boolean;
  recommended: boolean;
  managerReview: boolean;
};

/**
 * The seats one CV is attributed to, best answer first.
 *
 * An explicit send is the ONLY answer when there is one: a recruiter who chose Nasr City · Pedia
 * has settled the question, and letting the place reader add two more seats underneath would put
 * the CV in piles nobody sent it to.
 */
export function vacanciesForCandidate(
  candidate: VacancyApplicantInput,
  vacancies: readonly VacancyOption[],
): number[] {
  const sentFor = candidate.sentForVacancyId;
  if (typeof sentFor === "number" && vacancies.some((vacancy) => vacancy.id === sentFor)) {
    return [sentFor];
  }
  return suggestPositions(candidate, vacancies).shortlist.map((entry) => entry.vacancy.id);
}

/**
 * Every seat, with the size of the pile waiting on it.
 *
 * Returns a row for EVERY open vacancy, including the ones nobody matches. A seat that vanishes
 * from the rail when its pile empties is a seat a recruiter cannot tell from a seat that was
 * filled — and "nobody has applied for this yet" is the most actionable thing the rail can say.
 */
export function tallyVacancyApplicants<T>(
  candidates: readonly T[],
  vacancies: readonly VacancyOption[],
  describe: (item: T) => VacancyApplicantInput & VacancyApplicantState,
): Map<number, VacancyApplicantStats> {
  const stats = new Map<number, VacancyApplicantStats>();
  for (const vacancy of vacancies) {
    stats.set(vacancy.id, {
      applicants: 0,
      managerReview: 0,
      recommended: 0,
      unreviewed: 0,
      vacancyId: vacancy.id,
    });
  }
  if (vacancies.length === 0) return stats;

  for (const item of candidates) {
    const described = describe(item);
    for (const vacancyId of vacanciesForCandidate(described, vacancies)) {
      const row = stats.get(vacancyId);
      if (!row) continue;
      row.applicants += 1;
      if (described.unreviewed) row.unreviewed += 1;
      if (described.recommended) row.recommended += 1;
      if (described.managerReview) row.managerReview += 1;
    }
  }
  return stats;
}

/**
 * "Nasr City · Pedia" — the words under a vacancy's job title on the rail.
 *
 * Never an ellipsis and never a code: the area and the line are what tell two seats with the same
 * title apart, and they are the whole reason the rail lists seats rather than job titles.
 */
export function vacancyPlaceLabel(vacancy: Pick<VacancyOption, "areaName" | "lineName" | "regionName">): string {
  return [vacancy.areaName, vacancy.lineName ?? vacancy.regionName].filter(Boolean).join(" · ");
}
