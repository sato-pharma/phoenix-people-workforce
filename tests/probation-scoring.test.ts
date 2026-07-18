import assert from "node:assert/strict";

import { DEFAULT_PROBATION_CONFIG } from "../src/lib/probation/intelligence/config.ts";
import {
  computeProbationScore,
  meanScorecard,
  type FeedbackScoreInput,
} from "../src/lib/probation/intelligence/scoring.ts";
import { detectContradictions } from "../src/lib/probation/intelligence/contradictions.ts";
import type { ProbationEvaluatorRole, ProbationRecommendation } from "../src/lib/probation/intelligence/types.ts";

const cfg = DEFAULT_PROBATION_CONFIG;

function fb(role: ProbationEvaluatorRole, score: number, recommendation: ProbationRecommendation | null = null, id = `${role}-${score}`): FeedbackScoreInput {
  return { dvDayId: id, role, scores: { overall: score }, recommendation };
}

export function runProbationScoringTests() {
  // meanScorecard averages dimensions.
  assert.equal(meanScorecard({ a: 6, b: 8 }), 7);
  assert.equal(meanScorecard({}), null);

  // ── P6-T01 DM component = AVERAGE of the 3 DM DV-Days ──
  {
    const r = computeProbationScore({ feedbacks: [fb("dm", 6, null, "d1"), fb("dm", 8, null, "d2"), fb("dm", 10, null, "d3")], sfeScore: null, hrScore: null }, cfg);
    assert.equal(r.components.dm.score, 8, "DM = avg(6,8,10)");
    assert.equal(r.components.dm.count, 3);
    assert.equal(r.components.dm.complete, true, "3 DM DV-Days meets the requirement of 2");
    // P6-T02 weighted contribution = weight × score.
    assert.equal(r.components.dm.weightedContribution, 2.4, "0.3 × 8");
    // P6-T03 provisional normalizes over present components (only DM present here) → 8.
    assert.equal(r.provisionalScore, 8);
    assert.equal(r.decisionReady, false, "missing PM|GPM / NSM / SFE / HR (TM is optional)");
    assert.equal(r.finalScore, null, "no final score until decision-ready");
    // TM feedback is OPTIONAL (requirement 0, owner rule 2026-07-18): it is complete by definition and
    // never appears as a missing component or in missingByRole.
    assert.equal(r.components.tm.complete, true, "TM optional → complete by definition with 0 feedback");
    assert.deepEqual(r.completeness.missingComponents.sort(), ["hr", "nsm", "pm_gpm", "sfe"]);
    assert.equal(r.completeness.missingByRole.dm, undefined, "DM requirement met");
    assert.equal(r.completeness.missingByRole.tm, undefined, "TM is optional (requirement 0) — never missing");
  }

  // Incomplete DM (only 1 of the 2 required) → present but not complete.
  {
    const r = computeProbationScore({ feedbacks: [fb("dm", 6)], sfeScore: null, hrScore: null }, cfg);
    assert.equal(r.components.dm.present, true);
    assert.equal(r.components.dm.complete, false, "1 < 2 required");
    assert.equal(r.completeness.missingByRole.dm, 1, "needs 1 more DM feedback (2 required, 1 done)");
  }

  // ── P6-T03 full set → final score, decision-ready ──
  {
    const r = computeProbationScore({
      feedbacks: [fb("dm", 6, null, "d1"), fb("dm", 8, null, "d2"), fb("dm", 10, null, "d3"), fb("tm", 7), fb("pm_gpm", 6), fb("nsm", 9)],
      sfeScore: 5,
      hrScore: 4,
    }, cfg);
    // 0.3*8 + 0.15*7 + 0.15*6 + 0.15*9 + 0.15*5 + 0.1*4 = 6.85 over total weight 1.0
    assert.equal(r.decisionReady, true);
    assert.equal(r.finalScore, 6.85);
    assert.equal(r.provisionalScore, 6.85);
    assert.equal(r.status, "complete");
    assert.equal(r.completeness.missingComponents.length, 0);
  }

  // ── P6-T04 contradictions ──
  // Score variance: components 9 and 4 present → spread 5 → high variance.
  {
    const r = computeProbationScore({ feedbacks: [fb("dm", 9, null, "d1"), fb("dm", 9, null, "d2"), fb("dm", 9, null, "d3"), fb("tm", 4)], sfeScore: null, hrScore: null }, cfg);
    const cs = detectContradictions(r, [fb("dm", 9), fb("tm", 4)]);
    const variance = cs.find((c) => c.type === "score_variance");
    assert.ok(variance, "variance contradiction raised for spread ≥ 3");
    assert.equal(variance!.variance, 5);
    assert.ok(cs.some((c) => c.type === "evaluator_outlier"), "outlier flagged");
  }

  // Recommendation vs score: strong score + serious_concern.
  {
    const feedbacks = [fb("dm", 9, "serious_concern")];
    const r = computeProbationScore({ feedbacks, sfeScore: null, hrScore: null }, cfg);
    const cs = detectContradictions(r, feedbacks);
    const rc = cs.find((c) => c.type === "recommendation_vs_score");
    assert.ok(rc && rc.severity === "high", "strong score + serious concern = high contradiction");
  }
  // Weak score + on_track.
  {
    const feedbacks = [fb("dm", 3, "on_track")];
    const r = computeProbationScore({ feedbacks, sfeScore: null, hrScore: null }, cfg);
    assert.ok(detectContradictions(r, feedbacks).some((c) => c.type === "recommendation_vs_score"));
  }

  // HR vs field divergence: field ~8, HR 2 → gap 6.
  {
    const feedbacks = [fb("dm", 8, null, "d1"), fb("dm", 8, null, "d2"), fb("dm", 8, null, "d3")];
    const r = computeProbationScore({ feedbacks, sfeScore: null, hrScore: 2 }, cfg);
    const cs = detectContradictions(r, feedbacks);
    assert.ok(cs.some((c) => c.type === "hr_vs_field"), "HR diverging from field flagged");
  }

  // No contradictions when everyone agrees.
  {
    const feedbacks = [fb("dm", 7, "on_track", "d1"), fb("dm", 7, "on_track", "d2"), fb("dm", 7, "on_track", "d3"), fb("tm", 7, "on_track"), fb("pm_gpm", 7, "on_track"), fb("nsm", 7, "on_track")];
    const r = computeProbationScore({ feedbacks, sfeScore: 7, hrScore: 7 }, cfg);
    assert.equal(detectContradictions(r, feedbacks).length, 0, "consensus → no contradictions");
  }
}
