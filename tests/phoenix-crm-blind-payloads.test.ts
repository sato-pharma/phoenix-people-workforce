import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { AccessContext } from "../src/lib/auth/permissions.ts";
import { phoenixVisitDetail } from "../src/lib/crm/phoenix-visit-detail.ts";
import { groupVisitsByRep, type ByList, type VisitCounts } from "../src/lib/phoenix-crm/report-rules.ts";
import type { OrgSeat } from "../src/lib/phoenix-crm/scope.ts";
import {
  locationReportSeats,
  locationSight,
  readsLocationDetail,
  readsPlaceVsActual,
  readsSeatLocations,
  readsTeamReportsOn,
  type PhoenixCrmViewer,
} from "../src/lib/phoenix-crm/server/access.ts";
import {
  blindTerritoryList,
  blindVisitForm,
  blindVisitsReport,
  offPlanLocationFlag,
  placeWithoutMeasurements,
} from "../src/lib/phoenix-crm/server/blind-payloads.ts";
import { loadPhoenixCrmDayPage } from "../src/lib/phoenix-crm/server/day-detail.ts";
import { canReadDuplicateCustomers } from "../src/lib/phoenix-crm/server/duplicate-customers.ts";
import { canReadIntegrityBoard, readsPositionCases } from "../src/lib/phoenix-crm/server/integrity-board.ts";
import { mapPlaceRow, type ListPlace, type TerritoryListView } from "../src/lib/phoenix-crm/server/list.ts";
import { visitLocationFor, type VisitFormView } from "../src/lib/phoenix-crm/server/visits.ts";
import { stripComments } from "./support/comment-strip.ts";
import { listCustomer } from "./support/phoenix-crm-list-customer.ts";

/**
 * Phoenix CRM — who receives a measurement, enforced where the answer LEAVES THE SERVER.
 *
 * GOLDEN RULE #1: the rep gets no warning, badge, refusal, wording, distance or flag about any check of
 * his honesty — and a JSON field his browser receives counts as SHOWN even when React hides it. The
 * precedent is `team.ts`, which cleared `locationFlag` on the server on 2026-10-02 for exactly that
 * reason. The Phoenix CRM audit of the same day found five more holes, each hidden only by a screen:
 *
 *   1. the Visits report's `farVisits` on a rep's own seat;
 *   2. the List's place measurements and `rules.weakGpsMeters`;
 *   3. the visit form's `rules.visitFarMeters` and `rules.weakGpsMeters`;
 *   4. an ACTING District Manager's OWN seat inside the team-only sections;
 *   5. gate one (`canAccess(…, "phoenix_crm", "read")`) missing from the day page and two admin pages.
 *
 * The owner then ruled three visibility questions the same evening, picking the recommended answers:
 *
 *   A. the mock-location (position) evidence is the Super Admin's ONLY — the SFE Manager keeps the
 *      photo cases and the behaviour months, and the duplicates list gets its own predicate;
 *   B. every reader below the Super Admin and the SFE Manager sees the DISTANCE only — no accuracy, no
 *      weak-signal wording, no phone-clock warning, no raw readings, no point source;
 *   C. the place-vs-actual report is the DM's (acting or not), the NSM's, SFE's and the Super Admin's —
 *      not the CEO's and not a regional manager's.
 *
 * ## What is called, and why not the database
 *
 * Every loader reads Supabase, and this suite runs with PRODUCTION credentials. So each loader's answer
 * now ends in a pure shaper (`server/blind-payloads.ts`, `visitLocationFor`), and this test builds the
 * payload the way the loader does — through the loader's OWN mappers, `groupVisitsByRep` and
 * `mapPlaceRow`, from database-shaped rows — passes it through that shaper as each reader, and asserts
 * the fields are ABSENT, not zero. A source pin proves each loader returns through its shaper. The day
 * page needs no database for its refusal, so it is called for real, with `fetch` replaced so a single
 * request would be counted.
 *
 * ## Why the sections collect their failures
 *
 * Independent holes: one run names every one that is open, instead of one per CI round.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

/** The body of one top-level function: from its signature to the first closing brace at column 0. */
function bodyOf(text: string, signature: string): string {
  const start = text.indexOf(signature);
  assert.notEqual(start, -1, `${signature} is still there`);
  const end = text.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `${signature} has a closing brace at column 0`);
  return text.slice(start, end + 2);
}

/**
 * The function's OWN returns: a `return` opening a line at two spaces (its body) or four (an `if`
 * block in it). A callback's return inside a `.map` sits deeper and is not the loader's answer — and a
 * loader whose body moved to another indentation fails the "at least one" checks below, never passes.
 */
function ownReturns(body: string, indents: ReadonlyArray<number>): string[] {
  return body.split("\n").filter((line) => indents.some((indent) => line.startsWith(`${" ".repeat(indent)}return `)));
}

function seat(seatId: string, occupantHrId: string, tier = "REP"): OrgSeat {
  return {
    seatId,
    parentSeatId: "seat-dm",
    tier,
    path: ["seat-ceo", "seat-dm", seatId],
    occupantHrId,
    lineCode: "CNS",
    lineName: "CNS",
    areaName: "Delta",
    regionName: "Delta",
    seatLabel: seatId,
  };
}

/** The rep's own territory, and one territory of his team when he is also its acting manager. */
const OWN = seat("seat-own", "B-900");
const TEAM = seat("seat-team", "B-901");

/**
 * The fields the access predicates and the shapers read. A partial cast is honest here because that
 * is their whole contract; a real viewer needs an organogram, a config and a live access context.
 */
function viewerWith(patch: Partial<PhoenixCrmViewer>): PhoenixCrmViewer {
  return {
    hrId: "B-900",
    role: "Medical Rep",
    isSuperAdmin: false,
    isSfeManager: false,
    isTestPersona: false,
    basis: "tree",
    managerSeats: [],
    ownTerritories: [],
    scopeTerritories: [],
    ...patch,
  } as unknown as PhoenixCrmViewer;
}

const REP = viewerWith({ ownTerritories: [OWN], scopeTerritories: [OWN] });
const ACTING_DM = viewerWith({
  role: "District Manager",
  ownTerritories: [OWN],
  scopeTerritories: [OWN, TEAM],
  managerSeats: [seat("seat-dm", "B-900", "ACTING_DM")],
});
const DM = viewerWith({ hrId: "B-800", role: "District Manager", scopeTerritories: [OWN, TEAM], managerSeats: [seat("seat-dm", "B-800", "DM")] });
const RSM = viewerWith({ hrId: "B-600", role: "Regional Manager", scopeTerritories: [OWN, TEAM], managerSeats: [seat("seat-rsm", "B-600", "RSM")] });
const NSM = viewerWith({ hrId: "B-500", role: "National Sales Manager", scopeTerritories: [OWN, TEAM], managerSeats: [seat("seat-nsm", "B-500", "NSM")] });
const CEO = viewerWith({ hrId: "B-100", role: "CEO", basis: "all", scopeTerritories: [OWN, TEAM] });
const SFE = viewerWith({ hrId: "B-700", role: "SFE Manager", isSfeManager: true, basis: "all", scopeTerritories: [OWN, TEAM] });
const SUPER_ADMIN = viewerWith({ hrId: "B-10", role: "Super Admin", isSuperAdmin: true, basis: "all", scopeTerritories: [OWN, TEAM] });

/** Every key anywhere in a payload, at any depth — what a browser would receive. */
function keysIn(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) keysIn(entry, into);
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      into.add(key);
      keysIn(entry, into);
    }
  }
  return into;
}

function assertAbsent(payload: unknown, keys: ReadonlyArray<string>, who: string): void {
  const present = keysIn(payload);
  const leaked = keys.filter((key) => present.has(key));
  assert.deepEqual(leaked, [], `${who} received ${leaked.join(", ")} — a field a browser receives counts as shown`);
}

// ── 1 + 4 + C · the Visits report's far counts ──────────────────────────────────────────────────

/** `phoenix_crm_report_visits_by_day` rows, as the RPC returns them. */
const VISIT_ROWS = [
  { seat_id: OWN.seatId, rep_hr_id: "B-900", visit_date: "2026-10-03", list_type: "AM", visits: 4, double_visits: 0, chain_visits: 0, far_visits: 3, test_visits: 0, unplanned_waiting: 0 },
  { seat_id: OWN.seatId, rep_hr_id: "B-900", visit_date: "2026-10-03", list_type: "PM", visits: 9, double_visits: 1, chain_visits: 0, far_visits: 2, test_visits: 0, unplanned_waiting: 1 },
  { seat_id: OWN.seatId, rep_hr_id: null, visit_date: "2026-10-04", list_type: "PM", visits: 2, double_visits: 0, chain_visits: 0, far_visits: 1, test_visits: 0, unplanned_waiting: 0 },
  { seat_id: TEAM.seatId, rep_hr_id: "B-901", visit_date: "2026-10-03", list_type: "PM", visits: 8, double_visits: 0, chain_visits: 1, far_visits: 4, test_visits: 0, unplanned_waiting: 0 },
];

function visitsView(seatIds: ReadonlyArray<string>) {
  const { groups, totals } = groupVisitsByRep(VISIT_ROWS.filter((row) => seatIds.includes(row.seat_id)));
  return { period: { from: "2026-10-01", to: "2026-10-31" }, includeTest: false, rows: groups, totals, comparison: null };
}

function checkVisitsReport(): void {
  // The rep on his own seat: the field leaves every row, every day and both totals.
  const forRep = blindVisitsReport(REP, visitsView([OWN.seatId]), [OWN]);
  assertAbsent(forRep, ["farVisits"], "the rep (Visits report)");
  assert.equal(forRep.totals.PM.visits, 11, "the rep's own visit counts are his and are untouched");
  assert.equal(forRep.rows.find((row) => row.repHrId === "B-900")?.pm.doubleVisits, 1, "his double visits are his work and stay");

  // The acting District Manager: his team's far count stays, his own leaves, and the totals are the
  // team's alone so his own cannot be had by subtraction.
  const forActing = blindVisitsReport(ACTING_DM, visitsView([OWN.seatId, TEAM.seatId]), [OWN, TEAM]);
  assertAbsent(forActing.rows.filter((row) => row.seatId === OWN.seatId), ["farVisits"], "the acting DM, on his own seat (Visits report)");
  assert.equal(forActing.rows.find((row) => row.seatId === TEAM.seatId)?.pm.farVisits, 4, "the acting DM keeps his team's far count");
  const totals: ByList<VisitCounts> = forActing.totals;
  assert.equal(totals.PM.farVisits, 4, "the total is the team's alone — never his own plus theirs");
  assert.equal(totals.AM.farVisits, 0, "nothing measured in the AM for the team");

  // Ruling C: the far count is the place-vs-actual report's figure, so the CEO and a regional manager —
  // who read this tab but not that report — receive none of it.
  for (const [who, viewer] of [["the CEO", CEO], ["a regional manager", RSM]] as const) {
    assertAbsent(blindVisitsReport(viewer, visitsView([OWN.seatId, TEAM.seatId]), [OWN, TEAM]), ["farVisits"], `${who} (Visits report)`);
  }

  // Positive control: the district manager, the NSM and SFE keep every far count.
  for (const [who, viewer] of [["the district manager", DM], ["the NSM", NSM], ["SFE", SFE]] as const) {
    assert.equal(blindVisitsReport(viewer, visitsView([OWN.seatId, TEAM.seatId]), [OWN, TEAM]).totals.PM.farVisits, 7, `${who} keeps every far count`);
  }

  // The loader returns through the shaper on BOTH of its paths, the empty one included.
  const loader = bodyOf(source("src/lib/phoenix-crm/server/reports.ts"), "export async function loadVisitsReport(");
  const returns = ownReturns(loader, [2, 4]);
  const shaped = returns.filter((line) => line.trim().startsWith("return blindVisitsReport("));
  assert.ok(
    returns.length >= 2 && shaped.length === returns.length,
    `loadVisitsReport must return through blindVisitsReport every time (${shaped.length} of ${returns.length})`,
  );
}

// ── 2 + B · the List's place measurements ───────────────────────────────────────────────────────

const MOVE_REASON = "Moved by SFE: the photo was taken across the road";

/** A `phoenix_crm_places` row with every measurement filled — read by the loader's own mapper. */
const PLACE_ROW = {
  id: "place-1",
  label: "Main clinic",
  address: "12 Tahrir St",
  brick_id: "BR-1",
  brick_name: "Tanta Center",
  brick_distance_km: 0.8,
  area_code: "DL",
  area_name: "Delta",
  region_code: "DE",
  region_name: "Delta",
  zone: "Tanta",
  lat: 30.7865,
  lon: 31.0004,
  accuracy_meters: 140,
  timings: [{ weekday: 0, startMinute: 1080, endMinute: 1260, season: "normal" }],
  photo_path: "places/place-1.jpg",
  captured_at: "2026-10-01T15:00:00Z",
  device_skew_minutes: 42,
  point_source: "moved",
  pin_lat: 30.7861,
  pin_lon: 31.0001,
  pin_accuracy_meters: 22,
  brick_lookup: "none_nearby",
  photo_lat: 30.7871,
  photo_lon: 31.0012,
  photo_accuracy_meters: 140,
  moved_at: "2026-10-02T09:00:00Z",
  move_reason: MOVE_REASON,
};

/** What nobody below the Super Admin and the SFE Manager may receive about a place. */
const PLACE_MEASUREMENTS = ["clockOff", "accuracyMeters", "pinReading", "photoReading", "pointSource", "moved", "brickDistanceKm", "brickLookup"] as const;

function listView(place: ListPlace): TerritoryListView {
  return {
    customers: [listCustomer({ customerId: "c-1", places: [place] })],
    rules: { weakGpsMeters: 100, placesMax: 5 },
  } as unknown as TerritoryListView;
}

function checkList(): void {
  const mapped = mapPlaceRow(PLACE_ROW);
  // The fixture really carries every measurement, or the absence below proves nothing.
  for (const key of PLACE_MEASUREMENTS) assert.ok(mapped[key] !== undefined && mapped[key] !== null, `the fixture's mapped place carries ${key}`);
  assert.equal(mapped.clockOff, true, "the fixture's phone clock is off");

  // The rep (Golden Rule #1) and every manager below SFE (ruling B) receive none of them.
  for (const [who, viewer] of [["the rep", REP], ["the district manager", DM], ["the NSM", NSM], ["the CEO", CEO]] as const) {
    const view = blindTerritoryList(viewer, listView(mapped));
    assertAbsent(view, [...PLACE_MEASUREMENTS, "weakGpsMeters"], `${who} (List)`);
    assert.ok(!JSON.stringify(view).includes(MOVE_REASON), `${who} never receives the mover's written reason`);
    const place = view.customers[0]?.places[0];
    // His own board needs the point — the pin each address opens, and the neighbours (`rowPoint`).
    assert.equal(place?.lat, PLACE_ROW.lat, `${who} keeps the place's point: it is where the customer is, never a judgement`);
    assert.equal(place?.brickName, "Tanta Center", `${who} keeps the brick name`);
    assert.equal(view.rules.placesMax, 5, `${who} keeps how many clinics a customer may hold — the add-a-clinic button needs it`);
  }

  // An allow-list, so a measurement added to the place later is withheld until somebody decides. This
  // fails the day the mapper gains a field nobody has classified as plain or as a measurement.
  const kept = Object.keys(placeWithoutMeasurements(mapped)).sort();
  const expected = Object.keys(mapped)
    .filter((key) => !(PLACE_MEASUREMENTS as ReadonlyArray<string>).includes(key))
    .sort();
  assert.deepEqual(kept, expected, "every field of a mapped place is either plain or a named measurement");

  // Positive control: the Super Admin and the SFE Manager still read every measurement.
  for (const [who, viewer] of [["the Super Admin", SUPER_ADMIN], ["the SFE Manager", SFE]] as const) {
    const view = blindTerritoryList(viewer, listView(mapped));
    assert.equal(view.customers[0]?.places[0]?.clockOff, true, `${who} still reads the phone clock`);
    assert.equal(view.rules.weakGpsMeters, 100, `${who} still receives the weak-signal threshold`);
  }

  const loader = bodyOf(source("src/lib/phoenix-crm/server/list.ts"), "export async function loadTerritoryList(");
  assert.deepEqual(ownReturns(loader, [2]), ["  return blindTerritoryList(viewer, {"], "loadTerritoryList returns once, through blindTerritoryList");
  assert.match(loader, /seesMeasurements: readsLocationDetail\(viewer\),/, "the screen is told by the server who sees measurements");
  const screen = source("src/components/phoenix-crm/list-customer.tsx");
  assert.match(screen, /function seesMeasurements\(view: TerritoryListView\): boolean \{\s*return view\.seesMeasurements;\s*\}/, "the screen asks the server's answer");
}

// ── 3 + B · the visit form's thresholds ─────────────────────────────────────────────────────────

function formView(): VisitFormView {
  return { customers: [], todayVisits: [], rules: { visitFarMeters: 300, weakGpsMeters: 100 } } as unknown as VisitFormView;
}

function checkVisitForm(): void {
  assertAbsent(blindVisitForm(REP, OWN, formView()), ["rules", "visitFarMeters", "weakGpsMeters"], "the rep (visit form)");
  const forDm = blindVisitForm(DM, OWN, formView());
  assert.deepEqual(forDm.rules, { visitFarMeters: 300 }, "a manager entering a visit keeps how far is far, and nothing about the reading");
  assert.deepEqual(blindVisitForm(SFE, OWN, formView()).rules, { visitFarMeters: 300, weakGpsMeters: 100 }, "SFE keeps both thresholds");

  const loader = bodyOf(source("src/lib/phoenix-crm/server/visits.ts"), "export async function loadVisitForm(");
  assert.deepEqual(ownReturns(loader, [2]), ["  return blindVisitForm(viewer, seat, {"], "loadVisitForm returns once, through blindVisitForm");
}

// ── B · a visit's location line, the day page, the saved visit and the off-plan cards ──────────

function checkVisitLocation(): void {
  // Who sees how much, seat by seat.
  assert.equal(locationSight(REP, OWN), "none", "the rep on his own seat sees nothing");
  assert.equal(locationSight(ACTING_DM, OWN), "none", "so does the acting DM on his own rep seat");
  assert.equal(locationSight(ACTING_DM, TEAM), "distance", "and the distance only on his team's");
  for (const [who, viewer] of [["the district manager", DM], ["the RSM", RSM], ["the NSM", NSM], ["the CEO", CEO]] as const) {
    assert.equal(locationSight(viewer, OWN), "distance", `${who} sees the distance only`);
    assert.equal(readsLocationDetail(viewer), false, `${who} never reads the reading behind it`);
  }
  for (const [who, viewer] of [["the Super Admin", SUPER_ADMIN], ["the SFE Manager", SFE]] as const) {
    assert.equal(locationSight(viewer, OWN), "full", `${who} sees everything`);
  }

  // A weak reading, 80 m from the place, read at each level.
  const weakFull = visitLocationFor("full", "weak_gps", 80, 260);
  assert.equal(weakFull.locationFlag, "weak_gps", "SFE reads the weak-signal verdict");
  assert.match(weakFull.locationLabel, /not sure where it was/, "and its sentence, with the accuracy");
  const weakDistance = visitLocationFor("distance", "weak_gps", 80, 260);
  assert.equal(weakDistance.locationFlag, "ok", "a weak reading is never far, so a manager reads it as at the place");
  assert.equal(weakDistance.locationLabel, "At the saved place (80 m)", "with the plain distance and nothing about the signal");
  assert.ok(!/not sure|within|accura|signal/i.test(weakDistance.locationLabel), "no weak-signal wording reaches a manager");
  assert.match(visitLocationFor("distance", "far", 900, 260).locationLabel, /^About .* from this customer's saved place$/, "far stays far, by its distance");
  assert.deepEqual(visitLocationFor("none", "far", 900, 260), { locationFlag: "ok", locationLabel: "Visit saved" }, "the rep reads that it is saved, and nothing else");

  // A visit to a customer with no saved place says the location was captured, only when the row holds one.
  const capturedLine = "Location captured; no saved place to compare it with yet";
  assert.equal(visitLocationFor("distance", "no_place", null, 12, false, true).locationLabel, capturedLine, "a manager reads that the location was captured");
  assert.equal(visitLocationFor("full", "no_place", null, 12, false, true).locationLabel, capturedLine, "and so do SFE and the Super Admin");
  assert.equal(visitLocationFor("distance", "no_place", null, null).locationLabel, "No place saved for this customer yet", "a copied visit with no coordinates never claims a capture");
  assert.equal(visitLocationFor("full", "no_place", null, null, true, false).locationLabel, "No location: entered later by the Super Admin", "a visit the Super Admin entered still says it has no location");
  assert.deepEqual(visitLocationFor("none", "no_place", null, 12, false, true), { locationFlag: "ok", locationLabel: "Visit saved" }, "the rep still reads nothing about a location");
  const reportRow = { visit_kind: "single", location_flag: "no_place", distance_meters: null, accuracy_meters: 12 };
  assert.equal(phoenixVisitDetail({ ...reportRow, lat: 30.1, lon: 31.2 }, "distance").location, capturedLine, "the CRM report row reads its own coordinates");
  assert.equal(phoenixVisitDetail({ ...reportRow, lat: null, lon: null }, "distance").location, "No place saved for this customer yet", "and a report row with none never claims a capture");
  const hasReadingArgument = /enteredByAdmin,\s*numberOrNull\(row\.lat\) !== null && numberOrNull\(row\.lon\) !== null,?\s*\)/;
  assert.match(stripComments(bodyOf(source("src/lib/phoenix-crm/server/visits.ts"), "function mapVisitRow(")), hasReadingArgument, "the day page's rows answer from their own coordinates");
  assert.match(/const VISIT_COLUMNS =[^;]*;/.exec(stripComments(source("src/lib/phoenix-crm/server/visits.ts")))?.[0] ?? "", /"lat, lon, /, "and the visit read selects them, or every row would look as if it had no reading");

  // The off-plan approval cards.
  assert.equal(offPlanLocationFlag("none", "far"), null, "the rep's own waiting visit carries no flag");
  assert.equal(offPlanLocationFlag("distance", "weak_gps"), "ok", "a manager's card says nothing about the signal");
  assert.equal(offPlanLocationFlag("distance", "far"), "far", "and still says far");
  assert.equal(offPlanLocationFlag("full", "weak_gps"), "weak_gps", "SFE's card keeps the verdict");

  // Every reader of a visit's location goes through the one rule.
  const visits = source("src/lib/phoenix-crm/server/visits.ts");
  const mapper = bodyOf(visits, "function mapVisitRow(");
  assert.match(mapper, /\.\.\.visitLocationFor\(options\.sight, /, "every visit row's location goes through visitLocationFor");
  assert.match(mapper, /clockOff: options\.sight === "full" && /, "the phone-clock warning is the Super Admin's and SFE's alone");
  assert.match(visits, /const location = visitLocationFor\(locationSight\(viewer, seat\), flag, distance, visit\.accuracyMeters, false, true\);/, "and so does the saved visit, which always holds a reading");
  assert.ok(!/blind: |options\.blind/.test(visits), "no boolean blind flag is left beside the three levels");
  assert.match(source("src/lib/phoenix-crm/server/today.ts"), /\{ sight: locationSight\(viewer, seat\), org: viewer\.org \}/, "the Today screen asks the same rule");
  assert.match(
    source("src/lib/phoenix-crm/server/team.ts"),
    /locationFlag: offPlanLocationFlag\(seat \? locationSight\(viewer, seat\) : "none", view\.locationFlag\),/,
    "the off-plan cards ask the same rule, and an unplaceable seat fails blind",
  );
}

// ── 4 + C · the place-vs-actual report and the tracking note ────────────────────────────────────

function checkTeamSections(): void {
  // Ruling C: who reads the place-vs-actual report.
  for (const [who, viewer] of [["the Super Admin", SUPER_ADMIN], ["SFE", SFE], ["the district manager", DM], ["the acting DM", ACTING_DM], ["the NSM", NSM]] as const) {
    assert.equal(readsPlaceVsActual(viewer), true, `${who} reads the place-vs-actual report`);
  }
  for (const [who, viewer] of [["the CEO", CEO], ["a regional manager", RSM], ["the rep", REP]] as const) {
    assert.equal(readsPlaceVsActual(viewer), false, `${who} does not read the place-vs-actual report`);
  }

  // Fix 4: never the acting DM's own seat.
  assert.deepEqual(
    locationReportSeats(ACTING_DM, [OWN, TEAM]).map((entry) => entry.seatId),
    [TEAM.seatId],
    "the place-vs-actual report never measures the acting DM's own seat",
  );
  assert.equal(readsSeatLocations(ACTING_DM, TEAM), true, "the acting DM still reads his team");
  assert.equal(readsTeamReportsOn(ACTING_DM, OWN), false, "no spacing note on the acting DM's own sheet");
  assert.equal(readsTeamReportsOn(ACTING_DM, TEAM), true, "but on his team's");
  assert.equal(readsTeamReportsOn(CEO, OWN), true, "the spacing note is not a location figure, and ruling C left it with the CEO");
  assert.equal(readsTeamReportsOn(REP, OWN), false, "a rep reads no judgement of how he worked");

  const reports = source("src/lib/phoenix-crm/server/reports.ts");
  assert.ok(reports.includes("const canReadLocationReport = readsPlaceVsActual;"), "the report and canSeeLocations share the report's own predicate");
  const location = bodyOf(reports, "export async function loadVisitLocationReport(");
  assert.match(location, /const seats = locationReportSeats\(viewer, chosen\.seats\);/, "the place-vs-actual report narrows its seats first");
  const afterNarrowing = location.slice(location.indexOf("const seats = locationReportSeats("));
  assert.ok(!/chosen\.seats\.map|chosen\.seats\.length/.test(afterNarrowing), "nothing after the narrowing reads the un-narrowed seats");
  // Ruling B on the report: the distance for the DM and the NSM, the reading behind it for SFE and the
  // Super Admin alone — absent, never zero.
  assert.match(location, /const detail = readsLocationDetail\(viewer\);/, "the report asks who reads the reading behind a distance");
  assert.match(location, /\.\.\.\(detail \? \{ accuracyMeters: numberOrNull\(row\.accuracy_meters\) \} : \{\}\),/, "accuracy leaves the server for SFE and the Super Admin alone");
  assert.match(location, /locationFlag: !detail && flag === "weak_gps" \? "ok" : flag,/, "a weak reading reads as its plain distance to a manager");
  assert.match(location, /\.\.\.\(detail \? \{ weakGps \} : \{\}\)/, "and the weak-signal count is not his");

  const tracking = bodyOf(reports, "export async function loadTrackingSheetReport(");
  assert.match(tracking, /const managerView = readsTeamReportsOn\(viewer, seat\);/, "the spacing note is decided per seat");

  const exportRoute = source("app/api/phoenix-crm/reports/export/route.ts");
  assert.match(exportRoute, /locationSection \? loadVisitLocationReport\(/, "the workbook's location sheet follows the report's own audience");
}

// ── A · the integrity board and the duplicates list ─────────────────────────────────────────────

function checkIntegrityBoard(): void {
  assert.equal(readsPositionCases(SUPER_ADMIN), true, "the Super Admin reads the position cases");
  assert.equal(readsPositionCases(SFE), false, "the SFE Manager does not — the mock-location evidence is the Super Admin's only");
  assert.equal(canReadIntegrityBoard(SFE), true, "but SFE still opens the board, for the photo cases and the behaviour months");
  for (const viewer of [DM, NSM, CEO, REP]) assert.equal(canReadIntegrityBoard(viewer), false, "and nobody else opens it at all");
  // The duplicates list is housekeeping, and kept its two readers through the split.
  assert.equal(canReadDuplicateCustomers(SFE), true, "SFE keeps the duplicates list");
  assert.equal(canReadDuplicateCustomers(SUPER_ADMIN), true, "and so does the Super Admin");
  assert.equal(canReadDuplicateCustomers(DM), false, "and nobody else");
  // Where the board's QUERY is pinned: tests/phoenix-crm-blind-half.test.ts, section 6.
}

// ── 5 · gate one on the day page and the two admin pages ────────────────────────────────────────

async function checkGateOne(): Promise<void> {
  // A per-account module lock and a role without the grant both make `canAccess` answer false; a
  // `none` scope reaches that answer without a database round trip, which is what lets the real loader
  // run here. Anything the loader asks of Supabase before refusing is counted, and refused.
  const locked: AccessContext = { hrId: "B-900", loginId: "rep.locked", role: "Medical Rep", scope: "none", source: "session" };
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    throw new Error("phoenix-crm-blind-payloads: no request may leave this test");
  }) as typeof fetch;
  try {
    const load = await loadPhoenixCrmDayPage(locked, { seatId: OWN.seatId, date: "2026-10-03", test: false });
    assert.equal(load.kind, "refused", "a locked account is refused the day page");
    assert.equal(requests, 0, "the refusal comes from gate one, before the organogram is read");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const day = bodyOf(source("src/lib/phoenix-crm/server/day-detail.ts"), "export async function loadPhoenixCrmDayPage(");
  const gate = day.indexOf('canAccess(access, "phoenix_crm", "read")');
  assert.ok(gate !== -1 && gate < day.indexOf("resolvePhoenixCrmViewer("), "the day page asks gate one before anything else");

  for (const [page, reader] of [
    ["app/(admin)/admin/phoenix-crm/integrity/page.tsx", "canReadIntegrityBoard(viewer)"],
    ["app/(admin)/admin/phoenix-crm/duplicates/page.tsx", "canReadDuplicateCustomers(viewer)"],
    ["app/(admin)/admin/phoenix-crm/master-list/page.tsx", "canReadMasterList(viewer)"],
    ["app/(admin)/admin/phoenix-crm/refused-readings/page.tsx", "canReadRefusedReadings(viewer)"],
    ["app/(admin)/admin/phoenix-crm/visit-report/page.tsx", "canReadVisitReport(viewer)"],
    ["app/employee-portals/visit-report/page.tsx", "canReadVisitReport(viewer)"],
    ["app/(admin)/admin/phoenix-crm/my-map/page.tsx", "canReadMyMap(viewer)"],
    ["app/employee-portals/my-map/page.tsx", "canReadMyMap(viewer)"],
  ] as const) {
    const text = source(page);
    const pageGate = text.indexOf('canAccess(access, "phoenix_crm", "read")');
    assert.ok(pageGate !== -1 && pageGate < text.indexOf("resolvePhoenixCrmViewer("), `${page} asks gate one before the organogram`);
    assert.ok(text.includes(reader), `${page} keeps its own reader predicate`);
  }
}

export async function runPhoenixCrmBlindPayloadTests(): Promise<void> {
  const sections: Array<[string, () => void | Promise<void>]> = [
    ["1 · the Visits report's far counts", checkVisitsReport],
    ["2 · the List's place measurements", checkList],
    ["3 · the visit form's thresholds", checkVisitForm],
    ["B · a visit's location: the distance only below SFE", checkVisitLocation],
    ["4 + C · the place-vs-actual report and the tracking note", checkTeamSections],
    ["A · the integrity board's position cases", checkIntegrityBoard],
    ["5 · gate one on the day page and the admin pages", checkGateOne],
  ];
  const failures: string[] = [];
  for (const [name, check] of sections) {
    try {
      await check();
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  assert.deepEqual(failures, [], `Phoenix CRM visibility holes:\n${failures.join("\n")}`);
}
