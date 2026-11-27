import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildCeoHealth,
  buildCeoTrends,
  ceoDeparturesLast30d,
  ceoDvManagerRows,
  ceoRoiSignalFromTrend,
  employeeManagerLinkageRate,
} from "../src/lib/ceo/command-center.ts";
import type { PublishedClosingSales } from "../src/lib/ceo/published-closing-sales.ts";
import { buildCoachingReportAnalytics } from "../src/lib/coaching/analytics.ts";
import type { CoachingReportSummaryRow } from "../src/lib/coaching/types.ts";
import {
  buildScopedDoubleVisitDashboardCore,
  doubleVisitAsOfDate,
  type DoubleVisitDbRow,
} from "../src/lib/double-visit-analytics/service.ts";
import type { DoubleVisitIdleManager, DoubleVisitManagerSummary } from "../src/lib/double-visit-analytics/types.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import type { FinanceCommittedMonth } from "../src/lib/finance/command-center.ts";
import { canonicalHrIdKey } from "../src/lib/hr-id.ts";
import { buildCompanyWorkforceAggregateMetrics, emptyPlatformMetrics } from "../src/lib/platform/metrics.ts";
import type { SalesMarketingRoiTrendPoint } from "../src/lib/sales-marketing-intelligence/types.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * THE SYSTEM ADMINISTRATOR OVERVIEW'S NUMBERS (owner, 27 Nov 2026: "check that every single number
 * in the landing page is accurate and correct and updated").
 *
 * Each block drives the function that produces one figure on /admin (the CEO command centre's
 * admin variant) and states the production reading that was wrong:
 *   - every approval number counts only the viewer's OWN turn;
 *   - the sales card, its top lines and regions, the region table, the achievement rate and the
 *     sales trend read the PUBLISHED Monthly Closing, never the raw upload book, and add no units
 *     across products;
 *   - leavers leave the coaching red zone and the double-visit table; "Last DV" is measured to today;
 *   - the trends are real series, headcount movement prints its figures, exits drop cancelled
 *     resignations and hires drop future start dates;
 *   - employee health is active over total structure, employee linkage is manager attachment;
 *   - the ROI tile never reads a future month.
 */

const read = (path: string) => stripComments(readFileSync(path, "utf8"));
const COMMAND_CENTER = "src/lib/ceo/command-center.ts";
const CEO_COMPONENT = "src/components/admin/ceo-command-center.tsx";
const PHASE_B = "src/components/admin/ceo-phase-b.tsx";

// ── Double visits: "Last DV" is measured to today ─────────────────────────────

function person(input: Partial<EmployeeDirectoryRow> & { hrId: string; jobTitle: string }): EmployeeDirectoryRow {
  return {
    areaName: "Giza 1",
    crmId: null,
    departmentName: null,
    displayName: input.fullName ?? input.hrId,
    employmentStatus: "active",
    fullName: input.fullName ?? input.hrId,
    lineId: 1,
    lineName: "Pedia",
    managerHrId: null,
    managerName: null,
    pendingManagerReplacementForHrId: null,
    positionTitle: input.jobTitle,
    regionName: null,
    ...input,
  } as EmployeeDirectoryRow;
}

const DV_EMPLOYEES: EmployeeDirectoryRow[] = [
  person({ hrId: "H-1", fullName: "Regional Head", jobTitle: "Regional Sales Manager" }),
  person({ hrId: "D-1", fullName: "District Lead", jobTitle: "District Sales Manager", managerHrId: "H-1" }),
  person({ hrId: "R-1", fullName: "Rep One", jobTitle: "Medical Representative", managerHrId: "D-1" }),
];

function dvRow(date: string, id: string): DoubleVisitDbRow {
  return {
    activity_date: date,
    area_name: "Giza 1",
    double_visitor_hr_id: "D-1",
    double_visitor_name: "District Lead",
    from_phoenix: true,
    id,
    line_name: "Pedia",
    period: "AM",
    source_record_id: `-${id}`,
    source_type: "ireports360",
    speciality: "Pediatrics",
    visit_count: 1,
    visit_type: 0,
    visit_type_description: "Regular",
    visited_employee_hr_id: "R-1",
    visited_employee_name: "Rep One",
    visited_employee_status: "active_mapped",
  };
}

export function runOverviewDoubleVisitAgeTests() {
  assert.equal(doubleVisitAsOfDate("2026-11-30", "2026-11-27"), "2026-11-27", "a range running past today is measured to today");
  assert.equal(doubleVisitAsOfDate("2026-10-31", "2026-11-27"), "2026-10-31", "a closed range keeps its own end");

  // The board's default range is the whole month, so dateTo is the month's last day.
  const core = buildScopedDoubleVisitDashboardCore({
    access: { hrId: "B-10", loginId: "B-10", role: "Super Admin", scope: "system", source: "session" } as never,
    dateTo: "2026-10-31",
    employees: DV_EMPLOYEES,
    rows: [dvRow("2026-10-06", "a"), dvRow("2026-10-07", "b")],
    today: "2026-10-08",
  });
  const district = core.managerSummaries.find((summary) => summary.managerHrId === canonicalHrIdKey("D-1"));
  assert.ok(district, "the district manager has a leaderboard row");
  assert.equal(
    district.daysSinceLastDv,
    1,
    "a double visit yesterday reads 1 day, never the 24 days to the month's last day (27 Nov 2026: every Last DV read 3 days too old)",
  );
}

// ── Double visits: a manager who left is not in the CEO table ─────────────────

export function runOverviewDoubleVisitLeaverTests() {
  const summary = (hrId: string, name: string) => ({
    managerHrId: hrId,
    managerName: name,
    role: "District Sales Manager",
    roleCode: "DSM",
    lineName: "CNS",
    distinctMrs: 3,
    overFocusedMrCount: 0,
    neglectedMrCount: 1,
    teamMrCount: 4,
    daysSinceLastDv: 2,
    coveragePct: 75,
  }) as unknown as DoubleVisitManagerSummary;
  const idle: DoubleVisitIdleManager = {
    areaName: null,
    hrId: "b-77",
    lineName: "CNS",
    name: "Left Idle",
    role: "District Sales Manager",
    roleCode: "DSM",
    teamMrCount: 3,
  };
  const rows = ceoDvManagerRows([summary("b-10", "Still Here"), summary("b-55", "Resigned Manager")], [idle], ["B-55", "B-77"]);
  assert.deepEqual(
    rows.map((row) => row.managerName),
    ["Still Here"],
    "a resigned manager leaves the CEO double-visit table, as a leaderboard row and as an idle manager, whatever the hr id's case",
  );
  assert.equal(ceoDvManagerRows([summary("b-55", "Resigned Manager")], []).length, 1, "with no leavers named, nobody is dropped");
}

// ── Coaching red zone: leavers are not in it ──────────────────────────────────

function coachingReport(hrId: string, zone: CoachingReportSummaryRow["performanceZone"], date: string): CoachingReportSummaryRow {
  return {
    coachingDate: date,
    createdAt: `${date}T08:00:00Z`,
    finalScorePercent: 40,
    medicalRepHrId: hrId,
    performanceZone: zone,
    status: "submitted",
  } as unknown as CoachingReportSummaryRow;
}

export function runOverviewCoachingLeaverTests() {
  const reports = [
    coachingReport("R-1", "red_zone", "2026-11-01"),
    coachingReport("R-2", "critical_red", "2026-11-02"),
    coachingReport("R-3", "yellow_zone", "2026-11-03"),
  ];
  assert.equal(buildCoachingReportAnalytics(reports).redZoneRepCount, 2, "two reps' latest report is red");
  const withLeavers = buildCoachingReportAnalytics(reports, { leaverRepHrIds: ["r-2"] });
  assert.equal(
    withLeavers.redZoneRepCount,
    1,
    "a rep who resigned is not in the red zone (27 Nov 2026: all 7 counted on the overview had resigned)",
  );
  assert.equal(withLeavers.zoneCounts.critical_red, 1, "the report distribution stays whole — only the people count drops leavers");

  const sources = read("src/lib/needs-you/sources.ts");
  assert.match(sources, /buildCoachingReportAnalytics\(reports, \{ leaverRepHrIds \}\)/, "the coaching adapter hands the leavers in");
  assert.match(sources, /!isActiveLifecycleStatus\(employee\.employmentStatus\)/, "a leaver is anyone whose lifecycle is not active");
}

// ── Trends: real series from the published closing and the salary batches ───

const PUBLISHED: PublishedClosingSales = {
  period: "2026-10",
  totalValue: 14_710_556.07,
  byLine: [{ name: "CNS", value: 8_000_000, share: 0.54 }],
  byRegion: [{ name: "Delta (1)", value: 3_000_000, share: 0.2 }],
  monthly: [
    { period: "2026-08", value: 13_000_000, target: 15_000_000 },
    { period: "2026-09", value: 14_000_000, target: 15_000_000 },
    { period: "2026-10", value: 14_710_556.07, target: 16_000_000 },
  ],
  achievement: { sales: 41_710_556.07, target: 46_000_000, rate: 0.9067, fromPeriod: "2026-07", toPeriod: "2026-10" },
};

const committed = (period: string, gross: number): FinanceCommittedMonth => ({ period, status: "locked", employees: 120, net: gross * 0.8, gross });

export function runOverviewTrendsTests() {
  const trends = buildCeoTrends({
    published: PUBLISHED,
    payrollMonths: [committed("2026-10", 2_867_619), committed("2026-12", 9), committed("2026-09", 2_276_461), committed("2026-08", 2_462_241)],
    hiresLast30d: 26,
    exitsLast30d: 12,
    todayCairo: "2026-11-27",
  });
  assert.deepEqual(
    trends.sales.map((point) => [point.label, point.sales, point.target]),
    [["2026-08", 13_000_000, 15_000_000], ["2026-09", 14_000_000, 15_000_000], ["2026-10", 14_710_556.07, 16_000_000]],
    "Monthly Sales is the published closing month by month, never one year-to-date point",
  );
  assert.deepEqual(
    trends.financial.map((point) => [point.label, point.cost]),
    [["2026-08", 2_462_241], ["2026-09", 2_276_461], ["2026-10", 2_867_619]],
    "Payroll cost is each closed salary batch's gross, oldest first, and a future month is never drawn",
  );
  assert.equal(trends.financial[2].revenue, 14_710_556.07, "revenue beside a payroll month is that month's published sales");
  assert.deepEqual(trends.hireExit, [{ label: "Last 30 days", hires: 26, exits: 12 }], "headcount movement names its window");
  assert.deepEqual(
    buildCeoTrends({ published: null, payrollMonths: [], hiresLast30d: 0, exitsLast30d: 0 }),
    { sales: [], financial: [], hireExit: [] },
    "nothing published and nothing paid is an empty series, never an invented point",
  );

  const phaseB = read(PHASE_B);
  assert.doesNotMatch(phaseB, /Latest \{trends\.(sales|financial)\.length\} periods/, "never \"Latest 1 periods\"");
  assert.match(phaseB, /count === 1 \? "month" : "months"/, "the period count is singular for one month");
}

// ── ROI tile: never a future month; total requests is the month's own count ──

const roiPoint = (period: string, requestCount: number, onTrack: number, behind: number, noData: number): SalesMarketingRoiTrendPoint => ({
  actualSalesValue: 0,
  behindCount: behind,
  coverageGap: 0,
  expectedRoiValue: 0,
  marketingCost: 0,
  noDataCount: noData,
  onTrackCount: onTrack,
  period,
  requestCount,
  requiredRoiValue: 0,
});

export function runOverviewRoiTests() {
  const signal = ceoRoiSignalFromTrend(
    [roiPoint("2026-09", 13, 0, 1, 2), roiPoint("2026-10", 11, 1, 1, 1), roiPoint("2026-11", 20, 0, 0, 0), roiPoint("2026-12", 1, 0, 0, 0)],
    "2026-11-27",
  );
  assert.equal(signal.lastPeriod, "2026-11", "a request raised for December does not make December the latest period");
  assert.equal(signal.requestCount, 20, "total requests is the month's own request count, not the three buckets added (0)");
  assert.deepEqual(signal.trend.map((point) => point.period), ["2026-09", "2026-10", "2026-11"], "the trend stops at the current month");
  assert.match(read(PHASE_B), /\{data\.requestCount\} total requests/, "the ROI tile prints requestCount");
}

// ── Headcount movement: exits, hires and printed figures ──────────────────────

export function runOverviewHeadcountTests() {
  const now = new Date("2026-11-27T10:00:00Z");
  const exits = ceoDeparturesLast30d(
    [
      { effectiveDate: "2026-11-20", status: "approved" },
      { effectiveDate: "2026-11-21", status: "cancelled" },
      { effectiveDate: "2026-11-22", status: "Rejected" },
      { effectiveDate: "2026-09-01", status: "approved" },
      { effectiveDate: "2026-12-15", status: "approved" },
    ],
    now,
  );
  assert.equal(exits, 1, "a cancelled or rejected resignation is nobody leaving (27 Nov 2026: 13 read, 12 real)");

  const source = read(COMMAND_CENTER);
  assert.match(
    source,
    /\.gte\("hire_date", addDaysIso\(today, -30\)\)\s*\.lte\("hire_date", today\)/,
    "hires stop at today: a start date next month is not a hire yet (27 Nov 2026: 31 read, 26 real)",
  );
  assert.match(
    read(CEO_COMPONENT),
    /\{row\.a\.toLocaleString\("en-US"\)\}[\s\S]{0,200}\{row\.b\.toLocaleString\("en-US"\)\}/,
    "the hires and exits bars print their figures",
  );
}

// ── Company health: real denominators, published achievement ──────────────────

export function runOverviewHealthTests() {
  const workforce = buildCompanyWorkforceAggregateMetrics({
    employees: [
      { areaName: "Cairo", employmentStatus: "active", fullName: "Alpha", hrId: "A-1", lineName: "Line 1", managerHrId: "AA" },
      { areaName: "Giza", employmentStatus: "on_leave", fullName: "Beta", hrId: "A-2", lineName: "Line 1", managerHrId: null },
    ],
    lookups: { workforceVacancies: [{ vacancyCode: "VAC-1" }, { vacancyCode: "VAC-2" }] },
  } as never);
  assert.equal(workforce.totalStructure, 4, "two people and two open seats");
  assert.equal(workforce.employeeHealthRate, 0.5, "employee health is active over TOTAL STRUCTURE, never active over active (100%)");
  assert.equal(employeeManagerLinkageRate(workforce), 0.5, "employee linkage is the share attached to a manager");
  assert.equal(employeeManagerLinkageRate(null), null, "no employees read is no rate");

  const metrics = { ...emptyPlatformMetrics(), workforce };
  const health = buildCeoHealth(metrics, 0.8, PUBLISHED);
  assert.equal(health.salesAchievementRate, 0.9067, "sales achievement is the published closing's");
  assert.equal(health.salesAchievementWindow, "2026-07 to 2026-10", "and it names the months it covers");
  assert.equal(health.employeeLinkageRate, 0.5, "the Employee linkage bar has its own figure");
  assert.equal(buildCeoHealth(metrics, 0.8, null).salesAchievementRate, null, "nothing published is unmeasured, never a number");

  const phaseB = read(PHASE_B);
  assert.match(phaseB, /label: "Employee linkage", value: health\.employeeLinkageRate/, "the bar prints employeeLinkageRate");
  assert.doesNotMatch(phaseB, /"Sales linkage rate"/, "the district-manager match is named for what it measures");
  assert.match(read(CEO_COMPONENT), /sub="Active \/ total structure"/, "the Employee health tile names its ratio");
}

// ── Approvals: only the viewer's own turn ──────────────────────────────────────

export function runOverviewApprovalsOwnTurnTests() {
  const source = read(COMMAND_CENTER);
  assert.match(source, /getVacationAwaitingBadge\(access\)/, "leave counts the viewer's turn through the sidebar badge's own read");
  assert.match(source, /getPlanAwaitingBadge\(access\)/, "weekly plans count the plans on the viewer's own step");
  assert.doesNotMatch(source, /pendingByStage\.total/, "the company's whole leave queue is never a fallback");
  assert.match(source, /const overdueLeaveSla = leaveBadge\?\.overdueCount \?\? 0;/, "the URGENT leave row is the viewer's overdue requests only");
  assert.match(
    source,
    /const probationDueSoon = canDecideProbation\(access\)\s*\?\s*sharedCount\("probation-decisions", "probation-decisions:due"\)\s*:\s*null;/,
    "probation decisions are shown only to a viewer who decides them",
  );
  assert.match(source, /label: "Overdue leave approvals waiting on you"/, "the leave row says whose queue it is");
}

// ── Sales card: the published closing, value only ──────────────────────────────

export function runOverviewSalesCardTests() {
  const component = read(CEO_COMPONENT);
  assert.match(component, /headline=\{publishedSales \? egp\(publishedSales\.totalValue\) : "—"\}/, "the headline is the published closing");
  assert.match(component, /movers=\{publishedTopLines\}/, "Top Lines read the published closing");
  assert.match(component, /movers=\{publishedTopRegions\}/, "Top Regions read the published closing");
  assert.doesNotMatch(component, /totalQty/, "no unit total on the card: units of different products are never added");

  const phaseB = read(PHASE_B);
  assert.match(phaseB, /byRegion=\{\(landing\.adminSignals\?\.publishedSales\?\.byRegion \?\? \[\]\)/, "the region table reads the published closing");

  const tables = read("src/components/admin/ceo-sos-tables.tsx");
  const regionTable = tables.slice(tables.indexOf("function RegionTable("), tables.indexOf("function ProductTable("));
  assert.doesNotMatch(regionTable, /totalQty|"Qty"/, "the region table and its export carry no Qty column");

  const source = read(COMMAND_CENTER);
  assert.match(source, /const publishedPromise = loadPublishedClosingSales\(access\);/, "the closing is read once per page");
  assert.match(source, /publishedSales: adminSignals\?\.publishedSales \?\? publishedSales,/, "and handed to the card");
}

// ── Labels that named the wrong thing ──────────────────────────────────────────

export function runOverviewLabelTests() {
  const component = read(CEO_COMPONENT);
  assert.match(component, /label="Staffed areas"/, "the Areas tile counts areas with an active employee");
  const dv = read("src/components/admin/ceo-dv-table.tsx");
  assert.match(dv, /label="Reps double-visited"/, "the MRs column is the reps double-visited, not the team");
  assert.doesNotMatch(dv, /label="MRs"/, "the bare MRs header is gone");
  const expense = read("src/components/admin/ceo-expense-tables.tsx");
  assert.match(expense, /title="Spend by Area"/, "outstation spend is grouped by area");
  assert.doesNotMatch(expense, /Spend by Region/, "never called by region");
}
