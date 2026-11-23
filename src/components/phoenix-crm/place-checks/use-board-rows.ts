"use client";

/**
 * Phoenix CRM — Place checks: every set the board draws, narrowed by the one filter bar.
 *
 * The rows the page handed, the test entries taken out, the customers seated in a building moved under
 * that building, and each set filtered the same way. Nothing here decides which tab is open: the board
 * (`use-place-check-board.tsx`) reads these sets and draws the open one.
 */

import { useMemo } from "react";

import type { PlaceCheckBoardProps } from "@/components/phoenix-crm/place-checks/board-types";
import { filterSummary } from "@/components/phoenix-crm/place-checks/filter-bar";
import {
  decidedByMatches,
  EMPTY_VALIDATION_REVIEW_FILTERS,
  hasActiveValidationReviewFilter,
  matchesValidationReviewFilters,
  validatedPassesOutcome,
  validationReviewPeriodCutoff,
  withinValidationReviewPeriod,
  type ValidationReviewFilters,
} from "@/lib/phoenix-crm/validation-review-filters";
import {
  chipTakes,
  clinicsInUse,
  filterableReopened,
  isReal,
  mergeDecided,
  pageRowsThenClick,
  placeCheckOptions,
  placeCheckScorecardOf,
  withoutDecisionNotesThatAreComments,
  type PlaceChecksEverything,
  type PlaceChecksSummary,
  type UnconfirmedChip,
} from "@/lib/phoenix-crm/place-checks-on-demand";
import type { PlaceNoteIndex } from "@/lib/phoenix-crm/view-types";
import { narrowVenueGroups, seatedCustomersByVenue, venueNeedsDecision, withoutSeated } from "@/lib/phoenix-crm/shared-place-groups";

export function usePlaceCheckRows({
  chip,
  complete,
  everything,
  filtering,
  filters,
  noteIndex,
  onlyBuilding,
  props,
  showRejectedBuildings,
  summary,
  team,
}: {
  chip: UnconfirmedChip;
  /** Whether the board holds every row: always on a manager's board, and on the Super Admin's once the click's read is in. */
  complete: boolean;
  everything: PlaceChecksEverything | null;
  filtering: boolean;
  filters: ValidationReviewFilters;
  /** The page's notes and the click's as one index (`mergedNoteIndex`). */
  noteIndex: PlaceNoteIndex;
  onlyBuilding: string | null;
  props: PlaceCheckBoardProps;
  showRejectedBuildings: boolean;
  /** The figures counted over every place in use, or null until their read is in (and on a manager's board). */
  summary: PlaceChecksSummary | null;
  team: boolean;
}) {
  const { pending: pendingRows, decided: decidedRows, validated: validatedRows, reopened: reopenedRows, sharedPlaces: venueRows } = props;

  const pending = useMemo(() => pendingRows.filter(isReal), [pendingRows]);
  // 🔴 THE BOARD SHOWS THE OLDER DECISIONS ONLY WHILE A DECIDER IS CHOSEN — so "Decided by Khaled Bedair"
  // answers for all of his, and with nobody chosen the board is the recent window it always was. A
  // manager's page hands every decision; the Super Admin's hands the recent ones, and the older ones
  // arrive with the click.
  const everyDecided = useMemo(() => {
    const recent = decidedRows.filter(isReal);
    return everything ? mergeDecided(recent, withoutDecisionNotesThatAreComments(everything.olderDecided.filter(isReal), noteIndex.notes)) : recent;
  }, [decidedRows, everything, noteIndex.notes]);
  const decided = useMemo(
    () => (filters.decider ? everyDecided : everyDecided.filter((row) => row.recent)),
    [everyDecided, filters.decider],
  );
  const validated = useMemo(() => (everything ? everything.validated.filter(isReal) : validatedRows.filter(isReal)), [everything, validatedRows]);
  // 🔴 THE PAGE SENDS ONLY THE BUILDINGS THAT NEED A DECISION AND THE CUSTOMERS SEATED IN THEM (23 Nov 2026,
  // `venuesSentWithPage`); every other building and every sent-back customer arrive with the click. A row
  // in both is the page's, which is read again after every decision.
  const reopened = useMemo(
    () => pageRowsThenClick(reopenedRows.filter(isReal), everything ? everything.reopened.filter(isReal) : null, (row) => row.customerId),
    [reopenedRows, everything],
  );
  const sharedPlaces = useMemo(
    () => pageRowsThenClick(venueRows.filter(isReal), everything ? everything.sharedPlaces.filter(isReal) : null, (row) => row.sharedPlaceId),
    [venueRows, everything],
  );

  // The filter bar's lists, counted from every row the board holds; until the click's read is in, the
  // figures' read counted them from every row it read, and until THAT is in they are counted from what the
  // page sent (a pick from them asks for the rest). A manager's board never names a decider, so it gets no
  // list and no box.
  const counted = useMemo(
    () => placeCheckOptions({ team, pending, decided, everyDecided, validated, reopened, sharedPlaces }),
    [team, pending, decided, everyDecided, validated, reopened, sharedPlaces],
  );
  const { reps, lines, regions, areas, lists, deciders } = complete || !summary ? counted : summary.options;

  const cutoff = validationReviewPeriodCutoff(filters.period);

  // 🔴 A ROW IS TAKEN OUT OF THE CLINICS VIEW ONLY WHEN ITS BUILDING IS ON THIS BOARD, so a customer whose
  // building has aged out of the venue read stays among the clinics where he can still be found.
  const venueIds = useMemo(() => new Set(sharedPlaces.map((row) => row.sharedPlaceId)), [sharedPlaces]);
  const clinicPending = useMemo(() => withoutSeated(pending, venueIds), [pending, venueIds]);
  const clinicDecided = useMemo(() => withoutSeated(decided, venueIds), [decided, venueIds]);
  const clinicValidated = useMemo(() => withoutSeated(validated, venueIds), [validated, venueIds]);
  const clinicReopened = useMemo(() => withoutSeated(reopened, venueIds), [reopened, venueIds]);
  const seated = useMemo(
    () => seatedCustomersByVenue({ pending, decided, validated, reopened, venueIds }),
    [pending, decided, validated, reopened, venueIds],
  );

  const filteredPending = useMemo(
    () =>
      clinicPending.filter(
        (row) => decidedByMatches(null, filters.decider) && matchesValidationReviewFilters(row, filters) && withinValidationReviewPeriod(row.createdAt, cutoff),
      ),
    [clinicPending, filters, cutoff],
  );
  const filteredDecided = useMemo(
    () =>
      clinicDecided.filter((row) => {
        if (filters.outcome === "approved" && row.status !== "approved") return false;
        if (filters.outcome === "rejected" && row.status !== "rejected") return false;
        if (!decidedByMatches(row.decidedByName, filters.decider)) return false;
        return matchesValidationReviewFilters(row, filters) && withinValidationReviewPeriod(row.createdAt, cutoff);
      }),
    [clinicDecided, filters, cutoff],
  );
  const inUse = useMemo(() => clinicsInUse(clinicValidated, filters, cutoff), [clinicValidated, filters, cutoff]);
  const filteredValidated = useMemo(() => inUse.filter((row) => chipTakes(chip, row)), [inUse, chip]);
  // 🔴 THE SCORECARD COUNTS A CUSTOMER SEATED IN A POLYCLINIC TOO, AND THIS LIST IS THE SINGLE CLINICS — so
  // a count tapped through to here can hold more than the list shows. Those customers' photo is their
  // building's one timetable, drawn once on its card, so they are named and pointed to, never repeated.
  const seatedInChip = useMemo(() => {
    const clinics = new Set(clinicValidated.map((row) => row.placeId));
    return validated.filter(
      (row) =>
        !clinics.has(row.placeId) &&
        chipTakes(chip, row) &&
        validatedPassesOutcome(row, filters.outcome) &&
        decidedByMatches(row.decidedByName, filters.decider) &&
        matchesValidationReviewFilters(row, filters) &&
        withinValidationReviewPeriod(row.validatedAt, cutoff),
    ).length;
  }, [validated, clinicValidated, chip, filters, cutoff]);
  const filteredReopened = useMemo(
    () =>
      clinicReopened.filter(
        (row) =>
          decidedByMatches(row.refusedByName, filters.decider) &&
          matchesValidationReviewFilters(filterableReopened(row), filters) &&
          withinValidationReviewPeriod(row.reopenedAt, cutoff),
      ),
    [clinicReopened, filters, cutoff],
  );
  // One group per building: the building itself, then the customers seated in it that pass the filters.
  const filteredVenueGroups = useMemo(
    () => narrowVenueGroups({ venues: sharedPlaces, seated, filters, cutoff }),
    [sharedPlaces, seated, filters, cutoff],
  );
  // 🔴 A REJECTED BUILDING IS BEHIND ITS OWN SWITCH — or the Rejected outcome — so the 36 buildings taken
  // off the list never again bury the live ones. It is still on the board, and can still be brought back.
  const buildingGroups = useMemo(
    () =>
      showRejectedBuildings || filters.outcome === "rejected"
        ? filteredVenueGroups
        : filteredVenueGroups.filter((group) => group.venue.status !== "retired"),
    [filteredVenueGroups, showRejectedBuildings, filters.outcome],
  );
  const rejectedBuildings = filteredVenueGroups.length - filteredVenueGroups.filter((group) => group.venue.status !== "retired").length;
  // 🔴 A BUILDING OPENED FROM "TIMETABLES THAT KEEP FAILING" IS READ PAST THE FILTERS: the list named it,
  // so a rep, line or period filter left on the bar must not answer "no building matches".
  const openedBuilding = useMemo(
    () =>
      onlyBuilding
        ? narrowVenueGroups({ venues: sharedPlaces.filter((venue) => venue.sharedPlaceId === onlyBuilding), seated, filters: EMPTY_VALIDATION_REVIEW_FILTERS, cutoff: null })
        : null,
    [onlyBuilding, sharedPlaces, seated],
  );
  const listedBuildings = openedBuilding ?? buildingGroups;
  const needsGroups = useMemo(() => filteredVenueGroups.filter((group) => venueNeedsDecision(group)), [filteredVenueGroups]);

  // The scorecard reads every rep's places through the same filters, the clinics and the seated alike.
  // Until the click's read is in, the figures' read stands for the board with no filter; with a filter, or
  // before that read answers, there is no count to show yet — never one taken from the seated places alone.
  const countedScorecard = useMemo(
    () => (complete ? placeCheckScorecardOf({ pending, validated, reopened }, filters, cutoff) : null),
    [complete, pending, validated, reopened, filters, cutoff],
  );
  const scorecard = countedScorecard ?? (summary && !filtering ? summary.scorecard : null);

  const anyFilter = hasActiveValidationReviewFilter(filters);
  const narrowedBy = filterSummary(filters);
  const showWaiting = filters.outcome === "all" || filters.outcome === "pending";
  const showDecided = filters.outcome === "all" || filters.outcome === "approved" || filters.outcome === "rejected";
  const showValidated = filters.outcome === "all" || filters.outcome === "validated" || filters.outcome === "unseen";
  const showReopened = filters.outcome === "all" || filters.outcome === "rejected";

  // Every building with every customer in it, before the filters: what the header counts (the one waiting
  // number never moves with a filter) and what the one-by-one review looks a row up in after a decision
  // moved it.
  const everyVenueGroup = useMemo(
    () => narrowVenueGroups({ venues: sharedPlaces, seated, filters: EMPTY_VALIDATION_REVIEW_FILTERS, cutoff: null }),
    [sharedPlaces, seated],
  );

  /** What waits for a decision from one rep ("" for every rep), whatever else the filter bar holds. */
  const waitingOf = (rep: string) => {
    const only = { ...EMPTY_VALIDATION_REVIEW_FILTERS, rep };
    return {
      reviews: clinicPending.filter((row) => matchesValidationReviewFilters(row, only)),
      groups: narrowVenueGroups({ venues: sharedPlaces, seated, filters: only, cutoff: null }).filter((group) => venueNeedsDecision(group)),
    };
  };

  return {
    anyFilter,
    areas,
    buildingGroups,
    clinicPending,
    deciders,
    decided,
    everyVenueGroup,
    filteredDecided,
    filteredPending,
    filteredReopened,
    filteredValidated,
    filteredVenueGroups,
    inUse,
    lines,
    listedBuildings,
    lists,
    narrowedBy,
    needsGroups,
    openedBuilding,
    pending,
    regions,
    rejectedBuildings,
    reps,
    scorecard,
    seatedInChip,
    showDecided,
    showReopened,
    showValidated,
    showWaiting,
    validated,
    waitingOf,
  };
}
