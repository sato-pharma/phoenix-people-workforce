import {
  coachingMaxItemScore,
  coachingMaxScore,
  coachingMinItemScore,
  coachingParameterLabels,
  coachingScoreItemCount,
  coachingScoreItems,
  type CoachingParameterKey,
  type CoachingScoreItemKey,
} from "./constants.ts";
import type {
  CoachingCategorySubtotal,
  CoachingScoreItemInput,
  CoachingPerformanceZone,
  NormalizedCoachingScoreItem,
  CoachingScoreInput,
  CoachingScoreResult,
} from "./types.ts";

function round(value: number, fractionDigits = 2) {
  return Number(value.toFixed(fractionDigits));
}

export function getCoachingPerformanceZone(percent: number): CoachingPerformanceZone {
  if (percent < 50) return "critical_red";
  if (percent <= 65) return "red_zone";
  if (percent <= 80) return "yellow_zone";
  if (percent <= 90) return "green_zone";
  return "excellence_zone";
}

function cleanNote(value: unknown) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text : null;
}

function rawScoreValue(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value) && "score" in value) {
    return (value as CoachingScoreItemInput).score;
  }
  return value;
}

function normalizeScore(value: unknown, key: CoachingScoreItemKey) {
  const rawScore = rawScoreValue(value);
  const score = Number(rawScore);
  if (!Number.isInteger(score) || score < coachingMinItemScore || score > coachingMaxItemScore) {
    throw new Error(`Invalid coaching score for "${key}". Score must be an integer from 1 to 6.`);
  }
  return score;
}

function normalizeScoreItem(value: unknown, key: CoachingScoreItemKey): NormalizedCoachingScoreItem {
  const score = normalizeScore(value, key);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      areaToBeImproved: null,
      score,
      strengthPoint: null,
    };
  }

  return {
    areaToBeImproved: cleanNote((value as CoachingScoreItemInput).areaToBeImproved),
    score,
    strengthPoint: cleanNote((value as CoachingScoreItemInput).strengthPoint),
  };
}

export function normalizeCoachingScores(input: CoachingScoreInput): Record<CoachingScoreItemKey, number> {
  const normalized = {} as Record<CoachingScoreItemKey, number>;
  const keys = Object.keys(input);
  const allowedKeys = new Set(coachingScoreItems.map((item) => item.key));
  const unknownKey = keys.find((key) => !allowedKeys.has(key as CoachingScoreItemKey));

  if (unknownKey) {
    throw new Error(`Unknown coaching score item "${unknownKey}".`);
  }

  for (const item of coachingScoreItems) {
    if (input[item.key] === undefined || input[item.key] === null) {
      throw new Error(`Missing coaching score for "${item.label}". Exactly ${coachingScoreItemCount} scores are required.`);
    }

    normalized[item.key] = normalizeScore(input[item.key], item.key);
  }

  return normalized;
}

export function normalizeCoachingScoreItems(input: CoachingScoreInput): Record<CoachingScoreItemKey, NormalizedCoachingScoreItem> {
  const normalized = {} as Record<CoachingScoreItemKey, NormalizedCoachingScoreItem>;
  normalizeCoachingScores(input);

  for (const item of coachingScoreItems) {
    normalized[item.key] = normalizeScoreItem(input[item.key], item.key);
  }

  return normalized;
}

function buildCategorySubtotals(
  scores: Record<CoachingScoreItemKey, number>,
): CoachingCategorySubtotal[] {
  const categories = Object.keys(coachingParameterLabels) as CoachingParameterKey[];

  return categories.map((category) => {
    const items = coachingScoreItems.filter((item) => item.category === category);
    const actualScore = items.reduce((sum, item) => sum + scores[item.key], 0);
    const maxScore = items.length * coachingMaxItemScore;
    const averageScore = actualScore / items.length;
    const percent = (actualScore / maxScore) * 100;

    return {
      actualScore,
      averageScore: round(averageScore),
      category,
      label: coachingParameterLabels[category],
      maxScore,
      percent: round(percent),
      pointCount: items.length,
    };
  });
}

export function calculateCoachingScore(input: CoachingScoreInput): CoachingScoreResult {
  const normalizedScores = normalizeCoachingScores(input);
  const actualScore = coachingScoreItems.reduce((sum, item) => sum + normalizedScores[item.key], 0);
  const finalScorePercent = round((actualScore / coachingMaxScore) * 100);
  const categorySubtotals = buildCategorySubtotals(normalizedScores);
  const strongestParameter = [...categorySubtotals].sort((a, b) => b.percent - a.percent || b.actualScore - a.actualScore)[0];
  const keyDevelopmentArea = [...categorySubtotals].sort((a, b) => a.percent - b.percent || a.actualScore - b.actualScore)[0];

  return {
    actualScore,
    categorySubtotals,
    finalScorePercent,
    keyDevelopmentArea,
    maxScore: coachingMaxScore,
    normalizedScores,
    performanceZone: getCoachingPerformanceZone(finalScorePercent),
    strongestParameter,
  };
}

export function toCoachingScoreRows(reportId: string, result: CoachingScoreResult, input?: CoachingScoreInput | null) {
  const normalizedItems = input ? normalizeCoachingScoreItems(input) : null;
  return coachingScoreItems.map((item) => ({
    area_to_be_improved: normalizedItems?.[item.key]?.areaToBeImproved ?? null,
    display_order: item.displayOrder,
    parameter_category: item.category,
    report_id: reportId,
    score: result.normalizedScores[item.key],
    score_item_key: item.key,
    score_item_label: item.label,
    strength_point: normalizedItems?.[item.key]?.strengthPoint ?? null,
  }));
}
