/**
 * Phoenix CRM — Place checks: what the page sends when it opens, and what waits for the click (owner,
 * 2026-11-14, "Load lists on demand").
 *
 * 🔴 THE PAGE USED TO SEND 12.5 MB, AND BUILDING IT FROZE THE WHOLE SERVER. The 11 Nov 2026 stall alert
 * (1.08 s with no request answered, 11:34:44 Cairo) ended as one `GET /admin/field-crm/validation-reviews`
 * of 12.4 MB finished. 7.4 MB of it was the 5,807 places in use and 1.3 MB the decisions older than 14
 * days, and the board draws neither until he opens Not confirmed or picks a decider. Turning that into the
 * page's payload took React 273 to 314 ms in one block, and drawing it on the server another 107 to 438 ms,
 * while every other employee's request waited.
 *
 * So the page sends what Needs you draws: the places waiting, the buildings, the customers sent back, and
 * the places in use and the recent decisions that are SEATED in a building (a building's card shows
 * everybody in it). 🔴 THE DECISIONS OF SINGLE CLINICS WAIT FOR THE CLICK TOO (owner, 23 Nov 2026: "Fix
 * them"): 609 of the 991 decisions of the last 14 days were single clinics' that day, sent whole with every
 * open of the page and drawn only by History and "Approved by the system". Their two tab counts are counted
 * on the server (`history`, `bySystem`) and the rows come with the click, as the places in use do. Every figure the board shows on opening that is counted over the places in
 * use — the scorecard, the Not confirmed count, the filter lists — is counted on the server by the SAME
 * functions the board uses (`placeCheckOptions`, `placeCheckScorecardOf`, `unconfirmedOpenCount`), with
 * the filters empty, so the two can never disagree. The rest arrives from
 * `PLACE_CHECKS_EVERYTHING_ROUTE` on the first click that needs it: Not confirmed, any filter, a decider,
 * a tapped count, or the one-by-one review.
 *
 * 🔴 AND THE PAGE NO LONGER READS WHAT IT DOES NOT SEND (owner, 23 Nov 2026: "Fix speed next"). It still
 * read every place in use and every decision ever made, to count those figures, before it could draw the
 * first waiting place: 12.2 s to the first row on production, 9.75 s of it those two reads. Now the page
 * reads what it sends, and the board asks `PLACE_CHECKS_SUMMARY_ROUTE` for the figures once it is on
 * screen. That read is the wide one (`server/place-checks-wide-read.ts`): it counts the summary and leaves
 * its rows for the click, so the click still reads nothing again. Until it answers, a tab whose count
 * needs it shows no count — never one taken from the seated places alone.
 *
 * 🔴 NOR DOES THE PAGE READ THE DECISIONS IT DOES NOT SEND (owner, 23 Nov 2026: "Fix what is under 9.5"). It
 * read all 1,184 decisions of the last 14 days, kept the 404 seated in a building, and counted two cards of
 * the Figures tab from the rest. The page now asks the database for the seated decisions alone
 * (`loadValidationReviews`, `seatedDecisionsOnly`), and those two cards are counted by the wide read with
 * every other figure (`decisionFigures`).
 *
 * 🔴 AND OF THE BUILDINGS, ONLY THE ONES THAT NEED A DECISION (owner, 23 Nov 2026: "first list within 2
 * seconds"). The page sent all 433 buildings with every customer seated in them, decided or not — 2.5 MB of
 * its 3.6 MB document — when the lanes draw only the 10 held and the ones holding a waiting customer. It now
 * sends those buildings (`venuesSentWithPage`) and the customers seated in them; every other building, its
 * customers and the single clinics' sent-back customers come with the click (`sharedPlaces`, `reopened`),
 * and the Polyclinics tab is counted by the wide read (`buildings`) until they are in.
 * Pure and screen-free, so the server page and the client board both import it.
 */

import { decisionNoteIsAComment, placeNoteSubjectKey } from "@/lib/phoenix-crm/place-note-rules";
import { placeCheckScorecard, standingOfPlaceInUse, type PlaceStanding, type RepScore } from "@/lib/phoenix-crm/place-check-scorecard";
import { buildingsDrawnByDefault, narrowVenueGroups, seatedCustomersByVenue, withoutSeated } from "@/lib/phoenix-crm/shared-place-groups";
import {
  decidedByMatches,
  distinctValues,
  EMPTY_VALIDATION_REVIEW_FILTERS,
  matchesValidationReviewFilters,
  validatedPassesOutcome,
  withinValidationReviewPeriod,
  type ValidationReviewFilterable,
  type ValidationReviewFilters,
} from "@/lib/phoenix-crm/validation-review-filters";
import type { PlaceNoteIndex, ReopenedCustomerRow, SharedPlaceBoardRow, ValidatedPlaceRow, ValidationReviewRow } from "@/lib/phoenix-crm/view-types";

/** The read behind the click: every place in use, and every decision older than the 14-day window. */
export const PLACE_CHECKS_EVERYTHING_ROUTE = "/api/phoenix-crm/validation-reviews/everything";

/** The opening figures, counted over every place in use: asked for once the board is on screen. */
export const PLACE_CHECKS_SUMMARY_ROUTE = "/api/phoenix-crm/validation-reviews/summary";

export type PlaceChecksEverything = {
  validated: ValidatedPlaceRow[];
  /** Every building on the board, in the page's own order (`placeChecksBoardSets`); the page sends only `venuesSentWithPage`. */
  sharedPlaces: SharedPlaceBoardRow[];
  /** Every customer sent back; the page sends only the ones seated in a building it sends. */
  reopened: ReopenedCustomerRow[];
  /**
   * Every decision the page did not send: the ones outside the board's default window (`recent` false) and
   * the recent ones of single clinics. A row the page did send may be here too; `mergeDecided` keeps the page's.
   */
  olderDecided: ValidationReviewRow[];
  /**
   * The comments, recommendations and evidence on these rows. The page reads them for the rows it sends
   * and no others (23 Nov 2026), so a single clinic's come with its row; `mergedNoteIndex` makes the two one.
   */
  noteIndex: PlaceNoteIndex;
  /** Whether either of the two wide reads stopped at its ceiling, so the board says so. */
  capped: { reviews: boolean; validated: boolean };
  /** The Figures tab's two decision cards, counted from these rows by the read that made them. */
  decisionFigures: PlaceChecksDecisionFigures;
};

/** The Figures tab's "Approved, last 14 days" and "Rejected, last 14 days". */
export type PlaceChecksDecisionFigures = { approved: number; rejected: number };

/**
 * The real decisions made on or after `since` (milliseconds), by what was decided.
 *
 * 🔴 BY THE DAY IT WAS DECIDED, NEVER BY `recent`. A rejection that can still be taken back stays on the
 * board for 90 days and is `recent` all that time, so the card that counted `recent` rows read 733 under
 * "Rejected, last 14 days" on 23 Nov 2026 when 570 had been rejected in those 14 days.
 */
export function decisionFiguresSince(decided: ReadonlyArray<ValidationReviewRow>, since: number): PlaceChecksDecisionFigures {
  const inWindow = decided.filter((row) => isReal(row) && row.decidedAt !== null && Date.parse(row.decidedAt) >= since);
  return {
    approved: inWindow.filter((row) => row.status === "approved").length,
    rejected: inWindow.filter((row) => row.status === "rejected").length,
  };
}

/**
 * The page's notes and the click's as one index. A subject in both is the page's: the page is read again
 * after every decision, and the click's rows only once that re-read has asked for them.
 */
export function mergedNoteIndex(page: PlaceNoteIndex, click: PlaceNoteIndex | null): PlaceNoteIndex {
  if (!click) return page;
  return {
    notes: { ...click.notes, ...page.notes },
    recommendations: { ...click.recommendations, ...page.recommendations },
    integrity: { ...click.integrity, ...page.integrity },
  };
}

/**
 * The buildings the page sends on opening: the ones that need a decision — held, or holding a customer
 * whose review waits — which are exactly the buildings the lanes draw (`venueNeedsDecision`). A building
 * holding ANY waiting row is sent, retired or not, so no waiting customer is ever moved out from under his
 * building and counted among the clinics: what waits, and how it is counted, is what it was.
 */
export function venuesSentWithPage(sharedPlaces: ReadonlyArray<SharedPlaceBoardRow>, waiting: ReadonlyArray<ValidationReviewRow>): SharedPlaceBoardRow[] {
  const holdingWaiting = new Set(waiting.flatMap((row) => (row.sharedPlaceId === null ? [] : [row.sharedPlaceId])));
  return sharedPlaces.filter((venue) => venue.status === "held" || holdingWaiting.has(venue.sharedPlaceId));
}

/** The rows seated in one of these buildings — a building's card shows everybody in it, so they come with it. */
export function seatedInVenues<Row extends { sharedPlaceId: string | null }>(rows: ReadonlyArray<Row>, venues: ReadonlyArray<SharedPlaceBoardRow>): Row[] {
  const venueIds = new Set(venues.map((row) => row.sharedPlaceId));
  return rows.filter((row) => row.sharedPlaceId !== null && venueIds.has(row.sharedPlaceId));
}

/**
 * The decisions the page sends on opening: the recent ones of customers SEATED in a building it sends.
 * Every other decision waits for the click.
 */
export function decidedSentWithPage(recentDecided: ReadonlyArray<ValidationReviewRow>, sharedPlaces: ReadonlyArray<SharedPlaceBoardRow>): ValidationReviewRow[] {
  return seatedInVenues(recentDecided, sharedPlaces);
}

/**
 * The page's rows and the click's as one list: a row in both is the page's, which is read again after every
 * decision; the click's rows the page did not send follow, in the click's order. `pageSends` names the rows
 * the page ALWAYS sends (every held building): one of those the page no longer holds was decided since the
 * click, so the click's older copy is dropped rather than drawn as still held until the click is read again.
 */
export function pageRowsThenClick<Row>(
  page: ReadonlyArray<Row>,
  click: ReadonlyArray<Row> | null,
  keyOf: (row: Row) => string,
  pageSends: (row: Row) => boolean = () => false,
): Row[] {
  if (!click) return [...page];
  const seen = new Set(page.map(keyOf));
  return [...page, ...click.filter((row) => !seen.has(keyOf(row)) && !pageSends(row))];
}

/** The narrowing inside Not confirmed, each one a standing `standingOfPlaceInUse` gives a place. */
export type UnconfirmedChip = "open" | Exclude<PlaceStanding, "confirmed" | "waiting"> | "all";

export function chipTakes(chip: UnconfirmedChip, row: ValidatedPlaceRow): boolean {
  if (chip === "all") return true;
  if (row.reviewed) return false;
  const standing = standingOfPlaceInUse(row);
  return chip === "open" ? standing !== "confirmed" : standing === chip;
}

/** A row the shared filters can read, for a reopened customer who has no place on file any more. */
export function filterableReopened(row: ReopenedCustomerRow): ValidationReviewFilterable {
  return { ...row, speciality: null, placeLabel: null, address: null, brickName: null, areaName: null };
}

/** A test entry is never drawn on this board: it is nobody's real work and nobody decides on it. */
export function isReal(row: { isTest: boolean }): boolean {
  return !row.isTest;
}

export type PlaceCheckOptions = {
  reps: string[];
  lines: string[];
  regions: string[];
  areas: string[];
  lists: string[];
  /** Everybody who decided anything on the board; empty on a manager's board, which never names a decider. */
  deciders: string[];
};

/**
 * The filter bar's lists. `decided` is what the board shows (the recent window, or every decision while a
 * decider is chosen); `everyDecided` is every decision, which is what "Decided by" lists.
 */
export function placeCheckOptions(input: {
  team: boolean;
  pending: ReadonlyArray<ValidationReviewRow>;
  decided: ReadonlyArray<ValidationReviewRow>;
  everyDecided: ReadonlyArray<ValidationReviewRow>;
  validated: ReadonlyArray<ValidatedPlaceRow>;
  reopened: ReadonlyArray<ReopenedCustomerRow>;
  sharedPlaces: ReadonlyArray<SharedPlaceBoardRow>;
}): PlaceCheckOptions {
  const everyRow: ValidationReviewFilterable[] = [...input.pending, ...input.decided, ...input.validated];
  // A venue's own rep, line, region and area belong in the dropdowns too: a rep who has captured a
  // polyclinic and nothing else would otherwise be unreachable from the Rep box.
  return {
    reps: distinctValues([...everyRow.map((row) => row.repName), ...input.sharedPlaces.map((row) => row.repName)]),
    lines: distinctValues([...everyRow.map((row) => row.line), ...input.sharedPlaces.map((row) => row.line)]),
    regions: distinctValues([...everyRow.map((row) => row.region), ...input.sharedPlaces.map((row) => row.region)]),
    areas: distinctValues([...everyRow.map((row) => row.areaName), ...input.sharedPlaces.map((row) => row.areaName)]),
    lists: distinctValues(everyRow.map((row) => row.listType)),
    deciders: input.team
      ? []
      : distinctValues([
          ...input.everyDecided.map((row) => row.decidedByName),
          ...input.validated.map((row) => row.decidedByName),
          ...input.reopened.map((row) => row.refusedByName),
          ...input.sharedPlaces.map((row) => row.decidedByName),
        ]),
  };
}

/** The scorecard reads every rep's places through the same filters, the clinics and the seated alike. */
export function placeCheckScorecardOf(
  input: { pending: ReadonlyArray<ValidationReviewRow>; validated: ReadonlyArray<ValidatedPlaceRow>; reopened: ReadonlyArray<ReopenedCustomerRow> },
  filters: ValidationReviewFilters,
  cutoff: number | null,
): { reps: RepScore[]; total: RepScore } {
  return placeCheckScorecard({
    waiting: input.pending.filter(
      (row) => decidedByMatches(null, filters.decider) && matchesValidationReviewFilters(row, filters) && withinValidationReviewPeriod(row.createdAt, cutoff),
    ),
    inUse: input.validated.filter(
      (row) =>
        decidedByMatches(row.decidedByName, filters.decider) && matchesValidationReviewFilters(row, filters) && withinValidationReviewPeriod(row.validatedAt, cutoff),
    ),
    reopened: input.reopened.filter(
      (row) =>
        decidedByMatches(row.refusedByName, filters.decider) &&
        matchesValidationReviewFilters(filterableReopened(row), filters) &&
        withinValidationReviewPeriod(row.reopenedAt, cutoff),
    ),
  });
}

/** The single clinics in use that pass the filters — the rows of Not confirmed before its narrowing. */
export function clinicsInUse(clinicValidated: ReadonlyArray<ValidatedPlaceRow>, filters: ValidationReviewFilters, cutoff: number | null): ValidatedPlaceRow[] {
  return clinicValidated.filter(
    (row) =>
      validatedPassesOutcome(row, filters.outcome) &&
      decidedByMatches(row.decidedByName, filters.decider) &&
      matchesValidationReviewFilters(row, filters) &&
      withinValidationReviewPeriod(row.validatedAt, cutoff),
  );
}

/** The number on the Not confirmed tab. */
export function unconfirmedOpenCount(inUse: ReadonlyArray<ValidatedPlaceRow>, filters: ValidationReviewFilters): number {
  const showValidated = filters.outcome === "all" || filters.outcome === "validated" || filters.outcome === "unseen";
  return showValidated ? inUse.filter((row) => chipTakes("open", row)).length : 0;
}

/** What the board shows on opening that is counted over the places in use — counted once, on the server. */
export type PlaceChecksSummary = {
  options: PlaceCheckOptions;
  scorecard: { reps: RepScore[]; total: RepScore };
  unconfirmed: number;
  /** The number on the History tab: the single clinics' recent decisions and the customers sent back. */
  history: number;
  /** The number on "Approved by the system". Zero on a board with no lanes, whose History is whole. */
  bySystem: number;
  /** The number on "Polyclinics and hospitals": the buildings not rejected, as the board counts them with no filter. */
  buildings: number;
  /** The Figures tab's "Validated, in use": every real place still in use. */
  inUse: number;
  /** The Figures tab's "Never looked at": in use, and no review row of any status. */
  unseen: number;
  /** The Figures tab's two decision cards (`decisionFiguresSince`). */
  decisionFigures: PlaceChecksDecisionFigures;
  /** Whether a read these figures were counted from stopped at its ceiling. */
  capped: { reviews: boolean; validated: boolean };
};

/**
 * The opening figures, counted with the filters empty from every row the page read — exactly the board's
 * own counting, so the board opened on the summary and the board after the click show the same numbers.
 */
export function placeChecksSummary(input: {
  team: boolean;
  /** The Super Admin's board, which lists what the system approved apart from History. */
  lanes?: boolean;
  pending: ReadonlyArray<ValidationReviewRow>;
  decided: ReadonlyArray<ValidationReviewRow>;
  validated: ReadonlyArray<ValidatedPlaceRow>;
  reopened: ReadonlyArray<ReopenedCustomerRow>;
  sharedPlaces: ReadonlyArray<SharedPlaceBoardRow>;
  capped?: { reviews: boolean; validated: boolean };
  /** Where the two decision cards' 14 days begin, in milliseconds. Without one, every decision handed in counts. */
  decidedSince?: number;
}): PlaceChecksSummary {
  const filters = EMPTY_VALIDATION_REVIEW_FILTERS;
  const pending = input.pending.filter(isReal);
  const everyDecided = input.decided.filter(isReal);
  const decided = everyDecided.filter((row) => row.recent);
  const validated = input.validated.filter(isReal);
  const reopened = input.reopened.filter(isReal);
  const sharedPlaces = input.sharedPlaces.filter(isReal);
  const venueIds = new Set(sharedPlaces.map((row) => row.sharedPlaceId));
  // The two decided tabs as the board counts them with no filter: single clinics only, the system's apart.
  // A rejected building's customers stay in History, as the board lists them (`buildingsDrawnByDefault`).
  const drawnVenueIds = buildingsDrawnByDefault(sharedPlaces);
  const clinicDecided = withoutSeated(decided, drawnVenueIds);
  const bySystem = input.lanes ? clinicDecided.filter((row) => Boolean(row.approvedByRule)).length : 0;
  const seated = seatedCustomersByVenue({ pending, decided, validated, reopened, venueIds });
  const buildings = narrowVenueGroups({ venues: sharedPlaces, seated, filters, cutoff: null }).filter((group) => group.venue.status !== "retired").length;
  return {
    options: placeCheckOptions({ team: input.team, pending, decided, everyDecided, validated, reopened, sharedPlaces }),
    scorecard: placeCheckScorecardOf({ pending, validated, reopened }, filters, null),
    unconfirmed: unconfirmedOpenCount(clinicsInUse(withoutSeated(validated, venueIds), filters, null), filters),
    history: clinicDecided.length - bySystem + withoutSeated(reopened, drawnVenueIds).length,
    bySystem,
    buildings,
    inUse: validated.length,
    // Nobody has ever looked at these — no review row of any status (598 of the first 643, 2026-10-08).
    unseen: validated.filter((row) => !row.reviewed).length,
    decisionFigures: decisionFiguresSince(everyDecided, input.decidedSince ?? Number.NEGATIVE_INFINITY),
    capped: input.capped ?? { reviews: false, validated: false },
  };
}

/**
 * The places in use the page sends on opening: the ones seated in a building on the board, whose card shows
 * everybody in it. A test building's customers come too — the board drops test rows itself.
 */
export function seatedPlacesInUse(validated: ReadonlyArray<ValidatedPlaceRow>, sharedPlaces: ReadonlyArray<SharedPlaceBoardRow>): ValidatedPlaceRow[] {
  return seatedInVenues(validated, sharedPlaces);
}

/**
 * A comment written with a decision is on the row as a comment too (`tellDecisionComment`), so it is drawn
 * there, under "The rep can read this", and not a second time beside the decision.
 */
export function withoutDecisionNotesThatAreComments(rows: ReadonlyArray<ValidationReviewRow>, notes: PlaceNoteIndex["notes"]): ValidationReviewRow[] {
  return rows.map((row) =>
    decisionNoteIsAComment(row.decisionNote, notes[placeNoteSubjectKey("place", row.placeId)] ?? []) ? { ...row, decisionNote: null } : row,
  );
}

/**
 * The recent decisions the page sent and the older ones the click read, as ONE list in the read's own order
 * (newest first, then the id, as `loadValidationReviews` asks the database). A row in both — the page was
 * read again after the click — is the page's, which is the newer read.
 */
export function mergeDecided(recent: ReadonlyArray<ValidationReviewRow>, older: ReadonlyArray<ValidationReviewRow>): ValidationReviewRow[] {
  const seen = new Set(recent.map((row) => row.reviewId));
  const merged = [...recent, ...older.filter((row) => !seen.has(row.reviewId))];
  return merged.sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
    if (left.reviewId === right.reviewId) return 0;
    return left.reviewId < right.reviewId ? 1 : -1;
  });
}
