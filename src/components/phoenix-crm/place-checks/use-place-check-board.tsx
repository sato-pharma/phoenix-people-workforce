"use client";

/**
 * Phoenix CRM — Place checks: the board's one state.
 *
 * Which tab is open, what the filter bar holds, the rows the page did not send, the sets each tab draws
 * and the two lanes. The shell (`validation-reviews-board.tsx`) calls it once and hands the answer to
 * every panel, so no panel keeps a second copy of anything.
 *
 * 🔴 THE BOARD OPENS ON READY WHEN READY HOLDS ANYTHING, AND ON YOUR CALL WHEN IT DOES NOT (the rebuild, 23
 * Nov 2026). Until he chooses a tab the board stands on that one; the moment he chooses, or the address
 * names one, his choice stands for the visit.
 */

import { useMemo, useState, type KeyboardEvent } from "react";

import { useBulkRunGoing } from "@/components/phoenix-crm/place-check-bulk";
import { usePlaceCheckDecides } from "@/components/phoenix-crm/place-check-decides";
import { useCanRestoreValidation } from "@/components/phoenix-crm/place-check-restore";
import type { ScoreTarget } from "@/components/phoenix-crm/place-check-scorecard";
import {
  placeOfTarget,
  UNCONFIRMED_CHIPS,
  type PlaceCheckBoardProps,
  type PlaceCheckTab,
  type PlaceCheckView,
} from "@/components/phoenix-crm/place-checks/board-types";
import { usePlaceCheckAddress } from "@/components/phoenix-crm/place-checks/use-board-address";
import { usePlaceCheckLanes } from "@/components/phoenix-crm/place-checks/use-board-lanes";
import { usePlaceCheckRows } from "@/components/phoenix-crm/place-checks/use-board-rows";
import { usePlaceChecksEverything } from "@/components/phoenix-crm/place-checks/use-everything";
import { laneOfReviewRow, laneOfVenueGroup, openCaseSubjects, PLACE_CHECK_LANE_LABEL } from "@/lib/phoenix-crm/place-check-lanes";
import { unconfirmedOpenCount, type UnconfirmedChip } from "@/lib/phoenix-crm/place-checks-on-demand";
import {
  decidedSectionTitle,
  EMPTY_VALIDATION_REVIEW_FILTERS,
  hasActiveValidationReviewFilter,
  type ValidationReviewFilters,
} from "@/lib/phoenix-crm/validation-review-filters";
// Types only: this board is also a district manager's portal page, and the review is not his.
import type { PlaceReviewDeckInput } from "@/lib/place-review-deck/slides";

/** The filter signature: it remounts every paged list, and says which filters a list was opened under. */
const filterKeyOf = (filters: ValidationReviewFilters) =>
  `${filters.outcome}|${filters.rep}|${filters.line}|${filters.region}|${filters.area}|${filters.list}|${filters.period}|${filters.decider}|${filters.text}`;

export function usePlaceCheckBoard(props: PlaceCheckBoardProps) {
  const { agreement = null, capped, failingTimetables, mode, noteIndex, onDemand, reviewDeck, sfeRecommended, signWins, slots = [] } = props;

  const [filters, setFilters] = useState<ValidationReviewFilters>(EMPTY_VALIDATION_REVIEW_FILTERS);
  // The eight boxes fold away under a one-line summary of what is narrowing the board (17 Nov 2026).
  const [filtersOpen, setFiltersOpen] = useState(false);
  // The tab he chose, or null while the board stands on the one it opens on by itself (see the header).
  const [picked, setPicked] = useState<PlaceCheckView | null>(null);
  const [chip, setChip] = useState<UnconfirmedChip>("open");
  const [showRejectedBuildings, setShowRejectedBuildings] = useState(false);
  // The one building a row of "Timetables that keep failing" opened, or null for the whole list.
  const [onlyBuilding, setOnlyBuilding] = useState<string | null>(null);
  // The comparison reads every validated place, so it starts on the tab's first opening and then stays
  // mounted — switching tabs must not read it again.
  const [samePlaceOpened, setSamePlaceOpened] = useState(false);
  const [sameCustomerOpened, setSameCustomerOpened] = useState(false);
  const [lineLookalikesOpened, setLineLookalikesOpened] = useState(false);
  const set = <Key extends keyof ValidationReviewFilters>(key: Key, value: ValidationReviewFilters[Key]) =>
    setFilters((current) => ({ ...current, [key]: value }));
  // While a bulk run is going, the tabs, filters, counts and every switch that redraws a list wait for it
  // (`useBulkRunGoing`, 17 Nov 2026): the run's own report is drawn in the bar the switch would remove.
  const bulkRunning = useBulkRunGoing();

  // 🔴 EVERY SENTENCE BELOW THAT NAMES A DECISION IS BEHIND THIS FLAG. A manager's board must not say
  // "waiting for your decision", must not explain what approving or refusing does, and must not name
  // who settled a row — the three places this board used to state the decision out loud.
  const team = mode === "team";
  // Taking a rejection back is the Super Admin's alone, so only his board says a rejected building can
  // be brought back (owner, 2026-11-10; the SFE Manager's board said it too until 14 Nov 2026).
  const canRestore = useCanRestoreValidation();
  // 🔴 THE LANES ARE THE SUPER ADMIN'S ALONE: the SFE Manager reads the company board and decides nothing
  // on it, and a district manager's board is handed no advice at all, so neither has anything sorted.
  const decides = usePlaceCheckDecides();
  const lanes = decides && !team;

  const filtering = hasActiveValidationReviewFilter(filters) || filters.outcome !== "all";
  const { askForDeck, complete, everything, everythingRead, reloadEverything, wanted } = usePlaceChecksEverything({
    filtering,
    onDemand,
    view: picked ?? "needs",
  });
  const rows = usePlaceCheckRows({ chip, complete, everything, filtering, filters, onlyBuilding, props, showRejectedBuildings, team });
  const {
    buildingGroups,
    decided,
    everyVenueGroup,
    filteredDecided,
    filteredPending,
    filteredReopened,
    filteredValidated,
    filteredVenueGroups,
    inUse,
    needsGroups,
    pending,
    showDecided,
    showReopened,
    showWaiting,
    validated,
    waitingOf,
  } = rows;
  // The integrity cases the board already draws beside each row: one nobody has settled keeps its row out of Ready.
  const openCases = useMemo(() => openCaseSubjects(noteIndex.integrity), [noteIndex.integrity]);
  const laneSets = usePlaceCheckLanes({
    agreement,
    clinicPending: rows.clinicPending,
    everyVenueGroup,
    filteredPending,
    lanes,
    needsGroups,
    openCases,
    showWaiting,
  });
  const { callGroups, callReviews, desk, readyGroups, readyReviews } = laneSets;

  const view: PlaceCheckView = picked ?? (lanes && (desk?.ready ?? 0) > 0 ? "ready" : "needs");
  /** The board is waiting for the click's read: what it would draw needs rows it does not hold yet. */
  const reading = !complete && (filtering || view === "unconfirmed");

  // 🔴 WHAT THE SYSTEM APPROVED BY ITSELF IS LISTED APART (the rebuild, 23 Nov 2026): on the Super Admin's
  // board History is the decisions a person made, and "Approved by the system" is the rule's, each with its
  // take-back. A board with no lanes is not told which approvals were the system's, so its History is whole.
  const bySystemRows = useMemo(() => (lanes ? filteredDecided.filter((row) => Boolean(row.approvedByRule)) : []), [lanes, filteredDecided]);
  const historyDecided = useMemo(() => (lanes ? filteredDecided.filter((row) => !row.approvedByRule) : filteredDecided), [lanes, filteredDecided]);

  // What the one-by-one review is built from: each tab's rows as the board shows them now, and, to look
  // a row up after a decision moved it, every row the board holds with every customer in each building.
  const withDeck = !team && reviewDeck !== undefined;
  const deckInput = useMemo<PlaceReviewDeckInput | null>(
    () =>
      withDeck
        ? {
            // The review knows the board's older tabs: a lane opens it on Waiting, the system's approvals on History.
            boardView: view === "ready" ? "needs" : view === "bySystem" ? "history" : view,
            noteIndex,
            // Opened from a lane, the review holds that lane; from any other tab, everything waiting.
            waiting:
              view === "ready"
                ? { reviews: readyReviews, venues: readyGroups }
                : view === "needs"
                  ? { reviews: callReviews, venues: callGroups }
                  : { reviews: showWaiting ? filteredPending : [], venues: needsGroups },
            unconfirmed: { places: filteredValidated, venues: buildingGroups.filter((group) => group.venue.status === "active") },
            history: { reviews: showDecided ? filteredDecided : [], venues: filteredVenueGroups.filter((group) => group.venue.status === "retired") },
            lookup: { reviews: [...pending, ...decided], places: validated, venues: everyVenueGroup },
          }
        : null,
    [withDeck, view, noteIndex, readyReviews, readyGroups, callReviews, callGroups, showWaiting, filteredPending, needsGroups, filteredValidated, buildingGroups, showDecided, filteredDecided, filteredVenueGroups, pending, decided, validated, everyVenueGroup],
  );

  const readyCount = readyReviews.length + readyGroups.length;
  const callCount = callReviews.length + callGroups.length;
  const historyCount = (showDecided ? historyDecided.length : 0) + (showReopened ? filteredReopened.length : 0);
  const unconfirmedCount = complete ? unconfirmedOpenCount(inUse, filters) : onDemand && !filtering ? onDemand.summary.unconfirmed : null;
  // While the click's read is on its way under a filter, no tab shows a count it cannot stand behind.
  const shown = (count: number) => (reading && filtering ? null : count);
  const decidedTitle = decidedSectionTitle(filters, team);

  const filterKey = filterKeyOf(filters);
  const validatedKey = `${filterKey}|${chip}`;

  // ── How far the open tab's first list is open, for the address ──────────────────────────────────
  // Kept with the tab and the filters it was opened under, so a change of either starts the list over.
  const [rowsOpen, setRowsOpen] = useState<{ at: string; limit: number } | null>(null);
  const [addressRead, setAddressRead] = useState(0);
  const rowsAt = `${picked ?? ""}|${filterKey}`;
  const rowsShown = rowsOpen && rowsOpen.at === rowsAt ? rowsOpen.limit : null;
  const setRowsShown = (limit: number) => setRowsOpen({ at: rowsAt, limit });
  /** The key of a list the address may have opened further: it starts over on a filter, and once when the address is read. */
  const pageKey = `${filterKey}|${addressRead}`;

  // 🔴 THE COMPARISON TABS ARE THE COMPANY BOARD'S ALONE: a manager's board is `mode="team"` and is never
  // handed the tab, the panel or the read (the route refuses a manager as well).
  const decidedTabs: PlaceCheckTab[] = [
    { key: "history", label: "History", count: shown(historyCount) },
    ...(lanes ? [{ key: "bySystem" as const, label: "Approved by the system", count: shown(bySystemRows.length) }] : []),
  ];
  const tabs: ReadonlyArray<PlaceCheckTab> = [
    ...(lanes ? [{ key: "ready" as const, label: PLACE_CHECK_LANE_LABEL.ready, count: shown(readyCount) }] : []),
    { key: "needs", label: team ? "Being checked" : lanes ? PLACE_CHECK_LANE_LABEL.your_call : "Waiting", count: shown(callCount), open: lanes || (reading && filtering) ? 0 : callCount },
    // On the Super Admin's board what was decided sits beside what waits; on the others it stays last.
    ...(lanes ? decidedTabs : []),
    { key: "unconfirmed", label: "Not confirmed", count: unconfirmedCount },
    { key: "polyclinics", label: "Polyclinics and hospitals", count: shown(buildingGroups.length) },
    ...(team ? [] : [{ key: "samePlace" as const, label: "Same place, several reps", count: null }]),
    ...(team ? [] : [{ key: "sameCustomer" as const, label: "Same customer, several reps", count: null }]),
    // 🔴 The Super Admin's alone (`canRestore` is `canRestoreValidation`): "Same customer" there validates.
    ...(!team && canRestore ? [{ key: "lineLookalikes" as const, label: "Same customer, other line", count: null }] : []),
    ...(lanes ? [] : decidedTabs),
    // The scorecard is a tab on the company board (the rebuild); a district manager's board still opens with it.
    ...(team ? [] : [{ key: "scorecard" as const, label: "Scorecard", count: null }]),
    ...slots.map((slot) => ({ key: `slot:${slot.key}` as const, label: slot.label, count: slot.count })),
  ];
  const selectView = (key: PlaceCheckView) => {
    setPicked(key);
    setRowsOpen(null);
    if (key === "samePlace") setSamePlaceOpened(true);
    if (key === "sameCustomer") setSameCustomerOpened(true);
    if (key === "lineLookalikes") setLineLookalikesOpened(true);
  };
  /** The tab he stands on becomes his choice, so a list emptying under a run never moves him off it. */
  const stayOnView = () => setPicked(view);

  // 🔴 A WAITING COUNT OPENS THE LANE THAT HOLDS THAT REP'S ROWS: Your call when any of them is his call,
  // Ready when every one of them is ready. A board with no lanes has the one list.
  const laneOfTarget = (place: ReturnType<typeof placeOfTarget>, rep: string): ReturnType<typeof placeOfTarget> => {
    if (place.view !== "needs" || !lanes) return place;
    const waiting = waitingOf(rep);
    const hisCall =
      waiting.reviews.some((row) => laneOfReviewRow(row, agreement, openCases).lane === "your_call") ||
      waiting.groups.some((group) => laneOfVenueGroup(group, agreement, openCases).lane === "your_call");
    return hisCall || waiting.reviews.length + waiting.groups.length === 0 ? place : { view: "ready", chip: null };
  };
  // A tapped count opens exactly its rows: that rep (or every rep), the tab and narrowing that hold them,
  // and every outcome — the scorecard never reads the outcome selector, so its counts would not match.
  const openScore = (rep: string, target: ScoreTarget) => {
    const place = laneOfTarget(placeOfTarget(target), rep);
    setFilters((current) => ({ ...current, rep, outcome: "all" }));
    if (place.chip) setChip(place.chip);
    selectView(place.view);
    window.setTimeout(() => document.getElementById("vr-tabs")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  };
  const moveTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = tabs.length - 1;
    const next =
      event.key === "ArrowRight" ? (index === last ? 0 : index + 1) : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1) : event.key === "Home" ? 0 : event.key === "End" ? last : null;
    if (next === null) return;
    event.preventDefault();
    selectView(tabs[next].key);
    document.getElementById(`vr-tab-${tabs[next].key}`)?.focus();
  };

  // ── The address remembers the view (`place-check-address.ts`) ───────────────────────────────────
  usePlaceCheckAddress({
    apply: (address, kept) => {
      const tab = tabs.find((each) => each.key === address.tab)?.key ?? null;
      if (tab) selectView(tab);
      const narrowing = UNCONFIRMED_CHIPS.find((each) => each === address.chip);
      if (narrowing) setChip(narrowing);
      // A district manager's board has no Decided by box, so it never applies one it cannot show or clear.
      const next: ValidationReviewFilters = { ...EMPTY_VALIDATION_REVIEW_FILTERS, ...address.filters, ...kept, decider: team ? "" : kept.decider };
      if (hasActiveValidationReviewFilter(next) || next.outcome !== "all") setFilters(next);
      if (address.rows !== null) {
        setRowsOpen({ at: `${tab ?? ""}|${filterKeyOf(next)}`, limit: address.rows });
        setAddressRead(1);
      }
    },
    chip: chip === "open" ? null : chip,
    filters,
    rows: rowsShown,
    tab: picked,
  });

  return {
    ...rows,
    ...laneSets,
    agreement,
    askForDeck,
    bulkRunning,
    bySystemRows,
    canRestore,
    capped,
    chip,
    complete,
    decidedTitle,
    deckInput,
    everythingRead,
    failingTimetables,
    filterKey,
    filters,
    filtersOpen,
    historyDecided,
    lanes,
    lineLookalikesOpened,
    mode,
    moveTab,
    noteIndex,
    onDemand,
    onlyBuilding,
    openScore,
    pageKey,
    reading,
    reloadEverything,
    reviewDeck,
    rowsShown,
    sameCustomerOpened,
    samePlaceOpened,
    selectView,
    set,
    setChip,
    setFilters,
    setFiltersOpen,
    setOnlyBuilding,
    setRowsShown,
    setShowRejectedBuildings,
    sfeRecommended,
    showRejectedBuildings,
    signWins,
    slots,
    stayOnView,
    tabs,
    team,
    validatedKey,
    view,
    wanted,
  };
}

export type PlaceCheckBoard = ReturnType<typeof usePlaceCheckBoard>;
