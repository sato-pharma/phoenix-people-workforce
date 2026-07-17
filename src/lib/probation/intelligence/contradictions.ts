// Probation contradiction detection (Phase 6, P6-T04/T05). Pure.
//
// Surfaces conflicting evaluation evidence so a human decision-maker sees disagreement instead of
// it being averaged away. These are INDICATORS ONLY — nothing here changes a score or decides an
// outcome. Every contradiction explains itself (which categories, which evaluators, the variance).

import type { ScoreComponentKey, ComponentResult, ProbationScoreResult, FeedbackScoreInput } from "./scoring";
import { meanScorecard } from "./scoring";
import type { ProbationEvaluatorRole } from "./types";

export type ContradictionSeverity = "info" | "warning" | "high";

export type Contradiction = {
  type:
    | "score_variance"
    | "evaluator_outlier"
    | "recommendation_vs_score"
    | "hr_vs_field"
    | "sfe_vs_field";
  severity: ContradictionSeverity;
  title: string;
  detail: string;
  categories: ScoreComponentKey[];
  evaluatorsInvolved: ProbationEvaluatorRole[];
  variance?: number;
};

// Tunable thresholds (on the 1..10 scale). Kept here (documented) rather than magic numbers inline.
export const CONTRADICTION_THRESHOLDS = {
  /** Spread (max-min) across present component scores that flags a variance contradiction. */
  varianceSpread: 3,
  /** Deviation of one component from the mean of present components that flags an outlier. */
  outlierDeviation: 2.5,
  /** Divergence between HR/SFE and the field average that flags a cross-source conflict. */
  crossSourceGap: 3,
  /** A "strong" numeric score that conflicts with a "serious concern" recommendation. */
  strongScore: 7,
  /** A "weak" numeric score that conflicts with an "on track" recommendation. */
  weakScore: 4,
};

function round(n: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

const FIELD_ROLES: ProbationEvaluatorRole[] = ["dm", "tm", "pm_gpm", "nsm"];

function presentScore(c: ComponentResult): number | null {
  return c.present && c.score != null ? c.score : null;
}

export function detectContradictions(
  result: ProbationScoreResult,
  feedbacks: FeedbackScoreInput[],
): Contradiction[] {
  const out: Contradiction[] = [];
  const comps = result.components;
  const allKeys = Object.keys(comps) as ScoreComponentKey[];

  const present = allKeys
    .map((k) => ({ key: k, score: presentScore(comps[k]) }))
    .filter((x): x is { key: ScoreComponentKey; score: number } => x.score != null);

  // 1. Overall variance across present components.
  if (present.length >= 2) {
    const scores = present.map((p) => p.score);
    const spread = Math.max(...scores) - Math.min(...scores);
    if (spread >= CONTRADICTION_THRESHOLDS.varianceSpread) {
      out.push({
        type: "score_variance",
        severity: spread >= CONTRADICTION_THRESHOLDS.varianceSpread + 2 ? "high" : "warning",
        title: "Conflicting evaluations detected",
        detail: `Component scores range ${round(Math.min(...scores))}–${round(Math.max(...scores))} (spread ${round(spread)}). Evaluators disagree materially.`,
        categories: present.map((p) => p.key),
        evaluatorsInvolved: present.map((p) => p.key).filter((k): k is ProbationEvaluatorRole => (FIELD_ROLES as string[]).includes(k)),
        variance: round(spread),
      });
    }

    // 2. Individual outliers vs the mean of present components.
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    for (const p of present) {
      const dev = Math.abs(p.score - mean);
      if (dev >= CONTRADICTION_THRESHOLDS.outlierDeviation) {
        out.push({
          type: "evaluator_outlier",
          severity: "warning",
          title: `${p.key.toUpperCase()} scores against the consensus`,
          detail: `${p.key.toUpperCase()} = ${round(p.score)} vs peer mean ${round(mean)} (deviation ${round(dev)}).`,
          categories: [p.key],
          evaluatorsInvolved: (FIELD_ROLES as string[]).includes(p.key) ? [p.key as ProbationEvaluatorRole] : [],
          variance: round(dev),
        });
      }
    }
  }

  // 3. Recommendation vs numeric score conflict, per feedback.
  for (const f of feedbacks) {
    const s = meanScorecard(f.scores);
    if (s == null || !f.recommendation) continue;
    if (s >= CONTRADICTION_THRESHOLDS.strongScore && f.recommendation === "serious_concern") {
      out.push({
        type: "recommendation_vs_score",
        severity: "high",
        title: "Strong score but 'serious concern'",
        detail: `${f.role.toUpperCase()} scored ${round(s)} yet recommended "serious concern". The narrative conflicts with the number.`,
        categories: [f.role],
        evaluatorsInvolved: [f.role],
        variance: undefined,
      });
    } else if (s <= CONTRADICTION_THRESHOLDS.weakScore && f.recommendation === "on_track") {
      out.push({
        type: "recommendation_vs_score",
        severity: "warning",
        title: "Weak score but 'on track'",
        detail: `${f.role.toUpperCase()} scored ${round(s)} yet recommended "on track". The narrative conflicts with the number.`,
        categories: [f.role],
        evaluatorsInvolved: [f.role],
        variance: undefined,
      });
    }
  }

  // 4/5. Cross-source: HR / SFE vs the field average.
  const fieldScores = FIELD_ROLES.map((r) => presentScore(comps[r])).filter((x): x is number => x != null);
  if (fieldScores.length > 0) {
    const fieldAvg = fieldScores.reduce((a, b) => a + b, 0) / fieldScores.length;
    for (const key of ["hr", "sfe"] as const) {
      const cs = presentScore(comps[key]);
      if (cs == null) continue;
      const gap = Math.abs(cs - fieldAvg);
      if (gap >= CONTRADICTION_THRESHOLDS.crossSourceGap) {
        out.push({
          type: key === "hr" ? "hr_vs_field" : "sfe_vs_field",
          severity: "warning",
          title: key === "hr" ? "HR assessment diverges from field" : "SFE evidence diverges from field",
          detail: `${key.toUpperCase()} = ${round(cs)} vs field average ${round(fieldAvg)} (gap ${round(gap)}).`,
          categories: [key, ...FIELD_ROLES.filter((r) => comps[r].present)],
          evaluatorsInvolved: FIELD_ROLES.filter((r) => comps[r].present),
          variance: round(gap),
        });
      }
    }
  }

  return out;
}
