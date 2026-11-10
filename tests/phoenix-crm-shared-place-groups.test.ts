import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { decisionStamp } from "../src/lib/phoenix-crm/decision-stamp.ts";
import {
  narrowVenueGroups,
  seatedCustomersByVenue,
  seatedPassesOutcome,
  venueHasProblem,
  venueNeedsDecision,
  withoutSeated,
  type SeatedCustomer,
} from "../src/lib/phoenix-crm/shared-place-groups.ts";
import {
  EMPTY_VALIDATION_REVIEW_FILTERS,
  sharedPlacePassesOutcome,
  type ValidationReviewFilters,
} from "../src/lib/phoenix-crm/validation-review-filters.ts";
import type {
  ReopenedCustomerRow,
  SharedPlaceBoardRow,
  ValidatedPlaceRow,
  ValidationReviewRow,
} from "../src/lib/phoenix-crm/view-types.ts";

/**
 * Phoenix CRM — Place checks, a polyclinic grouped with the customers seated in it (owner, 2026-10-17:
 * "in place checks separate the polyclinics/hospitals checks than normal clinic steps and make sure
 * every polyclinic is grouped with the customers in it, showing the polyclinic itself photo validation
 * and the customers' timetable, and make the option for the admin to reject a customer not in the
 * timetable").
 *
 * The grouping is a pure module, exercised here directly. The board and the lists are client components
 * the harness does not render, so the last section pins by source what they wire.
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n"));
}

function filtersFor(overrides: Partial<ValidationReviewFilters>): ValidationReviewFilters {
  return { ...EMPTY_VALIDATION_REVIEW_FILTERS, ...overrides };
}

function venue(overrides: Partial<SharedPlaceBoardRow>): SharedPlaceBoardRow {
  return {
    sharedPlaceId: "venue-nile",
    name: "Nile Polyclinic",
    kind: "polyclinic",
    kindLabel: "Polyclinic",
    status: "active",
    address: null,
    brickName: null,
    areaName: "Qalubeya",
    point: { lat: 30, lon: 31 },
    seated: 0,
    timetableRefusedToday: 0,
    capturedAt: "2026-10-10T08:00:00.000Z",
    capturedAtText: "10 Oct 2026, 11:00",
    photoPath: "cairo/sign.jpg",
    schedulePhotoPath: "cairo/timetable.jpg",
    schedulePhotoCapturedAtText: "10 Oct 2026, 11:05",
    repName: "Hassan Adel",
    territory: "Cairo 1",
    line: "CNS",
    region: "Cairo",
    isTest: false,
    mapsLink: "https://example.test/maps",
    photo: null,
    pin: null,
    signboard: null,
    decidedAtText: null,
    decidedByName: null,
    decisionNote: null,
    timetableExempt: null,
    restorable: false,
    ...overrides,
  };
}

function review(overrides: Partial<ValidationReviewRow>): ValidationReviewRow {
  return {
    reviewId: "review-1",
    placeId: "place-1",
    status: "pending",
    kind: "validation",
    isTest: false,
    createdAt: "2026-10-12T08:00:00.000Z",
    createdAtText: "12 Oct 2026, 11:00",
    repName: "Hassan Adel",
    territory: "Cairo 1",
    line: "CNS",
    region: "Cairo",
    customerName: "Mona Said",
    listType: "AM",
    speciality: null,
    placeLabel: null,
    address: null,
    brickName: null,
    areaName: "Qalubeya",
    point: { lat: 30, lon: 31 },
    mapsLink: "https://example.test/maps",
    pin: null,
    photo: null,
    photoPath: "cairo/timetable.jpg",
    reason: "schedule_other_name",
    photoKind: "schedule",
    sharedPlaceName: "Nile Polyclinic",
    sharedPlaceId: "venue-nile",
    hoursRead: "Sat 10-2",
    evidence: { checkReason: null, heldBecause: null, legibility: "clear", problem: null, signboard: null },
    signText: "Dr Karim, Dr Salma",
    signNames: [],
    otherSigns: [],
    refusalLabel: null,
    query: null,
    listings: [],
    decidedByName: null,
    decidedAtText: null,
    decidedAt: null,
    decisionNote: null,
    restorable: false,
    refusable: false,
    systemStillReading: false,
    recent: true,
    ...overrides,
  };
}

function validated(overrides: Partial<ValidatedPlaceRow>): ValidatedPlaceRow {
  return {
    placeId: "place-v1",
    customerId: "customer-v1",
    customerName: "Amr Fathy",
    listType: "AM",
    speciality: "Pedia",
    isTest: false,
    repName: "Hassan Adel",
    territory: "Cairo 1",
    line: "CNS",
    region: "Cairo",
    validatedAt: "2026-10-11T08:00:00.000Z",
    validatedAtText: "11 Oct 2026, 11:00",
    placeLabel: null,
    address: null,
    brickName: null,
    areaName: "Qalubeya",
    point: { lat: 30, lon: 31 },
    mapsLink: "https://example.test/maps",
    pin: null,
    photo: null,
    photoPath: "cairo/timetable.jpg",
    visits: 0,
    otherPlaces: 0,
    reviewed: false,
    decidedByName: null,
    decidedAtText: null,
    signboard: null,
    photoKind: "schedule",
    sharedPlaceName: "Nile Polyclinic",
    sharedPlaceId: "venue-nile",
    schedule: { verdict: "match", scheduleText: "Dr Amr Fathy", hoursRead: "Sun 4-8" },
    ...overrides,
  };
}

function reopened(overrides: Partial<ReopenedCustomerRow>): ReopenedCustomerRow {
  return {
    customerId: "customer-z",
    customerName: "Zeinab Ali",
    listType: "PM",
    isTest: false,
    repName: "Hassan Adel",
    territory: "Cairo 1",
    line: "CNS",
    region: "Cairo",
    reopenedAt: "2026-10-14T08:00:00.000Z",
    reopenedAtText: "14 Oct 2026, 11:00",
    waitingHours: 52,
    reasonLabel: "The sign does not name the building",
    refusedByName: null,
    refusedAtText: null,
    sharedPlaceName: "Delta Medical Centre",
    sharedPlaceId: "venue-delta",
    ...overrides,
  };
}

function names(customers: ReadonlyArray<SeatedCustomer> | undefined): string[] {
  return (customers ?? []).map((customer) => customer.customerName);
}

export function runPhoenixCrmSharedPlaceGroupsTests(): void {
  const nile = venue({});
  const delta = venue({
    sharedPlaceId: "venue-delta",
    name: "Delta Medical Centre",
    status: "retired",
    restorable: true,
    capturedAt: "2026-10-08T08:00:00.000Z",
    schedulePhotoPath: null,
    schedulePhotoCapturedAtText: null,
    repName: "Hassan Adel",
  });
  const venueIds = new Set([nile.sharedPlaceId, delta.sharedPlaceId]);

  // ── Every seated customer is filed under his building, whichever of the four sets carried him ──
  const waiting = review({ reviewId: "review-w", placeId: "place-w", customerName: "Mona Said" });
  const approved = review({
    reviewId: "review-a",
    placeId: "place-a",
    status: "approved",
    customerName: "Bassem Nabil",
    refusable: true,
    decidedByName: "Omar Gawish",
    decidedAtText: "13 Oct 2026, 10:00",
  });
  const rejected = review({
    reviewId: "review-r",
    placeId: "place-r",
    status: "rejected",
    customerName: "Rania Hosny",
    sharedPlaceId: "venue-delta",
    restorable: true,
    reason: "refused_by_admin",
    refusalLabel: "The timetable does not name this customer",
  });
  const noVenue = review({ reviewId: "review-n", placeId: "place-n", customerName: "Single Clinic", sharedPlaceId: null, photoKind: "signboard", reason: "listing_far" });
  const elsewhere = review({ reviewId: "review-e", placeId: "place-e", customerName: "Other Building", sharedPlaceId: "venue-gone" });
  const inUse = validated({});
  const inUseApproved = validated({
    placeId: "place-a",
    customerId: "customer-a",
    customerName: "Bassem Nabil",
    reviewed: true,
    schedule: { verdict: "other_name", scheduleText: "Dr Karim", hoursRead: null },
    visits: 3,
    otherPlaces: 1,
  });
  const single = validated({ placeId: "place-single", customerName: "A Clinic", sharedPlaceId: null, sharedPlaceName: null, photoKind: "signboard", schedule: null });
  const sentBack = reopened({});

  const seated = seatedCustomersByVenue({
    pending: [waiting, noVenue, elsewhere],
    decided: [approved, rejected],
    validated: [inUse, inUseApproved, single],
    reopened: [sentBack],
    venueIds,
  });

  assert.deepEqual(names(seated.get("venue-nile")), ["Mona Said", "Amr Fathy", "Bassem Nabil"], "waiting first, then the ones in use by name");
  assert.deepEqual(names(seated.get("venue-delta")), ["Rania Hosny", "Zeinab Ali"], "a rejection that can be taken back, then the customer sent back");
  assert.equal(seated.has("venue-gone"), false, "a building the board does not hold files nobody — the customer stays among the clinics");
  assert.ok(![...seated.values()].flat().some((customer) => customer.customerName === "Single Clinic" || customer.customerName === "A Clinic"), "a single clinic is never filed under a building");

  const nileRows = seated.get("venue-nile") ?? [];
  const mona = nileRows.find((customer) => customer.customerName === "Mona Said");
  assert.equal(mona?.state, "waiting");
  assert.equal(mona?.reviewId, "review-w", "a waiting customer is decided on his review");
  assert.deepEqual(
    mona?.timetable,
    { verdict: "other_name", scheduleText: "Dr Karim, Dr Salma", hoursRead: "Sat 10-2", reason: null, legibility: "clear", problem: null, heldBecause: null },
    "the hold's reason says what the timetable read, and carries the reader's own evidence for the recommendation",
  );
  const amr = nileRows.find((customer) => customer.customerName === "Amr Fathy");
  assert.equal(amr?.state, "in_use");
  assert.equal(amr?.reviewId, null, "a customer the system never questioned has no review to decide on");
  assert.equal(amr?.reviewed, false, "and counts as never looked at");
  assert.equal(amr?.timetable?.verdict, "match");
  const bassem = nileRows.find((customer) => customer.customerName === "Bassem Nabil");
  assert.equal(nileRows.filter((customer) => customer.customerName === "Bassem Nabil").length, 1, "an approved review and its place are ONE customer");
  assert.equal(bassem?.reviewId, "review-a", "the approval carries the id a reject-after-all is made on");
  assert.equal(bassem?.refusable, true);
  assert.equal(bassem?.visits, 3, "and the place carries the visits the reject would un-place");
  assert.equal(bassem?.timetable?.verdict, "other_name", "the place's own timetable read wins over the review's reason");
  const rania = (seated.get("venue-delta") ?? [])[0];
  assert.equal(rania?.state, "rejected");
  assert.equal(rania?.restorable, true);
  const zeinab = (seated.get("venue-delta") ?? [])[1];
  assert.equal(zeinab?.state, "sent_back");
  assert.equal(zeinab?.placeId, null);
  assert.equal(zeinab?.waitingHours, 52);

  // An approval the validated read did not return is still a customer who can be rejected after all.
  const lone = seatedCustomersByVenue({ pending: [], decided: [approved], validated: [], reopened: [], venueIds });
  assert.deepEqual(names(lone.get("venue-nile")), ["Bassem Nabil"], "filed from the review alone rather than lost");
  const notRefusable = seatedCustomersByVenue({ pending: [], decided: [{ ...approved, refusable: false }], validated: [], reopened: [], venueIds });
  assert.equal(notRefusable.has("venue-nile"), false, "an approval with nothing left to retire is not offered a reject");

  // ── The clinics view keeps everything that is not seated in a building on the board ───────────
  assert.deepEqual(withoutSeated([waiting, noVenue, elsewhere], venueIds).map((row) => row.customerName), ["Single Clinic", "Other Building"]);
  assert.deepEqual(withoutSeated([inUse, single], venueIds).map((row) => row.customerName), ["A Clinic"]);
  assert.deepEqual(withoutSeated([sentBack, reopened({ sharedPlaceId: null })], venueIds).length, 1, "a customer sent back for his own place stays in Waiting to be captured again");

  // ── The outcome selector means the same thing on a seated customer as on a single clinic ──────
  const byName = (name: string): SeatedCustomer => {
    const found = [...seated.values()].flat().find((customer) => customer.customerName === name);
    assert.ok(found, name);
    return found;
  };
  const mona2 = byName("Mona Said");
  const amr2 = byName("Amr Fathy");
  const bassem2 = byName("Bassem Nabil");
  const rania2 = byName("Rania Hosny");
  const zeinab2 = byName("Zeinab Ali");
  assert.equal(seatedPassesOutcome(mona2, false, "pending"), true);
  assert.equal(seatedPassesOutcome(amr2, false, "pending"), false);
  assert.equal(seatedPassesOutcome(amr2, false, "validated"), true);
  assert.equal(seatedPassesOutcome(amr2, false, "unseen"), true, "never looked at");
  assert.equal(seatedPassesOutcome(bassem2, false, "unseen"), false, "somebody has decided him");
  assert.equal(seatedPassesOutcome(bassem2, false, "approved"), true);
  assert.equal(seatedPassesOutcome(rania2, false, "rejected"), true);
  assert.equal(seatedPassesOutcome(zeinab2, false, "rejected"), true, "sent back is part of Rejected, like Waiting to be captured again");
  assert.equal(seatedPassesOutcome(zeinab2, false, "validated"), false);
  assert.equal(seatedPassesOutcome(amr2, true, "pending"), true, "🔴 nobody behind a HELD building counts anywhere yet — they wait with it");
  assert.equal(seatedPassesOutcome(amr2, true, "validated"), false);
  for (const customer of [mona2, amr2, rania2, zeinab2]) assert.equal(seatedPassesOutcome(customer, false, "all"), true);

  // ── Narrowing: a building is shown through itself or through any customer behind it ───────────
  const heldPoly = venue({ sharedPlaceId: "venue-held", name: "Maadi Hospital", status: "held", capturedAt: "2026-10-01T08:00:00.000Z", repName: "Salma Tarek", areaName: "Cairo" });
  const quiet = venue({ sharedPlaceId: "venue-quiet", name: "Quiet Centre", capturedAt: "2026-10-16T08:00:00.000Z" });
  const heldCustomer = seatedCustomersByVenue({
    pending: [],
    decided: [],
    validated: [validated({ placeId: "place-h", customerName: "Held Customer", sharedPlaceId: "venue-held", listType: "PM" })],
    reopened: [],
    venueIds: new Set(["venue-held"]),
  });
  const all = new Map([...seated, ...heldCustomer]);
  const venues = [quiet, delta, heldPoly, nile];

  const everything = narrowVenueGroups({ venues, seated: all, filters: EMPTY_VALIDATION_REVIEW_FILTERS, cutoff: null });
  assert.equal(everything.length, 4, "no filter shows every building, including the one nobody is seated in");
  assert.deepEqual(
    everything.map((group) => group.venue.name),
    ["Maadi Hospital", "Nile Polyclinic", "Quiet Centre", "Delta Medical Centre"],
    "🔴 a building with something open comes first (held, then a waiting customer), then the newest",
  );
  assert.equal(venueNeedsDecision(everything[0]), true);
  assert.equal(venueNeedsDecision(everything[3]), false, "a rejected building with the customers sent back has nothing to decide");
  const quietGroup = everything.find((group) => group.venue.name === "Quiet Centre");
  assert.equal(quietGroup?.total, 0);
  assert.equal(quietGroup?.customers.length, 0);

  const byName2 = (groups: ReturnType<typeof narrowVenueGroups>) => groups.map((group) => group.venue.name);
  // The building's own name shows EVERYBODY seated in it, not only customers whose names match the text.
  const searchedBuilding = narrowVenueGroups({ venues, seated: all, filters: filtersFor({ text: "nile" }), cutoff: null });
  assert.deepEqual(byName2(searchedBuilding), ["Nile Polyclinic"]);
  assert.equal(searchedBuilding[0].customers.length, 3, "searching a polyclinic by name keeps all its customers");
  // A customer's name shows his building with only him.
  const searchedCustomer = narrowVenueGroups({ venues, seated: all, filters: filtersFor({ text: "bassem" }), cutoff: null });
  assert.deepEqual(byName2(searchedCustomer), ["Nile Polyclinic"]);
  assert.deepEqual(names(searchedCustomer[0].customers), ["Bassem Nabil"]);
  assert.equal(searchedCustomer[0].total, 3, "and the header can still say 1 of 3");
  // The LIST filter reaches the customers, never a building: a building is then shown only through them.
  const pmOnly = narrowVenueGroups({ venues, seated: all, filters: filtersFor({ list: "PM" }), cutoff: null });
  assert.deepEqual(byName2(pmOnly).sort(), ["Delta Medical Centre", "Maadi Hospital"], "only the buildings with a PM customer behind them");
  // Outcome Waiting: the held building with everybody behind it, plus the building with a waiting customer.
  const pending = narrowVenueGroups({ venues, seated: all, filters: filtersFor({ outcome: "pending" }), cutoff: null });
  assert.deepEqual(byName2(pending), ["Maadi Hospital", "Nile Polyclinic"]);
  assert.deepEqual(names(pending[0].customers), ["Held Customer"], "a held building keeps its customers waiting with it");
  assert.deepEqual(names(pending[1].customers), ["Mona Said"], "the other building shows only the customer who is waiting");
  // Outcome Rejected reaches a rejected building again — before this it hid the whole section.
  const rejectedOnly = narrowVenueGroups({ venues, seated: all, filters: filtersFor({ outcome: "rejected" }), cutoff: null });
  assert.deepEqual(byName2(rejectedOnly), ["Delta Medical Centre"]);
  assert.equal(rejectedOnly[0].customers.length, 2);
  // Rep reaches the building by the rep who captured it.
  assert.deepEqual(byName2(narrowVenueGroups({ venues, seated: all, filters: filtersFor({ rep: "Salma Tarek" }), cutoff: null })), ["Maadi Hospital"]);
  // Period uses the building's own capture date and each customer's own date.
  const recent = narrowVenueGroups({ venues, seated: all, filters: EMPTY_VALIDATION_REVIEW_FILTERS, cutoff: Date.parse("2026-10-15T00:00:00.000Z") });
  assert.ok(byName2(recent).includes("Quiet Centre"), "a building captured inside the period stays");
  assert.ok(!byName2(recent).includes("Maadi Hospital"), "one captured before it, with nobody inside it newer, goes");

  // ── sharedPlacePassesOutcome: a rejected building is on the board again ───────────────────────
  const retired = { status: "retired" as const, decidedAtText: "9 Oct 2026, 14:00" };
  assert.equal(sharedPlacePassesOutcome(retired, "rejected"), true, "🔴 Rejected shows the retired buildings that can be taken back");
  assert.equal(sharedPlacePassesOutcome(retired, "all"), true);
  for (const outcome of ["pending", "approved", "validated", "unseen"] as const) {
    assert.equal(sharedPlacePassesOutcome(retired, outcome), false, `a retired building is not ${outcome}`);
  }
  assert.equal(sharedPlacePassesOutcome({ status: "active", decidedAtText: null }, "rejected"), false, "and a live one is never rejected");

  // ── The server hands the board the building each row is seated in ─────────────────────────────
  const reviews = read("src/lib/phoenix-crm/server/validation-reviews.ts");
  assert.ok(/photo_path, status, shared_place_id, signboard_check"/.test(reviews), "the review read selects the place's shared_place_id, and its signboard reading for the recommendation");
  assert.ok(reviews.includes("sharedPlaceId: text(place.shared_place_id)"), "and a review row carries it whatever the hold was about");
  assert.ok(reviews.includes("sharedPlaceId: text(row.shared_place_id)"), "as does a validated place");
  assert.ok(reviews.includes("sharedPlaceId: venue?.sharedPlaceId ?? null"), "and a customer sent back by his building's refusal");
  assert.ok(read("src/lib/phoenix-crm/server/shared-places.ts").includes("sharedPlaceId: String(venue.id)"), "the venue refusal read names the building");

  // ── The board: five tabs, the clinics without the seated, the polyclinics grouped ─────────────
  // (owner, 2026-10-17: "is this a report that really shows me data? or it's a bunch of chaos")
  const board = read("src/components/phoenix-crm/validation-reviews-board.tsx");
  assert.ok(board.includes('role="tablist"') && board.includes('role="tab"') && board.includes('role="tabpanel"'), "the checks are a real tab switch");
  for (const label of ['"Needs you"', '"Being checked"', '"Not confirmed"', '"Polyclinics and hospitals"', '"History"']) {
    assert.ok(board.includes(label), `a tab named for what it holds: ${label}`);
  }
  assert.ok(board.includes('useState<PlaceCheckView>("needs")'), "the board opens on what is waiting for a decision");
  for (const set of ["pending", "decided", "validated", "reopened"]) {
    assert.ok(board.includes(`withoutSeated(${set}, venueIds)`), `the clinics view drops ${set} rows seated in a building on the board`);
  }
  assert.ok(board.includes("narrowVenueGroups({ venues: sharedPlaces, seated, filters, cutoff })"), "the polyclinics are grouped by the pure module");
  assert.ok(board.includes("{(groups) => <SharedPlaceList groups={groups}"), "and drawn as groups, a page at a time");
  assert.ok(board.includes("filteredVenueGroups.length"), "the heading count is the FILTERED count, like every other section");
  assert.ok(!board.includes("showSharedPlaces"), "🔴 Rejected no longer hides the polyclinics");
  assert.ok(board.includes("<ReopenedCustomerList"), "and History still lists who waits to be captured again");
  // 🔴 NO TAB DRAWS ITS WHOLE SET: the decided list alone was 197 rows and 88,288 px tall.
  assert.equal((board.match(/<Paged key=/g) ?? []).length, 5, "the five long lists are each drawn 20 (or 10 buildings) at a time");
  assert.ok(board.includes("const PAGE_ROWS = 20;") && board.includes("const PAGE_BUILDINGS = 10;"), "at a page size a person can read");
  // 🔴 A TEST ENTRY IS NEVER DRAWN — four test buildings sat among the live ones on production.
  for (const set of ["pendingRows", "decidedRows", "validatedRows", "reopenedRows", "venueRows"]) {
    assert.ok(board.includes(`${set}.filter(isReal)`), `${set} loses its test entries before anything else reads it`);
  }
  assert.ok(board.includes('group.venue.status !== "retired"'), "a rejected building waits behind its own switch");
  assert.ok(board.includes("{team ? null : <AdviceSummary advice={advice} />}"), "the recommendation summary is the Super Admin's alone");
  assert.ok(board.includes("<PlaceCheckScorecard"), "and the board opens with each rep's captures");

  // ── The group: the building's sign and timetable, then the customers behind it ────────────────
  const list = read("src/components/phoenix-crm/shared-place-list.tsx");
  assert.ok(list.includes("row.schedulePhotoPath") && list.includes("Timetable photo for"), "the building's own timetable photograph is on the board");
  const rows = read("src/components/phoenix-crm/shared-place-customers.tsx");
  assert.ok(rows.includes("const own = customer.photoPath;") && !/photoPath !== venueTimetablePath/.test(rows), "🔴 a customer's OWN photograph is always on their row — the checker's 'unreadable' and 'no timetable' are judged by eye, never hidden because it matches the building's");
  assert.ok(list.includes("Sign photo for"), "beside the sign on its door");
  assert.ok((list.match(/<SeatedCustomers/g) ?? []).length === 2, "the customers are drawn under their building on the phone and on the desktop");
  assert.ok(list.includes('layout="cards"') && list.includes('layout="table"'), "once per screen size, so a label points at the control the reader can see");
  assert.ok(list.includes("{signboardText(row.signboard)}"), "the building's sign verdict is still drawn in words");

  // ── The reject control: the existing refusal, on the timetable's own pick-list ────────────────
  const customersSource = read("src/components/phoenix-crm/shared-place-customers.tsx");
  assert.ok(customersSource.includes("Reject — not on the timetable"), "the option the request names");
  assert.ok(/kind="schedule"/.test(customersSource), "it offers the timetable's reasons, never 'a photo of paper'");
  assert.ok(customersSource.includes('"schedule_other_name"'), "starting on the one that says he is not named on it");
  assert.ok(customersSource.includes('"schedule_missing"'), "or the one that says there is no timetable when that is what was read");
  assert.ok(
    customersSource.includes('"/api/phoenix-crm/validation-reviews", { reviewId: customer.reviewId, decision: "reject", note, refusalReason: reason }'),
    "a customer with a review is rejected on it, which keeps the evidence",
  );
  assert.ok(
    customersSource.includes('"/api/phoenix-crm/validation-reviews/refuse", { placeId: customer.placeId, note, refusalReason: reason }'),
    "one the system never questioned goes through the refuse route, body for body",
  );
  assert.ok(customersSource.includes("<RestoreAfterRejection"), "a rejection can be taken back");
  assert.ok(
    readFileSync("src/components/phoenix-crm/place-check-restore.tsx", "utf8").includes("/api/phoenix-crm/validation-reviews/restore"),
    "through the review restore route",
  );
  assert.match(customersSource, /armed \?/, "a rejection is confirmed before it is sent");
  assert.match(customersSource, /disabled=\{reason === "" \|\| saving\}/, "and cannot be armed before a reason is chosen");
  assert.doesNotMatch(customersSource, /note\.trim\(\)\.length === 0/, "never gated on the free-text note — it is optional");
  assert.match(customersSource, /mode === "team" \? null : <Decision customer=\{customer\} noTimetable=\{noTimetable\} scope=\{scope\} \/>/, "🔴 a manager's board renders no decision control");
  assert.ok(customersSource.includes("<CrmCardsOnPhone") && !customersSource.includes("<CrmTable") && !/colSpan/.test(customersSource), "phone cards, then plain blocks inside the building's own cell — never a table nested in a table");
  assert.ok(!/colSpan/.test(list) && (list.match(/<tbody/g) ?? []).length === 1, "🔴 one row per building: the header and its seated customers sit in the first cell, no second row");
  assert.doesNotMatch(customersSource, /\brounded-(?!none\b)|\boverflow-x-auto\b|\btruncate\b|\bmin-w-\[|line-clamp|text-ellipsis/, "square, no sideways scroll, no ellipsis");
  assert.doesNotMatch(customersSource.toLowerCase(), /\b(doctor|doctors|account|accounts)\b/, "AM and PM customers — never the old words");
  for (const forbidden of ["waiting for approval", "pending approval", "awaiting a decision", "sent to the administrator"]) {
    assert.ok(!customersSource.toLowerCase().includes(forbidden), `never renders "${forbidden}"`);
  }
  // ── A building the administrator declared has NO timetable is his exception, not a fault ──────
  // (owner, 2026-10-18, City clinic: "make the place validated, and make those doctors validated by the
  // admin as an exception for this polyclinic and show this")
  const city = venue({ sharedPlaceId: "venue-city", name: "City clinic", seated: 2, schedulePhotoPath: null, capturedAt: "2026-10-05T08:00:00.000Z" });
  const cityExempt = venue({
    sharedPlaceId: "venue-city",
    name: "City clinic",
    seated: 2,
    schedulePhotoPath: null,
    capturedAt: "2026-10-05T08:00:00.000Z",
    timetableExempt: { atText: "18 Oct 2026, 20:44", byName: "Omar Gawish" },
  });
  assert.equal(venueHasProblem({ venue: city, customers: [] }), true, "customers seated and no timetable on file is the fault the owner named first");
  assert.equal(venueHasProblem({ venue: cityExempt, customers: [] }), false, "🔴 the same building with his exception on it is not a problem");
  const inOrder = (list: SharedPlaceBoardRow[]) =>
    narrowVenueGroups({ venues: list, seated: new Map(), filters: EMPTY_VALIDATION_REVIEW_FILTERS, cutoff: null }).map((group) => group.venue.name);
  assert.deepEqual(inOrder([quiet, city]), ["City clinic", "Quiet Centre"], "a building with a problem is sorted above an ordinary one");
  assert.deepEqual(inOrder([quiet, cityExempt]), ["Quiet Centre", "City clinic"], "🔴 and the exception is sorted as an ordinary building, newest first");

  const serverPlaces = read("src/lib/phoenix-crm/server/shared-places.ts");
  assert.ok(serverPlaces.includes("timetable_exempt_at, timetable_exempt_by_hr_id"), "the board read selects the exception marker");
  assert.ok(serverPlaces.includes("timetableExempt: text(row.timetable_exempt_at)"), "and puts it on the row");
  assert.match(customersSource, /!noTimetable\) return <RejectNotOnTimetable/, "🔴 no 'Reject — not on the timetable' where the administrator says there is none");
  assert.match(customersSource, /noTimetable && customer\.state !== "sent_back"/, "a customer in that building is drawn without a timetable verdict");
  assert.match(customersSource, /mode === "team" \? null : customer\.state === "in_use" && customer\.reviewStatus === "approved"/, "🔴 and only the Super Admin's board says WHO validated him");
  assert.match(
    customersSource,
    /noTimetable && customer\.state !== "waiting"\) \? null : <SystemAdvice advice=\{adviseOnTimetable\(customer\.timetable, noTimetable\)\}/,
    "the system's advice is silent there except on a customer still waiting",
  );
  assert.match(list, /if \(row\.timetableExempt\) \{/, "the building's timetable frame is replaced by the exception");
  assert.match(list, /\{mode === "team" \? null : \(\s*<>/, "🔴 a manager's board is told the building has no timetable and not who decided it");
  assert.ok(board.includes("adviseOnTimetable(customer.timetable, group.venue.timetableExempt !== null)"), "the Needs-you summary reads the same exception");

  // Owner, 2026-10-20: every approval or refusal by Khaled Bedair appears to him, by name and timestamp.
  assert.equal(decisionStamp("Approved", "Khaled Bedair", "19 Oct 2026, 14:43"), "Approved by Khaled Bedair · 19 Oct 2026, 14:43");
  assert.equal(decisionStamp("Refused", "Khaled Bedair", "19 Oct 2026, 14:44"), "Refused by Khaled Bedair · 19 Oct 2026, 14:44");
  assert.equal(decisionStamp("Approved", "The system", "19 Oct 2026, 23:32"), "Approved by the system · 19 Oct 2026, 23:32", "the system's own word reads as a word");
  assert.equal(decisionStamp("Approved", null, null), null, "a decision that predates the record draws nothing");
  assert.equal(decisionStamp("Refused", null, "19 Oct 2026, 14:44"), "Refused · 19 Oct 2026, 14:44", "a time with no name is still said");
  const byKhaled = seatedCustomersByVenue({
    pending: [],
    decided: [],
    validated: [validated({ decidedByName: "Khaled Bedair", decidedAtText: "19 Oct 2026, 14:43" })],
    reopened: [reopened({ refusedByName: "Khaled Bedair", refusedAtText: "19 Oct 2026, 14:44" })],
    venueIds: new Set(["venue-nile", "venue-delta"]),
  });
  assert.equal(byKhaled.get("venue-nile")?.[0]?.decidedByName, "Khaled Bedair", "🔴 a place that stays in use carries the name of whoever approved it");
  assert.equal(byKhaled.get("venue-nile")?.[0]?.decidedAtText, "19 Oct 2026, 14:43", "and the time");
  assert.equal(byKhaled.get("venue-delta")?.[0]?.decidedByName, "Khaled Bedair", "🔴 a customer sent back carries the name of whoever refused it");
  assert.equal(byKhaled.get("venue-delta")?.[0]?.decidedAtText, "19 Oct 2026, 14:44", "and the time");

  const reviewsSource = read("src/lib/phoenix-crm/server/validation-reviews.ts");
  // Since 2026-11-08 the in-use read's review rows come from phoenix_crm_validated_place_facts in one call.
  assert.ok(reviewsSource.includes('rpc("phoenix_crm_validated_place_facts"'), "the in-use read takes its reviews from the one function");
  assert.ok(
    read("supabase/migrations/20261108200549_phoenix_crm_validated_place_facts.sql").includes("'status', r.status, 'decided_by_hr_id', r.decided_by_hr_id, 'decided_at', r.decided_at"),
    "🔴 the in-use read asks each place's review who decided it and when",
  );
  assert.ok(reviewsSource.includes("refusedByName: decides ? deciderLabel("), "🔴 the reopened read names who refused, to the deciders");
  assert.ok(serverPlaces.includes("refusal_reason, decided_by_hr_id, decided_at"), "and a rejected building's own decider, for the customers it reopened");
  assert.match(read("src/components/phoenix-crm/validated-place-list.tsx"), /mode === "team" \? null : decisionStamp\("Approved"/, "🔴 only the company board says who approved a place in use");
  assert.match(read("src/components/phoenix-crm/reopened-customer-list.tsx"), /mode === "team" \? null : decisionStamp\("Refused"/, "🔴 only the company board says who refused a waiting customer");
  assert.match(customersSource, /mode === "team" \|\| \(customer\.state === "rejected" && customer\.restorable\)/, "🔴 a manager's board names nobody above him on a seated customer either");
  console.log("phoenix-crm shared place groups: OK");
}
