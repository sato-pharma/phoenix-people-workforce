import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";
import {
  buildCoachingReportAnalytics,
  buildCoachingScoreAnalytics,
  buildTrainingManagerCoachingComparison,
  completedReportStatuses,
  filterCoachingQuarterlySummaryByReports,
  type CoachingScoreAnalyticsInputRow,
} from "../src/lib/coaching/analytics.ts";
import {
  coachingParameterLabels,
  coachingScoreItems,
  type CoachingParameterKey,
} from "../src/lib/coaching/constants.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import type { CoachingQuarterlySummaryRow, CoachingReportSummaryRow } from "../src/lib/coaching/types.ts";

function rowsForReport(
  reportId: string,
  scoresByCategory: Record<CoachingParameterKey, number>,
): CoachingScoreAnalyticsInputRow[] {
  return coachingScoreItems.map((item) => ({
    parameter_category: item.category,
    report_id: reportId,
    score: scoresByCategory[item.category],
    score_item_key: item.key,
    score_item_label: item.label,
  }));
}

function report(overrides: Partial<CoachingReportSummaryRow>): CoachingReportSummaryRow {
  return {
    acknowledged: false,
    acknowledgedAt: null,
    actualScore: 0,
    areaId: null,
    areaName: null,
    coachHrId: "COACH-1",
    coachName: "Coach",
    coachingDate: "2026-05-01",
    coachingMonth: 5,
    coachingQuarter: 2,
    coachingYear: 2026,
    createdAt: "2026-05-01T00:00:00.000Z",
    finalScorePercent: 0,
    lineId: null,
    lineName: null,
    maxScore: 100,
    medicalRepHrId: "MR-1",
    medicalRepName: "Medical Rep",
    performanceZone: null,
    reportId: "report",
    reportNumber: "CR-1",
    status: "draft",
    submittedAt: null,
    teamId: null,
    teamName: null,
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

function employee(overrides: Partial<EmployeeDirectoryRow>): EmployeeDirectoryRow {
  return {
    areaId: null,
    areaName: null,
    employmentStatus: "active",
    fullName: "Medical Rep",
    hireDate: null,
    hrId: "MR-1",
    jobTitle: "Medical Representative",
    lineId: null,
    lineName: null,
    organogramVisible: true,
    positionTitle: null,
    teamId: null,
    teamName: null,
    ...overrides,
  } as EmployeeDirectoryRow;
}

/**
 * "COACHING RED-ZONE REPS" COUNTS PEOPLE, NOT REPORTS.
 *
 * Both command centres used to compute it as `zoneCounts.critical_red + zoneCounts.red_zone` —
 * a distribution over REPORTS. On production that put **35** on the CEO's attention queue against
 * 45 reps who have ever been coached at all and 18 who have ever been red: a headcount that could
 * not possibly be one. The real figure is 7.
 *
 * Two distinct ways the old sum lied, both pinned below: one rep coached red repeatedly counted
 * once per report, and a rep who went red and was later coached back to green stayed counted
 * forever. Only the rep's MOST RECENT completed report decides.
 */
function testRedZoneCountsPeopleNotReports() {
  const repeatedlyRed = buildCoachingReportAnalytics([
    report({ coachingDate: "2026-05-01", medicalRepHrId: "MR-1", performanceZone: "red_zone", reportId: "r1", status: "locked" }),
    report({ coachingDate: "2026-04-01", medicalRepHrId: "MR-1", performanceZone: "critical_red", reportId: "r2", status: "locked" }),
    report({ coachingDate: "2026-03-01", medicalRepHrId: "MR-1", performanceZone: "red_zone", reportId: "r3", status: "locked" }),
  ]);
  assert.equal(
    repeatedlyRed.zoneCounts.red_zone + repeatedlyRed.zoneCounts.critical_red,
    3,
    "zoneCounts must keep counting REPORTS — the coaching dashboard and the Excel export draw that distribution",
  );
  assert.equal(
    repeatedlyRed.redZoneRepCount,
    1,
    "one rep coached red three times is ONE red-zone rep, not three — this is the count the CEO's attention tile shows",
  );

  const recovered = buildCoachingReportAnalytics([
    report({ coachingDate: "2026-06-01", medicalRepHrId: "MR-1", performanceZone: "green_zone", reportId: "r1", status: "locked" }),
    report({ coachingDate: "2026-01-01", medicalRepHrId: "MR-1", performanceZone: "critical_red", reportId: "r2", status: "locked" }),
    report({ coachingDate: "2026-02-01", medicalRepHrId: "MR-2", performanceZone: "red_zone", reportId: "r3", status: "locked" }),
  ]);
  assert.equal(
    recovered.redZoneRepCount,
    1,
    "a rep coached back out of red must LEAVE the count; only MR-2, whose latest report is still red, remains",
  );

  // Latest is resolved by DATE, not by the caller's array order. `getCoachingReports` returns
  // newest-first today, but the whole meaning of this figure is "most recent" — it must not
  // silently become "whichever row came back first" when a caller sorts for a screen.
  const outOfOrder = buildCoachingReportAnalytics([
    report({ coachingDate: "2026-01-01", medicalRepHrId: "MR-1", performanceZone: "red_zone", reportId: "r1", status: "locked" }),
    report({ coachingDate: "2026-06-01", medicalRepHrId: "MR-1", performanceZone: "green_zone", reportId: "r2", status: "locked" }),
  ]);
  assert.equal(outOfOrder.redZoneRepCount, 0, "the LATEST report decides, whatever order the rows arrive in");

  // A draft red report is not a verdict — only completed statuses count, same as every other figure.
  const draftOnly = buildCoachingReportAnalytics([
    report({ medicalRepHrId: "MR-9", performanceZone: "critical_red", reportId: "r1", status: "draft" }),
  ]);
  assert.equal(draftOnly.redZoneRepCount, 0, "a DRAFT red report must not put a rep on the CEO's queue");

  // Both command centres must read the people count, never re-add the report buckets.
  // The CEO command centre no longer COMPUTES this figure: it reads the `coaching-red-zone`
  // adapter in src/lib/needs-you/sources.ts, which is now the single producer. The positive
  // assertion therefore follows the rule to its new home, while the negative one WIDENS to every
  // file that could reintroduce the defect — including the one the rule just left.
  for (const path of ["src/lib/needs-you/sources.ts", "src/lib/admin/command-center.ts"]) {
    assert.match(
      readFileSync(path, "utf8"),
      /analytics\.redZoneRepCount/,
      `${path} must read the PEOPLE count`,
    );
  }
  for (const path of [
    "src/lib/needs-you/sources.ts",
    "src/lib/admin/command-center.ts",
    "src/lib/ceo/command-center.ts",
  ]) {
    assert.doesNotMatch(
      readFileSync(path, "utf8"),
      /zoneCounts\.critical_red[\s\S]{0,40}zoneCounts\.red_zone/,
      `${path} must not sum the REPORT buckets back into a headcount`,
    );
  }
}

export function runCoachingAnalyticsTests() {
  const rows = [
    ...rowsForReport("report-a", {
      business_intelligence: 4,
      business_planning: 2,
      call_structure_skills: 4,
      knowledge: 5,
      personal_skills: 4,
    }),
    ...rowsForReport("report-b", {
      business_intelligence: 4,
      business_planning: 4,
      call_structure_skills: 4,
      knowledge: 2,
      personal_skills: 5,
    }),
  ];

  const analytics = buildCoachingScoreAnalytics(rows);

  assert.equal(analytics.categoryAverageScores.length, Object.keys(coachingParameterLabels).length);
  assert.equal(analytics.scoreItemAverageScores.length, coachingScoreItems.length);

  const strongestLabels = analytics.strongestParameterDistribution.map((row) => row.parameterLabel);
  assert.deepEqual(strongestLabels, ["Knowledge", "Personal Skills"]);
  assert.deepEqual(
    analytics.strongestParameterDistribution.map((row) => row.count),
    [1, 1],
  );

  const keyDevelopmentLabels = analytics.keyDevelopmentAreaDistribution.map((row) => row.parameterLabel);
  assert.deepEqual(keyDevelopmentLabels, ["Business Planning", "Knowledge"]);
  assert.deepEqual(
    analytics.keyDevelopmentAreaDistribution.map((row) => row.percent),
    [50, 50],
  );

  const knowledge = analytics.categoryAverageScores.find((row) => row.parameterCategory === "knowledge");
  assert.equal(knowledge?.averageScore, 3.5);
  assert.equal(knowledge?.averagePercent, 70);
  assert.equal(knowledge?.reportCount, 2);

  const lowestItem = analytics.scoreItemAverageScores[0];
  assert.equal(lowestItem.averageScore, 3);
  assert.equal(lowestItem.parameterCategory, "business_planning");

  const reportAnalytics = buildCoachingReportAnalytics([
    report({ finalScorePercent: 80, performanceZone: "green_zone", reportId: "submitted", status: "submitted" }),
    report({ acknowledged: true, finalScorePercent: 60, medicalRepHrId: "MR-2", performanceZone: "yellow_zone", reportId: "locked", status: "locked" }),
    report({ finalScorePercent: 95, reportId: "draft", status: "draft" }),
  ]);
  assert.equal(reportAnalytics.averageScore, 70);
  assert.equal(reportAnalytics.bestScore, 80);
  assert.equal(reportAnalytics.lowestScore, 60);
  assert.equal(reportAnalytics.coachingCount, 2);
  assert.equal(reportAnalytics.draftCount, 1);
  assert.equal(reportAnalytics.pendingAcknowledgmentCount, 1);
  assert.deepEqual(reportAnalytics.zoneCounts, { green_zone: 1, yellow_zone: 1 });
  assert.equal(reportAnalytics.redZoneRepCount, 0, "no completed red report means no red-zone rep");

  testRedZoneCountsPeopleNotReports();

  const quarterlySummary: CoachingQuarterlySummaryRow[] = [
    { averageScore: 80, bestScore: 85, coachingCount: 1, firstScore: 80, improvementScore: 0, latestScore: 80, latestZone: "green_zone", lowestScore: 80, medicalRepHrId: "MR-1", quarter: 2, year: 2026 },
    { averageScore: 70, bestScore: 75, coachingCount: 1, firstScore: 70, improvementScore: 0, latestScore: 70, latestZone: "yellow_zone", lowestScore: 70, medicalRepHrId: "MR-3", quarter: 2, year: 2026 },
  ];
  assert.deepEqual(
    filterCoachingQuarterlySummaryByReports(quarterlySummary, [report({ medicalRepHrId: "MR-1" })], true),
    [quarterlySummary[0]],
  );
  assert.equal(
    filterCoachingQuarterlySummaryByReports(quarterlySummary, [], false).length,
    2,
  );

  const comparison = buildTrainingManagerCoachingComparison({
    employees: [
      employee({ areaId: 1, areaName: "Cairo East", fullName: "Rep One", hireDate: "2026-01-10", hrId: "MR-1", lineId: 10, lineName: "Line A", teamId: 100, teamName: "Team A" }),
      employee({ areaId: 1, areaName: "Cairo East", fullName: "Rep Two", hireDate: "2025-08-20", hrId: "MR-2", lineId: 10, lineName: "Line A", positionTitle: "Medical Representative", teamId: 100, teamName: "Team A" }),
      employee({ areaId: 2, areaName: "Alex", fullName: "Rep Three", hireDate: "2024-03-05", hrId: "MR-3", lineId: 20, lineName: "Line B" }),
      employee({ areaId: 1, areaName: "Cairo East", fullName: "DSM One", hrId: "DSM-1", jobTitle: "District Sales Manager" }),
      employee({ areaId: 1, areaName: "Cairo East", employmentStatus: "resigned", fullName: "Inactive Rep", hrId: "MR-4" }),
    ],
    filters: { areaId: 1 },
    reports: [
      report({ coachingDate: "2026-02-01", finalScorePercent: 70, medicalRepHrId: "MR-1", reportId: "mr-1-old", status: "submitted" }),
      report({ coachingDate: "2026-04-01", finalScorePercent: 90, medicalRepHrId: "MR-1", reportId: "mr-1-new", status: "locked" }),
      report({ coachingDate: "2026-05-01", finalScorePercent: 95, medicalRepHrId: "MR-2", reportId: "mr-2-draft", status: "draft" }),
      report({ coachingDate: "2026-06-01", finalScorePercent: 88, medicalRepHrId: "MR-3", reportId: "mr-3-outside-area", status: "submitted" }),
    ],
  });

  assert.equal(comparison.totalMedicalReps, 2);
  assert.equal(comparison.coachedCount, 1);
  assert.equal(comparison.uncoachedCount, 1);
  assert.equal(comparison.coachedRate, 50);
  assert.deepEqual(
    comparison.rows.map((row) => [row.hrId, row.status, row.hireDate, row.areaName, row.coachingCount, row.averageScore]),
    [
      ["MR-2", "not_coached", "2025-08-20", "Cairo East", 0, null],
      ["MR-1", "coached", "2026-01-10", "Cairo East", 2, 80],
    ],
  );
  assert.deepEqual(
    comparison.areaBreakdown.map((row) => [row.areaName, row.totalReps, row.coachedCount, row.uncoachedCount, row.coachedRate]),
    [["Cairo East", 2, 1, 1, 50]],
  );
  assert.deepEqual(
    comparison.coachingMonthBreakdown
      .map((row) => [row.coachingMonth, row.label, row.totalReps, row.coachedCount, row.uncoachedCount]),
    [
      [2, "Feb", 2, 1, 1],
      [4, "Apr", 2, 1, 1],
    ],
  );
  assert.equal(comparison.coachingMonthBreakdown.length, 2);
  assert.equal(comparison.coachingMonthBreakdown.some((row) => row.coachingMonth === 5), false);

  const routeSource = readFileSync("app/api/coaching/analytics/route.ts", "utf8");
  assert.match(routeSource, /buildCoachingReportAnalytics/);
  assert.match(routeSource, /buildTrainingManagerCoachingComparison/);
  assert.match(routeSource, /filterCoachingQuarterlySummaryByReports/);
  assert.doesNotMatch(routeSource, /function buildAnalytics/);

  const adminAnalyticsPageSource = readFileSync("app/(admin)/coaching/analytics/page.tsx", "utf8");
  const dashboardSource = readFileSync("src/components/coaching/coaching-analytics-dashboard.tsx", "utf8");
  const portalTmCoachingSource = readFileSync("app/employee-portals/training-manager/coaching/page.tsx", "utf8");
  assert.match(adminAnalyticsPageSource, /buildCoachingReportAnalytics/);
  assert.match(portalTmCoachingSource, /buildCoachingReportAnalytics/);
  assert.doesNotMatch(adminAnalyticsPageSource, /function buildAnalytics/);
  assert.doesNotMatch(portalTmCoachingSource, /function buildAnalytics/);
  // The rep comparison, coverage table and filter options are built from the DIRECTORY, so each
  // surface narrows it by the coaching access rule before building them (owner, 2026-10-20) — the
  // admin page and its API listed every line's reps as uncoached to a line or team manager.
  for (const [surface, source] of [
    ["the admin coaching analytics page", adminAnalyticsPageSource],
    ["the coaching analytics API", routeSource],
  ] as const) {
    const code = stripComments(source);
    assert.match(code, /const employees = scopeCoachingDirectoryForAccess\(access, directory\);/, `${surface} must scope the directory by the coaching access rule`);
    assert.match(code, /,\s*directory\]\s*=\s*await Promise\.all\(\[/, `${surface} must read the raw directory as \`directory\`, never straight into \`employees\``);
  }
  const portalAnalyticsCode = stripComments(readFileSync("app/employee-portals/coaching-analytics/page.tsx", "utf8"));
  assert.match(portalAnalyticsCode, /const scopedEmployees = scopeCoachingDirectoryForAccess\(access, employees\);/, "the portal coaching analytics page uses the same scope helper");
  assert.match(portalAnalyticsCode, /employees: scopedEmployees,/, "the portal comparison is built from the scoped directory");
  assert.match(adminAnalyticsPageSource, /initialReportFilters = \{ year: currentYear \}/);
  assert.match(adminAnalyticsPageSource, /initialFilters=\{\{ year: String\(currentYear\) \}\}/);
  assert.match(portalTmCoachingSource, /initialReportFilters = \{ year: currentYear \}/);
  assert.match(portalTmCoachingSource, /initialFilters=\{\{ year: String\(currentYear\) \}\}/);
  assert.doesNotMatch(dashboardSource, /Coverage by Hiring Year/);
  assert.doesNotMatch(dashboardSource, /hireYearBreakdown/);
  // Style-3 "corporate report" sections — a structured, table-led layout.
  assert.match(dashboardSource, /title="Executive Summary"/);
  assert.match(dashboardSource, /title="Coaching Skill Index"/);
  assert.match(dashboardSource, /title="Parameter Detail"/);
  assert.match(dashboardSource, /title="Coverage by Area"/);
  assert.match(dashboardSource, /title="Medical Rep Coaching Comparison"/);
  assert.match(dashboardSource, /title="Per-Rep Coaching Detail"/);
  // The redesign surfaces per-parameter averages the previous UI computed but never rendered.
  assert.match(dashboardSource, /categoryAverageScores/);
  assert.match(dashboardSource, /scoreItemAverageScores/);
  // The per-rep coaching report link must be surface-aware: this dashboard renders on both the admin
  // /coaching* routes and the employee portal, so a hardcoded /coaching/<id> would bounce a portal
  // user into the (admin) route group (redirected to the landing page). The base is derived from the
  // current pathname instead.
  assert.match(dashboardSource, /href=\{`\$\{coachingReportBase\}\/\$\{row\.latestReportId\}`\}/);
  assert.match(
    dashboardSource,
    /coachingReportBase = pathname\?\.startsWith\("\/employee-portals"\) \? "\/employee-portals\/coaching" : "\/coaching"/,
  );
  assert.match(dashboardSource, /SelectField/);

  // ---- Audit findings M14 + M16 ----

  // M14: employee-coaching-list.tsx previously re-declared its own "completed" status set and
  // its own score-color threshold function, independently of analytics.ts / landing-insights.ts —
  // a silent-drift risk if the thresholds ever changed in one place but not the other. Both are
  // now imported from the shared modules instead of being redeclared locally.
  assert.ok(
    completedReportStatuses.has("locked") && completedReportStatuses.has("submitted") && completedReportStatuses.has("reviewed_by_employee"),
    "the shared completed-status set covers the same three statuses every coaching analytics surface expects",
  );
  // employee-coaching-list.tsx is now a thin next/dynamic wrapper (performance follow-up);
  // the real implementation this assertion targets lives in the sibling "-impl.tsx" file.
  const employeeCoachingListSource = readFileSync("src/components/coaching/employee-coaching-list-impl.tsx", "utf8");
  assert.match(
    employeeCoachingListSource,
    /import \{ completedReportStatuses as completedStatuses \} from "@\/lib\/coaching\/analytics";/,
    "the employee coaching list imports the shared completed-status set instead of redeclaring it",
  );
  assert.match(
    employeeCoachingListSource,
    /import \{ getCoachingScoreColor as getScoreColor \} from "@\/lib\/coaching\/landing-insights";/,
    "the employee coaching list imports the shared score-color function instead of redeclaring it",
  );
  assert.doesNotMatch(
    employeeCoachingListSource,
    /const completedStatuses = new Set</,
    "no local re-declaration of the completed-status set remains",
  );
  assert.doesNotMatch(
    employeeCoachingListSource,
    /function getScoreColor\(score: number\)/,
    "no local re-declaration of the score-color function remains",
  );

  // M16: the coaching report export route previously fetched each report's detail with a
  // separate getCoachingReportById call inside Promise.all — up to ~3N queries for N reports.
  // getCoachingReportsByIds batches the same 3 queries (report + scores + summary) into one
  // .in(batch) call each per 100-id chunk of `ids` (PostgREST header-overflow guard — see
  // src/lib/email/engagement.ts), with identical fail-together semantics.
  const coachingServiceSource = readFileSync("src/lib/coaching/service.ts", "utf8");
  assert.match(coachingServiceSource, /export async function getCoachingReportsByIds\(ids: string\[\], access: AccessContext\)/);
  assert.match(coachingServiceSource, /for \(let i = 0; i < ids\.length; i \+= 100\)/, "getCoachingReportsByIds must batch ids to avoid a PostgREST header-overflow crash");
  assert.match(coachingServiceSource, /\.from\("coaching_reports"\)\.select\("\*"\)\.in\("id", batch\)/);
  assert.match(coachingServiceSource, /\.from\("coaching_score_items"\)\.select\("\*"\)\.in\("report_id", batch\)/);
  assert.match(coachingServiceSource, /\.from\("coaching_reports_summary"\)\.select\("\*"\)\.in\("report_id", batch\)/);

  const exportRouteSource = readFileSync("app/api/coaching/reports/export/route.ts", "utf8");
  assert.match(exportRouteSource, /getCoachingReportsByIds/, "the export route uses the batched fetch");
  assert.doesNotMatch(
    exportRouteSource,
    /Promise\.all\(\s*reports\.map\(\(report\) => getCoachingReportById/,
    "the N+1 per-report Promise.all fetch is gone",
  );
}
