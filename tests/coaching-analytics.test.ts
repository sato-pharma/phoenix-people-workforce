import assert from "node:assert/strict";

import {
  buildCoachingScoreAnalytics,
  type CoachingScoreAnalyticsInputRow,
} from "../src/lib/coaching/analytics.ts";
import {
  coachingParameterLabels,
  coachingScoreItems,
  type CoachingParameterKey,
} from "../src/lib/coaching/constants.ts";

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

export function runCoachingAnalyticsTests() {
  const rows = [
    ...rowsForReport("report-a", {
      business_intelligence: 4,
      business_planning: 2,
      call_structure_skills: 4,
      knowledge: 6,
      personal_skills: 4,
    }),
    ...rowsForReport("report-b", {
      business_intelligence: 4,
      business_planning: 4,
      call_structure_skills: 4,
      knowledge: 2,
      personal_skills: 6,
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
  assert.equal(knowledge?.averageScore, 4);
  assert.equal(knowledge?.averagePercent, 66.67);
  assert.equal(knowledge?.reportCount, 2);

  const lowestItem = analytics.scoreItemAverageScores[0];
  assert.equal(lowestItem.averageScore, 3);
  assert.equal(lowestItem.parameterCategory, "business_planning");
}
