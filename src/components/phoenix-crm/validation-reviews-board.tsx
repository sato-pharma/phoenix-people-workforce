"use client";

/**
 * Phoenix CRM — Place checks, with one filter bar over every section (owner, 2026-10-05: "I want to be
 * able to filter by rep by line by region by period by field by rejected by accepted by any single
 * thing").
 *
 * The page hands this board every set at once — the places waiting for a decision, the ones decided in
 * the last two weeks, the validations the system never questioned, the customers sent back, and the
 * polyclinics. The filter bar is shared: rep, line, region, area, list and period narrow every tab, a
 * free-text box searches the names, and an outcome selector narrows to just the waiting / approved /
 * rejected / in-use rows. Every count in a heading is the filtered count.
 *
 * 🔴 IT IS A REPORT, NOT A DUMP (owner, 2026-10-17: "is this a report that really shows me data? or it's
 * a bunch of chaos … put corrective actions even if we will need to rebuild the module from scratch").
 * The Clinics tab drew every row it held — 197 decided rows, 104,455 px tall — and the polyclinics drew
 * all 98 buildings with test ones among them. So: a scorecard of each rep's captures at the top; five
 * tabs, of which only the open one is drawn; every list paged at 20; test entries never drawn; and a
 * rejected building only behind its own switch.
 *
 * It is an admin screen, so the dropdowns are combo boxes the Super Admin types into (the module's
 * surface rule): the board declares `surface="admin"` around itself, which is what turns `CrmSelect`
 * into the searchable control.
 *
 * 🔴 ONE BOARD, TWO MODES, AND NEVER A SECOND COPY (owner, 2026-10-13: a district manager gets this
 * board for his own team). `mode="company"` is the Super Admin's and the SFE Manager's (2026-10-19) — every decision control the Super Admin has had
 * since 2026-10-03, plus what the managers have written. `mode="team"` renders NO decision control at
 * all and no sentence about one: not "waiting for your decision", not who decided a settled row, not
 * what approving or refusing would do, and not the system's recommendation. He comments and he
 * recommends, and his screen says nothing about who decides — his own instruction the same day was
 * "don't show this on the screen". A second board file would have been the easy shape and is exactly
 * how one of two copies drifts; the portal mirrors removed in 2026-08 are the repo's own account of that.
 */

import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";

import { AdminCallout, AdminTableShell } from "@/components/admin/admin-design-system";
import { CrmSurfaceProvider } from "@/components/phoenix-crm/surface";
import { cn } from "@/lib/utils";
import { CrmButton, CrmCheck, CrmField, CrmPill, CrmSearchField, CrmSelect } from "@/components/phoenix-crm/ui";
import { PlaceCheckScorecard, type ScoreTarget } from "@/components/phoenix-crm/place-check-scorecard";
import { ReopenedCustomerList } from "@/components/phoenix-crm/reopened-customer-list";
import { CustomerMatchBoardView } from "@/components/phoenix-crm/customer-match-board";
import { PlaceMatchBoardView } from "@/components/phoenix-crm/place-match-board";
import { SharedPlaceList } from "@/components/phoenix-crm/shared-place-list";
import { ValidatedPlaceList } from "@/components/phoenix-crm/validated-place-list";
import { ValidationReviewQueue } from "@/components/phoenix-crm/validation-review-queue";
import {
  decidedByMatches,
  decidedSectionTitle,
  distinctValues,
  EMPTY_VALIDATION_REVIEW_FILTERS,
  hasActiveValidationReviewFilter,
  matchesValidationReviewFilters,
  validatedPassesOutcome,
  validationReviewPeriodCutoff,
  withinValidationReviewPeriod,
  type ValidationReviewFilterable,
  type ValidationReviewFilters,
  type ValidationReviewOutcome,
  type ValidationReviewPeriod,
} from "@/lib/phoenix-crm/validation-review-filters";
import { adviseOnBuilding, adviseOnReview, adviseOnTimetable, type PlaceCheckAdvice } from "@/lib/phoenix-crm/place-check-advice";
import { placeCheckScorecard, standingOfPlaceInUse, type PlaceStanding } from "@/lib/phoenix-crm/place-check-scorecard";
import { narrowVenueGroups, seatedCustomersByVenue, venueNeedsDecision, withoutSeated } from "@/lib/phoenix-crm/shared-place-groups";
import type { PlaceCheckNotesMode } from "@/components/phoenix-crm/place-check-notes";
import type { PlaceNoteIndex, ReopenedCustomerRow, SharedPlaceBoardRow, ValidatedPlaceRow, ValidationReviewRow } from "@/lib/phoenix-crm/view-types";
// Types only: this board is also a district manager's portal page, and the review is not his.
import type { PlaceReviewDeckInput } from "@/lib/place-review-deck/slides";

const OUTCOME_LABELS: Record<ValidationReviewOutcome, string> = {
  all: "Every outcome",
  pending: "Waiting",
  approved: "Approved",
  rejected: "Rejected",
  validated: "In use",
  unseen: "Never looked at",
};

const PERIOD_LABELS: Record<ValidationReviewPeriod, string> = {
  all: "Any time",
  today: "Today",
  "7": "Last 7 days",
  "14": "Last 14 days",
  "30": "Last 30 days",
};

/** Every list on the board shows this many rows, then "Show more" — no tab draws its whole set at once. */
const PAGE_ROWS = 20;
/** A building is a tall card with its customers under it, so the polyclinics page by fewer. */
const PAGE_BUILDINGS = 10;

/**
 * The five tabs, in the order the work is done (owner, 2026-10-17):
 * - `needs`       — everything waiting for a decision: a clinic the system held, a building held, a
 *                   customer seated behind a door whose timetable held them;
 * - `unconfirmed` — clinics in use that the reader never confirmed and nobody has looked at — the
 *                   unreadable photographs;
 * - `polyclinics` — every building, one card each, with its sign, its timetable and the customers in it;
 * - `samePlace`   — the same place seen by two or more reps, the Super Admin's alone, read when first
 *                   opened (owner, 2026-10-17: "a place validated by more than a rep");
 * - `sameCustomer` — one customer validated by two or more reps at places that do not agree, the
 *                   deciders' alone, read when first opened (owner, 2026-10-26, "Build the check");
 * - `history`     — what was decided in the last 14 days, and who is waiting to be captured again.
 */
type PlaceCheckView = "needs" | "unconfirmed" | "polyclinics" | "samePlace" | "sameCustomer" | "history";

/** The narrowing inside Not confirmed, each one a standing `standingOfPlaceInUse` gives a place. */
type UnconfirmedChip = "open" | Exclude<PlaceStanding, "confirmed" | "waiting"> | "all";

const CHIP_LABELS: Record<UnconfirmedChip, string> = {
  open: "Not confirmed",
  notReadable: "Not readable",
  wrongPhoto: "No sign in the photo",
  anotherName: "Another name",
  notRead: "Never read",
  all: "Every place in use",
};

const CHIP_TITLES: Record<UnconfirmedChip, string> = {
  open: "In use, not confirmed by the reader, and nobody has looked",
  notReadable: "In use, and the sign could not be read",
  wrongPhoto: "In use, and no sign in the photo",
  anotherName: "In use, and the sign names somebody else",
  notRead: "In use, and the sign was never read",
  all: "Every clinic in use",
};

function chipTakes(chip: UnconfirmedChip, row: ValidatedPlaceRow): boolean {
  if (chip === "all") return true;
  if (row.reviewed) return false;
  const standing = standingOfPlaceInUse(row);
  return chip === "open" ? standing !== "confirmed" : standing === chip;
}

/**
 * Where a scorecard count's own rows are (owner, 2026-10-17: "make me see what is the unreadable — the
 * photos"): a photo problem or a sign never read is that standing's narrowing of Not confirmed, a place
 * waiting is Needs you, a customer sent back is History, and the timetable count is the buildings.
 */
function placeOfTarget(target: ScoreTarget): { view: PlaceCheckView; chip: UnconfirmedChip | null } {
  switch (target) {
    case "waiting":
      return { view: "needs", chip: null };
    case "sentBack":
      return { view: "history", chip: null };
    case "timetable":
      return { view: "polyclinics", chip: null };
    default:
      return { view: "unconfirmed", chip: target };
  }
}

/** A row the shared filters can read, for a reopened customer who has no place on file any more. */
function filterableReopened(row: ReopenedCustomerRow): ValidationReviewFilterable {
  return { ...row, speciality: null, placeLabel: null, address: null, brickName: null, areaName: null };
}

/** A test entry is never drawn on this board: it is nobody's real work and nobody decides on it. */
function isReal(row: { isTest: boolean }): boolean {
  return !row.isTest;
}

/**
 * A list shown 20 at a time. Keyed by the filters at the call site, so a filter change starts it over
 * rather than keeping a page offset from the wider set.
 */
function Paged<Row>({ children, noun, rows, size }: { children: (shown: Row[]) => ReactNode; noun: string; rows: Row[]; size: number }) {
  const [limit, setLimit] = useState(size);
  const shown = rows.length > limit ? rows.slice(0, limit) : rows;
  const left = rows.length - shown.length;
  return (
    <>
      {children(shown)}
      {left > 0 ? (
        <div className="flex min-w-0 flex-wrap items-center gap-3 border-t border-slate-200 px-4 py-3">
          <CrmButton onClick={() => setLimit((current) => current + size)} size="sm">
            Show {Math.min(size, left)} more {noun}
          </CrmButton>
          <span className="break-words text-xs font-semibold text-slate-500">
            {shown.length} of {rows.length} shown
          </span>
        </div>
      ) : null}
    </>
  );
}

/** One line saying what the system recommends across the open decisions — the Super Admin's board only. */
function AdviceSummary({ advice }: { advice: PlaceCheckAdvice[] }) {
  if (advice.length === 0) return null;
  const count = (kind: PlaceCheckAdvice["kind"]) => advice.filter((item) => item.kind === kind).length;
  const parts = [
    count("approve") > 0 ? `approving ${count("approve")}` : null,
    count("reject") > 0 ? `rejecting ${count("reject")}` : null,
    count("look") > 0 ? `looking yourself at ${count("look")}` : null,
  ].filter((part): part is string => part !== null);
  return (
    <div className="min-w-0 border-l-4 border-orange-500 bg-white px-4 py-3">
      <p className="break-words text-sm font-black text-slate-900">
        Of the {advice.length} waiting, the system recommends {parts.join(", ")}.
      </p>
      <p className="mt-1 break-words text-xs text-slate-600">
        Each row says why. Nothing is decided until you press Approve or Reject, one row or ticked together.
      </p>
    </div>
  );
}

export function ValidationReviewsBoard({
  pending: pendingRows,
  decided: decidedRows,
  validated: validatedRows,
  reopened: reopenedRows,
  sharedPlaces: venueRows,
  capped,
  mode,
  noteIndex,
  reviewDeck,
}: {
  /** Whose board this is — see the header. "company" is the Super Admin's and the SFE Manager's, "team" a district manager's. */
  mode: PlaceCheckNotesMode;
  /** Every comment and recommendation on this page's subjects, keyed by `placeNoteSubjectKey`. */
  noteIndex: PlaceNoteIndex;
  pending: ValidationReviewRow[];
  decided: ValidationReviewRow[];
  validated: ValidatedPlaceRow[];
  /** Customers sent back to To validate and not captured again since — oldest wait first. */
  reopened: ReopenedCustomerRow[];
  /** Every polyclinic and centre in use, waiting for a decision, or rejected and still restorable. */
  sharedPlaces: SharedPlaceBoardRow[];
  /** Which reads stopped at their ceiling, so the page says "showing the newest" instead of lying. */
  capped: { reviews: boolean; validated: boolean; reopened: boolean; sharedPlaces: boolean };
  /**
   * The one-by-one review (owner, 2026-10-18), handed in by the Super Admin's page and drawn on his
   * board alone. It is a render prop rather than an import so the review is in none of the portal's
   * bundles; the board hands it what each of its tabs holds right now, filters applied.
   */
  reviewDeck?: (input: PlaceReviewDeckInput) => ReactNode;
}) {
  const [filters, setFilters] = useState<ValidationReviewFilters>(EMPTY_VALIDATION_REVIEW_FILTERS);
  const [view, setView] = useState<PlaceCheckView>("needs");
  const [chip, setChip] = useState<UnconfirmedChip>("open");
  const [showRejectedBuildings, setShowRejectedBuildings] = useState(false);
  // The comparison reads every validated place, so it starts on the tab's first opening and then stays
  // mounted — switching tabs must not read it again.
  const [samePlaceOpened, setSamePlaceOpened] = useState(false);
  const [sameCustomerOpened, setSameCustomerOpened] = useState(false);
  const set = <Key extends keyof ValidationReviewFilters>(key: Key, value: ValidationReviewFilters[Key]) =>
    setFilters((current) => ({ ...current, [key]: value }));

  const pending = useMemo(() => pendingRows.filter(isReal), [pendingRows]);
  // 🔴 THE PAGE MAY HAND EVERY DECISION EVER MADE (`everyDecision`), and the board shows the older ones
  // only while a decider is chosen — so "Decided by Khaled Bedair" answers for all of his, and with
  // nobody chosen the board is the recent window it always was.
  const everyDecided = useMemo(() => decidedRows.filter(isReal), [decidedRows]);
  const decided = useMemo(
    () => (filters.decider ? everyDecided : everyDecided.filter((row) => row.recent)),
    [everyDecided, filters.decider],
  );
  const validated = useMemo(() => validatedRows.filter(isReal), [validatedRows]);
  const reopened = useMemo(() => reopenedRows.filter(isReal), [reopenedRows]);
  const sharedPlaces = useMemo(() => venueRows.filter(isReal), [venueRows]);

  const everyRow = useMemo<ValidationReviewFilterable[]>(() => [...pending, ...decided, ...validated], [pending, decided, validated]);
  // A venue's own rep, line, region and area belong in the dropdowns too: a rep who has captured a
  // polyclinic and nothing else would otherwise be unreachable from the Rep box, and his venue could
  // only be found by typing in the search field.
  const reps = useMemo(
    () => distinctValues([...everyRow.map((row) => row.repName), ...sharedPlaces.map((row) => row.repName)]),
    [everyRow, sharedPlaces],
  );
  const lines = useMemo(() => distinctValues([...everyRow.map((row) => row.line), ...sharedPlaces.map((row) => row.line)]), [everyRow, sharedPlaces]);
  const regions = useMemo(
    () => distinctValues([...everyRow.map((row) => row.region), ...sharedPlaces.map((row) => row.region)]),
    [everyRow, sharedPlaces],
  );
  const areas = useMemo(
    () => distinctValues([...everyRow.map((row) => row.areaName), ...sharedPlaces.map((row) => row.areaName)]),
    [everyRow, sharedPlaces],
  );
  const lists = useMemo(() => distinctValues(everyRow.map((row) => row.listType)), [everyRow]);
  // Everybody who has decided anything this board holds — a person, or "The system". A manager's board
  // never names a decider, so it gets no list and no box.
  const deciders = useMemo(
    () =>
      mode === "team"
        ? []
        : distinctValues([
            ...everyDecided.map((row) => row.decidedByName),
            ...validated.map((row) => row.decidedByName),
            ...reopened.map((row) => row.refusedByName),
            ...sharedPlaces.map((row) => row.decidedByName),
          ]),
    [mode, everyDecided, validated, reopened, sharedPlaces],
  );

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
  const inUse = useMemo(
    () =>
      clinicValidated.filter(
        (row) =>
          validatedPassesOutcome(row, filters.outcome) &&
          decidedByMatches(row.decidedByName, filters.decider) &&
          matchesValidationReviewFilters(row, filters) &&
          withinValidationReviewPeriod(row.validatedAt, cutoff),
      ),
    [clinicValidated, filters, cutoff],
  );
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
  const needsGroups = useMemo(() => filteredVenueGroups.filter((group) => venueNeedsDecision(group)), [filteredVenueGroups]);

  // The scorecard reads every rep's places through the same filters, the clinics and the seated alike.
  const scorecard = useMemo(
    () =>
      placeCheckScorecard({
        waiting: pending.filter(
          (row) => decidedByMatches(null, filters.decider) && matchesValidationReviewFilters(row, filters) && withinValidationReviewPeriod(row.createdAt, cutoff),
        ),
        inUse: validated.filter(
          (row) =>
            decidedByMatches(row.decidedByName, filters.decider) &&
            matchesValidationReviewFilters(row, filters) &&
            withinValidationReviewPeriod(row.validatedAt, cutoff),
        ),
        reopened: reopened.filter(
          (row) =>
            decidedByMatches(row.refusedByName, filters.decider) &&
            matchesValidationReviewFilters(filterableReopened(row), filters) &&
            withinValidationReviewPeriod(row.reopenedAt, cutoff),
        ),
      }),
    [pending, validated, reopened, filters, cutoff],
  );

  const anyFilter = hasActiveValidationReviewFilter(filters);
  // 🔴 EVERY SENTENCE BELOW THAT NAMES A DECISION IS BEHIND THIS FLAG. A manager's board must not say
  // "waiting for your decision", must not explain what approving or refusing does, and must not name
  // who settled a row — the three places this board used to state the decision out loud.
  const team = mode === "team";
  const showWaiting = filters.outcome === "all" || filters.outcome === "pending";
  const showDecided = filters.outcome === "all" || filters.outcome === "approved" || filters.outcome === "rejected";
  const showValidated = filters.outcome === "all" || filters.outcome === "validated" || filters.outcome === "unseen";
  const showReopened = filters.outcome === "all" || filters.outcome === "rejected";

  // What the system recommends across every open decision on the Needs you tab.
  const advice = useMemo<PlaceCheckAdvice[]>(() => {
    if (team) return [];
    const clinics = showWaiting ? filteredPending.map((row) => adviseOnReview(row)) : [];
    const buildings = needsGroups.flatMap((group) => [
      ...(group.venue.status === "held" ? [adviseOnBuilding(group.venue)] : []),
      ...group.customers.filter((customer) => customer.state === "waiting").map((customer) => adviseOnTimetable(customer.timetable, group.venue.timetableExempt !== null)),
    ]);
    return [...clinics, ...buildings];
  }, [team, showWaiting, filteredPending, needsGroups]);

  // What the one-by-one review is built from: each tab's rows as the board shows them now, and, to look
  // a row up after a decision moved it, every row the board holds with every customer in each building.
  const withDeck = !team && reviewDeck !== undefined;
  const everyVenueGroup = useMemo(
    () => (withDeck ? narrowVenueGroups({ venues: sharedPlaces, seated, filters: EMPTY_VALIDATION_REVIEW_FILTERS, cutoff: null }) : []),
    [withDeck, sharedPlaces, seated],
  );
  const deckInput = useMemo<PlaceReviewDeckInput | null>(
    () =>
      withDeck
        ? {
            boardView: view,
            noteIndex,
            waiting: { reviews: showWaiting ? filteredPending : [], venues: needsGroups },
            unconfirmed: { places: filteredValidated, venues: buildingGroups.filter((group) => group.venue.status === "active") },
            history: { reviews: showDecided ? filteredDecided : [], venues: filteredVenueGroups.filter((group) => group.venue.status === "retired") },
            lookup: { reviews: [...pending, ...decided], places: validated, venues: everyVenueGroup },
          }
        : null,
    [withDeck, view, noteIndex, showWaiting, filteredPending, needsGroups, filteredValidated, buildingGroups, showDecided, filteredDecided, filteredVenueGroups, pending, decided, validated, everyVenueGroup],
  );

  const needsCount = (showWaiting ? filteredPending.length : 0) + needsGroups.length;
  const openCount = (showWaiting ? filteredPending.length : 0) + needsGroups.length;
  const historyCount = (showDecided ? filteredDecided.length : 0) + (showReopened ? filteredReopened.length : 0);
  const unconfirmedCount = showValidated ? inUse.filter((row) => chipTakes("open", row)).length : 0;
  const decidedTitle = decidedSectionTitle(filters, team);

  // The filter signature remounts every paged list so "Show more" starts over when a filter changes,
  // rather than keeping a page offset from the wider set.
  const filterKey = `${filters.outcome}|${filters.rep}|${filters.line}|${filters.region}|${filters.area}|${filters.list}|${filters.period}|${filters.decider}|${filters.text}`;
  const validatedKey = `${filterKey}|${chip}`;

  // 🔴 THE COMPARISON TAB IS THE SUPER ADMIN'S ALONE: a manager's board is `mode="team"` and is never
  // handed the tab, the panel or the read (the route refuses a manager as well).
  const tabs: ReadonlyArray<{ key: PlaceCheckView; label: string; count: number | null; open: number }> = [
    { key: "needs", label: team ? "Being checked" : "Needs you", count: needsCount, open: openCount },
    { key: "unconfirmed", label: "Not confirmed", count: unconfirmedCount, open: 0 },
    { key: "polyclinics", label: "Polyclinics and hospitals", count: buildingGroups.length, open: 0 },
    ...(team ? [] : [{ key: "samePlace" as const, label: "Same place, several reps", count: null, open: 0 }]),
    ...(team ? [] : [{ key: "sameCustomer" as const, label: "Same customer, several reps", count: null, open: 0 }]),
    { key: "history", label: "History", count: historyCount, open: 0 },
  ];
  const selectView = (key: PlaceCheckView) => {
    setView(key);
    if (key === "samePlace") setSamePlaceOpened(true);
    if (key === "sameCustomer") setSameCustomerOpened(true);
  };
  // A tapped count opens exactly its rows: that rep (or every rep), the tab and narrowing that hold them,
  // and every outcome — the scorecard never reads the outcome selector, so its counts would not match.
  const openScore = (rep: string, target: ScoreTarget) => {
    const place = placeOfTarget(target);
    setFilters((current) => ({ ...current, rep, outcome: "all" }));
    if (place.chip) setChip(place.chip);
    selectView(place.view);
    window.setTimeout(() => document.getElementById(`vr-tab-${place.view}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
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

  return (
    <CrmSurfaceProvider surface="admin">
      <div className="space-y-5">
        {deckInput && reviewDeck ? reviewDeck(deckInput) : null}
        <div className="min-w-0 border border-slate-200 bg-white px-4 py-4">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-black uppercase tracking-[0.12em] text-slate-500">Filters</h2>
            {anyFilter || filters.outcome !== "all" ? (
              <CrmButton onClick={() => setFilters(EMPTY_VALIDATION_REVIEW_FILTERS)} size="sm" variant="ghost">
                Clear filters
              </CrmButton>
            ) : null}
          </div>
          <div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <CrmField htmlFor="vr-outcome" label="Outcome">
              <CrmSelect id="vr-outcome" onChange={(event) => set("outcome", event.target.value as ValidationReviewOutcome)} value={filters.outcome}>
                {(Object.keys(OUTCOME_LABELS) as ValidationReviewOutcome[]).map((value) => (
                  <option key={value} value={value}>
                    {OUTCOME_LABELS[value]}
                  </option>
                ))}
              </CrmSelect>
            </CrmField>

            <CrmField htmlFor="vr-rep" label="Rep">
              <CrmSelect id="vr-rep" onChange={(event) => set("rep", event.target.value)} value={filters.rep}>
                <option value="">Every rep</option>
                {reps.map((rep) => (
                  <option key={rep} value={rep}>
                    {rep}
                  </option>
                ))}
              </CrmSelect>
            </CrmField>

            <CrmField htmlFor="vr-line" label="Line">
              <CrmSelect id="vr-line" onChange={(event) => set("line", event.target.value)} value={filters.line}>
                <option value="">Every line</option>
                {lines.map((line) => (
                  <option key={line} value={line}>
                    {line}
                  </option>
                ))}
              </CrmSelect>
            </CrmField>

            <CrmField htmlFor="vr-region" label="Region">
              <CrmSelect id="vr-region" onChange={(event) => set("region", event.target.value)} value={filters.region}>
                <option value="">Every region</option>
                {regions.map((region) => (
                  <option key={region} value={region}>
                    {region}
                  </option>
                ))}
              </CrmSelect>
            </CrmField>

            <CrmField htmlFor="vr-area" label="Area">
              <CrmSelect id="vr-area" onChange={(event) => set("area", event.target.value)} value={filters.area}>
                <option value="">Every area</option>
                {areas.map((area) => (
                  <option key={area} value={area}>
                    {area}
                  </option>
                ))}
              </CrmSelect>
            </CrmField>

            <CrmField htmlFor="vr-list" label="List">
              <CrmSelect id="vr-list" onChange={(event) => set("list", event.target.value)} value={filters.list}>
                <option value="">Every list</option>
                {lists.map((list) => (
                  <option key={list} value={list}>
                    {list}
                  </option>
                ))}
              </CrmSelect>
            </CrmField>

            <CrmField htmlFor="vr-period" label="Period">
              <CrmSelect id="vr-period" onChange={(event) => set("period", event.target.value as ValidationReviewPeriod)} value={filters.period}>
                {(Object.keys(PERIOD_LABELS) as ValidationReviewPeriod[]).map((value) => (
                  <option key={value} value={value}>
                    {PERIOD_LABELS[value]}
                  </option>
                ))}
              </CrmSelect>
            </CrmField>

            {team ? null : (
              <CrmField htmlFor="vr-decider" label="Decided by">
                <CrmSelect id="vr-decider" onChange={(event) => set("decider", event.target.value)} value={filters.decider}>
                  <option value="">Anyone</option>
                  {deciders.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </CrmSelect>
              </CrmField>
            )}
          </div>
          <div className="mt-3 min-w-0 lg:max-w-md">
            <CrmSearchField
              id="vr-search"
              label="Search"
              onChange={(next) => set("text", next)}
              placeholder="Customer, rep, territory, brick or area"
              value={filters.text}
            />
          </div>
        </div>

        {capped.reviews || capped.validated || capped.reopened || capped.sharedPlaces ? (
          <AdminCallout tone="warning">
            <span>
              This page is showing the newest rows only: there are more than it can hold in one read. Narrow the period or the
              filters to reach the older ones.
            </span>
          </AdminCallout>
        ) : null}

        <PlaceCheckScorecard
          mode={mode}
          onOpen={openScore}
          onPickRep={(rep) => set("rep", rep)}
          pickedRep={filters.rep}
          reps={scorecard.reps}
          total={scorecard.total}
        />

        <div aria-label="Place checks" className="flex min-w-0 flex-wrap border-b border-slate-200" role="tablist">
          {tabs.map(({ key, label, count, open }, index) => (
            <button
              key={key}
              aria-controls={view === key ? `vr-panel-${key}` : undefined}
              aria-selected={view === key}
              className={cn(
                "-mb-px inline-flex min-h-11 min-w-0 flex-wrap items-center gap-2 rounded-none border-b-2 px-4 py-2.5 text-left text-sm font-black",
                view === key ? "border-orange-500 text-slate-900" : "border-transparent text-slate-500 hover:text-slate-700",
              )}
              id={`vr-tab-${key}`}
              onClick={() => selectView(key)}
              onKeyDown={(event) => moveTab(event, index)}
              role="tab"
              tabIndex={view === key ? 0 : -1}
              type="button"
            >
              <span className="break-words">
                {label}
                {count === null ? "" : ` (${count})`}
              </span>
              {open > 0 ? <CrmPill tone="warn">{open} {team ? "being checked" : "waiting"}</CrmPill> : null}
            </button>
          ))}
        </div>

        {view === "needs" ? (
          <div aria-labelledby="vr-tab-needs" className="space-y-5" id="vr-panel-needs" role="tabpanel">
            {team ? null : <AdviceSummary advice={advice} />}
            {showWaiting ? (
              <AdminTableShell
                title={team ? `Still being checked (${filteredPending.length})` : `Waiting for your decision (${filteredPending.length})`}
                description={
                  team
                    ? "The places the system could not settle by itself: Google has no listing it is sure is the customer, its pin is far from where the rep stood, or the signboard names somebody else — or nobody. Each one's evidence is below, and the rep knows only that the system is checking."
                    : "Approve validates the place in the rep's name, and a customer already on the rep's list starts counting. It does not add anybody to the list: a customer outside it stays outside until the rep asks to add them and that request is approved on its own. Reject retires the place; when it was their only one, the customer goes back to To validate. The rep reads either as the system's answer."
                }
              >
                {filteredPending.length === 0 ? (
                  <div className="px-4 py-4">
                    <AdminCallout tone="success">
                      <span>
                        {anyFilter
                          ? "Nothing waiting matches these filters."
                          : team
                            ? "Nothing of your team's is still being checked — every place has matched its listing, been refused at the door, or been settled."
                            : "Nothing is waiting — every place has matched its listing, been refused at the door, or been decided by you."}
                      </span>
                    </AdminCallout>
                  </div>
                ) : (
                  <Paged key={filterKey} noun="places" rows={filteredPending} size={PAGE_ROWS}>
                    {(rows) => <ValidationReviewQueue mode={mode} noteIndex={noteIndex} rows={rows} section="waiting" />}
                  </Paged>
                )}
              </AdminTableShell>
            ) : null}

            <AdminTableShell
              title={team ? `Polyclinics still being checked (${needsGroups.length})` : `Polyclinics waiting for your decision (${needsGroups.length})`}
              description={
                team
                  ? "A building held at its door, or a customer seated in it whose timetable could not answer for them."
                  : "A building held at its door, or a customer seated in it whose timetable does not name them or could not be read. Each building is shown whole, with its sign, its timetable and everybody seated in it."
              }
            >
              {needsGroups.length === 0 ? (
                <div className="px-4 py-4">
                  <AdminCallout tone="success">
                    <span>{anyFilter ? "No polyclinic waiting matches these filters." : "No polyclinic or seated customer is waiting."}</span>
                  </AdminCallout>
                </div>
              ) : (
                <Paged key={filterKey} noun="buildings" rows={needsGroups} size={PAGE_BUILDINGS}>
                  {(groups) => <SharedPlaceList groups={groups} mode={mode} noteIndex={noteIndex} />}
                </Paged>
              )}
            </AdminTableShell>
          </div>
        ) : null}

        {view === "unconfirmed" ? (
          <div aria-labelledby="vr-tab-unconfirmed" className="space-y-3" id="vr-panel-unconfirmed" role="tabpanel">
            <div aria-label="Narrow the places in use" className="flex min-w-0 flex-wrap gap-2" role="group">
              {(Object.keys(CHIP_LABELS) as UnconfirmedChip[]).map((key) => {
                const total = inUse.filter((row) => chipTakes(key, row)).length;
                return (
                  <button
                    key={key}
                    aria-pressed={chip === key}
                    className={cn(
                      "inline-flex min-h-10 min-w-0 items-center gap-2 rounded-none border px-3 py-1.5 text-left text-xs font-black",
                      chip === key ? "border-orange-500 bg-orange-50 text-orange-800" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300",
                    )}
                    onClick={() => setChip(key)}
                    type="button"
                  >
                    <span className="break-words">{CHIP_LABELS[key]}</span>
                    <span className="tabular-nums">{total}</span>
                  </button>
                );
              })}
            </div>
            {seatedInChip > 0 ? (
              <div className="flex min-w-0 flex-wrap items-center gap-3 border-l-4 border-orange-500 bg-white px-4 py-3">
                <p className="min-w-0 flex-1 basis-60 break-words text-sm text-slate-700">
                  {seatedInChip} more {seatedInChip === 1 ? "is a customer" : "are customers"} seated in a polyclinic. Their photo is the
                  building&apos;s timetable, shown once on its card.
                </p>
                <CrmButton onClick={() => selectView("polyclinics")} size="sm">
                  Open Polyclinics and hospitals
                </CrmButton>
              </div>
            ) : null}
            {showValidated ? (
              <AdminTableShell
                title={`${CHIP_TITLES[chip]} (${filteredValidated.length})`}
                description={
                  team
                    ? "Single clinics still in use whose photograph the system could not confirm: the sign could not be read, it is not a sign, it names somebody else, or it was never read. Turn a sideways photo with the arrows on it, and open it to zoom."
                    : "Single clinics still in use whose photograph the system could not confirm, and that nobody has looked at: the sign could not be read, it is not a sign, it names somebody else, or it was never read. Turn a sideways photo with the arrows on it, and open it to zoom. Refusing one retires the place and, when it is the customer's only place, sends them back to To validate; the rep is told what is wrong with the photo and never that a person looked at them."
                }
              >
                {filteredValidated.length === 0 ? (
                  <div className="px-4 py-4">
                    <AdminCallout tone="success">
                      <span>{anyFilter ? "Nothing in use matches these filters." : "Nothing here: every clinic in use has been confirmed by its sign or looked at."}</span>
                    </AdminCallout>
                  </div>
                ) : (
                  <ValidatedPlaceList key={validatedKey} mode={mode} noteIndex={noteIndex} rows={filteredValidated} showSearch={false} />
                )}
              </AdminTableShell>
            ) : (
              <AdminCallout tone="neutral">
                <span>The outcome selected above holds no place in use.</span>
              </AdminCallout>
            )}
          </div>
        ) : null}

        {view === "polyclinics" ? (
          <div aria-labelledby="vr-tab-polyclinics" className="space-y-3" id="vr-panel-polyclinics" role="tabpanel">
            {rejectedBuildings > 0 && filters.outcome !== "rejected" ? (
              <CrmCheck checked={showRejectedBuildings} onChange={setShowRejectedBuildings}>
                {team
                  ? `Show the ${rejectedBuildings} ${rejectedBuildings === 1 ? "building" : "buildings"} no longer in use`
                  : `Show the ${rejectedBuildings} rejected ${rejectedBuildings === 1 ? "building" : "buildings"}, which can be brought back`}
              </CrmCheck>
            ) : null}
            <AdminTableShell
              title={`Polyclinics and hospitals (${buildingGroups.length})`}
              description={
                team
                  ? "A polyclinic, medical centre or hospital outpatient suite is validated ONCE, at its own door — a live photo of the sign on the building and both readings inside the place line — and every customer who receives behind that door is then seated in it against the building's one timetable. Each building is one card: its name and where it is, the sign on its door and its timetable, then the customers seated in it with what that timetable says about each. The buildings with something open or wrong come first."
                  : "A polyclinic, medical centre or hospital outpatient suite is validated ONCE, at its own door — a live photo of the sign on the building and both readings inside the place line — and every customer who receives behind that door is then seated in it against the building's one timetable. Each building is one card: its name and where it is, the sign on its door and its timetable, then the customers seated in it with what that timetable says about each. The buildings with something open or wrong come first. Rejecting a building retires it, retires everybody seated in it, and sends each of them back to To validate. A customer the timetable does not name is rejected on their own row, which leaves the building and everybody else seated in it alone."
              }
            >
              {buildingGroups.length === 0 ? (
                <div className="px-4 py-4">
                  <AdminCallout tone="neutral">
                    <span>{anyFilter || filters.outcome !== "all" ? "No polyclinic or hospital matches these filters." : "No polyclinic or centre has been captured yet."}</span>
                  </AdminCallout>
                </div>
              ) : (
                <Paged key={`${filterKey}|${showRejectedBuildings}`} noun="buildings" rows={buildingGroups} size={PAGE_BUILDINGS}>
                  {(groups) => <SharedPlaceList groups={groups} mode={mode} noteIndex={noteIndex} />}
                </Paged>
              )}
            </AdminTableShell>
            <p className="break-words text-xs text-slate-500">
              {filteredVenueGroups.length} {filteredVenueGroups.length === 1 ? "building" : "buildings"} on the board in all.
            </p>
          </div>
        ) : null}

        {!team && samePlaceOpened ? (
          <div aria-labelledby="vr-tab-samePlace" hidden={view !== "samePlace"} id="vr-panel-samePlace" role="tabpanel">
            <PlaceMatchBoardView filters={filters} />
          </div>
        ) : null}

        {!team && sameCustomerOpened ? (
          <div aria-labelledby="vr-tab-sameCustomer" hidden={view !== "sameCustomer"} id="vr-panel-sameCustomer" role="tabpanel">
            <CustomerMatchBoardView filters={filters} />
          </div>
        ) : null}

        {view === "history" ? (
          <div aria-labelledby="vr-tab-history" className="space-y-5" id="vr-panel-history" role="tabpanel">
            {showDecided ? (
              <AdminTableShell
                title={`${decidedTitle} (${filteredDecided.length})`}
                description={
                  team
                    ? "What has been settled, the one sentence the rep was told about the photograph, and any comment on it."
                    : "What was approved or rejected, by whom, with the comment the rep and their manager read."
                }
              >
                {filteredDecided.length === 0 ? (
                  <div className="px-4 py-4">
                    <AdminCallout tone="neutral">
                      <span>
                        {anyFilter
                          ? `Nothing ${team ? "settled" : "decided"} matches these filters.`
                          : `Nothing has been ${team ? "settled" : "decided"} in the last 14 days.`}
                      </span>
                    </AdminCallout>
                  </div>
                ) : (
                  <Paged key={filterKey} noun="places" rows={filteredDecided} size={PAGE_ROWS}>
                    {(rows) => <ValidationReviewQueue mode={mode} noteIndex={noteIndex} rows={rows} section="decided" />}
                  </Paged>
                )}
              </AdminTableShell>
            ) : null}

            {showReopened ? (
              <AdminTableShell
                title={`Waiting to be captured again (${filteredReopened.length})`}
                description="Customers sent back to To validate because their place was refused, and not validated again since — the longest wait first. The rep was told what is wrong with the photo and nothing else."
              >
                {filteredReopened.length === 0 ? (
                  <div className="px-4 py-4">
                    <AdminCallout tone="success">
                      <span>{anyFilter ? "Nobody waiting matches these filters." : "Nobody is waiting to be captured again."}</span>
                    </AdminCallout>
                  </div>
                ) : (
                  <Paged key={filterKey} noun="customers" rows={filteredReopened} size={PAGE_ROWS}>
                    {(rows) => <ReopenedCustomerList mode={mode} rows={rows} />}
                  </Paged>
                )}
              </AdminTableShell>
            ) : null}
          </div>
        ) : null}
      </div>
    </CrmSurfaceProvider>
  );
}
