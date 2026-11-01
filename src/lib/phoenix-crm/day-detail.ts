import { emptyVisitCountSplit, type VisitCountSplit } from "@/lib/crm/visit-count-buckets";
import { parseListType, pharmacyNameKey, visitCountBucketForListType } from "@/lib/phoenix-crm/pharmacy-call-rules";
import { todayPharmacies, type TodayVisit } from "@/lib/phoenix-crm/today-rules";

/**
 * Phoenix CRM — one person's ONE DAY, in full.
 *
 * Owner, 2026-09-30, of the team calendar: *"when I press on any day that have activity, I am
 * redirected to a new tab with the full detail of this day, with location, timing, everything."*
 * The calendar cell answers "which halves did he work"; this answers "what did he actually do".
 *
 * 🔴 THE THREE FIGURES ARE COUNTED THE WAY PHOENIX CRM COUNTS THEM, AND BY THE HELPERS THAT ALREADY
 * EXIST. AM and PM come from the customer's `list_type`, and a PHARMACY IS A DISTINCT NAME AND NOT A
 * ROW — a pharmacy here is feedback recorded ON a visit, so two visits naming the same pharmacy are
 * one pharmacy. `todayPharmacies` is that grouping, case-insensitive with the most recent spelling,
 * and it is reused rather than rewritten: a second copy is a second answer that will drift.
 *
 * 🔴 AND THE HEADLINE COUNTS ONLY WHAT COUNTS IN A KPI — THE SAME BASIS AS THE CALENDAR CELL THAT
 * OPENS THIS PAGE. It used to count every row it was handed, while `server/team-calendar.ts` counts
 * the rows `phoenix_crm_countable_visits` and `customer_validated` agree on. So a rep's Tuesday read
 * 3 on the grid and 5 on the page the grid links to, with nothing on either screen to say which was
 * right — and on a team that has just started the gap is EVERY visit, because none of the
 * carried-over customers is validated yet. `visitCountsInKpi` is the one predicate both sides now
 * stand on, and what is held back is REPORTED (`awaitingValidation`, `awaitingApproval`) rather than
 * quietly dropped: a visit waiting on somebody is work the rep really did.
 *
 * 🔴 AND THE THREE STAY APART (the AM · PM · Pharmacies golden rule). Nothing here adds them.
 */

/** Just enough of a visit to be counted and grouped. `VisitRow` satisfies it. */
export type DayDetailVisit = {
  customerId: string;
  customerName: string;
  listType: string;
  pharmacyName?: string | null;
  /** The server's own instant, unformatted — see `firstCapturedAt` for why it is not a clock here. */
  capturedAt: string;
  /**
   * Whether this visit is inside a KPI figure (`visitCountsInKpi`, read off the row). The headline
   * counts only these; the list below carries every visit with its own status.
   */
  countsInKpi: boolean;
  /** Whether its customer has been validated and admitted to the list. */
  customerValidated: boolean;
  /** Copied from the old system: `capturedAt` is a midnight nobody saw, so no pharmacy line reads it as a clock. */
  copiedFromOldSystem?: boolean;
  /** `visitIsArchiveHistory`: in no figure, and not waiting on anybody. */
  archiveHistory?: boolean;
};

export type DayDetailPharmacy = {
  name: string;
  /** The customers whose visits named it, in the order they were visited. */
  fromCustomers: string[];
  /**
   * The INSTANT of the first visit that named it — deliberately not a clock.
   *
   * `todayPharmacies` copies whatever it is given into its own `firstAt`, which that module
   * documents as an already-formatted Cairo clock because Today formats before it groups. This
   * page has the raw instants, so the field is renamed here to say what it really holds and the
   * screen formats it. Passing an instant under the name `firstAt` would have been a silent lie
   * that renders as a UTC timestamp on a screen whose every other time is Cairo.
   *
   * Empty for a pharmacy first named on a visit copied from the old system, which has no clock to give.
   */
  firstCapturedAt: string;
  /**
   * Whether a visit that COUNTS named it — so whether this pharmacy is inside the headline figure.
   * Every pharmacy is still listed: the feedback was really taken, and dropping it would hide work.
   */
  counted: boolean;
};

export type DayDetailCounts = {
  counts: VisitCountSplit;
  /** Each pharmacy once, whatever the spelling, with where it came from and whether it is counted. */
  pharmacies: DayDetailPharmacy[];
  /**
   * Visits saved on this day that are in NO figure because their customer is not validated yet. On a
   * team that has just started that is every visit it has — a flat 0 with nothing to explain it is
   * exactly what this number exists to prevent (`awaitingValidationNote` is the sentence).
   */
  awaitingValidation: number;
  /** Off-plan visits still waiting for the manager and then SFE: in no figure either, and not refused. */
  awaitingApproval: number;
  /** Copied history on a customer in the Archive: in no figure, and waiting for nobody (`archiveHistoryNote`). */
  archiveHistory: number;
};

function asToday(entries: readonly DayDetailVisit[]): TodayVisit[] {
  return entries.map((visit) => ({
    customerId: visit.customerId,
    doneAt: visit.copiedFromOldSystem ? "" : visit.capturedAt,
    listType: parseListType(visit.listType),
    name: visit.customerName,
    pharmacyName: visit.pharmacyName ?? null,
  }));
}

/** AM and PM from the list type; pharmacies grouped by name, never counted inside either. */
export function dayDetailCounts(visits: readonly DayDetailVisit[]): DayDetailCounts {
  const counts = emptyVisitCountSplit();

  let awaitingValidation = 0;
  let awaitingApproval = 0;
  let archiveHistory = 0;
  for (const visit of visits) {
    if (visit.countsInKpi) continue;
    // Why it is not counted, in the order the predicate asks: validation first, because a visit
    // whose customer is unvalidated is held back whatever its approval says. A copied visit to a
    // customer in the Archive is the one unvalidated visit that is waiting for nobody.
    if (visit.archiveHistory) archiveHistory += 1;
    else if (!visit.customerValidated) awaitingValidation += 1;
    else awaitingApproval += 1;
  }

  const counting = visits.filter((visit) => visit.countsInKpi);
  for (const visit of asToday(counting)) {
    // Through the golden rule's own helper, not an `=== "AM" ? am : pm` that files every third
    // list under the doctors. A pharmacy customer is a third list since 2026-10-02.
    const bucket = visitCountBucketForListType(visit.listType);
    if (bucket === "AM") counts.am += 1;
    else if (bucket === "PM") counts.pm += 1;
    else counts.pharmacies += 1;
  }

  // The LIST is every pharmacy named on the day; the FIGURE is the ones a counting visit named,
  // which is what the calendar cell counts. Two passes of the same grouping, never a second copy.
  const countedNames = new Set(todayPharmacies(asToday(counting)).map((entry) => pharmacyNameKey(entry.name)));
  const pharmacies = todayPharmacies(asToday(visits)).map((entry) => ({
    counted: countedNames.has(pharmacyNameKey(entry.name)),
    firstCapturedAt: entry.firstAt,
    fromCustomers: entry.fromCustomers,
    name: entry.name,
  }));
  counts.pharmacies = pharmacies.filter((entry) => entry.counted).length;
  return { archiveHistory, awaitingApproval, awaitingValidation, counts, pharmacies };
}
