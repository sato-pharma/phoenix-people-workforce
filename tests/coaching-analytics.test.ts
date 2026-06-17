import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildCoachingReportAnalytics,
  buildCoachingScoreAnalytics,
  filterCoachingQuarterlySummaryByReports,
  type CoachingScoreAnalyticsInputRow,
} from "../src/lib/coaching/analytics.ts";
import {
  coachingParameterLabels,
  coachingScoreItems,
  type CoachingParameterKey,
} from "../src/lib/coaching/constants.ts";
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

  const routeSource = readFileSync("app/api/coaching/analytics/route.ts", "utf8");
  assert.match(routeSource, /buildCoachingReportAnalytics/);
  assert.match(routeSource, /filterCoachingQuarterlySummaryByReports/);
  assert.doesNotMatch(routeSource, /function buildAnalytics/);

  const adminAnalyticsPageSource = readFileSync("app/(admin)/coaching/analytics/page.tsx", "utf8");
  const portalTrainingManagerSource = readFileSync("app/employee-portals/training-manager/page.tsx", "utf8");
  assert.match(adminAnalyticsPageSource, /buildCoachingReportAnalytics/);
  assert.match(portalTrainingManagerSource, /buildCoachingReportAnalytics/);
  assert.doesNotMatch(adminAnalyticsPageSource, /function buildAnalytics/);
  assert.doesNotMatch(portalTrainingManagerSource, /function buildAnalytics/);
}
