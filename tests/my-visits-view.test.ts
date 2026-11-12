import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MY_VISITS_PAGE_SIZE,
  buildMyVisitsView,
  myVisitsHref,
  parseMyVisitsPage,
  parseMyVisitsTab,
} from "../src/lib/employee-portal/my-visits-view.ts";
import { TEAM_VISIT_ROW_CAP } from "../src/lib/employee-portal/my-crm-visits-constants.ts";
import type {
  MyCrmCheckinRow,
  MyCrmDoubleVisitRow,
  MyCrmVisitRow,
  TeamCrmVisitRow,
} from "../src/lib/employee-portal/my-crm-visits.ts";

/**
 * My Visits sends the phone every tab's count and the rows of ONE page (owner, 12 Nov 2026,
 * "slim My Visits"). It used to send the whole 90-day window — 1,049 visits and 599 check-ins for
 * one Medical Rep, 956 KB of page — and page through it in the browser, 25 at a time.
 *
 * Pinned here: the counts still come from the whole window (field visits only on the two visit
 * tabs), the rows are one page and never more, an unknown tab or page falls back safely, and the
 * page and the workspace are wired so the whole window cannot travel again.
 */

function visit(id: number, fieldWork = true): MyCrmVisitRow {
  return {
    ampm: "AM",
    comment: fieldWork ? null : "Annual leave",
    contactName: `Dr ${id}`,
    customerName: null,
    doubleName: null,
    fieldWork,
    id: `v${id}`,
    visitDate: "2026-11-01",
    visitTime: null,
    visitTimeSource: "save_time",
    visitTypeDescription: fieldWork ? "Regular Visit" : "Vacation",
  };
}

function teamVisit(id: number, fieldWork = true): TeamCrmVisitRow {
  return { ...visit(id, fieldWork), agentName: "Rep", id: `t${id}` };
}

function doubleVisit(id: number): MyCrmDoubleVisitRow {
  return {
    ampm: "PM",
    comment: null,
    contactName: `Dr ${id}`,
    customerName: null,
    id: `d${id}`,
    primaryAgentName: "Rep",
    visitDate: "2026-11-01",
    visitTime: null,
    visitTypeDescription: "Double Visit",
  };
}

function checkin(id: number): MyCrmCheckinRow {
  return { address: null, checkDate: "2026-11-01T09:00:00Z", contactName: `Dr ${id}`, id: `c${id}` };
}

const range = <T,>(n: number, make: (i: number) => T) => Array.from({ length: n }, (_, i) => make(i + 1));

// One rep's real window, in shape: 1,049 visits (12 of them leave), 37 double visits, 599 check-ins.
const visits = [...range(1037, (i) => visit(i)), ...range(12, (i) => visit(5000 + i, false))];
const doubleVisits = range(37, doubleVisit);
const checkins = range(599, checkin);

function testCountsComeFromTheWholeWindow() {
  const model = buildMyVisitsView({ visits, doubleVisits, checkins, teamVisits: [], tab: undefined, page: undefined });
  assert.deepEqual(model.counts, { visits: 1037, double: 37, checkins: 599, team: 0 }, "every tab's count is the whole window, field visits only on My visits");
  assert.equal(model.hasTeam, false, "a rep with no team has no Team visits tab");
  assert.equal(model.view.tab, "visits");
  assert.equal(model.view.page, 1);
  assert.equal(model.view.totalRows, 1037);
  assert.equal(model.view.totalPages, Math.ceil(1037 / MY_VISITS_PAGE_SIZE));
}

function testOnlyOnePageOfRowsIsSent() {
  for (const tab of ["visits", "double", "checkins"]) {
    for (const page of ["1", "2", "999"]) {
      const { view } = buildMyVisitsView({ visits, doubleVisits, checkins, teamVisits: [], tab, page });
      assert.ok(
        view.rows.length <= MY_VISITS_PAGE_SIZE,
        `🔴 ${tab} page ${page}: ${view.rows.length} rows sent — one page is ${MY_VISITS_PAGE_SIZE}; the whole window must never travel to the phone again (956 KB for one rep)`,
      );
    }
  }
  const second = buildMyVisitsView({ visits, doubleVisits, checkins, teamVisits: [], tab: "visits", page: "2" }).view;
  assert.deepEqual(second.rows.map((row) => row.id), range(25, (i) => `v${25 + i}`), "page 2 is rows 26 to 50, in the order the server read them");
  const last = buildMyVisitsView({ visits, doubleVisits, checkins, teamVisits: [], tab: "visits", page: "999" }).view;
  assert.equal(last.page, last.totalPages, "a page past the end opens the last page");
  assert.deepEqual(last.rows.map((row) => row.id), ["v1026", "v1027", "v1028", "v1029", "v1030", "v1031", "v1032", "v1033", "v1034", "v1035", "v1036", "v1037"]);
}

function testDaysNotInTheFieldTravelWithTheirTab() {
  const mine = buildMyVisitsView({ visits, doubleVisits, checkins, teamVisits: [], tab: "visits", page: "1" }).view;
  assert.ok(mine.tab === "visits");
  assert.equal(mine.offDutyRows.length, 12, "the days not in the field are listed under their own heading, not dropped");
  assert.ok(mine.rows.every((row) => row.fieldWork), "the paged list is field visits only");

  const teamVisits = [...range(40, (i) => teamVisit(i)), teamVisit(900, false)];
  const team = buildMyVisitsView({ visits, doubleVisits, checkins, teamVisits, tab: "team", page: "2" });
  assert.equal(team.hasTeam, true);
  assert.equal(team.counts.team, 40, "the Team visits count is field visits only");
  assert.ok(team.view.tab === "team");
  assert.equal(team.view.rows.length, 15);
  assert.equal(team.view.offDutyRows.length, 1);
  assert.equal(team.teamCapped, false);
  const capped = buildMyVisitsView({ visits: [], doubleVisits: [], checkins: [], teamVisits: range(TEAM_VISIT_ROW_CAP, (i) => teamVisit(i)), tab: "team", page: "1" });
  assert.equal(capped.teamCapped, true, "a team feed at the cap says older visits are not listed");
}

function testUnknownTabsAndPagesFallBack() {
  assert.equal(parseMyVisitsTab("team", false), "visits", "🔴 a viewer with no team never opens the Team visits tab");
  assert.equal(parseMyVisitsTab("team", true), "team");
  assert.equal(parseMyVisitsTab("double", false), "double");
  assert.equal(parseMyVisitsTab("<script>", false), "visits");
  assert.equal(parseMyVisitsTab(["checkins", "team"], false), "checkins");
  assert.equal(parseMyVisitsTab(undefined, true), "visits");
  for (const bad of ["0", "-3", "2.5", "abc", "", undefined]) assert.equal(parseMyVisitsPage(bad), 1, `page ${String(bad)} is page 1`);
  assert.equal(parseMyVisitsPage("7"), 7);
  const empty = buildMyVisitsView({ visits: [], doubleVisits: [], checkins: [], teamVisits: [], tab: "checkins", page: "4" }).view;
  assert.equal(empty.page, 1);
  assert.equal(empty.totalPages, 1);
  assert.deepEqual(empty.rows, []);
}

function testTheAddresses() {
  const base = "/employee-portals/visits";
  assert.equal(myVisitsHref(base, "visits", 1), base, "page 1 of My visits is the bare page — the sidebar's own address");
  assert.equal(myVisitsHref(base, "visits", 3), `${base}?page=3`);
  assert.equal(myVisitsHref(base, "checkins", 1), `${base}?tab=checkins`);
  assert.equal(myVisitsHref(base, "team", 2), `${base}?tab=team&page=2`);
  for (const tab of ["double", "checkins", "team"] as const) {
    const href = myVisitsHref(base, tab, 5);
    const params = new URL(href, "https://x").searchParams;
    assert.equal(parseMyVisitsTab(params.get("tab") ?? undefined, true), tab, "the address opens the tab it names");
    assert.equal(parseMyVisitsPage(params.get("page") ?? undefined), 5);
  }
}

function testTheWholeWindowCannotTravelAgain() {
  const page = readFileSync("app/employee-portals/visits/page.tsx", "utf8");
  assert.match(page, /buildMyVisitsView\(\{ visits, doubleVisits, checkins, teamVisits, tab: params\.tab, page: params\.page \}\)/, "the page builds the one-page view from the whole window");
  assert.match(page, /<MyVisitsWorkspace dateFrom=\{dateFrom\} dateTo=\{dateTo\} view=\{view\} \/>/, "🔴 the workspace receives the view and nothing else");
  for (const prop of ["visits", "doubleVisits", "checkins", "teamVisits"]) {
    assert.doesNotMatch(page, new RegExp(`\\b${prop}=\\{${prop}\\}`), `🔴 the page must not hand the workspace the whole ${prop} list — that is the 956 KB this replaced`);
  }

  const workspace = readFileSync("src/components/employee-portal/my-visits-workspace.tsx", "utf8");
  assert.doesNotMatch(workspace, /\.slice\(/, "🔴 the workspace never pages rows itself — it only ever holds one page");
  assert.doesNotMatch(workspace, /partitionMyVisitRows/, "the field split happens on the server, in the view");
  assert.match(workspace, /router\.push\(myVisitsHref\(pathname, tab, page\), \{ scroll: false \}\)/, "a tab or page asks the server for that page, without jumping to the top");
}

export async function runMyVisitsViewTests() {
  testCountsComeFromTheWholeWindow();
  testOnlyOnePageOfRowsIsSent();
  testDaysNotInTheFieldTravelWithTheirTab();
  testUnknownTabsAndPagesFallBack();
  testTheAddresses();
  testTheWholeWindowCannotTravelAgain();
}
