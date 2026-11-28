import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import type { PhoenixCrmViewer } from "../src/lib/phoenix-crm/server/access.ts";
import type { OrgSeat } from "../src/lib/phoenix-crm/scope.ts";
import {
  FAR_VISIT_WEEK_KIND_LABELS,
  FAR_VISIT_WEEK_PATHS,
  farVisitWeek,
  farVisitWeekCellText,
  farVisitWeekDayLabel,
  farVisitWeekStanding,
  weekSaturday,
} from "../src/lib/phoenix-crm/far-visit-week-rules.ts";
import { canReadFarVisitWeekReport, farVisitWeekSeats, type FarVisitWeekReport } from "../src/lib/phoenix-crm/server/far-visit-week-report.ts";
import { FAR_VISIT_WEEK_SHEETS, buildFarVisitWeekWorkbook } from "../src/lib/phoenix-crm/server/far-visit-week-workbook.ts";
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
  const steps = ['assertPermission(access, "phoenix_crm", "read")', "assertExportRateLimit(", "loadFarVisitWeekReport(", "writeAuditLog("].map((step) => route.indexOf(step));
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
  assert.doesNotMatch(view, /^"use client"|<button|onClick|<form|fetch\(/m, "the view is read-only links, drawn on the server");
  assert.match(view, /<table className="w-full table-fixed/, "the desktop grid is a fixed table (fits the screen)");
  assert.doesNotMatch(view, /rounded|overflow-x-auto|min-w-\[/, "no round corner, no sideways scroll");
}

async function theWorkbook() {
  const week = farVisitWeek("2026-11-21", "2026-11-28");
  const report: FarVisitWeekReport = {
    week,
    rows: [
      {
        seatId: "t-1",
        repName: "Rep One",
        territory: "Area 1 · CNS",
        regionName: "Cairo",
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
    totals: { visits: 34, doorRejected: 1, sfeRejected: 1, waiting: 0, reps: 1, repsWithRejections: 1 },
  };
  const buffer = await buildFarVisitWeekWorkbook(report, "Super Admin", "2026-11-28T17:00:00.000Z");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), [FAR_VISIT_WEEK_SHEETS.week, FAR_VISIT_WEEK_SHEETS.details], "two sheets: the week and its details");

  const grid = workbook.getWorksheet(FAR_VISIT_WEEK_SHEETS.week)!;
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

export async function runPhoenixCrmFarVisitWeekTests(): Promise<void> {
  rulesOfTheWeek();
  whoReadsIt();
  theLoaderReadsOnlyWhatItMust();
  thePagesTheRouteAndTheSidebarHoldTheirGates();
  await theWorkbook();
  console.log("phoenix-crm-far-visit-week: PASS");
}
