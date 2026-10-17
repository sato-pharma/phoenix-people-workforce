/**
 * Phoenix CRM — Place checks, a polyclinic and the customers seated in it, as ONE group (owner,
 * 2026-10-17: "in place checks separate the polyclinics/hospitals checks than normal clinic steps and
 * make sure every polyclinic is grouped with the customers in it, showing the polyclinic's own photo
 * validation and the timetable, and make the option for the admin to reject a customer who is not in
 * the timetable").
 *
 * Pure and screen-free, like `validation-review-filters.ts`, so the board stays a thin shell and the
 * rules here are pinned by a test. A seated customer is an ordinary place row with a `shared_place_id`;
 * the board's four sets (waiting, decided, in use, sent back) already carry him, each under its own
 * section among the single clinics. This file lifts him out of those sets, files him under his
 * building, and answers which of the two tabs every row belongs to.
 *
 * 🔴 A ROW IS TAKEN OUT OF THE CLINICS VIEW ONLY WHEN ITS BUILDING IS ON THE BOARD. The venue read keeps
 * a rejected building for 90 days; a customer whose building has aged out of it, or whose place row
 * names a building that was never read, stays among the clinics where he can still be found. Hiding him
 * because "he is seated" would make him unreachable from either tab.
 */

import {
  EMPTY_VALIDATION_REVIEW_FILTERS,
  matchesSharedPlaceFilters,
  matchesValidationReviewFilters,
  sharedPlacePassesOutcome,
  withinValidationReviewPeriod,
  type ValidationReviewFilterable,
  type ValidationReviewFilters,
  type ValidationReviewOutcome,
} from "@/lib/phoenix-crm/validation-review-filters";
import type { ReopenedCustomerRow, SharedPlaceBoardRow, ValidatedPlaceRow, ValidationReviewRow } from "@/lib/phoenix-crm/view-types";

/**
 * Where a seated customer stands:
 * - `waiting`   — the system held him (the timetable does not name him, or names nobody) and a decision is open;
 * - `in_use`    — his place is active, whether he was approved or the system never questioned him;
 * - `rejected`  — he was refused and the refusal can still be taken back;
 * - `sent_back` — his building was refused, so he is waiting to be captured again.
 */
export type SeatedState = "waiting" | "in_use" | "rejected" | "sent_back";

/** What the system read beside this customer's name on the building's timetable. */
export type SeatedTimetable = {
  verdict: "match" | "other_name" | "no_schedule" | "unjudged";
  scheduleText: string | null;
  hoursRead: string | null;
};

export type SeatedCustomer = ValidationReviewFilterable & {
  /** Unique within the board: the place when there is one, the customer for a sent-back row. */
  key: string;
  sharedPlaceId: string;
  state: SeatedState;
  isTest: boolean;
  /** The row's own date, for the period filter and the sort. */
  at: string;
  atText: string;
  placeId: string | null;
  /** The review row a decision is made on, when there is one. Null is "nobody has ever looked at him". */
  reviewId: string | null;
  reviewStatus: "pending" | "approved" | "rejected" | null;
  /** Whether ANY review row exists for his place. False is "never looked at" — the Never looked at outcome. */
  reviewed: boolean;
  /** An approval that can still be taken back: rejecting it again has a place to retire. */
  refusable: boolean;
  /** A rejection that can still be taken back. */
  restorable: boolean;
  /** Visits measured against his place, and the places he would keep — only a validated row knows them. */
  visits: number | null;
  otherPlaces: number | null;
  timetable: SeatedTimetable | null;
  /** His own copy of the timetable photo. The building holds one for everybody, so it is usually the same path. */
  photoPath: string | null;
  /** What was wrong with the photo, as chosen — for a rejected or sent-back customer. */
  reasonLabel: string | null;
  decidedByName: string | null;
  decidedAtText: string | null;
  decisionNote: string | null;
  /** Whole hours since he went back to To validate, for a sent-back customer. */
  waitingHours: number | null;
};

export type VenueGroup = {
  venue: SharedPlaceBoardRow;
  /** The customers that pass the filters, waiting first. */
  customers: SeatedCustomer[];
  /** Every customer filed under this building, before the filters — the header says "3 of 7" when they differ. */
  total: number;
};

function timetableOfReview(row: ValidationReviewRow): SeatedTimetable | null {
  if (row.reason === "schedule_other_name") return { verdict: "other_name", scheduleText: row.signText, hoursRead: row.hoursRead };
  if (row.reason === "schedule_missing") return { verdict: "no_schedule", scheduleText: row.signText, hoursRead: row.hoursRead };
  return row.photoKind === "schedule" && row.signText ? { verdict: "unjudged", scheduleText: row.signText, hoursRead: row.hoursRead } : null;
}

function filterableOf(row: ValidationReviewFilterable): ValidationReviewFilterable {
  return {
    repName: row.repName,
    line: row.line,
    region: row.region,
    listType: row.listType,
    customerName: row.customerName,
    territory: row.territory,
    speciality: row.speciality,
    placeLabel: row.placeLabel,
    address: row.address,
    brickName: row.brickName,
    areaName: row.areaName,
  };
}

function fromReview(row: ValidationReviewRow, sharedPlaceId: string, state: SeatedState): SeatedCustomer {
  return {
    ...filterableOf(row),
    key: row.placeId,
    sharedPlaceId,
    state,
    isTest: row.isTest,
    at: row.createdAt,
    atText: row.createdAtText,
    placeId: row.placeId,
    reviewId: row.reviewId,
    reviewStatus: row.status,
    reviewed: true,
    refusable: row.refusable,
    restorable: row.restorable,
    visits: null,
    otherPlaces: null,
    timetable: timetableOfReview(row),
    photoPath: row.photoPath,
    reasonLabel: row.refusalLabel,
    decidedByName: row.decidedByName,
    decidedAtText: row.decidedAtText,
    decisionNote: row.decisionNote,
    waitingHours: null,
  };
}

function fromValidated(row: ValidatedPlaceRow, sharedPlaceId: string): SeatedCustomer {
  return {
    ...filterableOf(row),
    key: row.placeId,
    sharedPlaceId,
    state: "in_use",
    isTest: row.isTest,
    at: row.validatedAt,
    atText: row.validatedAtText,
    placeId: row.placeId,
    reviewId: null,
    reviewStatus: null,
    reviewed: row.reviewed,
    refusable: false,
    restorable: false,
    visits: row.visits,
    otherPlaces: row.otherPlaces,
    timetable: row.schedule,
    photoPath: row.photoPath,
    reasonLabel: null,
    decidedByName: null,
    decidedAtText: null,
    decisionNote: null,
    waitingHours: null,
  };
}

function fromReopened(row: ReopenedCustomerRow, sharedPlaceId: string): SeatedCustomer {
  return {
    repName: row.repName,
    line: row.line,
    region: row.region,
    listType: row.listType,
    customerName: row.customerName,
    territory: row.territory,
    speciality: null,
    placeLabel: null,
    address: null,
    brickName: null,
    areaName: null,
    key: `customer-${row.customerId}`,
    sharedPlaceId,
    state: "sent_back",
    isTest: row.isTest,
    at: row.reopenedAt,
    atText: row.reopenedAtText,
    placeId: null,
    reviewId: null,
    reviewStatus: null,
    reviewed: true,
    refusable: false,
    restorable: false,
    visits: null,
    otherPlaces: null,
    timetable: null,
    photoPath: null,
    reasonLabel: row.reasonLabel,
    decidedByName: null,
    decidedAtText: null,
    decisionNote: null,
    waitingHours: row.waitingHours,
  };
}

const STATE_ORDER: Record<SeatedState, number> = { waiting: 0, in_use: 1, rejected: 2, sent_back: 3 };

function byStateThenName(left: SeatedCustomer, right: SeatedCustomer): number {
  return STATE_ORDER[left.state] - STATE_ORDER[right.state] || left.customerName.localeCompare(right.customerName);
}

/**
 * Every customer seated in a building on the board, filed under it. `venueIds` is the set of buildings
 * the board holds — a row naming any other building is not returned here and stays among the clinics.
 *
 * An in-use place and the approved review written for it are ONE customer, joined by the place: the
 * review carries the id a decision is made on, the place carries the visits and the timetable read.
 */
export function seatedCustomersByVenue(input: {
  pending: ReadonlyArray<ValidationReviewRow>;
  decided: ReadonlyArray<ValidationReviewRow>;
  validated: ReadonlyArray<ValidatedPlaceRow>;
  reopened: ReadonlyArray<ReopenedCustomerRow>;
  venueIds: ReadonlySet<string>;
}): Map<string, SeatedCustomer[]> {
  const byVenue = new Map<string, SeatedCustomer[]>();
  const file = (customer: SeatedCustomer) => {
    const list = byVenue.get(customer.sharedPlaceId);
    if (list) list.push(customer);
    else byVenue.set(customer.sharedPlaceId, [customer]);
  };
  const known = (id: string | null): id is string => id !== null && input.venueIds.has(id);

  const approved = new Map<string, ValidationReviewRow>();
  for (const row of input.decided) {
    if (known(row.sharedPlaceId) && row.status === "approved") approved.set(row.placeId, row);
  }

  const placed = new Set<string>();
  for (const row of input.validated) {
    if (!known(row.sharedPlaceId)) continue;
    const customer = fromValidated(row, row.sharedPlaceId);
    const review = approved.get(row.placeId);
    if (review) {
      customer.reviewId = review.reviewId;
      customer.reviewStatus = "approved";
      customer.reviewed = true;
      customer.refusable = review.refusable;
      customer.decidedByName = review.decidedByName;
      customer.decidedAtText = review.decidedAtText;
      customer.decisionNote = review.decisionNote;
      customer.timetable ??= timetableOfReview(review);
    }
    placed.add(row.placeId);
    file(customer);
  }
  // An approval the validated read did not return (it stopped at its ceiling) is still a customer who can
  // be rejected after all, so it is filed from the review alone rather than lost.
  for (const [placeId, review] of approved) {
    if (placed.has(placeId) || !review.refusable || !known(review.sharedPlaceId)) continue;
    file(fromReview(review, review.sharedPlaceId, "in_use"));
  }
  for (const row of input.pending) {
    if (known(row.sharedPlaceId)) file(fromReview(row, row.sharedPlaceId, "waiting"));
  }
  for (const row of input.decided) {
    if (row.status === "rejected" && known(row.sharedPlaceId)) file(fromReview(row, row.sharedPlaceId, "rejected"));
  }
  for (const row of input.reopened) {
    if (known(row.sharedPlaceId)) file(fromReopened(row, row.sharedPlaceId));
  }
  for (const list of byVenue.values()) list.sort(byStateThenName);
  return byVenue;
}

/**
 * The rows that belong among the single clinics: everything NOT seated in a building the board holds.
 * Generic over the four row types, each of which carries `sharedPlaceId`.
 */
export function withoutSeated<Row extends { sharedPlaceId: string | null }>(rows: ReadonlyArray<Row>, venueIds: ReadonlySet<string>): Row[] {
  return rows.filter((row) => row.sharedPlaceId === null || !venueIds.has(row.sharedPlaceId));
}

/** Whether a seated customer passes the outcome selector — the same words the single clinics answer to. */
export function seatedPassesOutcome(customer: SeatedCustomer, venueHeld: boolean, outcome: ValidationReviewOutcome): boolean {
  if (outcome === "all") return true;
  // A held building keeps everybody seated in it waiting for the building: nobody behind it counts anywhere yet.
  if (venueHeld && customer.state === "in_use") return outcome === "pending";
  if (outcome === "pending") return customer.state === "waiting";
  if (outcome === "approved") return customer.state === "in_use" && customer.reviewStatus === "approved";
  if (outcome === "rejected") return customer.state === "rejected" || customer.state === "sent_back";
  if (outcome === "validated") return customer.state === "in_use";
  return customer.state === "in_use" && !customer.reviewed;
}

function venueTextHit(venue: SharedPlaceBoardRow, text: string): boolean {
  return matchesSharedPlaceFilters(venue, { ...EMPTY_VALIDATION_REVIEW_FILTERS, text });
}

/** A building has something open if it is held itself or any customer behind it is waiting. */
export function venueNeedsDecision(group: Pick<VenueGroup, "venue" | "customers">): boolean {
  return group.venue.status === "held" || group.customers.some((customer) => customer.state === "waiting");
}

/**
 * The buildings the filters leave, each with the customers that pass them.
 *
 * A building is shown when it passes the filters itself, or when any customer behind it does. The text
 * box is read against the building first: a search for the polyclinic's name must show everybody seated
 * in it, not only the customers whose own name happens to contain it. The LIST filter does not reach a
 * building (it is on nobody's list), so when it is set a building is shown only through its customers.
 */
export function narrowVenueGroups(input: {
  venues: ReadonlyArray<SharedPlaceBoardRow>;
  seated: ReadonlyMap<string, SeatedCustomer[]>;
  filters: ValidationReviewFilters;
  cutoff: number | null;
}): VenueGroup[] {
  const { filters, cutoff } = input;
  const groups: VenueGroup[] = [];
  for (const venue of input.venues) {
    const all = input.seated.get(venue.sharedPlaceId) ?? [];
    const hit = filters.text.trim() === "" || venueTextHit(venue, filters.text);
    const customerFilters = hit ? { ...filters, text: "" } : filters;
    const held = venue.status === "held";
    const customers = all.filter(
      (customer) =>
        seatedPassesOutcome(customer, held, filters.outcome) &&
        matchesValidationReviewFilters(customer, customerFilters) &&
        withinValidationReviewPeriod(customer.at, cutoff),
    );
    const itself =
      filters.list === "" &&
      sharedPlacePassesOutcome(venue, filters.outcome) &&
      matchesSharedPlaceFilters(venue, filters) &&
      withinValidationReviewPeriod(venue.capturedAt, cutoff);
    if (!itself && customers.length === 0) continue;
    groups.push({ venue, customers, total: all.length });
  }
  return groups.sort((left, right) => {
    const rank = urgencyOf(left) - urgencyOf(right);
    if (rank !== 0) return rank;
    return String(right.venue.capturedAt).localeCompare(String(left.venue.capturedAt));
  });
}

/** A building that is itself held comes first, then one with a customer waiting, then everything else. */
function urgencyOf(group: Pick<VenueGroup, "venue" | "customers">): number {
  if (group.venue.status === "held") return 0;
  return venueNeedsDecision(group) ? 1 : 2;
}
