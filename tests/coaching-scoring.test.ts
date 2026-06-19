import assert from "node:assert/strict";

import {
  coachingMaxItemScore,
  coachingMaxScore,
  coachingMinItemScore,
  coachingScoreItemCount,
  coachingScoreItems,
  type CoachingScoreItemKey,
} from "../src/lib/coaching/constants.ts";
import {
  calculateCoachingScore,
  getCoachingPerformanceZone,
  normalizeCoachingScoreItems,
} from "../src/lib/coaching/scoring.ts";
import type { CoachingScoreInput } from "../src/lib/coaching/types.ts";

function scoresWith(defaultScore: number, overrides: Partial<Record<CoachingScoreItemKey, number>> = {}) {
  return Object.fromEntries(
    coachingScoreItems.map((item) => [item.key, overrides[item.key] ?? defaultScore]),
  ) as Record<CoachingScoreItemKey, number>;
}

export function runCoachingScoringTests() {
  assert.equal(coachingScoreItems.length, coachingScoreItemCount);
  assert.equal(coachingMaxScore, coachingScoreItemCount * coachingMaxItemScore);
  assert.equal(coachingMinItemScore, 0);
  assert.equal(coachingMaxItemScore, 5);

  assert.deepEqual(
    coachingScoreItems.map((item) => item.label),
    [
      "Medical & Patient/Physician Knowledge",
      "Product Knowledge",
      "Competitor Knowledge",
      "Opening, Patient Profile & Attractive Approach",
      "Asking Questions / Probing",
      "Presentation Skills",
      "Closing & Asking for Business",
      "Handling Customer Objection",
      "Body Language & Tone of Voice",
      "Professional Pharmacy Feedback",
      "Assertiveness in Asking for Business",
      "Customer Adaptation & Relationship",
      "Time & Territory Planning",
      "Using Promotional Material",
      "Pre-Call Planning",
      "Execution & Follow-Up",
      "Appearance",
      "Dress Code",
      "Attitude",
      "Discipline",
    ],
  );

  assert.throws(() => calculateCoachingScore({}), /Missing coaching score/);
  const zeroScore = calculateCoachingScore(scoresWith(0));
  assert.equal(zeroScore.actualScore, 0);
  assert.equal(zeroScore.finalScorePercent, 0);
  assert.equal(zeroScore.performanceZone, "critical_red");

  assert.throws(
    () => calculateCoachingScore({ ...scoresWith(4), product_knowledge: 7 }),
    /from 0 to 5/,
  );
  assert.throws(
    () => calculateCoachingScore({ ...scoresWith(4), product_knowledge: 4.5 }),
    /from 0 to 5/,
  );
  assert.throws(
    () => calculateCoachingScore({ ...scoresWith(4), unknown_score: 4 } as CoachingScoreInput),
    /Unknown coaching score item/,
  );

  const perfect = calculateCoachingScore(scoresWith(5));
  assert.equal(perfect.actualScore, 100);
  assert.equal(perfect.maxScore, 100);
  assert.equal(perfect.finalScorePercent, 100);
  assert.equal(perfect.performanceZone, "excellence_zone");

  assert.equal(getCoachingPerformanceZone(49.99), "critical_red");
  assert.equal(getCoachingPerformanceZone(50), "red_zone");
  assert.equal(getCoachingPerformanceZone(65), "red_zone");
  assert.equal(getCoachingPerformanceZone(66), "yellow_zone");
  assert.equal(getCoachingPerformanceZone(80), "yellow_zone");
  assert.equal(getCoachingPerformanceZone(81), "green_zone");
  assert.equal(getCoachingPerformanceZone(90), "green_zone");
  assert.equal(getCoachingPerformanceZone(91), "excellence_zone");

  const mixed = calculateCoachingScore(
    scoresWith(3, {
      competitor_knowledge: 1,
      medical_patient_knowledge: 1,
      product_knowledge: 1,
      execution_follow_up: 5,
      pre_call_planning: 5,
      time_territory_planning: 5,
      using_promotional_material: 5,
    }),
  );
  assert.equal(mixed.strongestParameter.category, "business_planning");
  assert.equal(mixed.keyDevelopmentArea.category, "knowledge");

  const notesInput = {
    ...scoresWith(4),
    product_knowledge: {
      areaToBeImproved: "  Improve product comparisons  ",
      score: 5,
      strengthPoint: "  Clear core message  ",
    },
  };
  const notesResult = calculateCoachingScore(notesInput);
  const normalizedItems = normalizeCoachingScoreItems(notesInput);
  assert.equal(notesResult.normalizedScores.product_knowledge, 5);
  assert.equal(normalizedItems.product_knowledge.areaToBeImproved, "Improve product comparisons");
  assert.equal(normalizedItems.product_knowledge.strengthPoint, "Clear core message");

  const numericItems = normalizeCoachingScoreItems(scoresWith(4));
  assert.equal(numericItems.product_knowledge.score, 4);
  assert.equal(numericItems.product_knowledge.areaToBeImproved, null);
  assert.equal(numericItems.product_knowledge.strengthPoint, null);
}
