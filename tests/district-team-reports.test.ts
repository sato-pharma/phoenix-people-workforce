import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { districtTeamReportLinks, regionalTeamReportLinks } from "../src/lib/employee-portal/regional-team-reports.ts";
import { resolveRegionRouteScope, territoryRouteAdmitsRequest } from "../src/lib/marketing-requests/roi-report-scope.ts";
import {
  readsDistrictTeamReports,
  readsRegionalTeamReports,
  readsRegionOrDistrictReports,
  teamReportRepSeats,
  type PhoenixCrmViewer,
} from "../src/lib/phoenix-crm/server/access.ts";
import { regionalDistrictSeats } from "../src/lib/phoenix-crm/server/manager-plan-bookings.ts";

/**
 * Dr. Hany Saad's shortcuts, built for every District Manager over their own district (owner, 2026-11-09: "all
 * shortcuts we built for Hany, build it for all district managers, but every one based on his scope"). The gate,
 * the reach, the district seats, the ROI area route, the tiles on the District Manager's overview, and the one thing
 * that must NOT widen — the plan board's Regional Sales Manager extras. Account: docs/regional-team-reports.md.
 */

type SeatShape = { seatId: string; tier: string; isOtherPseudoDm?: boolean; path?: string[]; areaName?: string };

function viewer(managerSeats: SeatShape[], scope: SeatShape[] = [], own: SeatShape[] = []): PhoenixCrmViewer {
  return {
    isSfeManager: false,
    isSuperAdmin: false,
    managerSeats,
    ownTerritories: own,
    scopeTerritories: scope,
  } as unknown as PhoenixCrmViewer;
}

function gate() {
  // A District Manager seat and an acting one read their own team's reports; the line's "Others" pseudo seat does not.
  assert.equal(readsDistrictTeamReports(viewer([{ seatId: "D1", tier: "DM" }])), true);
  assert.equal(readsDistrictTeamReports(viewer([{ seatId: "D1", tier: "ACTING_DM" }])), true);
  assert.equal(readsDistrictTeamReports(viewer([{ isOtherPseudoDm: true, seatId: "D9", tier: "DM" }])), false, "the line's Others seat is not a team");
  for (const tier of ["RSM", "NSM", "REP", "PM", "TM"]) {
    assert.equal(readsDistrictTeamReports(viewer([{ seatId: "S", tier }])), false, `${tier} is not a district seat`);
  }
  // The reports' gate admits either tier, and nobody else.
  assert.equal(readsRegionOrDistrictReports(viewer([{ seatId: "R", tier: "RSM" }])), true);
  assert.equal(readsRegionOrDistrictReports(viewer([{ seatId: "D", tier: "DM" }])), true);
  assert.equal(readsRegionOrDistrictReports(viewer([{ seatId: "D", tier: "ACTING_DM" }])), true);
  for (const tier of ["NSM", "REP", "PM", "TM"]) {
    assert.equal(readsRegionOrDistrictReports(viewer([{ seatId: "S", tier }])), false, `${tier} must not open the team reports`);
  }
  assert.equal(readsRegionOrDistrictReports(viewer([])), false, "no seat at all (the CEO's login) is refused");
  // 🔴 The regional predicate is NOT widened: the plan board's "Also with" half-notes key on it.
  assert.equal(readsRegionalTeamReports(viewer([{ seatId: "D", tier: "DM" }])), false);
  const hub = readFileSync("src/lib/phoenix-crm/server/manager-plan-hub.ts", "utf8");
  assert.ok(hub.includes('plan.plannerKind === "dm" && readsRegionalTeamReports(viewer)'), "the plan board's RSM extras keep the RSM gate");
}

function reach() {
  // The District Manager's reach is their own scope's rep seats — never a manager seat, never a blind seat.
  const scope = [
    { seatId: "R1", tier: "REP" },
    { seatId: "R2", tier: "REP" },
    { seatId: "D1", tier: "DM" },
  ];
  assert.deepEqual(teamReportRepSeats(viewer([{ seatId: "D1", tier: "DM" }], scope)).map((seat) => seat.seatId), ["R1", "R2"]);
  // An acting District Manager's own rep seat is location-blind to them, so it is left out of their own report.
  assert.deepEqual(
    teamReportRepSeats(viewer([{ seatId: "D1", tier: "ACTING_DM" }], scope, [{ seatId: "R2", tier: "REP" }])).map((seat) => seat.seatId),
    ["R1"],
  );
  assert.deepEqual(teamReportRepSeats(viewer([{ seatId: "N1", tier: "NSM" }], scope)), [], "no gate, no reps");
  assert.deepEqual(teamReportRepSeats(viewer([{ seatId: "RS1", tier: "RSM" }], scope)).map((seat) => seat.seatId), ["R1", "R2"], "the RSM keeps the region");
}

function districtSeats() {
  // Two regions, two district seats under the first, one under the second, and the line's Others pseudo seat.
  const seats: SeatShape[] = [
    { areaName: "North", path: ["RS1"], seatId: "RS1", tier: "RSM" },
    { areaName: "Cairo East", path: ["RS1", "D1"], seatId: "D1", tier: "DM" },
    { areaName: "Cairo West", path: ["RS1", "D2"], seatId: "D2", tier: "ACTING_DM" },
    { areaName: "Others", isOtherPseudoDm: true, path: ["RS1", "D9"], seatId: "D9", tier: "DM" },
    { areaName: "Assiut", path: ["RS2", "D3"], seatId: "D3", tier: "DM" },
  ];
  const org = { seats: new Map(seats.map((seat) => [seat.seatId, seat])) };
  const ids = (managerSeats: SeatShape[]) =>
    regionalDistrictSeats({ managerSeats, org } as unknown as Pick<PhoenixCrmViewer, "org" | "managerSeats">).map((seat) => seat.seatId);
  assert.deepEqual(ids([seats[0]]), ["D1", "D2"], "the RSM: every district seat under the region, never Others");
  assert.deepEqual(ids([seats[1]]), ["D1"], "a District Manager: their own seat only");
  assert.deepEqual(ids([seats[4]]), ["D3"], "another region's District Manager: their own seat, never a neighbour's");
  assert.deepEqual(ids([seats[3]]), [], "the Others pseudo seat is never listed");
  assert.deepEqual(ids([{ path: ["N"], seatId: "N", tier: "NSM" }]), []);
}

function roiAreaRoute() {
  const row = (hrId: string, areaId: number | null, lineName: string, employmentStatus = "active") =>
    ({ areaId, employmentStatus, hrId, lineName }) as never;
  const rows = [row("DM-0001", 99, "CNS"), row("R-1", 21, "CNS"), row("R-2", 22, "CNS"), row("R-3", 23, "CNS", "terminated"), row("X-9", 24, "Pedia")];
  const chain = new Set(["r-1", "r-2", "r-3"]);
  const scope = resolveRegionRouteScope({ role: "District Manager" }, rows, "dm-0001", chain);
  // Their reps' areas (active people only, never their own seat, never outside their chain) and their own line.
  assert.deepEqual([...scope.areaIds].sort(), [21, 22]);
  assert.deepEqual([...scope.lineNames], ["cns"]);
  const route = { visibleAreaIds: scope.areaIds, visibleAreaLineNames: scope.lineNames };
  assert.equal(territoryRouteAdmitsRequest(route, 21, ["CNS"]), true);
  assert.equal(territoryRouteAdmitsRequest(route, 21, ["Pedia"]), false, "another line's request on their area stays out");
  assert.equal(territoryRouteAdmitsRequest(route, 24, ["CNS"]), false, "an area outside the district stays out");
  // Still BOTH halves or neither: no line known for them admits nothing.
  const lineless = resolveRegionRouteScope({ role: "District Manager" }, [row("DM-0001", 99, ""), row("R-1", 21, "CNS")], "dm-0001", chain);
  assert.equal(lineless.areaIds.size, 0);
  assert.equal(resolveRegionRouteScope({ role: "Medical Rep" }, rows, "dm-0001", chain).areaIds.size, 0, "a rep keeps their own route");
}

function homeShortcuts() {
  const regional = regionalTeamReportLinks("2026-11-09");
  const district = districtTeamReportLinks("2026-11-09");
  // Every one of Dr. Hany's shortcuts, in his order, opening the same page; only one label differs.
  assert.deepEqual(district.map((link) => link.href), regional.map((link) => link.href));
  assert.deepEqual(district.map((link) => link.key), regional.map((link) => link.key));
  assert.deepEqual(
    district.map((link) => link.label),
    [
      "Reps weekly plans",
      "Visits — Yesterday and Today",
      "Coverage",
      "Coverage · Last month",
      "Frequency · Last month",
      "My Plans",
      "Plan your week in Phoenix CRM",
      "Weekly Sheet",
      "ROI Tracking",
    ],
  );
  assert.equal(district.find((link) => link.key === "frequency-last-month")?.href, "/employee-portals/kpis/frequency?month=2026-10");

  // The District Manager's overview draws them, and the two sales dashboards from the Regional Sales Manager's row.
  const home = readFileSync("src/components/employee-portal/dashboards/dsm-command-center.tsx", "utf8");
  assert.ok(home.includes("<DashboardsGrid items={teamReportTiles(cairoTodayIso())} title=\"My Team's Reports\" />"));
  assert.ok(home.includes("districtTeamReportLinks(today)"), "the district list, never the regional one");
  assert.ok(home.includes('{ href: "/employee-portals/source-of-sales", icon: TrendingUp, label: "Source of Sales" }'));
  assert.ok(home.includes('{ href: "/employee-portals/territory-drilldown", icon: MapIcon, label: "Sales Drilldown" }'));
  assert.ok(home.includes('{ href: "/employee-portals/expense-dashboard", icon: ReceiptText, label: "My Expenses" }'), "the existing tiles stay");
  assert.ok(!home.includes('href: "/employee-portals/plans"'), "no tile opens the read-only plan history");
}

function pagesAndExports() {
  for (const name of ["team-visits", "district-manager-plans", "weekly-sheet"]) {
    const page = readFileSync(`app/employee-portals/${name}/page.tsx`, "utf8");
    assert.ok(page.includes('if (!viewer || !readsRegionOrDistrictReports(viewer)) redirect("/employee-portals");'), `${name}: the page asks the team-report gate`);
    const route = readFileSync(`app/api/crm/${name}/export/route.ts`, "utf8");
    const gateAt = route.indexOf("if (!viewer || !readsRegionOrDistrictReports(viewer))");
    assert.ok(gateAt > 0, `${name}: the export asks the team-report gate`);
    assert.ok(!route.includes("readsRegionalTeamReports"), `${name}: the export is not left on the RSM-only gate`);
    assert.ok(route.includes("is for a Regional Sales Manager or a District Manager."), `${name}: the 403 names who opens it`);
  }
  for (const loader of ["src/lib/phoenix-crm/server/team-visits.ts", "src/lib/crm/weekly-sheet.ts", "src/lib/phoenix-crm/server/manager-plan-bookings.ts"]) {
    const source = readFileSync(loader, "utf8");
    assert.ok(source.includes("if (!readsRegionOrDistrictReports(viewer)) throw forbiddenError("), `${loader}: the loader asks the gate again`);
    assert.ok(source.includes("teamReportRepSeats(viewer)"), `${loader}: the reps are the viewer's own scope`);
    assert.ok(!source.includes("regionalTeamRepSeats("), `${loader}: never the RSM-only reach`);
  }
  // The wording follows the viewer: a District Manager reads "your district" and "My Plans".
  const visits = readFileSync("app/employee-portals/team-visits/page.tsx", "utf8");
  assert.ok(visits.includes('readsRegionalTeamReports(viewer) ? "Every rep under your district managers" : "Every rep in your district"'));
  const plans = readFileSync("app/employee-portals/district-manager-plans/page.tsx", "utf8");
  assert.ok(plans.includes('title={regional ? "District Managers\' Plans" : "My Plans"}'));
}

export function runDistrictTeamReportsTests() {
  gate();
  reach();
  districtSeats();
  roiAreaRoute();
  homeShortcuts();
  pagesAndExports();
}
