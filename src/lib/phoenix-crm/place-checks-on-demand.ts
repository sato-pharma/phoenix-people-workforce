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
 * So the page sends what Needs you draws: the places waiting, the decisions of the last 14 days, the
 * buildings, the customers sent back, and the places in use that are SEATED in a building (a building's
 * card shows everybody in it). Every figure the board shows on opening that is counted over the places in
 * use — the scorecard, the Not confirmed count, the filter lists — is counted on the server by the SAME
 * functions the board uses (`placeCheckOptions`, `placeCheckScorecardOf`, `unconfirmedOpenCount`), with
 * the filters empty, so the two can never disagree. The rest arrives from
 * `PLACE_CHECKS_EVERYTHING_ROUTE` on the first click that needs it: Not confirmed, any filter, a decider,
 * a tapped count, or the one-by-one review.
 *
 * Pure and screen-free, so the server page and the client board both import it.
 */

import { decisionNoteIsAComment, placeNoteSubjectKey } from "@/lib/phoenix-crm/place-note-rules";
import { placeCheckScorecard, standingOfPlaceInUse, type PlaceStanding, type RepScore } from "@/lib/phoenix-crm/place-check-scorecard";
import { withoutSeated } from "@/lib/phoenix-crm/shared-place-groups";
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

export type PlaceChecksEverything = {
  validated: ValidatedPlaceRow[];
  /** Decisions outside the board's default window (`recent` false). The page already sent the recent ones. */
  olderDecided: ValidationReviewRow[];
};

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
};

/**
 * The opening figures, counted with the filters empty from every row the page read — exactly the board's
 * own counting, so the board opened on the summary and the board after the click show the same numbers.
 */
export function placeChecksSummary(input: {
  team: boolean;
  pending: ReadonlyArray<ValidationReviewRow>;
  decided: ReadonlyArray<ValidationReviewRow>;
  validated: ReadonlyArray<ValidatedPlaceRow>;
  reopened: ReadonlyArray<ReopenedCustomerRow>;
  sharedPlaces: ReadonlyArray<SharedPlaceBoardRow>;
}): PlaceChecksSummary {
  const filters = EMPTY_VALIDATION_REVIEW_FILTERS;
  const pending = input.pending.filter(isReal);
  const everyDecided = input.decided.filter(isReal);
  const decided = everyDecided.filter((row) => row.recent);
  const validated = input.validated.filter(isReal);
  const reopened = input.reopened.filter(isReal);
  const sharedPlaces = input.sharedPlaces.filter(isReal);
  const venueIds = new Set(sharedPlaces.map((row) => row.sharedPlaceId));
  return {
    options: placeCheckOptions({ team: input.team, pending, decided, everyDecided, validated, reopened, sharedPlaces }),
    scorecard: placeCheckScorecardOf({ pending, validated, reopened }, filters, null),
    unconfirmed: unconfirmedOpenCount(clinicsInUse(withoutSeated(validated, venueIds), filters, null), filters),
  };
}

/**
 * The places in use the page sends on opening: the ones seated in a building on the board, whose card shows
 * everybody in it. A test building's customers come too — the board drops test rows itself.
 */
export function seatedPlacesInUse(validated: ReadonlyArray<ValidatedPlaceRow>, sharedPlaces: ReadonlyArray<SharedPlaceBoardRow>): ValidatedPlaceRow[] {
  const venueIds = new Set(sharedPlaces.map((row) => row.sharedPlaceId));
  return validated.filter((row) => row.sharedPlaceId !== null && venueIds.has(row.sharedPlaceId));
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
