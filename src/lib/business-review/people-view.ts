// Business Review — WHICH PEOPLE a view holds. One answer for the portal page and for the pack.
//
// Owner, 2026-10-20: "many modules all over Phoenix show only reports on reps, and when you filter by
// manager you find no manager." Here that was literal. The page and the pack kept a person only when
// the district seat of his OWN field visits was among the kept seats — and a manager who rides with
// his reps and logs no visit of his own has no such seat. So the National Sales Managers, the
// Regional Manager, the Product and Group Product Managers, the SFE Manager and any District Manager
// who logged rides but no visits vanished from "Double visits — led, by manager" and "Activity by
// role", in company and line packs as much as in a district's. The admin screen was right all along:
// it shows each scope's people list whole.
//
//   company           the company's own list — one row per person, across every line.
//   line              that line's list, whole. It already holds only the people the month's own
//                     attribution places on the line, riders included (sources/roles.ts).
//   district, region  the people whose own work stood in a kept seat, AND the managers who rode
//                     with a rep standing in one.
//   chosen areas      the same, by area.
//   a medical rep     himself, and nobody else.
//
// 🔴 A MANAGER FOUND ONLY THROUGH HIS RIDES CARRIES ONLY THOSE RIDES. His own visits, customers,
// outstation and marketing stood somewhere else, and his whole line's "Rides led" and "Reps ridden
// with" printed inside one district's pack would read as that district's — a National Sales Manager
// "riding with 45 reps" in a district of six. So his row is cut to the rides he gave there, and it
// carries no customers: the visit feed holds a ride's customers per manager per month, never per rep,
// so there is no honest way to cut them to a district, and no figure is better than his whole line's
// printed as the district's. When everything he did lies inside the view, the row stands whole.
//
// THE SAME MANAGER ACROSS LINES IS ONE ROW. A view spanning several lines reads each line's list, and
// the SFE Manager or a Training Manager rides on all three — so the rows a view found him through
// rides are folded into one: rides and reps added (a rep stands on one line in a month, so the reps
// of two lines are two sets of people), and no customers, because two lines' customer counts cannot
// be unioned. Two rows each holding a line's OWN work stay two, as they always have.

import { emptyVisitCountSplit } from "@/lib/crm/visit-count-buckets";

import type { ReviewLine } from "./canonical";
import type { ReviewPortalScope } from "./portal-scope";
import type { ResolvedReviewFilter } from "./scope-filter";
import type { ReviewPersonRow, ReviewRideTally } from "./sources/roles";

/** Which cut of ONE list a view takes. */
export type ReviewPeopleView =
  | { kind: "all" }
  | { kind: "rep"; hrId: string }
  | { kind: "seats"; seatIds: ReadonlySet<string> }
  | { kind: "areas"; areaCodes: ReadonlySet<string> };

/** One line's people list and the cut the view takes of it. */
export type ReviewPeopleList = { people: readonly ReviewPersonRow[]; view: ReviewPeopleView };

/** The parts of a resolved filter this module reads. */
export type ReviewPeopleFilter = Pick<ResolvedReviewFilter, "applied" | "dmSeatIds" | "level" | "lines" | "territories">;

/**
 * The people a resolved filter holds — what the pack route and the narrowed page both render.
 *
 * `peopleByLine` is each line's own list (`ReviewDataset.people`); `companyPeople` the company's
 * (`ReviewCompany.people`), read only when nothing narrowed a company scope.
 */
export function peopleForReviewFilter(input: {
  scope: ReviewPortalScope;
  filter: ReviewPeopleFilter;
  peopleByLine: Partial<Record<ReviewLine, readonly ReviewPersonRow[]>>;
  companyPeople: readonly ReviewPersonRow[];
}): ReviewPersonRow[] {
  const { scope, filter } = input;
  // The whole company, unnarrowed: its own list is already one row per person across the lines —
  // stitching the three line lists together would print a cross-line rider once per line.
  if (scope.kind === "company" && filter.level === "company") return [...input.companyPeople];
  return peopleInReviewView(
    filter.lines.map((line) => ({
      people: input.peopleByLine[line] ?? [],
      view: reviewPeopleView({ filter, line, scope }),
    })),
  );
}

/** The cut a resolved filter takes of one line's list. */
export function reviewPeopleView(input: {
  scope: ReviewPortalScope;
  filter: ReviewPeopleFilter;
  line: ReviewLine;
}): ReviewPeopleView {
  const { scope, filter, line } = input;
  if (scope.kind === "rep") return { hrId: scope.hrId, kind: "rep" };
  if (filter.level === "company" || filter.level === "line") return { kind: "all" };
  if (filter.applied.areaCodes.length > 0) {
    // AREAS were chosen, so a colleague in the same district but another area is not in this view.
    // Keying on the seat would widen the people back out to the whole district while every sales
    // figure showed the chosen areas.
    return {
      areaCodes: new Set(
        filter.territories
          .filter((territory) => territory.line === line && territory.areaCode != null)
          .map((territory) => territory.areaCode as string),
      ),
      kind: "areas",
    };
  }
  return { kind: "seats", seatIds: new Set(filter.dmSeatIds) };
}

/** Every list cut to its view, a manager found through rides on several lines folded into one row. */
export function peopleInReviewView(lists: readonly ReviewPeopleList[]): ReviewPersonRow[] {
  const out: ReviewPersonRow[] = [];
  const at = new Map<string, { index: number; byRides: boolean }>();
  for (const { people, view } of lists) {
    for (const person of people) {
      const found = cutToView(person, view);
      if (!found) continue;
      const key = person.hrId.trim().toUpperCase();
      const seen = at.get(key);
      if (!seen) {
        at.set(key, { byRides: found.byRides, index: out.length });
        out.push(found.row);
        continue;
      }
      const held = out[seen.index];
      if (found.byRides && seen.byRides) {
        // Rides on two lines: added, and no customers — two lines' customer counts cannot be unioned.
        out[seen.index] = ridesOnly(held, held.ridesLed + found.row.ridesLed, held.repsCoached + found.row.repsCoached);
      } else if (found.byRides) {
        out[seen.index] = withRides(held, found.row);
      } else if (seen.byRides) {
        out[seen.index] = withRides(found.row, held);
        seen.byRides = false;
      } else {
        // Two lines' OWN work. Their customers are unions, so they stay two rows, as they always have.
        out.push(found.row);
      }
    }
  }
  return out;
}

/**
 * This person's row as the view holds him, or null when it does not hold him at all. `byRides` says
 * the view found him through the rides he gave there, not through work of his own.
 */
function cutToView(
  person: ReviewPersonRow,
  view: ReviewPeopleView,
): { row: ReviewPersonRow; byRides: boolean } | null {
  switch (view.kind) {
    case "all":
      return { byRides: false, row: person };
    case "rep":
      return person.hrId.toUpperCase() === view.hrId ? { byRides: false, row: person } : null;
    case "seats":
      return cutByPlace(person, person.dmSeatId, person.ridesBySeat, view.seatIds);
    case "areas":
      return cutByPlace(person, person.areaCode, person.ridesByArea, view.areaCodes);
  }
}

function cutByPlace(
  person: ReviewPersonRow,
  ownPlace: string | null,
  ridesByPlace: Record<string, ReviewRideTally> | undefined,
  kept: ReadonlySet<string>,
): { row: ReviewPersonRow; byRides: boolean } | null {
  // His own work stood here: the whole row, exactly as before.
  if (ownPlace != null && kept.has(ownPlace)) return { byRides: false, row: person };

  let rides = 0;
  let reps = 0;
  for (const [place, tally] of Object.entries(ridesByPlace ?? {})) {
    if (!kept.has(place) || tally.rides <= 0) continue;
    rides += tally.rides;
    reps += tally.reps;
  }
  if (rides === 0) return null;

  // Nothing he did lies outside the view — no work of his own anywhere, and every ride he led was
  // to somebody standing here — so the whole row is this view's, customers and all.
  const ownWork =
    ownPlace != null || person.fieldVisits > 0 || person.outstationClaimed !== 0 || person.marketingRequests > 0;
  if (!ownWork && rides === person.ridesLed) return { byRides: true, row: person };

  // A rep counted in two seats moved between them inside the window; never more than his total.
  return { byRides: true, row: ridesOnly(person, rides, Math.min(reps, person.repsCoached)) };
}

/**
 * His row holding these rides and nothing of his own — no visits, customers, outstation or marketing.
 *
 * Nor his ride tallies by seat and area: they name every district and area he rode in, other
 * districts' seats among them, and a District Manager's page or pack must not print where his
 * National Sales Manager rode elsewhere (risk review, 2026-10-20). They exist only to make this cut,
 * and the cut figures are already in `ridesLed` and `repsCoached`.
 */
function ridesOnly(person: ReviewPersonRow, rides: number, reps: number): ReviewPersonRow {
  return {
    ...person,
    ridesByArea: undefined,
    ridesBySeat: undefined,
    avgPerActiveMonth: 0,
    campaignVisits: 0,
    customerVisitSplit: emptyVisitCountSplit(),
    customers: 0,
    customersAm: 0,
    customersByMonth: Object.fromEntries(Object.keys(person.customersByMonth).map((month) => [month, 0])),
    customersPharmacy: 0,
    customersPm: 0,
    fieldVisits: 0,
    marketingRequests: 0,
    outstationClaimed: 0,
    regularVisits: 0,
    repsCoached: reps,
    ridesLed: rides,
    visitSplit: emptyVisitCountSplit(),
  };
}

/** `row` with the rides another line's row found him through added on. */
function withRides(row: ReviewPersonRow, rider: ReviewPersonRow): ReviewPersonRow {
  return { ...row, repsCoached: row.repsCoached + rider.repsCoached, ridesLed: row.ridesLed + rider.ridesLed };
}
