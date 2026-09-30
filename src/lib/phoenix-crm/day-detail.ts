import { emptyVisitCountSplit, type VisitCountSplit } from "@/lib/crm/visit-count-buckets";
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
   */
  firstCapturedAt: string;
};

export type DayDetailCounts = {
  counts: VisitCountSplit;
  /** Each pharmacy once, whatever the spelling, with where it came from. */
  pharmacies: DayDetailPharmacy[];
};

/** AM and PM from the list type; pharmacies grouped by name, never counted inside either. */
export function dayDetailCounts(visits: readonly DayDetailVisit[]): DayDetailCounts {
  const counts = emptyVisitCountSplit();
  const asToday: TodayVisit[] = visits.map((visit) => ({
    customerId: visit.customerId,
    doneAt: visit.capturedAt,
    listType: visit.listType === "AM" ? "AM" : "PM",
    name: visit.customerName,
    pharmacyName: visit.pharmacyName ?? null,
  }));
  for (const visit of asToday) {
    if (visit.listType === "AM") counts.am += 1;
    else counts.pm += 1;
  }
  const pharmacies = todayPharmacies(asToday).map((entry) => ({
    firstCapturedAt: entry.firstAt,
    fromCustomers: entry.fromCustomers,
    name: entry.name,
  }));
  counts.pharmacies = pharmacies.length;
  return { counts, pharmacies };
}
