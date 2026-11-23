import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";
import { PLACE_CHECK_BOARD_FILES, PLACE_CHECK_BOARD_SHELL, placeCheckBoardSource } from "./support/place-check-board-source.ts";
import { PLACE_CHECK_LIST_FILES, PLACE_CHECK_LIST_PATHS, placeCheckListSource, type PlaceCheckList } from "./support/place-check-list-source.ts";

import {
  parsePlaceCheckAddress,
  parsePrivateFilters,
  PLACE_CHECK_ADDRESS_FILTERS,
  PLACE_CHECK_ADDRESS_MAX_ROWS,
  PLACE_CHECK_PRIVATE_FILTERS,
  placeCheckAddressSearch,
  privateFiltersText,
} from "../src/lib/phoenix-crm/place-check-address.ts";
import {
  adviceIsConfidentNow,
  deskHeadline,
  deskLongWait,
  deskMakeUp,
  deskUnitsOf,
  LANE_NO_REVIEW_ROW,
  LANE_OPEN_CASE,
  LANE_SHORT_NAME,
  laneOf,
  laneOfBuilding,
  laneOfReviewRow,
  laneOfVenueGroup,
  openCaseSubjects,
  PLACE_CHECK_LANE_LABEL,
  PLACE_CHECK_RETIRED_VERBS,
  PLACE_CHECK_VERBS,
  placeCheckDesk,
  READY_BUILDING_ROUTE,
  READY_REVIEW_ROUTE,
  readyLaneRequests,
  yourCallReasons,
  type LaneSubject,
} from "../src/lib/phoenix-crm/place-check-lanes.ts";
import { AGREEMENT_READY_MIN_DECISIONS, placeCheckAgreement, type AgreementDecision } from "../src/lib/phoenix-crm/place-check-stored-advice.ts";
import { placeNoteSubjectKey } from "../src/lib/phoenix-crm/place-note-rules.ts";
import { needsYouDecisionCount, type SeatedCustomer, type VenueGroup } from "../src/lib/phoenix-crm/shared-place-groups.ts";
import { EMPTY_VALIDATION_REVIEW_FILTERS } from "../src/lib/phoenix-crm/validation-review-filters.ts";
import type { SharedPlaceBoardRow, ValidationReviewRow } from "../src/lib/phoenix-crm/view-types.ts";

/**
 * Phoenix CRM — Place checks, the rebuild of 23 Nov 2026 (`docs/approvals-rebuild-2026-11-place-checks.md`):
 * the two lanes a waiting decision sits in, the ONE waiting number, the Ready lane's one press, what the
 * page's address remembers, and the page's verbs.
 *
 * The lanes, the desk and the address are pure modules, exercised here directly. The board is a set of
 * client components the harness does not render, so the last section pins by source what they wire.
 */

const ROOT = new URL("../", import.meta.url);

function code(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n"));
}

const subject = (kind: "approve" | "reject" | "look", confident: boolean, code_ = "sign_match", needsFullName = false): LaneSubject => ({
  advice: { kind, code: code_, confident },
  needsFullName,
});

/** `total` decisions of his on one kind of advice, `against` of them the other way. */
function decided(codeOf: string, advice: "approve" | "reject", total: number, against: number): AgreementDecision[] {
  const agrees = advice === "approve" ? "approved" : "rejected";
  const disagrees = advice === "approve" ? "rejected" : "approved";
  return Array.from({ length: total }, (_, index) => ({ advice, code: codeOf, outcome: index < against ? disagrees : agrees, bySystem: false }));
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
    timetableTakenBack: null,
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
    customerName: "Mona Said Hassan",
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
    photoPath: "cairo/sign.jpg",
    reason: null,
    photoKind: "signboard",
    sharedPlaceName: null,
    sharedPlaceId: null,
    hoursRead: null,
    evidence: { checkReason: null, heldBecause: null, legibility: null, problem: null, signboard: { verdict: "match", reason: null, signText: "Dr Mona Said Hassan" } },
    signText: "Dr Mona Said Hassan",
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

/** A customer behind a building, with only what the lanes and the desk read. */
function seated(overrides: Partial<SeatedCustomer>): SeatedCustomer {
  return {
    key: "seat-1",
    sharedPlaceId: "venue-nile",
    state: "waiting",
    isTest: false,
    at: "2026-10-12T08:00:00.000Z",
    atText: "12 Oct 2026, 11:00",
    placeId: "place-seat-1",
    reviewId: "review-seat-1",
    reviewStatus: "pending",
    reviewed: true,
    refusable: false,
    restorable: false,
    visits: null,
    otherPlaces: null,
    timetable: { verdict: "match", scheduleText: "Dr Karim Adel Fouad", hoursRead: "Sat 10-2" },
    photoPath: null,
    reasonLabel: null,
    decidedByName: null,
    decidedAtText: null,
    decisionNote: null,
    waitingHours: null,
    customerName: "Karim Adel Fouad",
    listType: "PM",
    ...overrides,
  } as SeatedCustomer;
}

const group = (venueRow: SharedPlaceBoardRow, customers: SeatedCustomer[]): Pick<VenueGroup, "venue" | "customers"> => ({ venue: venueRow, customers });

function runLaneTests() {
  // 🔴 READY NEEDS ALL THREE: the advice is Approve, that kind is confident, and Approve can be pressed.
  assert.deepEqual(laneOf(subject("approve", true)), { lane: "ready", because: null }, "an Approve the page is sure of is Ready, with no sentence");
  const leans = laneOf(subject("approve", false));
  assert.equal(leans.lane, "your_call", "🔴 an Approve this kind of evidence has not earned is his call");
  assert.match(leans.because ?? "", /leans to Approve.*19 times in 20/, "and it says the system leans, and why that is not enough");
  const rejects = laneOf(subject("reject", true));
  assert.equal(rejects.lane, "your_call", "🔴 a Reject is never Ready, however sure the system is");
  assert.equal(rejects.because, "The system leans to Reject. A rejection is always your call.");
  assert.equal(laneOf(subject("look", false)).because, "The system could not tell from the photo.", "no verdict says so");
  assert.deepEqual(
    laneOf(subject("approve", true, "sign_match", true)),
    { lane: "your_call", because: LANE_SHORT_NAME },
    "🔴 a customer still short of a full name is never Ready: Approve is refused for him everywhere",
  );

  // 🔴 THE 30-DAY COUNT OUTRANKS THE TABLE, once it holds enough decisions of that kind.
  const sure = { kind: "approve" as const, code: "sign_match", confident: true };
  const unsure = { kind: "approve" as const, code: "timetable_match", confident: false };
  assert.equal(adviceIsConfidentNow(sure, null), true, "with no count read, the table stands");
  assert.equal(adviceIsConfidentNow(unsure, null), false);
  assert.equal(AGREEMENT_READY_MIN_DECISIONS, 20, "a kind speaks for itself after 20 decisions of his");
  const promoted = placeCheckAgreement(decided("timetable_match", "approve", 20, 1));
  assert.equal(adviceIsConfidentNow(unsure, promoted), true, "🔴 19 of 20 in the last 30 days makes a kind Ready although the table held it back");
  assert.equal(laneOf({ advice: unsure, needsFullName: false }, promoted).lane, "ready");
  const demoted = placeCheckAgreement(decided("sign_match", "approve", 20, 2));
  assert.equal(adviceIsConfidentNow(sure, demoted), false, "🔴 and 18 of 20 takes a kind out of Ready although the table called it sure");
  assert.equal(laneOf({ advice: sure, needsFullName: false }, demoted).lane, "your_call");
  const tooFew = placeCheckAgreement(decided("sign_match", "approve", 19, 19));
  assert.equal(adviceIsConfidentNow(sure, tooFew), true, "19 decisions are not enough to overrule the table, even all against");
  const otherAdvice = placeCheckAgreement(decided("sign_match", "reject", 20, 20));
  assert.equal(adviceIsConfidentNow(sure, otherAdvice), true, "a count is read for the same kind AND the same advice, never a namesake");
  assert.equal(laneOf(subject("approve", true, "sign_match", true), promoted).lane, "your_call", "and no count opens Approve for a short name");

  // 🔴 A BUILDING IS READY ONLY IF EVERYTHING OPEN IN IT IS.
  assert.deepEqual(laneOfBuilding({ building: null, waiting: [subject("approve", true), subject("approve", true)] }), { lane: "ready", because: null });
  assert.deepEqual(laneOfBuilding({ building: subject("approve", true), waiting: [] }), { lane: "ready", because: null }, "a held building alone, sure of its sign");
  const heldUnsure = laneOfBuilding({ building: subject("approve", false), waiting: [subject("approve", true)] });
  assert.equal(heldUnsure.lane, "your_call");
  assert.ok(heldUnsure.because?.startsWith("The building: The system leans to Approve"), "the building is named first: it is what he meets first");
  const twoOfThree = laneOfBuilding({ building: null, waiting: [subject("approve", true), subject("look", false), subject("reject", true)] });
  assert.equal(twoOfThree.because, "2 of the 3 customers waiting in it: The system could not tell from the photo.", "🔴 one thing to look at makes the whole building his call, counted");
  assert.equal(
    laneOfBuilding({ building: null, waiting: [subject("reject", true)] }).because,
    "The customer waiting in it: The system leans to Reject. A rejection is always your call.",
    "one customer is said as one",
  );

  // The board's own rows.
  assert.equal(laneOfReviewRow(review({})).lane, "ready", "a clinic whose photographed sign names the customer is Ready");
  assert.deepEqual(
    laneOfReviewRow(review({ listType: "PM", customerName: "Mona Said" })),
    { lane: "your_call", because: LANE_SHORT_NAME },
    "🔴 the same evidence under a two-name doctor is his call",
  );
  assert.equal(
    laneOfReviewRow(review({ reason: "sign_other_name", evidence: { checkReason: null, heldBecause: null, legibility: null, problem: null, signboard: null } })).lane,
    "your_call",
    "a sign naming somebody else is looked at",
  );
  assert.equal(laneOfReviewRow(review({}), demoted).lane, "your_call", "and the row reads the 30-day count too");

  const heldVenue = venue({ status: "held", signboard: { verdict: "match", reason: null, signText: "Nile Polyclinic", note: null } });
  const heldReading = laneOfVenueGroup(group(heldVenue, []));
  assert.equal(heldReading.lane, "your_call", "🔴 a held building is not Ready on the table: he approved 100 of 120");
  assert.ok(heldReading.because?.startsWith("The building: "));
  assert.equal(
    laneOfVenueGroup(group(venue({}), [seated({ reviewId: null })])).because,
    LANE_NO_REVIEW_ROW,
    "🔴 a waiting customer with no review row cannot be settled by one press, so his building is never Ready",
  );
  const matched = group(venue({}), [seated({})]);
  assert.equal(laneOfVenueGroup(matched).lane, "your_call", "a timetable naming the customer leans to Approve and is not Ready on the table (116 of 143)");
  assert.equal(laneOfVenueGroup(matched, promoted).lane, "ready", "until his own 30 days say it is");
  assert.equal(
    laneOfVenueGroup(group(venue({ status: "active" }), [seated({ state: "in_use", timetable: null }), seated({ key: "seat-2" })]), promoted).lane,
    "ready",
    "only the WAITING customers are read: one already in use decides nothing",
  );
  assert.equal(
    laneOfVenueGroup(group(venue({ timetableExempt: { byName: "Omar", atText: "1 Nov 2026" } as SharedPlaceBoardRow["timetableExempt"] }), [seated({})]), promoted).lane,
    "your_call",
    "🔴 a building declared to have no timetable is his own exception: never Ready",
  );

  // 🔴 NOTHING WITH AN UNSETTLED INTEGRITY CASE IS READY (the CRM review of pull request 700, 23 Nov 2026).
  // The sign-wins rule leaves such a place to him; the lane's one press must not approve it for him.
  const openCases = openCaseSubjects({
    [placeNoteSubjectKey("place", "place-1")]: [{ settledText: "Settled by Omar Gawish, 1 Nov 2026" }, { settledText: null }],
    [placeNoteSubjectKey("place", "place-2")]: [{ settledText: "Settled by Omar Gawish, 1 Nov 2026" }],
    [placeNoteSubjectKey("place", "place-3")]: [],
    [placeNoteSubjectKey("shared_place", "v-case")]: [{ settledText: null }],
    [placeNoteSubjectKey("place", "place-seat-case")]: [{ settledText: null }],
  });
  assert.deepEqual(
    [...openCases].sort(),
    [placeNoteSubjectKey("place", "place-1"), placeNoteSubjectKey("place", "place-seat-case"), placeNoteSubjectKey("shared_place", "v-case")].sort(),
    "a subject is open while ANY of its cases has no settlement; one whose cases are all settled, or that has none, is not",
  );
  assert.deepEqual(
    laneOfReviewRow(review({}), null, openCases),
    { lane: "your_call", because: LANE_OPEN_CASE },
    "🔴 a clinic whose sign names the customer is NOT Ready while a case on its place is unsettled",
  );
  assert.equal(laneOfReviewRow(review({ placeId: "place-2" }), null, openCases).lane, "ready", "a settled case holds nothing back");
  assert.equal(laneOf({ ...subject("approve", true), openCase: true }, promoted).lane, "your_call", "🔴 and no 30-day count opens it");
  assert.equal(
    laneOf({ ...subject("approve", true, "sign_match", true), openCase: true }).because,
    LANE_SHORT_NAME,
    "a short name is said first: it is the one Approve itself refuses",
  );
  assert.equal(
    laneOfVenueGroup(group(venue({ sharedPlaceId: "v-case" }), [seated({ sharedPlaceId: "v-case" })]), promoted, openCases).because,
    `The building: ${LANE_OPEN_CASE}`,
    "🔴 a case on the building keeps the whole building his, in use or held",
  );
  const caseBehind = laneOfVenueGroup(group(venue({}), [seated({ placeId: "place-seat-case" })]), promoted, openCases);
  assert.equal(caseBehind.lane, "your_call", "🔴 and so does a case on one customer waiting in it");
  assert.ok(caseBehind.because?.endsWith(LANE_OPEN_CASE));
  assert.equal(laneOfVenueGroup(group(venue({}), [seated({})]), promoted, openCases).lane, "ready", "a building with no case on it or behind it is still Ready");
  assert.equal(
    placeCheckDesk(deskUnitsOf({ clinics: [review({}), review({ placeId: "place-2" })], groups: [] }, null, openCases)).ready,
    1,
    "🔴 the header's Ready count leaves the open case out too",
  );
}

function runDeskTests() {
  // 🔴 ONE UNIT: A DECISION. Three clinics, a held building with two waiting, a building in use with one
  // waiting, and a building in use with nobody waiting (which is not a decision).
  const clinics = [
    review({ reviewId: "c1", waitingLong: true } as Partial<ValidationReviewRow>),
    review({ reviewId: "c2", reason: "sign_other_name" }),
    review({ reviewId: "c3" }),
  ];
  const held = group(venue({ sharedPlaceId: "v-held", status: "held", waitingLong: true } as Partial<SharedPlaceBoardRow>), [
    seated({ key: "h1", sharedPlaceId: "v-held", reviewId: "r-h1" }),
    seated({ key: "h2", sharedPlaceId: "v-held", reviewId: "r-h2" }),
  ]);
  const inUse = group(venue({ sharedPlaceId: "v-use" }), [seated({ key: "u1", sharedPlaceId: "v-use", reviewId: "r-u1" }), seated({ key: "u2", sharedPlaceId: "v-use", state: "in_use" })]);
  const quiet = group(venue({ sharedPlaceId: "v-quiet" }), [seated({ key: "q1", sharedPlaceId: "v-quiet", state: "in_use" })]);
  const units = deskUnitsOf({ clinics, groups: [held, inUse, quiet] });
  const desk = placeCheckDesk(units);
  assert.deepEqual(
    desk,
    { decisions: 5, clinics: 3, buildings: 2, customersBehind: 3, ready: 2, yourCall: 3, waitingLong: 2 },
    "three clinics and two buildings are five decisions; the three customers behind them are named, never added",
  );
  assert.equal(desk.ready + desk.yourCall, desk.decisions, "🔴 every decision is in exactly one lane");

  // 🔴 THE PAGE'S NUMBER IS THE NUMBER NEEDS YOU SHOWS, on the same rows.
  const needsYou = needsYouDecisionCount({
    waiting: [
      ...clinics.map((row) => ({ id: row.reviewId, at: row.createdAt, sharedPlaceId: null })),
      { id: "r-h1", at: "2026-10-12T08:00:00.000Z", sharedPlaceId: "v-held" },
      { id: "r-h2", at: "2026-10-12T08:00:00.000Z", sharedPlaceId: "v-held" },
      { id: "r-u1", at: "2026-10-12T08:00:00.000Z", sharedPlaceId: "v-use" },
    ],
    heldVenues: [{ id: "v-held", at: "2026-10-10T08:00:00.000Z" }],
    venuesOnBoard: new Set(["v-held", "v-use", "v-quiet"]),
  });
  assert.equal(desk.decisions, needsYou.count, "🔴 the desk and Needs You count the same fixture to the same number");

  assert.equal(deskHeadline(desk), "5 decisions wait for you");
  assert.equal(deskMakeUp(desk), "3 clinics and 2 buildings, with 3 customers waiting behind them.");
  assert.equal(deskLongWait(desk), "2 have waited over 72 hours.");

  const one = placeCheckDesk([{ kind: "building", lane: "your_call", customersBehind: 1, waitingLong: true }]);
  assert.equal(deskHeadline(one), "1 decision waits for you", "one is said as one");
  assert.equal(deskMakeUp(one), "1 building, with 1 customer waiting behind it.", "a part that is zero is left out, and one building is 'it'");
  assert.equal(deskLongWait(one), "1 has waited over 72 hours.");
  const clinicOnly = placeCheckDesk([{ kind: "clinic", lane: "ready", customersBehind: 0, waitingLong: false }]);
  assert.equal(deskMakeUp(clinicOnly), "1 clinic.", "no buildings, no word about them");
  assert.equal(deskLongWait(clinicOnly), "", "the long-wait line is drawn only when it says something");
  const none = placeCheckDesk([]);
  assert.equal(deskHeadline(none), "Nothing waits for you");
  assert.equal(deskMakeUp(none), "", "and nothing is made of nothing");
  assert.equal(placeCheckDesk([{ kind: "building", lane: "ready", customersBehind: -3.5, waitingLong: false }]).customersBehind, 0, "a bad count never subtracts");

  // The lane's one line: the commonest reason first, a tie in the sentence's own order, Ready ignored.
  const reasons = yourCallReasons([
    { lane: "your_call", because: "B reason" },
    { lane: "your_call", because: "A reason" },
    { lane: "your_call", because: "C reason" },
    { lane: "your_call", because: "C reason" },
    { lane: "ready", because: null },
    { lane: "your_call", because: null },
  ]);
  assert.deepEqual(reasons, [
    { because: "C reason", count: 2 },
    { because: "A reason", count: 1 },
    { because: "B reason", count: 1 },
  ]);

  // 🔴 "APPROVE ALL" IS THE SAME ANSWER N TIMES: each building, then its waiting customers, then the clinics.
  const heldRow = venue({ sharedPlaceId: "v-held", name: "Held Centre", status: "held" });
  const requests = readyLaneRequests({
    reviews: [
      { reviewId: "c1", customerName: "Clinic One" },
      { reviewId: "c2", customerName: "Clinic Two" },
    ],
    groups: [
      group(heldRow, [seated({ key: "h1", reviewId: "r-h1", customerName: "Behind Held" } as Partial<SeatedCustomer>)]),
      group(venue({ sharedPlaceId: "v-use", name: "In Use Centre" }), [
        seated({ key: "u1", reviewId: "r-u1", customerName: "Behind In Use" } as Partial<SeatedCustomer>),
        seated({ key: "u2", state: "in_use", reviewId: "r-u2" }),
        seated({ key: "u3", reviewId: null }),
      ]),
    ],
  });
  assert.deepEqual(
    requests.map((request) => [request.kind, request.name, request.building]),
    [
      ["building", "Held Centre", "v-held"],
      ["customer", "Behind Held", "v-held"],
      ["customer", "Behind In Use", "v-use"],
      ["clinic", "Clinic One", null],
      ["clinic", "Clinic Two", null],
    ],
    "🔴 a building before the customers behind it; a building in use is not approved again; nobody without a review row, nobody already in use",
  );
  assert.deepEqual(requests[0].body, { sharedPlaceId: "v-held", decision: "approve", note: "" }, "the building's own approval, as its button sends it");
  assert.equal(requests[0].route, READY_BUILDING_ROUTE);
  assert.deepEqual(requests[1].body, { reviewId: "r-h1", decision: "approve", note: "" });
  assert.ok(requests.slice(1).every((request) => request.route === READY_REVIEW_ROUTE), "every other request is a row's own approval route");
  assert.equal(requests[0].subject, heldRow, "and each carries the row its own control draws, so the saved mark lands under it");
  assert.equal(READY_REVIEW_ROUTE, "/api/phoenix-crm/validation-reviews");
  assert.equal(READY_BUILDING_ROUTE, "/api/phoenix-crm/validation-reviews/shared-place", "🔴 the two routes a row's Approve already posts to: no second decision path");
}

function runAddressTests() {
  const plain = parsePlaceCheckAddress("");
  assert.deepEqual(plain, {
    tab: null,
    chip: null,
    rows: null,
    filters: { outcome: EMPTY_VALIDATION_REVIEW_FILTERS.outcome, period: EMPTY_VALIDATION_REVIEW_FILTERS.period, line: "", region: "", area: "", list: "" },
  });
  const asked = parsePlaceCheckAddress("?tab=history&chip=unreadable&rows=40&outcome=rejected&period=7&line=CNS&region=Cairo&area=Qalubeya&list=AM");
  assert.deepEqual(asked, { tab: "history", chip: "unreadable", rows: 40, filters: { outcome: "rejected", period: "7", line: "CNS", region: "Cairo", area: "Qalubeya", list: "AM" } });

  // Anything it cannot read is the default, never an error.
  assert.equal(parsePlaceCheckAddress("?outcome=everything").filters.outcome, EMPTY_VALIDATION_REVIEW_FILTERS.outcome);
  assert.equal(parsePlaceCheckAddress("?period=365").filters.period, EMPTY_VALIDATION_REVIEW_FILTERS.period);
  for (const bad of ["a b", "<script>", "1tab", "x".repeat(41), ""]) {
    assert.equal(parsePlaceCheckAddress(`?tab=${encodeURIComponent(bad)}`).tab, null, `a tab key that is not a key is no tab: ${bad.slice(0, 12)}`);
  }
  assert.equal(PLACE_CHECK_ADDRESS_MAX_ROWS, 200);
  assert.equal(parsePlaceCheckAddress("?rows=100000").rows, 200, "🔴 a typed number never opens a whole set: rows are capped at 200");
  for (const bad of ["0", "-20", "12.5", "many"]) assert.equal(parsePlaceCheckAddress(`?rows=${bad}`).rows, null, `rows=${bad} is the first page`);
  assert.equal(parsePlaceCheckAddress(`?line=${"x".repeat(300)}`).filters.line.length, 120, "a filter's text is cut at 120 characters");

  // 🔴 NO PERSON'S NAME IS EVER WRITTEN TO THE ADDRESS.
  assert.deepEqual([...PLACE_CHECK_PRIVATE_FILTERS], ["rep", "decider", "text"], "the rep, the decider and the search box name people");
  assert.deepEqual([...PLACE_CHECK_ADDRESS_FILTERS], ["outcome", "period", "line", "region", "area", "list"], "a link carries places and lines only");
  assert.deepEqual(
    Object.keys(EMPTY_VALIDATION_REVIEW_FILTERS).sort(),
    [...PLACE_CHECK_ADDRESS_FILTERS, ...PLACE_CHECK_PRIVATE_FILTERS].sort(),
    "🔴 every filter the board has is in exactly one of the two lists: a new filter must choose",
  );
  const written = placeCheckAddressSearch("?review=1&rep=Hassan+Adel&decider=Omar&text=Mona&campaign=x&tab=needs", asked);
  const params = new URLSearchParams(written);
  for (const name of PLACE_CHECK_PRIVATE_FILTERS) assert.equal(params.has(name), false, `🔴 ${name} is taken OFF an address that carried it`);
  assert.equal(params.get("review"), "1", "🔴 the one-by-one review's own parameter is left alone");
  assert.equal(params.get("campaign"), "x", "and so is a parameter this file does not know");
  assert.equal(params.get("tab"), "history", "its own parameters are replaced, not added twice");
  assert.equal(params.getAll("tab").length, 1);
  assert.deepEqual(parsePlaceCheckAddress(written), asked, "what is written reads back as the same view");
  assert.equal(placeCheckAddressSearch("", plain), "", "the plain page keeps its plain address");
  assert.equal(placeCheckAddressSearch("?tab=history&rows=40", plain), "", "and going back to the defaults clears it");
  assert.equal(placeCheckAddressSearch("", { ...plain, rows: 5000 }), "?rows=200", "the cap is applied on the way out too");

  // The private filters, kept for the visit in the session store.
  assert.equal(privateFiltersText({ rep: "", decider: " ", text: "" }), null, "nothing kept is nothing stored");
  const kept = privateFiltersText({ rep: "Hassan Adel", decider: "", text: "Mona" });
  assert.equal(kept, JSON.stringify({ rep: "Hassan Adel", text: "Mona" }), "empty values are left out");
  assert.deepEqual(parsePrivateFilters(kept), { rep: "Hassan Adel", decider: "", text: "Mona" });
  for (const garbage of [null, "", "not json", "null", "[1,2]", "42", JSON.stringify({ rep: 7, decider: null, text: ["a"] })]) {
    assert.deepEqual(parsePrivateFilters(garbage), { rep: "", decider: "", text: "" }, `anything that is not the object this file wrote reads as nothing kept: ${garbage}`);
  }
  assert.equal(parsePrivateFilters(JSON.stringify({ text: "y".repeat(400) })).text.length, 120);

  const hook = code("src/components/phoenix-crm/place-checks/use-board-address.ts");
  assert.ok(hook.includes("window.history.replaceState(window.history.state"), "the board writes the address without a history entry or a request");
  assert.ok(
    hook.includes("placeCheckAddressSearch(window.location.search, { tab, chip, rows, filters: { outcome, period, line, region, area, list } })"),
    "🔴 and hands the address the six filters a link may carry, by name: rep, decider and text are not among them",
  );
  assert.ok(hook.includes("privateFiltersText({ rep, decider, text })") && hook.includes("window.sessionStorage"), "those three go to the session store");
  assert.ok(!hook.includes("localStorage"), "never to a store that outlives the visit");
}

/** Every screen of Place checks that draws a word: the board, the lists it holds, the one-by-one review, the page. */
const PLACE_CHECK_SCREENS: ReadonlyArray<string> = [
  ...PLACE_CHECK_BOARD_FILES,
  "src/components/phoenix-crm/place-check-bulk.tsx",
  "src/components/phoenix-crm/place-check-decides.tsx",
  "src/components/phoenix-crm/place-check-done.tsx",
  "src/components/phoenix-crm/place-check-notes.tsx",
  "src/components/phoenix-crm/place-check-restore.tsx",
  "src/components/phoenix-crm/place-check-scorecard.tsx",
  "src/components/phoenix-crm/reopened-customer-list.tsx",
  // The four lists and the review are each a file and its parts since the split of 23 Nov 2026: every
  // part draws words, so every part is read.
  ...PLACE_CHECK_LIST_FILES["shared-place-customers"],
  ...PLACE_CHECK_LIST_FILES["shared-place-list"],
  "src/components/phoenix-crm/system-advice.tsx",
  ...PLACE_CHECK_LIST_FILES["validated-place-list"],
  ...PLACE_CHECK_LIST_FILES["validation-review-queue"],
  "src/components/place-review-deck/deck-parts.tsx",
  "src/components/place-review-deck/place-checks-with-deck.tsx",
  "src/components/place-review-deck/review-deck-button.tsx",
  ...PLACE_CHECK_LIST_FILES["review-deck"],
  "app/(admin)/admin/field-crm/validation-reviews/page.tsx",
];

/**
 * The files whose bulk bar offers decisions; each action is `label: "…",` then `busyLabel:`. The bulk
 * answers stayed in the file at each list's original path when its row's parts moved out (23 Nov 2026).
 */
const BULK_ACTION_FILES = ["src/components/phoenix-crm/validation-review-queue.tsx", "src/components/phoenix-crm/shared-place-list.tsx", "src/components/phoenix-crm/validated-place-list.tsx"];

function runWordingAndFileTests() {
  // 🔴 ONE VOCABULARY. The page decides with two verbs, and undoes a decision with the same two.
  assert.deepEqual(
    PLACE_CHECK_VERBS,
    { approve: "Approve", reject: "Reject", approveAfterAll: "Approve after all", rejectAfterAll: "Reject after all" },
    "Approve and Reject; taking one back is the other verb, 'after all' (his own words of 14 Nov 2026)",
  );
  assert.deepEqual([...PLACE_CHECK_RETIRED_VERBS], ["Refuse", "Refused", "Refusing"]);
  assert.deepEqual(PLACE_CHECK_LANE_LABEL, { ready: "Ready", your_call: "Your call" });

  const retired = new RegExp(`\\b(${PLACE_CHECK_RETIRED_VERBS.join("|")})\\b`);
  for (const path of PLACE_CHECK_SCREENS) {
    const hit = retired.exec(code(path));
    assert.equal(hit, null, `🔴 ${path} still says "${hit?.[0]}": the page's one word for it is Reject`);
  }

  const verbs = new Set<string>(Object.values(PLACE_CHECK_VERBS));
  let actions = 0;
  for (const path of BULK_ACTION_FILES) {
    for (const match of code(path).matchAll(/label: "([^"]+)",\n\s+busyLabel:/g)) {
      actions += 1;
      assert.ok(verbs.has(match[1]), `🔴 ${path} offers "${match[1]}" on its bulk bar, which is not one of the page's verbs`);
    }
  }
  assert.equal(actions, 9, "nine bulk actions on the three lists, every one read above (a new one is counted here)");

  // One Approve label and one Reject label on a row: the object is the row itself, never a second noun.
  const inUse = placeCheckListSource("validated-place-list", code);
  assert.ok(inUse.includes('{saving ? "Approving…" : PLACE_CHECK_VERBS.approve}'), "a place in use is approved with the page's own Approve");
  assert.ok(!inUse.includes("Approve this validation") && !inUse.includes("Reject this validation"), "🔴 not 'Approve this validation': one action had four names");
  assert.ok(!placeCheckListSource("shared-place-customers", code).includes("Reject this customer"));

  // The board's tabs are named by the lanes' own labels.
  const board = placeCheckBoardSource(code);
  assert.ok(board.includes("label: PLACE_CHECK_LANE_LABEL.ready"), "the Ready tab reads the lane's label");
  assert.ok(board.includes("placeCheckDesk(deskUnitsOf({ clinics: clinicPending, groups: everyVenueGroup }, agreement, openCases))"), "🔴 the header counts the rows BEFORE the filters, so its number never moves with one");
  assert.ok(board.includes("readyLaneRequests({ reviews: readyReviews, groups: readyGroups })"), "and the lane's one press sends what the pure function lists");
  // 🔴 EVERY SORT OF THE BOARD IS HANDED THE OPEN CASES: the lanes, the header's count, and the lane a
  // tapped count opens. One call without them would put an unsettled case back in Ready.
  assert.ok(board.includes("const openCases = useMemo(() => openCaseSubjects(noteIndex.integrity), [noteIndex.integrity]);"), "read from the cases the board already draws beside each row");
  assert.equal(board.split("laneOfReviewRow(row, agreement, openCases)").length - 1, 2, "both sorts of a waiting clinic");
  assert.equal(board.split("laneOfVenueGroup(group, agreement, openCases)").length - 1, 2, "and both sorts of a building");
  assert.ok(!board.includes("laneOfReviewRow(row, agreement)") && !board.includes("laneOfVenueGroup(group, agreement)"), "🔴 never a sort that leaves them out");
  assert.ok(board.includes("at least 19 times in 20. Nothing is approved until you press."), "the lane says AT LEAST 19 in 20: the figure is a floor, never the count");

  // 🔴 A PANEL DRAWS NO TABLE: THE LIST IT HOLDS OWNS THE TABLE AND THE PHONE CARDS (`place-checks/section.tsx`).
  // Every list a panel imports from the module is read here for both, so "a table has a phone layout" is
  // proven where the table is. A panel that drew its own table would have to carry its own cards.
  const dir = "src/components/phoenix-crm/place-checks";
  const lists = new Set<string>();
  for (const panel of ["needs-panel", "history-panel", "in-use-panel", "buildings-panel", "scorecard-panel"]) {
    const source = code(`${dir}/${panel}.tsx`);
    assert.ok(!/<(?:table|CrmTable|PortalDesktopTable|RgTable)\b/.test(source), `🔴 ${panel}.tsx draws a table of its own: it needs its own phone cards`);
    for (const match of source.matchAll(/import \{ ([A-Za-z]+(?:List|Queue|Scorecard|Panel)) \} from "@\/components\/phoenix-crm\/([a-z-]+)"/g)) lists.add(match[2]);
  }
  assert.deepEqual(
    [...lists].sort(),
    ["failing-timetables-panel", "place-check-scorecard", "reopened-customer-list", "shared-place-list", "validated-place-list", "validation-review-queue"],
    "the six lists the panels hold (a new one is read below)",
  );
  for (const list of lists) {
    assert.ok(code(`src/components/phoenix-crm/${list}.tsx`).includes("CrmCardsOnPhone"), `🔴 ${list}.tsx is drawn on the board and has no cards for a phone`);
  }
  // 🔴 A WAITING PLACE ON A PHONE IS CLOSED UNTIL IT IS PRESSED. Measured at 375 px in the preview of the
  // rebuild (23 Nov 2026): the page was 50,990 px long and one polyclinic ran 14,000 px, because every
  // card drew its photographs, evidence and controls whole. The two lists the lanes draw fold each card.
  const fold = code(`${dir}/phone-fold.tsx`);
  assert.ok(fold.includes("<details") && fold.includes("<summary") && fold.includes("{children}"), "HEADLINE: the fold is the browser's own details: closed, and what is inside is drawn once");
  assert.ok(fold.includes("min-h-11"), "its press target is 44px tall");
  const clinicCards = code("src/components/phoenix-crm/validation-review-queue.tsx");
  const buildingCards = code("src/components/phoenix-crm/shared-place-list.tsx");
  for (const [name, source] of [["validation-review-queue", clinicCards], ["shared-place-list", buildingCards]] as const) {
    const cards = source.slice(source.indexOf("<CrmCardsOnPhone>"), source.indexOf("</CrmCardsOnPhone>"));
    assert.ok(cards.includes("<PhoneFold"), `HEADLINE: ${name}.tsx folds each phone card`);
    assert.ok(!source.slice(source.indexOf("</CrmCardsOnPhone>")).includes("<PhoneFold"), `${name}.tsx: the desktop table is never folded`);
    assert.ok(cards.indexOf("<PhoneFold") < cards.indexOf("<LastColumn"), `HEADLINE: ${name}.tsx keeps the decision controls inside the fold, so there is one way to decide`);
    assert.equal(cards.split("<LastColumn").length - 1, 1, `${name}.tsx: the controls are drawn once per card`);
  }
  assert.ok(clinicCards.includes('{bulk && section === "waiting" ? ('), "HEADLINE: the system's word on a closed card is the Super Admin's alone, and only on a row that waits");
  assert.ok(buildingCards.includes("summary={<VenueHeader mode={mode} row={row} />}"), "a closed building says its name, its state and who captured it");
  // 🔴 "WHY THESE ARE YOUR CALL" IS ONE LINE UNTIL IT IS PRESSED. Open, it stood about 130 px above the
  // first waiting place at 1440 px (measured in the preview, 23 Nov 2026), and every row says its own reason.
  const needs = code(`${dir}/needs-panel.tsx`);
  const reasonsBox = needs.slice(needs.indexOf("data-your-call-reasons"), needs.indexOf("</details>"));
  assert.ok(needs.includes("<details") && reasonsBox.includes("<summary"), "HEADLINE: the reasons above Your call are a closed fold, never an open list above the first row");
  assert.ok(reasonsBox.includes("{reasons[0].count}") && reasonsBox.includes("{reasons[0].because}"), "closed, it still says the commonest reason and how many places it holds");
  assert.ok(reasonsBox.indexOf("</summary>") < reasonsBox.indexOf("reasons.slice(0, REASONS_SHOWN)"), "the full list is inside the fold, under the one line");
  // 🔴 THE REVIEW BUTTON STANDS BARE IN THE TOP LINE. As a boxed bar with its sentence it wrapped under the
  // headline and stood 58 px above the first waiting place at 1440 px (measured on the branch, 23 Nov 2026).
  const deckButton = code("src/components/place-review-deck/review-deck-button.tsx");
  assert.ok(code(PLACE_CHECK_BOARD_SHELL).includes("retry: reloadEverything, bare: lanes }"), "HEADLINE: the board with lanes asks for the review button bare, inside its top line");
  assert.ok(deckButton.includes("{rows.bare ? null : ("), "HEADLINE: bare, the button draws no title and no sentence of its own");
  assert.match(deckButton, /rows\.bare\s+\? "flex min-w-0 max-w-full flex-wrap items-center gap-3"/, "and no box of its own inside the top line's box");
  // 🔴 THE FOLDED FILTERS LINE ENDS THE TAB STRIP'S LAST ROW ON HIS BOARD. As a boxed bar of its own it stood
  // 82 px, the bar and its gap, above the first waiting place (the live page, 23 Nov 2026). The boxes still
  // open in their own panel, a phone keeps the bar, and a board with no lanes keeps it whole.
  const strip = code(`${dir}/tab-strip.tsx`);
  const filterBar = code(`${dir}/filter-bar.tsx`);
  assert.ok(strip.includes("{lanes ? (") && strip.includes("<PlaceCheckFilterLine board={board} inStrip />"), "HEADLINE: on a board with lanes the tab strip draws the folded Filters line");
  // 🔴 IN THE STRIP THE LINE TAKES ONLY THE WIDTH ITS WORDS NEED. With the bar's `flex-1 basis-60` under the
  // labels, or a `flex-1` on the line itself, it never fitted beside the last tabs: it took a row of its own
  // and the strip grew (headless, the same classes in a 1,126 px column, 23 Nov 2026: 144 px against 88).
  // Set on the live page's own elements, it gives back 82 px beside the last tabs and 39 px on its own row.
  assert.ok(filterBar.includes('!inStrip && "flex-1 basis-60"'), "HEADLINE: in the strip the labels drop the bar's 240 px floor, so the line fits beside the last tabs");
  assert.ok(filterBar.includes('inStrip && "shrink-0"'), "and the buttons never shrink there, so their words never wrap and raise the row");
  assert.ok(strip.includes('className="ml-auto flex min-w-0 max-w-full items-center gap-x-3 py-1 pl-3" data-filters-in-strip'), "the line asks for no width of its own, ends the row, and stands no taller than a tab (36 + 8 = 44 px)");
  assert.ok(strip.includes('className="contents" role="tablist"'), "the tab list is `contents`, so the tabs and the line wrap as one row");
  assert.ok(strip.indexOf("data-filters-in-strip") > strip.indexOf('role="tab"'), "and the line stands after the tabs: it is no tab");
  assert.ok(filterBar.includes('lanes && !filtersOpen && "sm:hidden"'), "HEADLINE: closed, the boxed Filters bar leaves a desktop on a board with lanes");
  assert.ok(filterBar.includes('"flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3", lanes && "sm:hidden"'), "open, the box holds the fields alone: the line is never drawn twice on a desktop");
  assert.equal(filterBar.split("<PlaceCheckFilterLine board={board} />").length - 1, 1, "a phone, and a board with no lanes, still read the line in the bar");
  assert.ok(
    code(`${dir}/section.tsx`).includes('export { AdminTableShell as PlaceCheckSection } from "@/components/admin/admin-design-system";'),
    "the panels' titled card is the admin shell's own, so the board keeps its sibling pages' look",
  );

  // 🔴 A NEW FILE OF THE BOARD IS IN THE LIST THE SOURCE PINS READ, or the rule it carries is pinned by nothing.
  const listed = new Set(PLACE_CHECK_BOARD_FILES);
  const onDisk = readdirSync(new URL(`${dir}/`, ROOT)).map((name) => `${dir}/${name}`);
  assert.ok(onDisk.length >= 16, "the board's folder is read");
  for (const path of onDisk) assert.ok(listed.has(path), `🔴 ${path} is a file of the board the source pins do not read: add it to PLACE_CHECK_BOARD_FILES`);
  assert.ok(listed.has(PLACE_CHECK_BOARD_SHELL), "the frame is one of them");
  assert.equal(listed.size, PLACE_CHECK_BOARD_FILES.length, "and none is listed twice");
  for (const path of PLACE_CHECK_BOARD_FILES) assert.ok(code(path).length > 0, `${path} exists and holds code`);

  // 🔴 THE SAME RULE FOR THE FIVE FILES SPLIT INTO PARTS BESIDE THEMSELVES (23 Nov 2026): a new part of a
  // list is in the list the source pins read. A part is a sibling named `<list>-…`; the review's opener,
  // `review-deck-button.tsx`, was a file of its own long before the split and is read by name above.
  const notAPart = new Set(["src/components/place-review-deck/review-deck-button.tsx"]);
  for (const list of Object.keys(PLACE_CHECK_LIST_FILES) as PlaceCheckList[]) {
    const files = PLACE_CHECK_LIST_FILES[list];
    const original = PLACE_CHECK_LIST_PATHS[list];
    const folder = original.slice(0, original.lastIndexOf("/"));
    const base = original.slice(folder.length + 1, -".tsx".length);
    assert.equal(files.filter((path) => path === original).length, 1, `${list}: the file at the original path is read, once`);
    assert.equal(new Set(files).size, files.length, `${list}: no part is listed twice`);
    for (const path of files) assert.ok(code(path).length > 0, `${path} exists and holds code`);
    const siblings = readdirSync(new URL(`${folder}/`, ROOT))
      .filter((name) => name.startsWith(`${base}-`))
      .map((name) => `${folder}/${name}`);
    assert.ok(siblings.length >= 2, `${list}: its parts are read from the folder`);
    for (const path of siblings) {
      assert.ok(files.includes(path) || notAPart.has(path), `🔴 ${path} is a part of ${list} the source pins do not read: add it to PLACE_CHECK_LIST_FILES`);
    }
  }
}

export function runPhoenixCrmPlaceCheckLanesTests() {
  runLaneTests();
  runDeskTests();
  runAddressTests();
  runWordingAndFileTests();
}
