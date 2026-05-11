import {
  coachingMaxItemScore,
  coachingParameterLabels,
  type CoachingParameterKey,
  type CoachingScoreItemKey,
} from "./constants.ts";
import type {
  CoachingParameterDistributionRow,
  CoachingScoreAnalytics,
} from "./types.ts";

export type CoachingScoreAnalyticsInputRow = {
  parameter_category: CoachingParameterKey;
  report_id: string;
  score: number | string;
  score_item_key: CoachingScoreItemKey;
  score_item_label: string;
};

type ScoreBucket = {
  category: CoachingParameterKey;
  itemKey?: CoachingScoreItemKey;
  itemLabel?: string;
  reports: Set<string>;
  scoreCount: number;
  totalScore: number;
};

function round(value: number, fractionDigits = 2) {
  return Number(value.toFixed(fractionDigits));
}

function average(total: number, count: number) {
  if (count === 0) return 0;
  return round(total / count);
}

function averagePercent(score: number) {
  return round((score / coachingMaxItemScore) * 100);
}

function categoryLabel(category: CoachingParameterKey) {
  return coachingParameterLabels[category] ?? category.replace(/_/g, " ");
}

function createBucket(category: CoachingParameterKey, itemKey?: CoachingScoreItemKey, itemLabel?: string): ScoreBucket {
  return {
    category,
    itemKey,
    itemLabel,
    reports: new Set<string>(),
    scoreCount: 0,
    totalScore: 0,
  };
}

function incrementDistribution(
  distribution: Map<CoachingParameterKey, number>,
  category: CoachingParameterKey,
) {
  distribution.set(category, (distribution.get(category) ?? 0) + 1);
}

function mapDistribution(
  distribution: Map<CoachingParameterKey, number>,
  denominator: number,
): CoachingParameterDistributionRow[] {
  return [...distribution.entries()]
    .map(([parameterCategory, count]) => ({
      count,
      parameterCategory,
      parameterKey: parameterCategory,
      parameterLabel: categoryLabel(parameterCategory),
      percent: denominator > 0 ? round((count / denominator) * 100) : 0,
    }))
    .sort((left, right) => right.count - left.count || left.parameterLabel.localeCompare(right.parameterLabel));
}

export function buildCoachingScoreAnalytics(
  rows: CoachingScoreAnalyticsInputRow[],
): CoachingScoreAnalytics {
  const categoryBuckets = new Map<CoachingParameterKey, ScoreBucket>();
  const itemBuckets = new Map<string, ScoreBucket>();
  const reportCategoryBuckets = new Map<string, Map<CoachingParameterKey, ScoreBucket>>();

  for (const row of rows) {
    const score = Number(row.score);
    if (!row.report_id || !Number.isFinite(score)) continue;

    const category = row.parameter_category;
    const categoryBucket = categoryBuckets.get(category) ?? createBucket(category);
    categoryBucket.scoreCount += 1;
    categoryBucket.totalScore += score;
    categoryBucket.reports.add(row.report_id);
    categoryBuckets.set(category, categoryBucket);

    const itemKey = `${category}:${row.score_item_key}`;
    const itemBucket = itemBuckets.get(itemKey) ?? createBucket(category, row.score_item_key, row.score_item_label);
    itemBucket.scoreCount += 1;
    itemBucket.totalScore += score;
    itemBucket.reports.add(row.report_id);
    itemBuckets.set(itemKey, itemBucket);

    const reportBuckets = reportCategoryBuckets.get(row.report_id) ?? new Map<CoachingParameterKey, ScoreBucket>();
    const reportCategoryBucket = reportBuckets.get(category) ?? createBucket(category);
    reportCategoryBucket.scoreCount += 1;
    reportCategoryBucket.totalScore += score;
    reportCategoryBucket.reports.add(row.report_id);
    reportBuckets.set(category, reportCategoryBucket);
    reportCategoryBuckets.set(row.report_id, reportBuckets);
  }

  const strongestDistribution = new Map<CoachingParameterKey, number>();
  const keyDevelopmentAreaDistribution = new Map<CoachingParameterKey, number>();

  for (const reportBuckets of reportCategoryBuckets.values()) {
    const categoryAverages = [...reportBuckets.values()].map((bucket) => ({
      averageScore: average(bucket.totalScore, bucket.scoreCount),
      category: bucket.category,
    }));
    if (categoryAverages.length === 0) continue;

    const strongest = [...categoryAverages].sort(
      (left, right) => right.averageScore - left.averageScore || categoryLabel(left.category).localeCompare(categoryLabel(right.category)),
    )[0];
    const keyDevelopment = [...categoryAverages].sort(
      (left, right) => left.averageScore - right.averageScore || categoryLabel(left.category).localeCompare(categoryLabel(right.category)),
    )[0];

    incrementDistribution(strongestDistribution, strongest.category);
    incrementDistribution(keyDevelopmentAreaDistribution, keyDevelopment.category);
  }

  const categoryAverageScores = [...categoryBuckets.values()]
    .map((bucket) => {
      const averageScore = average(bucket.totalScore, bucket.scoreCount);
      return {
        averagePercent: averagePercent(averageScore),
        averageScore,
        parameterCategory: bucket.category,
        parameterKey: bucket.category,
        parameterLabel: categoryLabel(bucket.category),
        reportCount: bucket.reports.size,
        scoreCount: bucket.scoreCount,
      };
    })
    .sort((left, right) => right.averageScore - left.averageScore || left.parameterLabel.localeCompare(right.parameterLabel));

  const scoreItemAverageScores = [...itemBuckets.values()]
    .map((bucket) => {
      const averageScore = average(bucket.totalScore, bucket.scoreCount);
      return {
        averagePercent: averagePercent(averageScore),
        averageScore,
        parameterCategory: bucket.category,
        parameterKey: bucket.category,
        parameterLabel: categoryLabel(bucket.category),
        reportCount: bucket.reports.size,
        scoreCount: bucket.scoreCount,
        scoreItemKey: bucket.itemKey as CoachingScoreItemKey,
        scoreItemLabel: bucket.itemLabel ?? bucket.itemKey ?? "",
      };
    })
    .sort((left, right) => left.averageScore - right.averageScore || left.scoreItemLabel.localeCompare(right.scoreItemLabel));

  const reportCount = reportCategoryBuckets.size;

  return {
    categoryAverageScores,
    keyDevelopmentAreaDistribution: mapDistribution(keyDevelopmentAreaDistribution, reportCount),
    scoreItemAverageScores,
    strongestParameterDistribution: mapDistribution(strongestDistribution, reportCount),
  };
}

export const emptyCoachingScoreAnalytics: CoachingScoreAnalytics = {
  categoryAverageScores: [],
  keyDevelopmentAreaDistribution: [],
  scoreItemAverageScores: [],
  strongestParameterDistribution: [],
};
