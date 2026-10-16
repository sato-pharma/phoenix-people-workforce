import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import { canReadVisitReport, type PhoenixCrmViewer } from "../src/lib/phoenix-crm/server/access.ts";
import type { OrgSeat } from "../src/lib/phoenix-crm/scope.ts";
import { buildVisitReportValues, type VisitReportContext } from "../src/lib/phoenix-crm/server/visit-report-values.ts";
import { MISSED_VISIT_LOCATION_LABEL } from "../src/lib/phoenix-crm/visit-location-words.ts";
import {
  VISIT_REPORT_SHEET,
  buildVisitReportWorkbook,
  visitReportCellValue,
  visitReportWorkbookColumns,
} from "../src/lib/phoenix-crm/server/visit-report-workbook.ts";
import { computeVisitSequence, type SequenceInput } from "../src/lib/phoenix-crm/visit-report-compute.ts";
import { buildVisitReportDashboard, countVisitReportFilled } from "../src/lib/phoenix-crm/visit-report-dashboard.ts";
import {
  EMPTY_VISIT_REPORT_FILTER,
  NO_POSITION,
  describeVisitReportFilter,
  isVisitReportFilterEmpty,
  matchesVisitReportFilter,
  narrowVisitReportView,
  readVisitReportFilter,
  visitReportFilterOptions,
  visitReportFilterParams,
  type VisitReportFilter,
} from "../src/lib/phoenix-crm/visit-report-filters.ts";
import {
  VISIT_REPORT_CATEGORIES,
  VISIT_REPORT_FIELDS,
  VISIT_REPORT_LEAD_KEYS,
  VISIT_REPORT_SAVED_VIEWS_MAX,
  VISIT_REPORT_STARTER_SETS,
  VISIT_REPORT_VIEW_NAME_MAX,
  cleanVisitReportViewName,
  resolveVisitReportPeriod,
  resolveVisitReportSelection,
  visitReportField,
  visitReportFieldsFor,
  visitReportStarterFields,
  type VisitReportRow,
  type VisitReportView,
} from "../src/lib/phoenix-crm/visit-report-fields.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the Visit report generator (owner, 2026-10-15).
 *
 * ## What would be wrong without anybody noticing
 *
 *   - **A field above the viewer's sight reaching him.** The SFE Manager reads every field but the
 *     mock-location evidence. The selection is cleaned server-side and the evidence loader never queries a
 *     position case for him, so the field is ABSENT from his answer — pinned here at both ends.
 *   - **A workbook that holds more than was chosen.** It is read back out of the real `.xlsx` bytes: one
 *     tab, only the chosen headings, only the visits the filter returned.
 *   - **A blank read as a zero.** A field nobody filled is null, never 0, and the dashboard says "recorded
 *     on X of Y visits" rather than drawing a bar that reads as "nobody did".
 *   - **A save time read as a time at the door** (owner, 2026-10-02): the speed comes from the phone's own
 *     reading times only.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

function viewer(flags: Partial<PhoenixCrmViewer>): PhoenixCrmViewer {
  return { isSfeManager: false, isSuperAdmin: false, managerSeats: [], ...flags } as PhoenixCrmViewer;
}

// ── 1 · the catalogue ───────────────────────────────────────────────────────────────────────────

function checkCatalogue(): void {
  assert.equal(VISIT_REPORT_FIELDS.length, 115, "the owner's list is 115 fields");
  assert.equal(VISIT_REPORT_CATEGORIES.length, 10, "in ten categories");
  const keys = VISIT_REPORT_FIELDS.map((field) => field.key);
  assert.equal(new Set(keys).size, keys.length, "no field key is used twice");
  const categoryIds = new Set<string>(VISIT_REPORT_CATEGORIES.map((category) => category.id));
  for (const field of VISIT_REPORT_FIELDS) {
    assert.ok(categoryIds.has(field.category), `${field.key} sits in a known category`);
    assert.ok(field.label.trim().length > 0 && field.width > 0, `${field.key} has a label and a width`);
  }
  for (const category of VISIT_REPORT_CATEGORIES) {
    assert.ok(VISIT_REPORT_FIELDS.some((field) => field.category === category.id), `${category.id} is not an empty heading`);
  }

  // The module guard refuses these words in any string under src/lib/phoenix-crm — a customer is a customer.
  const banned = /\b(account|accounts|doctor|doctors)\b/i;
  const words = [
    ...VISIT_REPORT_FIELDS.flatMap((field) => [field.label, field.hint ?? ""]),
    ...VISIT_REPORT_CATEGORIES.flatMap((category) => [category.label, category.blurb]),
  ];
  for (const word of words) assert.ok(!banned.test(word), `"${word}" uses a word the module never prints`);

  assert.deepEqual(
    VISIT_REPORT_FIELDS.filter((field) => field.sight === "superAdmin").map((field) => field.key),
    ["mockDevice"],
    "the mock-location answer is the ONLY field above the SFE Manager's sight",
  );

  // The three that come from save times say so wherever they are shown.
  for (const key of ["visitNumberInDay", "gapMinutes", "speedKmh"]) {
    assert.ok((visitReportField(key)?.hint ?? "").length > 0, `${key} carries its reading note`);
  }
}

function checkSelection(): void {
  const asked = ["comment", "mockDevice", "visitDate", "no-such-field", "visitDate", 42];
  assert.deepEqual(
    resolveVisitReportSelection(asked, "sfe").map((field) => field.key),
    ["visitDate", "comment"],
    "the SFE Manager's selection drops the mock-location field, unknown keys and repeats, and keeps the catalogue's order",
  );
  assert.ok(
    resolveVisitReportSelection(asked, "superAdmin").some((field) => field.key === "mockDevice"),
    "the Super Admin keeps it",
  );
  assert.equal(visitReportFieldsFor("sfe").length, 114, "the SFE Manager is offered 114 of the 115");
  assert.equal(visitReportFieldsFor("superAdmin").length, 115, "the Super Admin all of them");
  assert.equal(visitReportFieldsFor("manager").length, 97, "a district manager is offered 97 of the 115");

  // The district manager's sight: no measurement behind a distance, no integrity case, no device
  // telemetry, no mock-location evidence (owner, 2026-10-02 "District Managers see the distance only";
  // the integrity board is the Super Admin's and the SFE Manager's).
  const beyondTheDistrictManager = [
    "clockOffsetMinutes", "visitAccuracy", "photoAccuracy", "placeAccuracy", "pointSource", "photoLat", "photoLon",
    "photoTakenAt", "fixAgeSeconds", "deviceInstall", "appRevision", "browser", "integrityDetectors",
    "integrityStrength", "caseSettled", "repMonthFlags", "speedKmh", "mockDevice",
  ];
  const offeredToManager = new Set(visitReportFieldsFor("manager").map((field) => field.key));
  for (const key of beyondTheDistrictManager) {
    assert.equal(offeredToManager.has(key), false, `${key} is never offered to a district manager`);
    assert.deepEqual(
      resolveVisitReportSelection([key], "manager"),
      [],
      `${key} chosen by a district manager is dropped before anything is read`,
    );
  }
  assert.equal(
    visitReportFieldsFor("manager").length + beyondTheDistrictManager.length,
    115,
    "the hidden list is exactly the difference — a field added without a sight is a manager's by default, so add it here when it is not",
  );
  for (const key of ["distanceFromPlace", "locationFlag", "visitLat", "visitLon", "placeLat", "placeLon"]) {
    assert.equal(offeredToManager.has(key), true, `${key} — the distance and where the place is — stays with the district manager`);
  }

  // Who opens it: the Super Admin and the SFE Manager, and a district manager or acting one on his own
  // seat — by the seat's tier, never by a role name.
  assert.equal(canReadVisitReport(viewer({ isSuperAdmin: true })), true);
  assert.equal(canReadVisitReport(viewer({ isSfeManager: true })), true);
  assert.equal(canReadVisitReport(viewer({ managerSeats: [{ tier: "DM" }] as never })), true, "a district manager");
  assert.equal(canReadVisitReport(viewer({ managerSeats: [{ tier: "ACTING_DM" }] as never })), true, "an acting district manager");
  assert.equal(canReadVisitReport(viewer({ managerSeats: [{ tier: "RM" }] as never })), false, "a regional manager is not admitted by this rung");
  assert.equal(canReadVisitReport(viewer({})), false, "nobody else opens it");
}

function checkPeriod(): void {
  const today = "2026-10-15";
  assert.deepEqual(resolveVisitReportPeriod({ cairoToday: today, from: "2026-10-01", kind: "rep", to: "2026-10-20" }), {
    days: 15,
    from: "2026-10-01",
    ok: true,
    to: today,
  }, "days after today are cut off, never an error");
  assert.equal(resolveVisitReportPeriod({ cairoToday: today, from: "2026-10-10", kind: "rep", to: "2026-10-01" }).ok, false, "from after to is refused");
  assert.equal(resolveVisitReportPeriod({ cairoToday: today, from: "2026-10-16", kind: "rep", to: "2026-10-20" }).ok, false, "a period wholly in the future is refused");
  assert.equal(resolveVisitReportPeriod({ cairoToday: today, from: "2026-07-14", kind: "rep", to: today }).ok, false, "a rep is capped at 92 days");
  assert.equal(resolveVisitReportPeriod({ cairoToday: today, from: "2026-07-16", kind: "rep", to: today }).ok, true, "92 days exactly is allowed for a rep");
  assert.equal(resolveVisitReportPeriod({ cairoToday: today, from: "2026-09-14", kind: "district", to: today }).ok, false, "a district is capped at 31 days");
  assert.equal(resolveVisitReportPeriod({ cairoToday: today, from: "2026-09-15", kind: "district", to: today }).ok, true, "31 days exactly is allowed for a district");
}

// ── 2 · the values and the sequence ─────────────────────────────────────────────────────────────

function context(overrides: Partial<VisitReportContext> = {}): VisitReportContext {
  return {
    activities: [],
    ask: null,
    behaviourFlags: null,
    customer: { name: "Pharmacy One", status: "active" },
    dayStartedAt: null,
    districtManagerHrId: null,
    doubles: [],
    editedAt: null,
    evidence: null,
    names: new Map(),
    onLeave: null,
    personHrId: null,
    readsLocationDetail: true,
    place: { label: "Pharmacy One, Faisal", status: "validated" },
    placeNotes: [],
    planItem: null,
    provenance: { fix_age_seconds: -5 },
    recommendations: [],
    region: null,
    regionalManagerHrId: null,
    review: null,
    seat: null,
    sequence: null,
    sharedPlace: null,
    unplanned: null,
    visit: {
      captured_at: "2026-10-06T07:30:00Z",
      distance_meters: 420,
      location_flag: "far",
      product_availability: { Ivyronc: "has", Lacto: "missing" },
      products: ["Ivyronc", "Lacto"],
      samples_given: { Ivyronc: 2, Lacto: 0 },
      visit_date: "2026-10-06",
    },
    ...overrides,
  };
}

function checkValues(): void {
  const values = buildVisitReportValues(context());
  assert.deepEqual(
    Object.keys(values).sort(),
    VISIT_REPORT_FIELDS.map((field) => field.key).sort(),
    "one visit produces a value (or an explicit null) for every catalogue key — no key is missing and none is extra",
  );
  assert.equal(values.dayOfWeek, "Tuesday");
  assert.equal(values.month, "October 2026");
  assert.equal(values.productsDetailed, "Ivyronc, Lacto");
  assert.equal(values.productsAvailable, "Ivyronc");
  assert.equal(values.productsMissing, "Lacto");
  assert.equal(values.samplesGiven, "Ivyronc × 2", "a sample count of zero is not a sample");
  assert.equal(values.locationFlag, "Far from the place");
  assert.equal(values.distanceFromPlace, 420);
  assert.equal(values.fixAgeSeconds, null, "a negative reading age is a clock running ahead, not a measurement");
  assert.equal(values.nextStep, null, "a field nobody filled is null — never an empty string and never zero");
  assert.equal(values.mockDevice, null, "no evidence read for this viewer means the field is null");
  assert.equal(values.speedKmh, null, "no sequence facts means no speed");
  assert.equal(values.plannedOrNot, "Planned");
  assert.equal(buildVisitReportValues(context({ visit: { ...context().visit, is_unplanned: true } })).plannedOrNot, "Unplanned");
  assert.equal(values.editedBySuperAdmin, "No");

  // 🔴 WHOSE VISIT (2026-10-16): a manager's own visit has no rep on it and sits on a rep's seat. It is the
  // manager's, named by the loader — never the seat's occupant, which printed 13 of them under a rep's name.
  const seat = { areaName: "Faisal", lineName: "Pedia", occupantHrId: "B-1", regionName: null, seatId: "SEAT-1", seatLabel: null } as unknown as OrgSeat;
  const names = new Map([["B-1", "Mahmoud Adel"], ["B-50", "Hany Saad"]]);
  const managersOwn = buildVisitReportValues(
    context({ names, personHrId: "B-50", seat, visit: { ...context().visit, manager_hr_id: "B-50", rep_hr_id: null } }),
  );
  assert.equal(managersOwn.repName, "Hany Saad", "a manager's own visit names the manager");
  const nobody = buildVisitReportValues(context({ names, personHrId: null, seat, visit: { ...context().visit, rep_hr_id: null } }));
  assert.notEqual(nobody.repName, "Mahmoud Adel", "and never falls back to whoever holds the seat");

  // 🔴 A visit the Super Admin entered later for a rep carries no reading — it says so, never "No validated place".
  const enteredLater = buildVisitReportValues(
    context({ visit: { ...context().visit, entered_by_hr_id: "B-10", location_flag: "no_place", rep_hr_id: "B-1" } }),
  );
  assert.equal(enteredLater.locationFlag, MISSED_VISIT_LOCATION_LABEL);
  const ownSave = buildVisitReportValues(
    context({ visit: { ...context().visit, entered_by_hr_id: "B-1", location_flag: "no_place", rep_hr_id: "B-1" } }),
  );
  assert.equal(ownSave.locationFlag, "No validated place", "a rep's own save keeps its real wording");

  // 🔴 A DISTRICT MANAGER READS THE DISTANCE ONLY (owner, 2026-10-02): a weak reading reads to him as at the
  // place, as on every other screen. The Super Admin and the SFE Manager still read the verdict.
  const weak = { ...context().visit, distance_meters: 40, location_flag: "weak_gps" };
  assert.equal(
    buildVisitReportValues(context({ readsLocationDetail: false, visit: weak })).locationFlag,
    "At the place",
    "a district manager never reads a weak-signal verdict",
  );
  assert.equal(buildVisitReportValues(context({ readsLocationDetail: true, visit: weak })).locationFlag, "Weak signal", "the SFE Manager and the Super Admin still do");
  assert.equal(buildVisitReportValues(context({ readsLocationDetail: false })).locationFlag, "Far from the place", "far stays far for everybody");
}

function checkSequence(): void {
  const base: Omit<SequenceInput, "visitId" | "savedAtMs" | "fixAtMs" | "lat" | "visitDate" | "customerId"> = { lon: 31.2, person: "B-1" };
  const first: SequenceInput = { ...base, customerId: "C1", fixAtMs: Date.parse("2026-10-06T06:00:00Z"), lat: 30, savedAtMs: Date.parse("2026-10-06T07:00:00Z"), visitDate: "2026-10-06", visitId: "V1" };
  const second: SequenceInput = { ...base, customerId: "C2", fixAtMs: Date.parse("2026-10-06T06:30:00Z"), lat: 30.09, savedAtMs: Date.parse("2026-10-06T07:30:00Z"), visitDate: "2026-10-06", visitId: "V2" };
  const earlier: SequenceInput = { ...base, customerId: "C1", fixAtMs: null, lat: 30, savedAtMs: Date.parse("2026-10-02T07:00:00Z"), visitDate: "2026-10-02", visitId: "V0" };
  const facts = computeVisitSequence([second, first, earlier]);

  const one = facts.get("V1");
  const two = facts.get("V2");
  assert.equal(one?.numberInDay, 1, "the day's order is the order the visits were saved");
  assert.equal(two?.numberInDay, 2);
  assert.equal(two?.visitsThatDay, 2);
  assert.equal(two?.gapMinutes, 30);
  assert.ok(Math.abs((two?.distanceFromPreviousKm ?? 0) - 10) < 0.2, "0.09 degrees of latitude is about ten kilometres");
  assert.ok(Math.abs((two?.speedKmh ?? 0) - 20) < 0.5, "ten kilometres between phone readings half an hour apart is twenty an hour");
  assert.equal(one?.gapMinutes, null);
  assert.equal(one?.daysSinceCustomerVisit, 4, "the customer was last seen four days before");
  assert.equal(one?.customerVisitsThisMonth, 2);

  // 🔴 A SAVE TIME IS NEVER A POSITION IN TIME: without the phone's own reading times there is no speed,
  // however well the saves are spaced.
  const noFix = computeVisitSequence([{ ...first, fixAtMs: null }, { ...second, fixAtMs: null }]);
  assert.equal(noFix.get("V2")?.speedKmh, null, "no reading time, no speed");
  assert.ok(noFix.get("V2")?.distanceFromPreviousKm !== null, "the distance is still a straight line between the two positions");
  const backwards = computeVisitSequence([first, { ...second, fixAtMs: Date.parse("2026-10-06T05:00:00Z") }]);
  assert.equal(backwards.get("V2")?.speedKmh, null, "two phone clocks that disagree about the order measure nothing");

  // 🔴 A DAY IS ONE PERSON'S (2026-10-16): his manager's own call on the same seat, saved between his two,
  // takes no place in his order, his count or his gaps.
  const managers: SequenceInput = { ...second, customerId: "C9", person: "B-50", savedAtMs: Date.parse("2026-10-06T07:15:00Z"), visitId: "VM" };
  const shared = computeVisitSequence([first, managers, second]);
  assert.equal(shared.get("V2")?.numberInDay, 2, "the rep's second visit is still his second");
  assert.equal(shared.get("V2")?.visitsThatDay, 2, "and his day still holds two");
  assert.equal(shared.get("V2")?.gapMinutes, 30, "measured from his own first visit, not from the manager's");
  assert.equal(shared.get("VM")?.numberInDay, 1, "the manager's call is the first of his own day");
}

// ── 3 · the dashboard ───────────────────────────────────────────────────────────────────────────

function row(index: number, over: Partial<VisitReportRow> = {}): VisitReportRow {
  return {
    customerName: `Customer ${index}`,
    distanceMeters: 50,
    listType: "AM",
    locationFlag: "At the place",
    placeLabel: null,
    placeLat: null,
    placeLon: null,
    planned: true,
    repName: "Mahmoud Adel",
    savedAtIso: `2026-10-0${index}T07:00:00Z`,
    values: {},
    visitDate: `2026-10-0${index}`,
    visitId: `V${index}`,
    visitLat: null,
    visitLon: null,
    visitType: "Single visit",
    ...over,
  };
}

function checkDashboard(): void {
  const rows = [
    row(1, { values: { nextStep: "Visit again", productsMissing: "Lacto" } }),
    row(2, { locationFlag: "Far from the place", planned: false, values: { nextStep: null, productsMissing: null } }),
    row(3, { values: { nextStep: null, productsMissing: null } }),
  ];
  const fields = ["nextStep", "productsMissing"].map((key) => visitReportField(key)!);
  const dashboard = buildVisitReportDashboard({
    days: ["2026-10-01", "2026-10-02", "2026-10-03"],
    fields,
    filled: { nextStep: 1, productsMissing: 1 },
    rows,
  });

  assert.equal(dashboard.tiles.find((tile) => tile.label === "Visits")?.value, "3");
  assert.equal(dashboard.tiles.find((tile) => tile.label === "On the plan")?.value, "67%");
  assert.equal(dashboard.tiles.find((tile) => tile.label === "Far from the place")?.value, "33%");

  const next = dashboard.panels.find((panel) => panel.id === "next-steps");
  assert.ok(next, "a chosen field draws its panel");
  assert.match(next.note ?? "", /Recorded on 1 of 3 visits/, "a sparse field says how many visits carry it, never a bare zero");
  assert.ok(dashboard.panels.some((panel) => panel.id === "products-missing"));
  assert.ok(!dashboard.panels.some((panel) => panel.id === "grade" || panel.id === "bricks"), "a field that was not chosen draws nothing");
  assert.ok(dashboard.panels.some((panel) => panel.id === "visits-per-day"), "the visits per day are always drawn");

  const empty = buildVisitReportDashboard({ days: [], fields, filled: {}, rows: [] });
  assert.equal(empty.tiles.find((tile) => tile.label === "On the plan")?.value, "—", "no visits is a dash, never 0%");
}

// ── 4 · the workbook, read back out of the emitted bytes ───────────────────────────────────────

async function checkWorkbook(): Promise<void> {
  const fields = ["visitDate", "customerName", "savedAt", "distanceFromPlace", "nextStep"].map((key) => visitReportField(key)!);
  const rows: VisitReportRow[] = [
    row(1, {
      values: {
        comment: "SECRET-COMMENT-NOT-CHOSEN",
        customerName: "Pharmacy One",
        distanceFromPlace: 250,
        nextStep: "Visit again",
        savedAt: "2026-01-15T07:30:00Z",
        visitDate: "2026-10-06",
      },
    }),
    row(2, { values: { customerName: "Pharmacy Two", distanceFromPlace: null, nextStep: null, savedAt: null, visitDate: "2026-10-07" } }),
  ];
  const view: VisitReportView = {
    dashboard: { panels: [], tiles: [] },
    days: ["2026-10-06", "2026-10-07"],
    filled: { nextStep: 1 },
    generatedAtIso: "2026-10-15T09:00:00Z",
    period: { days: 15, from: "2026-10-01", to: "2026-10-15" },
    rows,
    selected: fields.map((field) => field.key),
    target: { id: "SEAT-1", kind: "rep", name: "Mahmoud Adel", reps: ["Mahmoud Adel"] },
    total: rows.length,
  };

  const bytes = await buildVisitReportWorkbook({ fields, view, viewerName: "Omar Gawish" });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);

  assert.equal(workbook.worksheets.length, 1, "ONE tab, never a master sheet and a second one");
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.name, VISIT_REPORT_SHEET);

  const text = (row: number, column: number): string => String(sheet.getCell(row, column).text ?? "");
  // The date, who visited and the customer lead (owner, 2026-10-16) — "Who visited" was not ticked and is
  // there anyway; the two that were ticked are not printed twice. Then the chosen rest, in catalogue order.
  const columns = ["Visit date", "Who visited", "Customer name", "Saved at (Cairo time)", "Distance from the place (m)", "Next step"];
  const heading = columns.map((_, index) => text(5, index + 1));
  assert.deepEqual(heading, columns, "the lead three, then exactly the chosen fields, in the catalogue's order");
  assert.equal(text(5, columns.length + 1), "", "and nothing sits beside them");

  const mastheadText = [1, 2, 3].flatMap((rowNumber) => columns.map((_, index) => text(rowNumber, index + 1))).join(" | ");
  assert.match(mastheadText, /Visit report/, "the house masthead carries the title");
  assert.match(mastheadText, /Mahmoud Adel/, "and the rep's name, never a code");
  assert.match(mastheadText, /Prepared for Omar Gawish/, "and who prepared it");

  const dataRows = [6, 7].map((rowNumber) => columns.map((_, index) => sheet.getCell(rowNumber, index + 1).value));
  const dateCell = dataRows[0][0];
  assert.ok(dateCell instanceof Date && dateCell.toISOString().startsWith("2026-10-06"), "a date is a real date");
  assert.equal(dataRows[0][1], "Mahmoud Adel", "who visited comes from the row itself when it was not ticked");
  assert.equal(dataRows[0][2], "Pharmacy One", "a ticked lead field keeps its own value");
  const savedCell = dataRows[0][3];
  assert.ok(savedCell instanceof Date, "an instant is a real date-time");
  assert.equal((savedCell as Date).getUTCHours(), 9, "written as the Cairo wall clock: 07:30 UTC in January is 09:30 in Cairo");
  assert.equal((savedCell as Date).getUTCMinutes(), 30);
  assert.equal(dataRows[0][4], 250, "a distance is a number that sorts");
  assert.ok(dataRows[1][4] === null || dataRows[1][4] === "", "a blank is an empty cell, never a zero");
  assert.ok(dataRows[1][5] === null || dataRows[1][5] === "");
  assert.equal(String(sheet.getCell(8, 1).value ?? ""), "", "only the visits the filter returned, one row each");

  let everyCell = "";
  sheet.eachRow((excelRow) => excelRow.eachCell((cell) => {
    everyCell += `${cell.text}\n`;
  }));
  assert.ok(!everyCell.includes("SECRET-COMMENT-NOT-CHOSEN"), "a field that was not chosen is nowhere in the file");

  assert.equal(sheet.views[0]?.state, "frozen");
  assert.equal(sheet.views[0]?.ySplit, 5, "the headings stay put while the visits scroll");
  assert.ok(sheet.autoFilter, "every heading filters");
  assert.equal(sheet.pageSetup.orientation, "landscape", "it prints landscape");
  assert.equal(sheet.pageSetup.printTitlesRow, "4:5", "with the category band and headings repeated on every page");
  assert.match(String(sheet.headerFooter.oddFooter ?? ""), /SATO-DIS-2026-01/, "and the document id in the footer");

  assert.equal(visitReportCellValue("integer", null), null);
  assert.equal(visitReportCellValue("yesno", true), "Yes");
}

// ── 1 · the ready-made sets ─────────────────────────────────────────────────────────────────────

function checkStarterSets(): void {
  assert.deepEqual(
    VISIT_REPORT_STARTER_SETS.map((set) => set.label),
    ["Daily activity", "Location", "Off-plan approvals"],
    "the three sets the owner was offered",
  );
  for (const set of VISIT_REPORT_STARTER_SETS) {
    for (const key of set.keys) assert.ok(visitReportField(key), `${set.label} names ${key}, which is in the catalogue`);
    assert.equal(new Set(set.keys).size, set.keys.length, `${set.label} names no field twice`);
    for (const key of VISIT_REPORT_LEAD_KEYS) assert.ok(set.keys.includes(key), `${set.label} starts from the date, who visited and the customer`);
  }

  // Each set is cut to the reader's sight: a district manager's Location set holds the distance and the
  // places, never the accuracy, the cases or the device; the SFE Manager's never the mock-location field.
  const location = VISIT_REPORT_STARTER_SETS.find((set) => set.id === "location")!;
  const forManager = visitReportStarterFields(location, "manager").map((field) => field.key);
  const managerSight = new Set(visitReportFieldsFor("manager").map((field) => field.key));
  for (const key of forManager) assert.ok(managerSight.has(key), `${key} is within the district manager's sight`);
  for (const key of ["visitAccuracy", "photoAccuracy", "placeAccuracy", "pointSource", "integrityDetectors", "integrityStrength", "mockDevice"]) {
    assert.ok(!forManager.includes(key), `the district manager's Location set leaves out ${key}`);
  }
  assert.ok(forManager.includes("distanceFromPlace") && forManager.includes("locationFlag"), "and keeps the distance and the far / at-the-place wording");
  const forSfe = visitReportStarterFields(location, "sfe").map((field) => field.key);
  assert.ok(!forSfe.includes("mockDevice") && forSfe.includes("integrityDetectors"), "the SFE Manager gets the cases, never the mock-location field");
  assert.ok(visitReportStarterFields(location, "superAdmin").some((field) => field.key === "mockDevice"), "the Super Admin gets all of it");
}

// ── 3 · the result filters ──────────────────────────────────────────────────────────────────────

function checkFilters(): void {
  const rows = [
    row(1, { repName: "Aya Ibrahim" }),
    row(2, { locationFlag: "Far from the place", planned: false, repName: "Aya Ibrahim" }),
    row(3, { locationFlag: null, repName: "Hany Saad" }),
    row(4, { locationFlag: "Far from the place", repName: "Hany Saad", values: { nextStep: "Visit again" } }),
  ];
  const only = (filter: Partial<VisitReportFilter>) =>
    rows.filter((entry) => matchesVisitReportFilter(entry, { ...EMPTY_VISIT_REPORT_FILTER, ...filter })).map((entry) => entry.visitId);

  assert.deepEqual(only({}), ["V1", "V2", "V3", "V4"], "no filter keeps every visit");
  assert.deepEqual(only({ who: "Hany Saad" }), ["V3", "V4"], "who visited");
  assert.deepEqual(only({ day: "2026-10-02" }), ["V2"], "one day");
  assert.deepEqual(only({ planned: "unplanned" }), ["V2"], "unplanned only");
  assert.deepEqual(only({ planned: "planned" }), ["V1", "V3", "V4"], "planned only");
  assert.deepEqual(only({ position: "Far from the place" }), ["V2", "V4"], "far from the place");
  assert.deepEqual(only({ position: NO_POSITION }), ["V3"], "a visit with no position has a choice of its own");
  assert.deepEqual(only({ position: "Far from the place", who: "Aya Ibrahim" }), ["V2"], "the filters combine");

  const options = visitReportFilterOptions(rows);
  assert.deepEqual(options.who, ["Aya Ibrahim", "Hany Saad"], "only the people the answer holds");
  assert.deepEqual(options.days, ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
  assert.deepEqual(options.positions, ["Far from the place", "At the place", NO_POSITION], "far first, a blank position last");

  // The same four filters travel to the workbook route as parameters and come back unchanged.
  const chosen: VisitReportFilter = { day: "2026-10-04", planned: "planned", position: "Far from the place", who: "Hany Saad" };
  const params = new URLSearchParams(visitReportFilterParams(chosen));
  assert.deepEqual(readVisitReportFilter((key) => params.get(key)), chosen, "a filter survives the trip to the file");
  assert.deepEqual(visitReportFilterParams(EMPTY_VISIT_REPORT_FILTER), {}, "an unfiltered link carries no filter at all");
  const junk = new URLSearchParams({ day: "yesterday", planned: "maybe", position: "   ", who: "x".repeat(500) });
  assert.ok(isVisitReportFilterEmpty(readVisitReportFilter((key) => junk.get(key))), "a malformed filter narrows nothing");
  assert.equal(describeVisitReportFilter(chosen), "Hany Saad · 4 Oct 2026 · planned visits · Far from the place");

  // Narrowing works the figures out again from what is left — the count, the days, the "recorded on" counts
  // and the dashboard — and an empty filter hands back the server's own answer untouched.
  const fields = ["nextStep"].map((key) => visitReportField(key)!);
  const view: VisitReportView = {
    dashboard: buildVisitReportDashboard({ days: ["x"], fields, filled: countVisitReportFilled(rows, fields), rows }),
    days: ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"],
    filled: countVisitReportFilled(rows, fields),
    generatedAtIso: "2026-10-16T09:00:00Z",
    period: { days: 4, from: "2026-10-01", to: "2026-10-04" },
    rows,
    selected: ["nextStep"],
    target: { id: "SEAT-D", kind: "district", name: "Delta (1)", reps: ["Aya Ibrahim"] },
    total: rows.length,
  };
  assert.equal(narrowVisitReportView(view, EMPTY_VISIT_REPORT_FILTER, fields), view, "no filter: the server's figures stand");
  const narrowedView = narrowVisitReportView(view, { ...EMPTY_VISIT_REPORT_FILTER, who: "Hany Saad" }, fields);
  assert.equal(narrowedView.total, 2);
  assert.deepEqual(narrowedView.rows.map((entry) => entry.visitId), ["V3", "V4"]);
  assert.deepEqual(narrowedView.days, ["2026-10-03", "2026-10-04"]);
  assert.deepEqual(narrowedView.filled, { nextStep: 1 }, "recorded on 1 of the 2 visits that are left");
  assert.equal(narrowedView.dashboard.tiles.find((tile) => tile.label === "Visits")?.value, "2", "the dashboard counts what is shown");
  assert.equal(narrowedView.dashboard.tiles.find((tile) => tile.label === "Far from the place")?.value, "100%", "1 of the 1 measured");
  assert.match(narrowedView.dashboard.panels.find((panel) => panel.id === "next-steps")?.note ?? "", /Recorded on 1 of 2 visits/);
}

// ── 4 · the workbook's lead columns ─────────────────────────────────────────────────────────────

async function checkWorkbookLead(): Promise<void> {
  assert.deepEqual(VISIT_REPORT_LEAD_KEYS, ["visitDate", "repName", "customerName"]);
  const onlyDistance = ["distanceFromPlace"].map((key) => visitReportField(key)!);
  assert.deepEqual(
    visitReportWorkbookColumns(onlyDistance).map((field) => field.key),
    ["visitDate", "repName", "customerName", "distanceFromPlace"],
    "the lead three come first even when none of them was ticked",
  );
  const tickedLead = ["customerName", "comment", "repName", "visitDate"].map((key) => visitReportField(key)!);
  assert.deepEqual(
    visitReportWorkbookColumns(tickedLead).map((field) => field.key),
    ["visitDate", "repName", "customerName", "comment"],
    "a ticked lead field is moved to the front, never printed twice",
  );

  // A file of distances alone still says on every line whose visit it was, from the row's own head.
  const rows: VisitReportRow[] = [row(5, { customerName: "Customer Five", repName: "Hany Saad", values: { distanceFromPlace: 40 } })];
  const view: VisitReportView = {
    dashboard: { panels: [], tiles: [] },
    days: ["2026-10-05"],
    filled: {},
    generatedAtIso: "2026-10-16T09:00:00Z",
    period: { days: 5, from: "2026-10-01", to: "2026-10-05" },
    rows,
    selected: ["distanceFromPlace"],
    target: { id: "SEAT-1", kind: "rep", name: "Hany Saad", reps: [] },
    total: 1,
  };
  const bytes = await buildVisitReportWorkbook({ fields: onlyDistance, narrowedTo: "Far from the place", view, viewerName: "Omar Gawish" });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  const text = (rowNumber: number, column: number): string => String(sheet.getCell(rowNumber, column).text ?? "");
  assert.deepEqual([1, 2, 3, 4].map((column) => text(5, column)), ["Visit date", "Who visited", "Customer name", "Distance from the place (m)"]);
  const date = sheet.getCell(6, 1).value;
  assert.ok(date instanceof Date && date.toISOString().startsWith("2026-10-05"), "the date is the visit's own, as a real date");
  assert.equal(sheet.getCell(6, 2).value, "Hany Saad");
  assert.equal(sheet.getCell(6, 3).value, "Customer Five");
  assert.equal(sheet.getCell(6, 4).value, 40);
  assert.equal(text(4, 1), "The visit", "the lead three sit under one band of their own");
  const masthead = [1, 2, 3].flatMap((rowNumber) => [1, 2, 3, 4].map((column) => text(rowNumber, column))).join(" | ");
  assert.match(masthead, /Only Far from the place/, "a narrowed file says what it was narrowed to");
}

// ── 6 · saved views ─────────────────────────────────────────────────────────────────────────────

function checkSavedViews(): void {
  assert.equal(cleanVisitReportViewName("  Monday   review "), "Monday review", "spaces are collapsed");
  assert.equal(cleanVisitReportViewName("   "), null, "a blank name is refused");
  assert.equal(cleanVisitReportViewName(42), null);
  assert.equal(cleanVisitReportViewName("x".repeat(VISIT_REPORT_VIEW_NAME_MAX + 1)), null, "a name over the limit is refused, never cut");
  assert.equal(VISIT_REPORT_SAVED_VIEWS_MAX, 20);

  // 🔴 ONLY ITS OWNER (owner, 2026-10-16). Every read, save and delete is keyed on the viewer's own HR id
  // AND the test world, and no function takes an owner from its caller.
  const service = source("src/lib/phoenix-crm/server/visit-report-views.ts");
  assert.equal((service.match(/.eq("owner_hr_id", ownerHrId)/g) ?? []).length, 3, "list, the cap's count and delete are each keyed on the owner");
  assert.equal((service.match(/.eq("is_test", isTest)/g) ?? []).length, 3, "and on the test world — a persona carries the real person's HR id");
  assert.match(service, /owner_hr_id: ownerHrId/, "a save writes the viewer as the owner");
  assert.match(service, /onConflict: "owner_hr_id,is_test,name"/, "the same name again replaces that view");
  assert.match(service, /ownerHrId: viewer.hrId/, "the owner is the viewer, never an argument");
  for (const fn of ["listVisitReportViews", "saveVisitReportView", "deleteVisitReportView"]) {
    assert.match(service, new RegExp(`export async function ${fn}\\(viewer: PhoenixCrmViewer(?:, (?:input|id): [^)]*)?\\)`), `${fn} takes the viewer and nothing naming an owner`);
  }
  assert.match(service, /if \(!canReadVisitReport\(viewer\)\) throw notFoundError/, "gated as the report is, with the same 404");
  assert.equal(
    (service.match(/resolveVisitReportSelection\(/g) ?? []).length,
    2,
    "fields are cleaned to the reader's sight on the way in and on the way out",
  );
  assert.match(service, /VISIT_REPORT_SAVED_VIEWS_MAX/, "the cap is held by the service");

  const route = source("app/api/phoenix-crm/visit-report/views/route.ts");
  for (const method of ["GET", "POST", "DELETE"]) {
    const body = route.slice(route.indexOf(`export async function ${method}(`));
    assert.ok(body.indexOf('assertPermission(access, "phoenix_crm", "read")') !== -1, `${method} asks the permission gate`);
  }
  for (const method of ["POST", "DELETE"]) {
    const body = route.slice(route.indexOf(`export async function ${method}(`));
    assert.ok(body.indexOf("assertSameOriginMutation(") < body.indexOf("resolveAccessContext("), `${method} refuses a cross-site write first`);
  }

  const registry = readFileSync(new URL("src/lib/security/access-registry.ts", ROOT), "utf8");
  // One entry per method (the module's boundary test decides each gate): the list is a plain read, a save
  // and a delete are audited mutations that check the origin.
  assert.match(registry, /sessionApi\(\{ methods: \["GET"\], pattern: "\/api\/phoenix-crm\/visit-report\/views", permission: \{ resource: "phoenix_crm", action: "read" \}, guard: "assert-permission", csrfRequired: false \}\)/);
  for (const method of ["POST", "DELETE"]) {
    assert.ok(
      registry.includes(`sessionApi({ audit: { classification: "mutation", required: true }, methods: ["${method}"], pattern: "/api/phoenix-crm/visit-report/views", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: true })`),
      `the registry records ${method} as an audited write that checks the origin`,
    );
  }

  const migration = readFileSync(new URL("supabase/migrations/20261017001000_phoenix_crm_visit_report_views.sql", ROOT), "utf8").replace(/--.*$/gm, "");
  assert.match(migration, /create unique index if not exists phoenix_crm_visit_report_views_owner_name_uidx\s+on public\.phoenix_crm_visit_report_views \(owner_hr_id, is_test, name\);/, "the upsert's key, and a plain index PostgREST can infer");
  assert.match(migration, /alter table public\.phoenix_crm_visit_report_views enable row level security;/);
  assert.match(migration, /revoke all on table public\.phoenix_crm_visit_report_views from public, anon, authenticated;/, "no browser key reads anybody's views");
}

// ── 5 · where the line is held in the source ────────────────────────────────────────────────────

function checkSource(): void {
  const loader = source("src/lib/phoenix-crm/server/visit-report.ts");
  assert.match(loader, /if \(!canReadVisitReport\(viewer\)\) throw notFoundError\(/, "the loader refuses anybody else with a 404");
  assert.match(loader, /resolveVisitReportSelection\(.*visitReportTierOf\(viewer\)\)/, "the selection is cleaned against the viewer's sight before anything is read");
  assert.match(loader, /&& !isLocationBlind\(viewer, seat\)/, "an acting district manager's own rep seat is never one he reports on");
  assert.ok(
    loader.includes('has("fixAgeSeconds", "deviceInstall", "appRevision", "browser") || has("speedKmh")') &&
      loader.includes('has("integrityDetectors", "integrityStrength", "mockDevice", "caseSettled")') &&
      loader.includes('has("repMonthFlags")'),
    "the fields that read a silent table are still exactly the ones the district manager's sight hides — change both together",
  );
  assert.match(loader, /const needsReview = categories\.has\("validation"\);/, "the validation table is read only when its category was chosen");
  assert.match(loader, /const needsUnplanned = categories\.has\("approval"\);/, "and so is the approval table");
  assert.match(loader, /const needsDay = categories\.has\("day"\);/, "and the day's tables");
  assert.match(loader, /if \(needsEvidence \|\| needsBehaviour\) \{/, "the integrity cases are asked for only when an evidence field was chosen");
  assert.match(loader, /VISIT_REPORT_MAX_ROWS/, "a choice that would read an unbounded number of visits is refused");

  const evidence = source("src/lib/phoenix-crm/server/integrity-board.ts");
  const body = evidence.slice(evidence.indexOf("export async function loadVisitReportEvidence("));
  assert.match(body, /if \(!canReadIntegrityBoard\(viewer\)\) throw notFoundError\(/, "the evidence is behind the board's own audience");
  assert.match(body, /\$\{positions \? ", device_mocked" : ""\}/, "device_mocked is not even in the SFE Manager's select");
  assert.match(body, /if \(!positions\) tuned = tuned\.in\("source", SFE_SOURCES\);/, "a position case is never queried for the SFE Manager");

  // Whose visit: the integrity board's own rule, never the seat's occupant.
  assert.match(loader, /personOnTheVisit\(\{/, "the loader names a visit's person with the integrity board's rule");
  assert.ok(!loader.includes("seat?.occupantHrId"), "and never falls back to whoever holds the seat");
  assert.match(loader, /person: whoseVisit\(visit\)/, "a day's order is per person, not per seat");
  assert.match(loader, /locationFlag: visitLocationFlagLabel\(visit, detail\)/, "the row head says when the Super Admin entered a visit later, in the reader's own sight");
  assert.match(loader, /const detail = readsLocationDetail\(viewer\);/, "and that sight is the one every other screen asks");
  assert.match(loader, /readsLocationDetail: detail,/, "the values get the same sight as the row head");

  const route = source("app/api/phoenix-crm/visit-report/route.ts");
  assert.ok(route.indexOf("assertSameOriginMutation(request)") < route.indexOf("resolveAccessContext(request)"), "the POST checks the origin before anything else");
  assert.match(route, /assertPermission\(access, "phoenix_crm", "read"\)/);
  // 🔴 Opening the report on screen discloses where named people's phones were, so it is rate limited and audited.
  const limit = route.indexOf("assertApiRateLimit(");
  assert.ok(limit !== -1 && limit < route.indexOf("loadVisitReport("), "the screen's read is rate limited BEFORE the heavy read");
  assert.match(route, /writeAuditLog\(/, "every report built on screen is audited");
  assert.match(route, /entityType: "phoenix_crm_visit_report_view"/, "under its own entity type");

  // The map is built once and redrawn — a pin click or a day change never builds a new one.
  const map = source("src/components/phoenix-crm/visit-report/visit-report-map.tsx");
  assert.match(map, /if \(existing && existing\.element === element\) \{\s*map = existing\.map;\s*\} else \{\s*map = new MapCtor\(/, "a new map only when there is none for this element");
  assert.equal((map.match(/new MapCtor\(/g) ?? []).length, 1);
  assert.match(map, /if \(fittedKeyRef\.current !== fitKey\)/, "the view is refitted only when what is shown changes");

  // The headings count the fields the viewer is actually offered.
  for (const path of ["app/(admin)/admin/phoenix-crm/visit-report/page.tsx", "app/employee-portals/visit-report/page.tsx"]) {
    const text = source(path);
    assert.ok(!/from the \d+/.test(text), `${path} never hard-codes how many fields there are`);
    assert.match(text, /visitReportFieldsFor\(scope\.sight\)\.length/, `${path} counts the viewer's own fields`);
  }

  const exportRoute = source("app/api/phoenix-crm/visit-report/export/route.ts");
  assert.ok(exportRoute.indexOf("assertExportRateLimit(") < exportRoute.indexOf("loadVisitReport("), "the rate limit runs BEFORE the heavy read");
  assert.match(exportRoute, /writeAuditLog\(/, "a file naming people and where their phones were is audited");

  const page = source("app/(admin)/admin/phoenix-crm/visit-report/page.tsx");
  const gate = page.indexOf('canAccess(access, "phoenix_crm", "read")');
  assert.ok(gate !== -1 && gate < page.indexOf("resolvePhoenixCrmViewer("), "the page asks gate one before the organogram");
  assert.match(page, /!canReadVisitReport\(viewer\)\) redirect\("\/admin"\)/, "anybody else is redirected, never told the page exists");

  // The district manager's own copy: a portal page, gated the same way, drawn from the same loader.
  const teamPage = source("app/employee-portals/visit-report/page.tsx");
  const teamGate = teamPage.indexOf('canAccess(access, "phoenix_crm", "read")');
  assert.ok(teamGate !== -1 && teamGate < teamPage.indexOf("resolvePhoenixCrmViewer("), "the team page asks gate one before the organogram");
  assert.match(teamPage, /!canReadVisitReport\(viewer\)\) redirect\("\/employee-portals"\)/, "anybody else is sent back, never told the page exists");
  assert.ok(teamPage.includes("loadVisitReportScope(viewer)"), "the picker is the viewer's own scope");
  assert.ok(!teamPage.includes("phoenix-crm-app"), "the report is never a tab of the app a rep runs");

  const layout = source("src/components/employee-portal/employee-portal-layout.tsx");
  assert.match(layout, /showTeamPlaceChecksTab \? \[\{ href: "\/employee-portals\/visit-report", label: "Visit report"/, "the sidebar row rides the district manager flag");

  const workbook = source("src/lib/phoenix-crm/server/visit-report-workbook.ts");
  assert.equal((workbook.match(/addWorksheet\(/g) ?? []).length, 1, "the workbook adds exactly one worksheet");

  // What is on screen is what is in the file, after narrowing too: the route narrows the loaded answer
  // through the screen's own matcher before the workbook is built from it.
  const narrowAt = exportRoute.indexOf("narrowVisitReportView(");
  assert.ok(narrowAt > exportRoute.indexOf("loadVisitReport(") && narrowAt < exportRoute.indexOf("buildVisitReportWorkbook("), "the file is narrowed exactly as the screen is");
  assert.match(exportRoute, /readVisitReportFilter\(/);

  const generator = source("src/components/phoenix-crm/visit-report/visit-report-generator.tsx");
  assert.match(generator, /\.\.\.visitReportFilterParams\(filter\)/, "the download link carries the filters on screen");
  assert.match(generator, /narrowVisitReportView\(view, filter, appliedFields\)/, "the screen narrows through the same function");
  for (const piece of ["<VisitReportDashboardView dashboard={shown.dashboard} />", "rows={shown.rows} />"]) {
    assert.ok(generator.includes(piece), `the dashboard, the map and the table all read the narrowed answer: ${piece}`);
  }
  assert.equal((generator.match(/rows=\{shown\.rows\}/g) ?? []).length, 2, "the map and the table both");
  // The remembered choice is a per-browser convenience: every storage call is inside a try.
  const storage = generator.slice(generator.indexOf("function readLastFields"), generator.indexOf("function splitTarget"));
  assert.equal((storage.match(/try \{/g) ?? []).length, 2, "reading and writing the last choice can never break the page");
  assert.ok(!/localStorage/.test(generator.replace(storage, "")), "nothing else touches browser storage");
}

export async function runPhoenixCrmVisitReportTests(): Promise<void> {
  const sections: Array<[string, () => void | Promise<void>]> = [
    ["1 · the catalogue", checkCatalogue],
    ["1 · the selection and who reads it", checkSelection],
    ["1 · the period", checkPeriod],
    ["1 · the ready-made sets", checkStarterSets],
    ["2 · one visit's values", checkValues],
    ["2 · the sequence facts", checkSequence],
    ["3 · the dashboard", checkDashboard],
    ["3 · the result filters", checkFilters],
    ["4 · the workbook read back", checkWorkbook],
    ["4 · the workbook's lead columns", checkWorkbookLead],
    ["5 · the source pins", checkSource],
    ["6 · saved views", checkSavedViews],
  ];
  const failures: string[] = [];
  for (const [name, check] of sections) {
    try {
      await check();
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  assert.deepEqual(failures, [], `Visit report failures:\n${failures.join("\n")}`);
}
