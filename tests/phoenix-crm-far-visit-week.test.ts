import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import type { PhoenixCrmViewer } from "../src/lib/phoenix-crm/server/access.ts";
import type { OrgSeat } from "../src/lib/phoenix-crm/scope.ts";
import {
  FAR_VISIT_WEEK_KIND_LABELS,
  FAR_VISIT_WEEK_PATHS,
  farVisitWeek,
  FAR_VISIT_WEEK_MAX,
  farVisitWeekCellText,
  farVisitWeekChoices,
  farVisitWeeks,
  farVisitWeekDayLabel,
  farVisitWeekFilterNarrows,
  farVisitWeekQuery,
  farVisitWeekStanding,
  parseFarVisitWeekFilter,
  weekSaturday,
} from "../src/lib/phoenix-crm/far-visit-week-rules.ts";
import {
  canReadFarVisitWeekReport,
  farVisitWeekSeats,
  combineFarVisitWeeks,
  filterFarVisitWeekReport,
  type FarVisitWeekItem,
  type FarVisitWeekRow,
} from "../src/lib/phoenix-crm/server/far-visit-week-report.ts";
import { FAR_VISIT_WEEK_SHEETS, buildFarVisitWeekWorkbook, farVisitWeekSheetName } from "../src/lib/phoenix-crm/server/far-visit-week-workbook.ts";
import { stripComments } from "./support/comment-strip.ts";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function seat(seatId: string, tier: string, extra: Partial<OrgSeat> = {}): OrgSeat {
  return {
    areaName: `Area ${seatId}`,
    isOtherPseudoDm: false,
    lineCode: "CNS",
    lineName: "CNS",
    occupantHrId: null,
    parentSeatId: null,
    path: [seatId],
    regionName: "Cairo",
    seatId,
    seatLabel: null,
    tier,
    ...extra,
  } as OrgSeat;
}

function viewer(flags: Partial<PhoenixCrmViewer>): PhoenixCrmViewer {
  return { basis: "seat", isSfeManager: false, isSuperAdmin: false, managerSeats: [], ownTerritories: [], scopeTerritories: [], ...flags } as PhoenixCrmViewer;
}

function rulesOfTheWeek() {
  // The company week runs Saturday to Friday: Tue 24 Nov 2026 belongs to the week of Sat 21 Nov.
  assert.equal(weekSaturday("2026-11-24"), "2026-11-21", "a Tuesday moves to its Saturday");
  assert.equal(weekSaturday("2026-11-21"), "2026-11-21", "a Saturday is its own week");
  assert.equal(weekSaturday("2026-11-27"), "2026-11-21", "a Friday closes the week it is in");
  assert.equal(weekSaturday("2026-11-28"), "2026-11-28", "the next Saturday opens the next week");

  const thisWeek = farVisitWeek(null, "2026-11-28");
  assert.equal(thisWeek.start, "2026-11-28", "nothing asked is this week");
  assert.equal(thisWeek.next, null, "this week offers no next week");
  assert.equal(thisWeek.previous, "2026-11-21");
  assert.equal(thisWeek.days.length, 7);
  assert.equal(thisWeek.end, "2026-12-04");
  assert.equal(farVisitWeek("2026-12-20", "2026-11-28").start, "2026-11-28", "a week that has not begun is never offered");
  assert.equal(farVisitWeek("nonsense", "2026-11-28").start, "2026-11-28", "nonsense is this week");
  assert.equal(farVisitWeek("2026-02-30", "2026-11-28").start, "2026-11-28", "an impossible date is this week");
  const last = farVisitWeek("2026-11-24", "2026-11-28");
  assert.equal(last.start, "2026-11-21");
  assert.equal(last.next, "2026-11-28", "a past week offers the one after it");

  // The four standings, and a refusal outranks a wait.
  assert.equal(farVisitWeekStanding({ visits: 6, doorRejected: 0, sfeRejected: 0, waiting: 0 }), "clean");
  assert.equal(farVisitWeekStanding({ visits: 0, doorRejected: 0, sfeRejected: 0, waiting: 0 }), "none");
  assert.equal(farVisitWeekStanding({ visits: 4, doorRejected: 2, sfeRejected: 0, waiting: 1 }), "rejected");
  assert.equal(farVisitWeekStanding({ visits: 4, doorRejected: 0, sfeRejected: 1, waiting: 0 }), "rejected");
  assert.equal(farVisitWeekStanding({ visits: 4, doorRejected: 0, sfeRejected: 0, waiting: 2 }), "waiting");

  assert.deepEqual(farVisitWeekCellText({ visits: 6, doorRejected: 0, sfeRejected: 0, waiting: 0 }), { head: "Clean", foot: "6 visits" });
  assert.deepEqual(farVisitWeekCellText({ visits: 4, doorRejected: 5, sfeRejected: 3, waiting: 0 }), { head: "8 rejected", foot: "4 visits" }, "his words: \"8 rejected\"");
  assert.deepEqual(farVisitWeekCellText({ visits: 1, doorRejected: 1, sfeRejected: 0, waiting: 2 }), { head: "1 rejected", foot: "1 visit · 2 waiting" });
  assert.deepEqual(farVisitWeekCellText({ visits: 0, doorRejected: 0, sfeRejected: 0, waiting: 0 }), { head: "—", foot: "" });
  assert.equal(farVisitWeekDayLabel("2026-11-24"), "Tue 24 Nov");
}

function whoReadsIt() {
  assert.equal(canReadFarVisitWeekReport(viewer({ isSuperAdmin: true })), true, "the Super Admin reads it");
  assert.equal(canReadFarVisitWeekReport(viewer({ isSfeManager: true })), true, "the SFE Manager reads it");
  assert.equal(canReadFarVisitWeekReport(viewer({ managerSeats: [seat("dm-1", "DM")] })), true, "a District Manager reads it");
  assert.equal(canReadFarVisitWeekReport(viewer({ managerSeats: [seat("adm-1", "ACTING_DM")] })), true, "an acting District Manager reads it");
  assert.equal(canReadFarVisitWeekReport(viewer({ managerSeats: [seat("nsm-1", "NSM")] })), true, "the National Sales Manager reads it");
  // 🔴 The owner's ruling of 2026-10-02: no far-visit count for the CEO or a Regional Sales Manager.
  assert.equal(canReadFarVisitWeekReport(viewer({ basis: "all" } as Partial<PhoenixCrmViewer>)), false, "never the CEO");
  assert.equal(canReadFarVisitWeekReport(viewer({ managerSeats: [seat("rsm-1", "RSM")] })), false, "never a Regional Sales Manager");
  assert.equal(canReadFarVisitWeekReport(viewer({ ownTerritories: [seat("t-1", "REP")] })), false, "🔴 never a rep (Golden Rule #1)");
  assert.throws(() => farVisitWeekSeats(viewer({ ownTerritories: [seat("t-1", "REP")] })), "a rep is refused by the loader too");

  // A manager reads his scope, never the Others pseudo-district and never his own seat as its rep.
  const mine = seat("t-own", "REP");
  const theirs = seat("t-team", "REP");
  const others = seat("t-others", "REP", { isOtherPseudoDm: true });
  const actingDm = viewer({ managerSeats: [seat("adm-1", "ACTING_DM")], ownTerritories: [mine], scopeTerritories: [mine, theirs, others] });
  assert.deepEqual(farVisitWeekSeats(actingDm).map((entry) => entry.seatId), ["t-team"], "his own rep seat and the Others pseudo-district are dropped");
  const sfe = viewer({ isSfeManager: true, ownTerritories: [mine], scopeTerritories: [mine, theirs] });
  assert.deepEqual(farVisitWeekSeats(sfe).map((entry) => entry.seatId), ["t-own", "t-team"], "the SFE Manager is blind on nothing");
}

function theLoaderReadsOnlyWhatItMust() {
  const loader = stripComments(read("src/lib/phoenix-crm/server/far-visit-week-report.ts"));
  assert.match(loader, /\.from\("phoenix_crm_visits"\)[\s\S]{0,200}\.eq\("is_test", false\)\s*\.is\("imported_from_ireports360_at", null\)/, "the visits are the rep's own entries, never a test or a copied iReports360 visit");
  assert.match(loader, /\.from\("phoenix_crm_refused_readings"\)[\s\S]{0,300}\.eq\("reason", "far_from_place"\)\s*\.eq\("is_test", false\)/, "only far refusals, never a test");
  assert.match(loader, /\.from\("phoenix_crm_far_visit_holds"\)[\s\S]{0,300}\.in\("status", \["refused", "sfe_pending"\]\)\s*\.eq\("is_test", false\)/, "refused holds and waiting holds, never a test");
  // 🔴 A far try is refused at once and never accepted (owner, 28 Nov 2026): it is ALWAYS a rejection, even when the
  // rep then visited that customer from the right place the same day.
  assert.match(loader, /const loggedLater = logged\.has\(key\);\s*cellOf\(seatId, date\)\.doorRejected \+= 1;/, "every refused try counts as rejected");
  assert.doesNotMatch(loader, /if \(!loggedLater\)/, "and a later accepted visit never cancels it");
  assert.match(loader, /const companyWide = viewer\.isSuperAdmin \|\| viewer\.isSfeManager;/, "only the company readers skip the seat filter");
  assert.match(loader, /if \(!inScope\.has\(seatId\)\) continue;/, "and every row is narrowed to the reader's scope again");
  assert.match(loader, /export async function loadFarVisitWeekDay\([^)]*\)[^{]*\{\s*if \(!farVisitWeekSeats\(viewer\)\.some\(/, "a day is opened only for a territory in the reader's scope");
  assert.doesNotMatch(loader, /device_mocked|position_case/, "no mock-location evidence");
}

function thePagesTheRouteAndTheSidebarHoldTheirGates() {
  for (const [path, home] of [
    ["app/(admin)/admin/phoenix-crm/far-visit-week/page.tsx", "/admin"],
    ["app/employee-portals/far-visit-week/page.tsx", "/employee-portals"],
  ] as const) {
    const page = stripComments(read(path));
    const order = ['canAccess(access, "phoenix_crm", "read")', "canReadFarVisitWeekReport(viewer)", "loadFarVisitWeekPage("].map((step) => page.indexOf(step));
    assert.ok(order.every((at) => at > 0) && order[0]! < order[1]! && order[1]! < order[2]!, `${path}: the permission, then the reader, and only then the read`);
    assert.ok(page.includes(`redirect("${home}")`), `${path}: anybody else is redirected, never told the page exists`);
  }
  assert.equal(FAR_VISIT_WEEK_PATHS.admin, "/admin/phoenix-crm/far-visit-week");
  assert.equal(FAR_VISIT_WEEK_PATHS.portal, "/employee-portals/far-visit-week");

  const route = stripComments(read("app/api/phoenix-crm/far-visit-week-report/export/route.ts"));
  assert.doesNotMatch(route, /export async function (?:POST|PATCH|PUT|DELETE)\(/, "the export only reads");
  const steps = ['assertPermission(access, "phoenix_crm", "read")', "assertExportRateLimit(", "loadFarVisitWeeksReport(", "writeAuditLog("].map((step) => route.indexOf(step));
  assert.ok(steps.every((at) => at > 0) && steps.every((at, index) => index === 0 || at > steps[index - 1]!), "permission, rate limit, the loader's own gate, then the export is recorded");

  const entries = stripComments(read("src/lib/phoenix-crm/server/sidebar-entries.ts"));
  assert.match(entries, /farVisitWeek: canReadFarVisitWeekReport\(viewer\),/, "the sidebar row is the page's own predicate");
  const navigation = stripComments(read("src/lib/employee-portal/navigation.ts"));
  assert.match(navigation, /showFarVisitWeekTab: hasFarVisitWeek === true,/, "and nothing else decides the row");
  for (const caller of ["src/components/employee-portal/employee-portal-server-shell.tsx", "app/api/employee-portals/navigation/route.ts", "app/employee-portals/profile/page.tsx", "app/payslips/page.tsx"]) {
    assert.match(stripComments(read(caller)), /phoenixCrm\.myMap,\s*phoenixCrm\.farVisitWeek,/, `${caller} passes the flag in its place`);
  }
  const basemap = stripComments(read("app/api/admin/phoenix-crm/case-map-basemap/route.ts"));
  assert.match(basemap, /!canReadFarVisitWeekReport\(viewer\)/, "the week's readers are drawn the streets behind its maps");

  const view = stripComments(read("src/components/phoenix-crm/far-visit-week-report-view.tsx"));
  assert.doesNotMatch(view, /^"use client"|onClick|fetch\(|method="post"/im, "the view is read-only links and a GET form, drawn on the server");
  assert.match(view, /<form action=\{reading\.basePath\}[^>]*method="get"/, "the weeks and filters are a plain GET form on the page's own address");
  assert.match(view, /name="week" type="checkbox"/, "several weeks are ticked, each a repeated week= in the address");
  for (const link of ["single.previous", "single.next", "reading.chosen"]) {
    assert.match(view, new RegExp(`farVisitWeekQuery\\(${link.replace(".", "\\.")}, filter\\)`), `the ${link} link keeps the filters`);
  }
  assert.match(view, /farVisitWeekQuery\(reading\.chosen, reading\.filter, \{ seat: seatId, date \}\)/, "a day opened from the grid keeps the weeks and the filters");
  const page = stripComments(read("src/lib/phoenix-crm/server/far-visit-week-page.ts"));
  assert.match(page, /loadFarVisitWeeksReport\(viewer, all\(params\.week\), parseFarVisitWeekFilter\(/, "the page reads every week and the filters from its address");
  const exportRoute = stripComments(read("app/api/phoenix-crm/far-visit-week-report/export/route.ts"));
  assert.match(exportRoute, /loadFarVisitWeeksReport\(viewer, search\.getAll\("week"\), parseFarVisitWeekFilter\(/, "the Excel file is read with the same weeks and filters");
  assert.match(view, /<CrmTable columns=\{\["19%", \.\.\.week\.days\.map/, "the desktop grid is the module's fixed table (fits the screen)");
  assert.doesNotMatch(view, /rounded|overflow-x-auto|min-w-\[/, "no round corner, no sideways scroll");
}

function weekRow(week: ReturnType<typeof farVisitWeek>, extra: Partial<FarVisitWeekRow> & Pick<FarVisitWeekRow, "seatId" | "repName">): FarVisitWeekRow {
  const counts = { visits: 5, doorRejected: 1, sfeRejected: 0, waiting: 0 };
  return {
    territory: "Area · CNS",
    regionName: "Cairo",
    lineName: "CNS",
    districtSeatId: "dm-1",
    districtLabel: "Manager One (Area dm-1 · CNS)",
    cells: week.days.map((date) => ({ ...counts, date, standing: farVisitWeekStanding(counts) })),
    totals: { visits: 35, doorRejected: 7, sfeRejected: 0, waiting: 0 },
    cleanDays: 0,
    ...extra,
  };
}

function itemOf(seatId: string): FarVisitWeekItem {
  return {
    kind: "door",
    seatId,
    date: "2026-11-23",
    at: null,
    repName: seatId,
    territory: seatId,
    customerId: `c-${seatId}`,
    customerName: "Customer",
    distanceMeters: 400,
    farMeters: 300,
    tries: 1,
    loggedLater: false,
    spot: null,
    visitId: null,
    placeId: null,
  };
}

function theFilters() {
  // The address: three names, blanks are no filter, and every link keeps them.
  const given: Record<string, string | null> = { dm: " dm-2 ", line: "", rep: null };
  const filter = parseFarVisitWeekFilter((name) => given[name]);
  assert.deepEqual(filter, { dm: "dm-2", line: null, rep: null });
  assert.equal(farVisitWeekFilterNarrows(filter), true);
  assert.equal(farVisitWeekFilterNarrows({ dm: null, line: null, rep: null }), false);
  assert.equal(
    farVisitWeekQuery("2026-11-21", { dm: "dm-2", line: "Pedia", rep: null }, { seat: "t 1", date: "2026-11-23" }),
    "?week=2026-11-21&dm=dm-2&line=Pedia&seat=t+1&date=2026-11-23",
  );
  assert.equal(farVisitWeekQuery("2026-11-14", { dm: null, line: null, rep: null }), "?week=2026-11-14", "no filter, no noise in the address");

  const week = farVisitWeek("2026-11-21", "2026-11-28");
  const rows = [
    weekRow(week, { seatId: "t-1", repName: "Rep One" }),
    weekRow(week, { seatId: "t-2", repName: "Rep Two", lineName: "Pedia", districtSeatId: "dm-2", districtLabel: "Manager Two (Area dm-2 · Pedia)" }),
    weekRow(week, {
      seatId: "t-3",
      repName: "Rep Three",
      lineName: "Pedia",
      districtSeatId: "none",
      districtLabel: "No district manager",
      totals: { visits: 35, doorRejected: 0, sfeRejected: 0, waiting: 0 },
    }),
  ];
  const items = rows.map((row) => itemOf(row.seatId));
  const none = { dm: null, line: null, rep: null };

  const all = filterFarVisitWeekReport({ week, rows, items }, none);
  assert.equal(all.rows.length, 3);
  assert.equal(all.filterLabel, null, "nothing narrows the week: no label on the file");
  assert.deepEqual(all.options.lines, ["CNS", "Pedia"]);
  assert.deepEqual(all.options.districts.map((option) => option.value), ["dm-1", "dm-2", "none"], "every district manager in the scope, and the reps with none");
  assert.equal(all.totals.reps, 3);
  assert.equal(all.totals.repsWithRejections, 2);

  const byDistrict = filterFarVisitWeekReport({ week, rows, items }, { ...none, dm: "dm-2" });
  assert.deepEqual(byDistrict.rows.map((row) => row.seatId), ["t-2"], "a district manager's reps only");
  assert.deepEqual(byDistrict.items.map((item) => item.seatId), ["t-2"], "and the detail lines of those reps only");
  assert.equal(byDistrict.totals.doorRejected, 7, "the totals are counted again from what is left");
  assert.equal(byDistrict.totals.reps, 1);
  assert.equal(byDistrict.filterLabel, "District manager: Manager Two (Area dm-2 · Pedia)");
  assert.equal(byDistrict.options.districts.length, 3, "the district list never shrinks to the one picked");

  const byLine = filterFarVisitWeekReport({ week, rows, items }, { ...none, line: "Pedia" });
  assert.deepEqual(byLine.rows.map((row) => row.seatId), ["t-2", "t-3"]);
  assert.deepEqual(byLine.options.reps.map((option) => option.value), ["t-3", "t-2"], "the rep list follows the line picked (by name)");
  assert.equal(byLine.totals.repsWithRejections, 1);

  const byRep = filterFarVisitWeekReport({ week, rows, items }, { ...none, rep: "t-1" });
  assert.deepEqual(byRep.rows.map((row) => row.seatId), ["t-1"]);
  assert.equal(byRep.filterLabel, "Rep: Rep One");

  const outside = filterFarVisitWeekReport({ week, rows, items }, { ...none, rep: "someone-else" });
  assert.equal(outside.rows.length, 0, "a rep outside the reader's scope is never drawn — a filter only takes rows away");
  assert.equal(outside.items.length, 0);
}

async function theWorkbook() {
  const week = farVisitWeek("2026-11-21", "2026-11-28");
  const report = filterFarVisitWeekReport({
    week,
    rows: [
      {
        seatId: "t-1",
        repName: "Rep One",
        territory: "Area 1 · CNS",
        regionName: "Cairo",
        lineName: "CNS",
        districtSeatId: "dm-1",
        districtLabel: "Manager One (Area dm-1 · CNS)",
        cells: week.days.map((date, index) => {
          const counts = index === 3 ? { visits: 4, doorRejected: 1, sfeRejected: 1, waiting: 0 } : { visits: index === 6 ? 0 : 5, doorRejected: 0, sfeRejected: 0, waiting: 0 };
          return { ...counts, date, standing: farVisitWeekStanding(counts) };
        }),
        totals: { visits: 34, doorRejected: 1, sfeRejected: 1, waiting: 0 },
        cleanDays: 5,
      },
    ],
    items: [
      {
        kind: "sfe",
        seatId: "t-1",
        date: "2026-11-24",
        at: "2026-11-24T08:15:00.000Z",
        repName: "Rep One",
        territory: "Area 1 · CNS",
        customerId: "c-1",
        customerName: "Dr. Example",
        distanceMeters: 311,
        farMeters: 150,
        tries: 5,
        loggedLater: false,
        spot: { lat: 30.05, lon: 31.25 },
        visitId: "v-1",
        placeId: "p-1",
      },
    ],
  }, { dm: null, line: "CNS", rep: null });
  assert.equal(report.totals.reps, 1);
  const buffer = await buildFarVisitWeekWorkbook(combineFarVisitWeeks([report], report.filter), "Super Admin", "2026-11-28T17:00:00.000Z");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), [FAR_VISIT_WEEK_SHEETS.week, FAR_VISIT_WEEK_SHEETS.details], "two sheets: the week and its details");

  const grid = workbook.getWorksheet(FAR_VISIT_WEEK_SHEETS.week)!;
  assert.match(String(grid.getRow(2).getCell(1).value), / · Line: CNS · /, "a filtered file says what it was filtered by");
  assert.equal(grid.getRow(5).getCell(1).value, "Rep");
  assert.equal(grid.getRow(5).getCell(3).value, "Sat 21 Nov", "a day per column, from Saturday");
  assert.equal(grid.getRow(6).getCell(1).value, "Rep One");
  assert.equal(grid.getRow(6).getCell(3).value, "Clean · 5 visits");
  assert.equal(grid.getRow(6).getCell(6).value, "2 rejected · 4 visits", "Tuesday reads as the screen does");
  assert.equal(grid.getRow(6).getCell(9).value, "—", "an empty day is a dash");
  const fill = grid.getRow(6).getCell(6).fill as { fgColor?: { argb?: string } } | undefined;
  assert.ok(!fill || !fill.fgColor || /FFFFFFFF$/i.test(fill.fgColor.argb ?? "FFFFFFFF"), "🔴 the ink rule: a rejected day is words, never a coloured fill");

  const details = workbook.getWorksheet(FAR_VISIT_WEEK_SHEETS.details)!;
  assert.equal(details.getRow(5).getCell(10).value, "Accepted later the same day");
  const line = details.getRow(6);
  assert.equal(line.getCell(5).value, "Dr. Example");
  assert.equal(line.getCell(6).value, FAR_VISIT_WEEK_KIND_LABELS.sfe);
  assert.equal(line.getCell(7).value, 311, "the distance is a real number");
  const link = line.getCell(11).value as ExcelJS.CellHyperlinkValue;
  assert.equal(link.hyperlink, "https://www.google.com/maps/search/?api=1&query=30.050000,31.250000", "where save was pressed opens in Google Maps");
  assert.ok(details.autoFilter, "the details can be filtered");
}

async function severalWeeks() {
  // 🔴 SEVERAL WEEKS AT ONCE (owner, 28 Nov 2026: "multi select multi weeks").
  const today = "2026-11-28"; // a Saturday: this week is Sat 28 Nov
  assert.deepEqual(
    farVisitWeeks(["2026-11-17", "2026-11-24", "2026-11-21", "nonsense", ""], today).map((week) => week.start),
    ["2026-11-21", "2026-11-14"],
    "each day moves to its Saturday, repeats fold into one, nonsense is dropped, newest first",
  );
  assert.deepEqual(farVisitWeeks([], today).map((week) => week.start), ["2026-11-28"], "nothing chosen is this week alone");
  assert.deepEqual(farVisitWeeks(["2027-01-09"], today).map((week) => week.start), ["2026-11-28"], "a week not begun yet is never read");
  const many = Array.from({ length: 12 }, (_, index) => new Date(Date.UTC(2026, 10, 28 - 7 * index)).toISOString().slice(0, 10));
  assert.equal(farVisitWeeks(many, today).length, FAR_VISIT_WEEK_MAX, `no more than ${FAR_VISIT_WEEK_MAX} weeks in one reading`);
  const choices = farVisitWeekChoices(today);
  assert.equal(choices.length, 12);
  assert.equal(choices[0].start, "2026-11-28", "the picker opens on this week");
  assert.equal(choices[1].start, "2026-11-21", "then the weeks before it");
  assert.equal(
    farVisitWeekQuery(["2026-11-21", "2026-11-14"], { dm: null, line: "CNS", rep: null }, { seat: "t-1", date: "2026-11-17" }),
    "?week=2026-11-21&week=2026-11-14&line=CNS&seat=t-1&date=2026-11-17",
    "every week chosen rides in the address, with the filters",
  );

  // One set of totals across the weeks: the reps once, a rep with a rejection once however many weeks held one.
  const none = { dm: null, line: null, rep: null };
  const weekA = farVisitWeek("2026-11-21", today);
  const weekB = farVisitWeek("2026-11-14", today);
  const a = filterFarVisitWeekReport({ week: weekA, rows: [weekRow(weekA, { seatId: "t-1", repName: "Rep One" }), weekRow(weekA, { seatId: "t-2", repName: "Rep Two", totals: { visits: 30, doorRejected: 0, sfeRejected: 0, waiting: 1 } })], items: [itemOf("t-1")] }, none);
  const b = filterFarVisitWeekReport({ week: weekB, rows: [weekRow(weekB, { seatId: "t-1", repName: "Rep One" }), weekRow(weekB, { seatId: "t-2", repName: "Rep Two" })], items: [itemOf("t-2")] }, none);
  const both = combineFarVisitWeeks([a, b], none);
  assert.equal(both.totals.reps, 2, "the same two reps, counted once");
  assert.equal(both.totals.repsWithRejections, 2);
  assert.equal(both.totals.doorRejected, 21, "the rejections add up across the weeks");
  assert.equal(both.totals.waiting, 1);
  assert.equal(both.totals.visits, 135);

  // The file: one sheet per week, newest first, and every week's lines in Details.
  const buffer = await buildFarVisitWeekWorkbook(both, "Super Admin", "2026-11-28T17:00:00.000Z");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  assert.deepEqual(
    workbook.worksheets.map((sheet) => sheet.name),
    ["Week Sat 21 Nov", "Week Sat 14 Nov", FAR_VISIT_WEEK_SHEETS.details],
    "a sheet per week, named by its Saturday, then the details",
  );
  assert.equal(farVisitWeekSheetName(weekA, false), FAR_VISIT_WEEK_SHEETS.week, "one week keeps the plain name");
  const details = workbook.getWorksheet(FAR_VISIT_WEEK_SHEETS.details)!;
  assert.equal(details.getRow(6).getCell(1).value, "t-1");
  assert.equal(details.getRow(7).getCell(1).value, "t-2", "both weeks' lines are in the details");
  assert.match(String(details.getRow(2).getCell(1).value), /^2 weeks, Sat 14 Nov to Fri 27 Nov 2026/, "the details say which weeks they hold");
}

export async function runPhoenixCrmFarVisitWeekTests(): Promise<void> {
  rulesOfTheWeek();
  whoReadsIt();
  theLoaderReadsOnlyWhatItMust();
  thePagesTheRouteAndTheSidebarHoldTheirGates();
  theFilters();
  await theWorkbook();
  await severalWeeks();
  console.log("phoenix-crm-far-visit-week: PASS");
}
