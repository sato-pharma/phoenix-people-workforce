import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildCoachingReportAnalytics,
  buildCoachingScoreAnalytics,
  buildTrainingManagerCoachingComparison,
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
    comparison.hireYearBreakdown.map((row) => [row.hireYear, row.totalReps, row.coachedCount, row.uncoachedCount]),
    [
      [2025, 1, 0, 1],
      [2026, 1, 1, 0],
    ],
  );

  const routeSource = readFileSync("app/api/coaching/analytics/route.ts", "utf8");
  assert.match(routeSource, /buildCoachingReportAnalytics/);
  assert.match(routeSource, /buildTrainingManagerCoachingComparison/);
  assert.match(routeSource, /filterCoachingQuarterlySummaryByReports/);
  assert.doesNotMatch(routeSource, /function buildAnalytics/);

  const adminAnalyticsPageSource = readFileSync("app/(admin)/coaching/analytics/page.tsx", "utf8");
  const portalTrainingManagerSource = readFileSync("app/employee-portals/training-manager/page.tsx", "utf8");
  assert.match(adminAnalyticsPageSource, /buildCoachingReportAnalytics/);
  assert.match(portalTrainingManagerSource, /buildCoachingReportAnalytics/);
  assert.doesNotMatch(adminAnalyticsPageSource, /function buildAnalytics/);
  assert.doesNotMatch(portalTrainingManagerSource, /function buildAnalytics/);
}
