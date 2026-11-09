import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { accountDoctorDepth, doctorMentionsIn, familyOfWord } from "../src/lib/crm/account-doctor-notes.ts";
import { weeklySheetResult, weeklySheetTargets, weeklySheetWindow } from "../src/lib/crm/weekly-sheet.ts";
import { previousMonthKey, regionalTeamReportLinks } from "../src/lib/employee-portal/regional-team-reports.ts";
import { resolveRegionRouteScope, territoryRouteAdmitsRequest } from "../src/lib/marketing-requests/roi-report-scope.ts";
import { readsRegionalTeamReports, regionalTeamRepSeats, type PhoenixCrmViewer } from "../src/lib/phoenix-crm/server/access.ts";
import { chainVisitLine, otherManagersOnRepDay, type RepDayBooking } from "../src/lib/phoenix-crm/server/manager-plan-bookings.ts";
import { foldTeamVisitDay } from "../src/lib/phoenix-crm/server/team-visits.ts";
import { joinedLabel, managersWithoutPublishedMonth } from "../src/lib/employee-portal/unranked-managers.ts";
import { groupByRegionAndManager, regionGroupCaption, regionManagerTitle } from "../src/lib/phoenix-crm/region-manager-groups.ts";
import type { OrgSeat } from "../src/lib/phoenix-crm/scope.ts";

/**
 * Dr. Hany Saad's team reports (owner, 2026-11-08) — the Regional Sales Manager's eight needs. Names in the
 * comment shapes are invented; the shapes are the ones the reps really write.
 */

function viewerWith(tiers: string[], repSeats: Array<{ seatId: string; tier: string }> = []): PhoenixCrmViewer {
  return {
    isSfeManager: false,
    isSuperAdmin: false,
    managerSeats: tiers.map((tier, index) => ({ seatId: `M${index}`, tier })),
    ownTerritories: [],
    scopeTerritories: repSeats,
  } as unknown as PhoenixCrmViewer;
}

function gate() {
  // Only the Regional Sales Manager's seat opens the team reports.
  assert.equal(readsRegionalTeamReports(viewerWith(["RSM"])), true);
  for (const tier of ["DM", "ACTING_DM", "NSM", "REP", "PM", "TM"]) {
    assert.equal(readsRegionalTeamReports(viewerWith([tier])), false, `${tier} must not open the regional team reports`);
  }
  assert.equal(readsRegionalTeamReports(viewerWith([])), false, "no seat at all (the CEO's login) is refused");
  // His reach is the REP seats under him; a district manager's seat is not a rep row, and a DM viewer reads none.
  const reps = [
    { seatId: "R1", tier: "REP" },
    { seatId: "D1", tier: "DM" },
  ];
  assert.deepEqual(
    regionalTeamRepSeats(viewerWith(["RSM"], reps)).map((seat) => seat.seatId),
    ["R1"],
  );
  assert.deepEqual(regionalTeamRepSeats(viewerWith(["DM"], reps)), []);
}

function visitsYesterdayAndToday() {
  const row = (over: Record<string, unknown>) => ({
    captured_at: "2026-11-08T07:42:00Z",
    customer_validated: true,
    id: String(Math.random()),
    imported_from_ireports360_at: null,
    list_type: "PM",
    pharmacy_name: null,
    seat_id: "R1",
    visit_date: "2026-11-08",
    ...over,
  });
  const day = foldTeamVisitDay([
    row({ list_type: "AM" }),
    row({ captured_at: "2026-11-08T06:10:00Z" }),
    row({ list_type: "Pharmacy", pharmacy_name: "Pharmacy Nour" }),
    row({ list_type: "Pharmacy", pharmacy_name: "Pharmacy Nour" }),
    row({ customer_validated: false }),
    row({ imported_from_ireports360_at: "2026-11-08T10:00:00Z" }),
  ]);
  // AM · PM · Pharmacies apart; the unvalidated visit is waiting, never in a figure.
  assert.equal(day.am, 1);
  assert.equal(day.pm, 2, "the copied visit still counts — only its time is unknown");
  assert.equal(day.pharmacies, 1, "one pharmacy twice in a day is one pharmacy");
  assert.equal(day.waiting, 1);
  // Every visit's Saved-at time, Cairo, 12-hour, earliest first; a copied visit has none.
  assert.equal(day.times.length, 6);
  assert.equal(day.times[0].savedAt, "08:10 AM");
  assert.equal(day.times.filter((time) => time.savedAt === null).length, 1);
  // No location column is read by the report.
  const source = readFileSync("src/lib/phoenix-crm/server/team-visits.ts", "utf8");
  const select = /\.select\("([^"]+)"\)/.exec(source)?.[1] ?? "";
  assert.ok(select.includes("captured_at"));
  for (const banned of ["lat", "lon", "distance", "location", "far"]) {
    assert.ok(!select.split(/,\s*/).some((column) => column.includes(banned)), `team visits must not read ${banned}`);
  }
}

function chainVisits() {
  const bookings: RepDayBooking[] = [
    { date: "2026-11-10", half: "AM", managerHrId: "DM-1", plannerKind: "dm", repSeatId: "R1" },
    { date: "2026-11-10", half: "PM", managerHrId: "PM-7", plannerKind: "pm", repSeatId: "R1" },
    { date: "2026-11-10", half: "PM", managerHrId: "PM-7", plannerKind: "pm", repSeatId: "R1" },
    { date: "2026-11-11", half: "AM", managerHrId: "TM-2", plannerKind: "tm", repSeatId: "R1" },
    { date: "2026-11-10", half: "AM", managerHrId: "TM-2", plannerKind: "tm", repSeatId: "R2" },
  ];
  // The other managers with this rep this day — each once, never the manager asked about.
  assert.deepEqual(
    otherManagersOnRepDay(bookings, "R1", "2026-11-10", "DM-1").map((booking) => booking.managerHrId),
    ["PM-7"],
  );
  assert.deepEqual(otherManagersOnRepDay(bookings, "R1", "2026-11-12", "DM-1"), []);
  // Neutral words — a chain visit, never a warning or a clash.
  const line = chainVisitLine({ name: "Sara Adel", title: "Product manager" }, "Ahmed Ali");
  assert.equal(line, "Chain visit — Sara Adel (Product manager) is also with Ahmed Ali this day");
  assert.ok(!/clash|conflict|warning|double/i.test(line));
}

function commentDoctors() {
  assert.equal(familyOfWord("الباطنة"), "internal");
  assert.equal(familyOfWord("GP"), "internal");
  assert.equal(familyOfWord("اطفال"), "pediatrics");
  assert.equal(familyOfWord("ENT"), "ent");
  assert.equal(familyOfWord("جراحة"), "other");
  // A heading carries down to the doctors under it.
  assert.deepEqual(doctorMentionsIn("عياده الباطنه\nد. احمد سامي\nد. محمد فريد ود. هاني"), [
    { family: "internal", name: "احمد سامي" },
    { family: "internal", name: "محمد فريد" },
    { family: "internal", name: "هاني" },
  ]);
  // Two doctors sharing the speciality written after them; a doctor with his speciality on one line.
  assert.deepEqual(doctorMentionsIn("د امل د سلمي اطفال"), [
    { family: "pediatrics", name: "امل" },
    { family: "pediatrics", name: "سلمي" },
  ]);
  assert.deepEqual(doctorMentionsIn("د وائل Im . د وهيب ped . د البير Ent"), [
    { family: "internal", name: "وائل" },
    { family: "pediatrics", name: "وهيب" },
    { family: "ent", name: "البير" },
  ]);
  // "ولد" (a boy) is never a doctor, "drug" is never "dr", and a verb is never part of a name.
  assert.deepEqual(doctorMentionsIn("ولد صغير"), []);
  assert.deepEqual(doctorMentionsIn("the drug was discussed"), []);
  assert.deepEqual(doctorMentionsIn("لدكتوره دعاء هتكتب"), [{ family: null, name: "دعاء" }]);

  // An account's week: distinct doctors per column, a short name folded into the full one, 3 of each = met.
  const depth = accountDoctorDepth([
    "عياده الاطفال\nد امل فتحي\nد سلمي\nد نهي",
    "د امل اطفال",
    "عياده الباطنه\nد كريم\nد سامح\nد فادي",
    "د رامي ent د شادي ent د هادي ent",
  ]);
  assert.deepEqual(
    { ent: depth.ent, internal: depth.internal, met: depth.met, pediatrics: depth.pediatrics },
    { ent: 3, internal: 3, met: true, pediatrics: 3 },
  );
  const thin = accountDoctorDepth(["د كريم باطنه", "زياره ممتازه"]);
  assert.equal(thin.met, false);
  assert.equal(thin.noDoctorsWritten, false);
  const none = accountDoctorDepth(["زياره ممتازه", null]);
  assert.equal(none.noDoctorsWritten, true, "a comment naming no doctor says so — never a zero");
}

function weeklySheet() {
  // 10 PM and 2 AM per working day: a full Saturday-to-Wednesday week is exactly 50 and 10.
  assert.deepEqual(weeklySheetTargets(5), { am: 10, pm: 50 });
  assert.deepEqual(weeklySheetTargets(4), { am: 8, pm: 40 }, "a day of leave or a holiday comes out of the target");
  assert.deepEqual(weeklySheetTargets(0), { am: 0, pm: 0 });
  const window = weeklySheetWindow("2026-11-08", "2026-11-03");
  assert.equal(window.from, "2026-10-31", "the week opens on the Saturday");
  assert.equal(window.to, "2026-11-04", "and closes on the Wednesday");
  // A vacant seat has no rep to measure: never "Below" against a target nobody holds.
  assert.equal(weeklySheetResult(0, 50, true), "Seat is vacant");
  assert.equal(weeklySheetResult(27, 40, false), "Below");
  assert.equal(weeklySheetResult(50, 50, false), "Met");
}

function roiRegionRoute() {
  const row = (hrId: string, areaId: number | null, lineName: string, employmentStatus = "active") =>
    ({ areaId, employmentStatus, hrId, lineName }) as never;
  const rows = [row("PD-0001", 99, "Pedia"), row("R-1", 11, "Pedia"), row("R-2", 12, "Pedia"), row("R-3", 13, "Pedia", "terminated"), row("X-9", 14, "CNS")];
  const visible = new Set(["r-1", "r-2", "r-3"]); // normalized, as the requester walk hands them over
  const scope = resolveRegionRouteScope({ role: "Regional Manager" }, rows, "pd-0001", visible);
  // His team's areas (active people only, never his own seat, never someone outside his chain) and his own line.
  assert.deepEqual([...scope.areaIds].sort(), [11, 12]);
  assert.deepEqual([...scope.lineNames], ["pedia"]);
  const route = { visibleAreaIds: scope.areaIds, visibleAreaLineNames: scope.lineNames };
  // BOTH halves: his area AND his line. Another line's request on his area stays out.
  assert.equal(territoryRouteAdmitsRequest(route, 11, ["Pedia"]), true);
  assert.equal(territoryRouteAdmitsRequest(route, 11, ["CNS"]), false);
  assert.equal(territoryRouteAdmitsRequest(route, 14, ["Pedia"]), false);
  // No line known for him → the route admits nothing; every other role gets nothing.
  const lineless = resolveRegionRouteScope({ role: "Regional Manager" }, [row("PD-0001", 99, ""), row("R-1", 11, "Pedia")], "pd-0001", visible);
  assert.equal(lineless.areaIds.size, 0);
  assert.equal(resolveRegionRouteScope({ role: "District Manager" }, rows, "pd-0001", visible).areaIds.size, 0);
}

function landingShortcuts() {
  assert.equal(previousMonthKey("2026-11-08"), "2026-10");
  assert.equal(previousMonthKey("2026-01-15"), "2025-12");
  const links = regionalTeamReportLinks("2026-11-08");
  // One shortcut per report, in Dr. Hany's order, in the words Phoenix already uses.
  assert.deepEqual(
    links.map((link) => link.label),
    [
      "Reps weekly plans",
      "Visits — Yesterday and Today",
      "Coverage",
      "Coverage · Last month",
      "Frequency · Last month",
      "District Managers' Plans",
      "Plan your week in Phoenix CRM",
      "Weekly Sheet",
      "ROI Tracking",
    ],
  );
  assert.equal(links.find((link) => link.key === "coverage-last-month")?.href, "/employee-portals/kpis/coverage?month=2026-10");
  // Need 6 is his own plan board in Phoenix CRM, never the read-only Weekly / Monthly Plans history.
  assert.equal(links.find((link) => link.key === "region-plans")?.href, "/employee-portals/field-crm?tab=plan");
  // Every shortcut opens a page that exists.
  for (const link of links) {
    const path = link.href.split("?")[0].replace("/employee-portals", "app/employee-portals");
    assert.ok(readFileSync(`${path}/page.tsx`, "utf8").length > 0, `${link.label} must open a page`);
  }
  // The landing page draws them.
  const landing = readFileSync("src/components/employee-portal/dashboards/rm-command-center.tsx", "utf8");
  assert.ok(landing.includes('title="My Team\'s Reports"'));
  assert.ok(landing.includes("regionalTeamReportLinks("));
  // The older Dashboards row's "Region Plans" opens the same board, never the read-only plan history.
  assert.ok(landing.includes("{ href: RSM_PLAN_BOARD_HREF, icon: CalendarDays, label: \"Region Plans\" }"));
  assert.ok(!landing.includes('href: "/employee-portals/plans"'), "no tile on his landing opens the read-only plan history");
}

function districtsWithoutPublishedMonth() {
  // A district manager who joined after the published window (Sahar El Gallad, 24 Oct 2026, against Jul–Sep)
  // is listed on "My Districts" unranked, with when she joined — never left off, never a 0%.
  const unranked = managersWithoutPublishedMonth({
    hireDates: new Map([["PD-0028", "2026-10-24"], ["B-154", "2026-02-01"]]),
    ranked: [{ hrId: "b-154" }, { hrId: "PD-0012" }],
    roster: [
      { hrId: "B-154", name: "Nermeen Salah" },
      { hrId: "PD-0012", name: "Mohamed Eleiwa" },
      { hrId: "PD-0028", name: "Sahar El Gallad" },
      { hrId: "pd-0028", name: "Sahar El Gallad" },
    ],
  });
  assert.deepEqual(unranked, [{ hrId: "PD-0028", name: "Sahar El Gallad", note: "Joined 24 Oct 2026" }], "only the unranked, once, whatever the letter case");
  assert.equal(joinedLabel("2026-10-24"), "24 Oct 2026");
  assert.equal(joinedLabel(null), null, "a missing date is never guessed");
  const board = readFileSync("src/components/employee-portal/dashboards/rm-command-center.tsx", "utf8");
  assert.ok(board.includes("unranked={rmRegional?.dsmsWithoutPublishedMonth ?? []}"), "his My Districts board draws them");
}

function seat(seatId: string, regionName: string | null, parentSeatId: string | null, occupantHrId: string | null): OrgSeat {
  return { areaName: null, lineCode: "PED", lineName: "Pedia", occupantHrId, parentSeatId, path: [], regionName, seatId, seatLabel: null, tier: parentSeatId ? "REP" : "DM" };
}

function groupedByRegionAndManager() {
  // Owner, 2026-11-09: "in every screen u build for Hany group reps by their manager and region".
  const dmD2 = seat("DM-D2", "Delta (2)", null, "PD-0028");
  const dmAb = seat("DM-AB", "Alex-BHR", null, "PD-0012");
  const districts = new Map([["DM-D2", dmD2], ["DM-AB", dmAb]]);
  const reps = [
    seat("REP-D21", "Delta (2)", "DM-D2", "PD-0034"),
    seat("REP-AB1", "Alex-BHR", "DM-AB", "PD-0035"),
    seat("REP-D22", "Delta (2)", "DM-D2", null),
    // Two reps with no district manager above them, in two regions: two groups, never one heap.
    seat("REP-X1", "Delta (1)", null, "B-100"),
    seat("REP-X2", null, null, "B-91"),
  ];
  const groups = groupByRegionAndManager(reps, (rep) => rep, (rep) => districts.get(rep.parentSeatId ?? "") ?? null);
  assert.deepEqual(
    groups.map((group) => [group.regionName, group.district?.seatId ?? null, group.items.map((rep) => rep.seatId)]),
    [
      ["Alex-BHR", "DM-AB", ["REP-AB1"]],
      ["Delta (1)", null, ["REP-X1"]],
      ["Delta (2)", "DM-D2", ["REP-D21", "REP-D22"]],
      ["No region", null, ["REP-X2"]],
    ],
    "region order, one group per region and district manager, an unknown region last",
  );
  assert.equal(regionManagerTitle("Delta (2)", "Sahar El Gallad"), "Delta (2) · Sahar El Gallad");
  assert.equal(regionGroupCaption(6, 3), "Region and district manager · 3 reps · 3 vacant seats");
  assert.equal(regionGroupCaption(2, 1), "Region and district manager · 1 rep · 1 vacant seat");
  assert.equal(regionGroupCaption(5, 0), "Region and district manager · 5 reps");
  for (const view of ["team-visits-view", "weekly-sheet-view", "district-manager-plans-view"]) {
    const source = readFileSync(`src/components/crm/regional/${view}.tsx`, "utf8");
    assert.ok(source.includes("title={regionManagerTitle("), `${view} heads each group with its region and manager`);
  }
  const workbook = readFileSync("src/lib/crm/weekly-sheet-workbook.ts", "utf8");
  assert.equal(workbook.match(/\{ label: "Region", width: 14 \}/g)?.length, 2, "both export sheets carry the region column");
}

function vacantSeatsKeyCard() {
  // Owner, 2026-11-09: "also a key card for vacants number" — on the Reps Weekly Plans tiles, counted by the
  // Vacant Areas tab's own pipeline and opening that tab.
  const board = readFileSync("src/components/crm/reps-weekly-plans-board.tsx", "utf8");
  assert.ok(board.includes('label="Vacant seats"'), "the fifth key card");
  assert.ok(board.includes("href={hrefToVacant(basePath, board)}"), "it opens Vacant Areas under the same filters");
  assert.ok(board.includes('vacantSeats == null ? "–"'), "a failed read is a dash and a sentence, never a 0");
  for (const page of ["app/employee-portals/reps-list/page.tsx", "app/(admin)/admin/reps-list/page.tsx"]) {
    const source = readFileSync(page, "utf8");
    assert.ok(source.includes("vacantSeats = await countVacantAreas("), `${page} counts the vacancies`);
    assert.ok(source.includes("vacantSeats={vacantSeats}"), `${page} hands the count to the board`);
  }
  const vacant = readFileSync("src/lib/crm/reps-list-vacant-areas.ts", "utf8");
  const counter = vacant.slice(vacant.indexOf("export async function countVacantAreas"), vacant.indexOf("export async function getVacantAreasBoard"));
  assert.ok(counter.includes("foldVacancyCells(vacanciesMatching(") && counter.includes("pruneLineFirst(") && counter.includes("allowedHrIdsFor(input.scope)"), "the same restrict, prune, match and fold as the tab");
}

function backToAllReps() {
  // Owner, 2026-11-09: "when I press a rep there is no back button to go back to all reps".
  for (const board of ["src/components/crm/reps-list-board.tsx", "src/components/crm/reps-weekly-plans-board.tsx"]) {
    const source = readFileSync(board, "utf8");
    assert.ok(source.includes("{selected ? <BackToAllReps href={hrefWithRep(basePath, board, null)} /> : null}"), `${board} opens a rep with the back bar first`);
  }
  const day = readFileSync("app/employee-portals/field-crm/day/[seatId]/[date]/page.tsx", "utf8");
  assert.ok(day.includes('const BACK_TO: Record<string, string> = { "team-visits": "/employee-portals/team-visits" };'), "the day page goes back by a fixed key, never a free address");
  assert.ok(day.includes("<BackToAllReps href={BACK_TO[query.from]} />"), "the day page draws the back bar");
  const visits = readFileSync("src/components/crm/regional/team-visits-view.tsx", "utf8");
  assert.ok(visits.includes("?from=team-visits`"), "Visits opens the day with its way back");
}

function teamReportsReadTheRealWorld() {
  // Owner, 2026-11-09: Hany's test login reads the real Phoenix CRM rows on his team reports ("Read the real data live").
  const access = readFileSync("src/lib/phoenix-crm/server/access.ts", "utf8");
  assert.ok(access.includes("export const REGIONAL_TEAM_REPORTS_READ_TEST_ROWS = false;"), "the regional team reports read the real world");
  for (const path of ["src/lib/phoenix-crm/server/team-visits.ts", "src/lib/crm/weekly-sheet.ts", "src/lib/phoenix-crm/server/manager-plan-bookings.ts"]) {
    const source = readFileSync(path, "utf8");
    assert.ok(!source.includes("viewer.isTestPersona"), `${path} must not read the test world for a test login`);
    assert.ok(!source.includes("isTest: input.isTest, repSeatIds"), `${path}: other managers' bookings are the real world's`);
    assert.ok(source.includes("isTest = REGIONAL_TEAM_REPORTS_READ_TEST_ROWS") || source.includes("isTest: REGIONAL_TEAM_REPORTS_READ_TEST_ROWS"), `${path} reads with the real-world switch`);
  }
  const board = readFileSync("src/lib/phoenix-crm/server/manager-plans.ts", "utf8");
  assert.ok(board.includes('const dmWeeksIsTest = writer.kind === "rsm" ? REGIONAL_TEAM_REPORTS_READ_TEST_ROWS : isTest;'), "his board reads the district managers' real weeks");
}

export function runRegionalTeamReportsTests() {
  teamReportsReadTheRealWorld();
  backToAllReps();
  groupedByRegionAndManager();
  vacantSeatsKeyCard();
  districtsWithoutPublishedMonth();
  gate();
  visitsYesterdayAndToday();
  chainVisits();
  commentDoctors();
  weeklySheet();
  roiRegionRoute();
  landingShortcuts();
}
