import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { WEEKLY_SHEET_ADMIN_PATH, weeklySheetHref } from "../src/lib/crm/weekly-sheet-summary.ts";
import { adminTeamReportLinks, regionalTeamReportLinks } from "../src/lib/employee-portal/regional-team-reports.ts";
import {
  readsAnyTeamReport,
  readsCompanyTeamReports,
  readsRegionOrDistrictReports,
  teamReportRepSeats,
  type PhoenixCrmViewer,
} from "../src/lib/phoenix-crm/server/access.ts";
import { DISTRICT_PLANS_ADMIN_PATH, districtPlansHref } from "../src/lib/phoenix-crm/server/district-plans-summary.ts";
import { regionalDistrictSeats } from "../src/lib/phoenix-crm/server/manager-plan-bookings.ts";
import { TEAM_VISITS_ADMIN_PATH, teamVisitFilterHref } from "../src/lib/phoenix-crm/server/team-visits-summary.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Dr. Hany Saad's team reports for the Super Admin, over the whole company, in the admin shell (owner, 2026-11-11:
 * "add for the admin the reports u added to hany saad in his overview dashboard"). The gate is the Super Admin's
 * alone, the reach is every rep and every district manager, the tiles sit on /admin, and each link stays in the admin
 * shell. Account: docs/regional-team-reports.md, "The Super Admin's copy".
 */

type SeatShape = { seatId: string; tier: string; isOtherPseudoDm?: boolean; path?: string[]; areaName?: string };

function viewer(input: { superAdmin?: boolean; sfe?: boolean; managerSeats?: SeatShape[]; scope?: SeatShape[] }): PhoenixCrmViewer {
  return {
    isSfeManager: input.sfe === true,
    isSuperAdmin: input.superAdmin === true,
    managerSeats: input.managerSeats ?? [],
    ownTerritories: [],
    scopeTerritories: input.scope ?? [],
  } as unknown as PhoenixCrmViewer;
}

function gate() {
  assert.equal(readsCompanyTeamReports(viewer({ superAdmin: true })), true, "the Super Admin opens the company copy");
  assert.equal(readsCompanyTeamReports(viewer({})), false, "a login with no seat (the CEO's) does not");
  assert.equal(readsCompanyTeamReports(viewer({ sfe: true })), false, "the SFE Manager does not");
  assert.equal(readsCompanyTeamReports(viewer({ managerSeats: [{ seatId: "R", tier: "RSM" }] })), false, "an RSM reads the region, not the company");
  // Every loader and export asks the wider gate; the PORTAL pages keep the RSM / DM gate and still send him home.
  assert.equal(readsAnyTeamReport(viewer({ superAdmin: true })), true);
  assert.equal(readsAnyTeamReport(viewer({ managerSeats: [{ seatId: "D", tier: "DM" }] })), true);
  assert.equal(readsAnyTeamReport(viewer({ sfe: true })), false);
  assert.equal(readsRegionOrDistrictReports(viewer({ superAdmin: true })), false, "the portal pages are not widened");
}

function reach() {
  const scope = [
    { seatId: "R1", tier: "REP" },
    { seatId: "R2", tier: "REP" },
    { seatId: "D1", tier: "DM" },
    { seatId: "R3", tier: "REP" },
    { seatId: "RS1", tier: "RSM" },
  ];
  assert.deepEqual(teamReportRepSeats(viewer({ scope, superAdmin: true })).map((seat) => seat.seatId), ["R1", "R2", "R3"], "every rep seat in the company");
  assert.deepEqual(teamReportRepSeats(viewer({ scope, sfe: true })), [], "no gate, no reps");

  const seats: SeatShape[] = [
    { areaName: "North", path: ["RS1"], seatId: "RS1", tier: "RSM" },
    { areaName: "Cairo East", path: ["RS1", "D1"], seatId: "D1", tier: "DM" },
    { areaName: "Cairo West", path: ["RS1", "D2"], seatId: "D2", tier: "ACTING_DM" },
    { areaName: "Others", isOtherPseudoDm: true, path: ["RS1", "D9"], seatId: "D9", tier: "DM" },
    { areaName: "Assiut", path: ["N1", "D3"], seatId: "D3", tier: "DM" },
  ];
  const org = { seats: new Map(seats.map((seat) => [seat.seatId, seat])) };
  const ids = (isSuperAdmin: boolean) =>
    regionalDistrictSeats({ isSuperAdmin, managerSeats: [], org } as unknown as Pick<PhoenixCrmViewer, "org" | "managerSeats"> & { isSuperAdmin: boolean })
      .map((seat) => seat.seatId)
      .sort();
  assert.deepEqual(ids(true), ["D1", "D2", "D3"], "the Super Admin: every district manager seat, every region, never Others");
  assert.deepEqual(ids(false), [], "no seat and not the Super Admin: nothing");
}

function tiles() {
  const links = adminTeamReportLinks("2026-01-15");
  // Hany's order, less his own plan board — the Super Admin plans no week.
  const hany = regionalTeamReportLinks("2026-01-15").filter((link) => link.key !== "region-plans");
  assert.deepEqual(links.map((link) => link.key), hany.map((link) => link.key));
  assert.deepEqual(links.map((link) => link.label), hany.map((link) => link.label), "the same words as his tiles");
  for (const link of links) {
    assert.ok(link.href.startsWith("/admin/"), `${link.label}: opens in the admin shell`);
    assert.ok(link.headline.length > 0, `${link.label}: says what it answers`);
  }
  const href = (key: string) => links.find((link) => link.key === key)?.href;
  assert.equal(href("team-visits"), TEAM_VISITS_ADMIN_PATH);
  assert.equal(href("district-manager-plans"), DISTRICT_PLANS_ADMIN_PATH);
  assert.equal(href("weekly-sheet"), WEEKLY_SHEET_ADMIN_PATH);
  assert.equal(href("coverage-last-month"), "/admin/kpis?tab=coverage&month=2025-12", "last month across a year");
  assert.equal(href("frequency-last-month"), "/admin/kpis?tab=frequency&month=2025-12");

  const overview = stripComments(readFileSync("src/components/admin/system-admin-overview.tsx", "utf8"));
  assert.ok(overview.includes("<TeamReportsBand />"), "/admin draws the Team Reports band");
  assert.ok(overview.includes("adminTeamReportLinks(cairoTodayIso())"), "from the one list");
}

function adminPages() {
  // Every filter link on an admin page stays on the admin page.
  assert.equal(teamVisitFilterHref("none", "today", "first", TEAM_VISITS_ADMIN_PATH), "/admin/field-crm/team-visits?show=none&day=today&sort=first");
  assert.equal(districtPlansHref("2026-11-07", "waiting", DISTRICT_PLANS_ADMIN_PATH), "/admin/field-crm/district-manager-plans?week=2026-11-07&show=waiting");
  assert.equal(weeklySheetHref(null, "all", WEEKLY_SHEET_ADMIN_PATH), "/admin/field-crm/weekly-sheet");
  for (const name of ["team-visits", "district-manager-plans", "weekly-sheet"]) {
    const page = stripComments(readFileSync(`app/(admin)/admin/field-crm/${name}/page.tsx`, "utf8"));
    const gateAt = page.indexOf('if (!viewer || !readsCompanyTeamReports(viewer)) redirect("/admin");');
    const loadAt = page.search(/load(TeamVisitsReport|DistrictManagersPlans|WeeklySheet)\(viewer/);
    assert.ok(gateAt > 0 && loadAt > gateAt, `${name}: the Super Admin's gate before any read`);
    assert.ok(page.includes('surface="admin"'), `${name}: the view's links stay in the admin shell`);
  }
  const plans = stripComments(readFileSync("src/lib/phoenix-crm/server/manager-plan-bookings.ts", "utf8"));
  assert.ok(plans.includes('managerPlanHref(plan.planId, viewer.isSuperAdmin ? "admin" : "portal")'), "a sent week opens on the admin approval page");
  const visits = stripComments(readFileSync("src/components/crm/regional/team-visits-view.tsx", "utf8"));
  assert.ok(visits.includes('surface === "admin" ? phoenixCrmDayPath("admin", "rep", seatId, on, false)'), "a rep's day opens the admin day");
}

export function runAdminTeamReportsTests() {
  gate();
  reach();
  tiles();
  adminPages();
}
