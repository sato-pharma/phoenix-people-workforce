// Probation scoring engine (Phase 6, P6-T01/T02/T03). Pure, config-driven, transparent.
//
// Rules (owner spec):
//   * A DV-Day feedback score = the mean of its scorecard dimension scores.
//   * The District Manager component is the AVERAGE of the (up to 3) DM DV-Day scores — NOT a
//     simple average across all forms. TM / PM|GPM / NSM components are the average of their
//     (normally single) DV-Day scores. SFE / HR components come from their assessments.
//   * Apply CONFIGURABLE role weights (config.roleWeights) — never silently assumed.
//   * A component counts toward the score only when present. The PROVISIONAL score normalizes the
//     weighted sum over the PRESENT components' weights (so it stays on the 1..scale.max scale);
//     the FINAL score is only produced when every required component is present (decision-ready).
//   * Nothing here decides an outcome — it produces evidence: scores, completeness, readiness.

import type { ProbationConfig } from "./config";
import type {
  ProbationEvaluatorRole,
  ProbationRecommendation,
  ProbationScorecard,
} from "./types";

export type ScoreComponentKey = ProbationEvaluatorRole | "sfe" | "hr";

export type FeedbackScoreInput = {
  dvDayId: string;
  role: ProbationEvaluatorRole;
  scores: ProbationScorecard;
  recommendation: ProbationRecommendation | null;
};

export type ScoringInput = {
  feedbacks: FeedbackScoreInput[];
  sfeScore: number | null;
  hrScore: number | null;
};

export type ComponentResult = {
  key: ScoreComponentKey;
  /** Averaged component score (null if no data yet). */
  score: number | null;
  /** How many DV-Day feedbacks contributed (roles) / 1 for sfe|hr when present. */
  count: number;
  /** Required DV-Days for this role (undefined for sfe|hr). */
  requiredDvDays?: number;
  present: boolean;
  /** Requirement satisfied (enough DV-Days, or assessment submitted). */
  complete: boolean;
  weight: number;
  /** weight × score (null when not present). */
  weightedContribution: number | null;
};

export type ProbationScoreResult = {
  perDvDayScores: Array<{ dvDayId: string; role: ProbationEvaluatorRole; score: number | null }>;
  components: Record<ScoreComponentKey, ComponentResult>;
  presentWeightSum: number;
  totalWeightSum: number;
  /** Weighted score over PRESENT components, on the configured scale. Null if nothing present. */
  provisionalScore: number | null;
  /** Same value, exposed as final ONLY when decisionReady. */
  finalScore: number | null;
  decisionReady: boolean;
  status: "incomplete" | "complete";
  completeness: {
    requiredDvDays: number;
    completedDvDays: number;
    missingComponents: ScoreComponentKey[];
    missingByRole: Partial<Record<ProbationEvaluatorRole, number>>;
  };
};

const ROLE_KEYS: ProbationEvaluatorRole[] = ["dm", "tm", "pm_gpm", "nsm"];

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Mean of a scorecard's dimension scores (null if empty). */
export function meanScorecard(scores: ProbationScorecard): number | null {
  const values = Object.values(scores ?? {}).map(Number).filter((n) => Number.isFinite(n));
  if (values.length === 0) return null;
  return round(values.reduce((a, b) => a + b, 0) / values.length);
}

function averageOf(values: number[]): number | null {
  if (values.length === 0) return null;
  return round(values.reduce((a, b) => a + b, 0) / values.length);
}

export function computeProbationScore(input: ScoringInput, config: ProbationConfig): ProbationScoreResult {
  const weights = config.roleWeights;
  const requirements = config.requirements;

  // Per-DV-Day feedback scores.
  const perDvDayScores = input.feedbacks.map((f) => ({
    dvDayId: f.dvDayId,
    role: f.role,
    score: meanScorecard(f.scores),
  }));

  // Group DV-Day scores by role.
  const byRole = new Map<ProbationEvaluatorRole, number[]>();
  for (const key of ROLE_KEYS) byRole.set(key, []);
  for (const s of perDvDayScores) {
    if (s.score != null) byRole.get(s.role)?.push(s.score);
  }

  const components = {} as Record<ScoreComponentKey, ComponentResult>;

  // Field roles: component = average of that role's DV-Day scores; complete when enough DV-Days.
  for (const role of ROLE_KEYS) {
    const scores = byRole.get(role) ?? [];
    const required = requirements[role] ?? 0;
    const score = averageOf(scores);
    components[role] = {
      key: role,
      score,
      count: scores.length,
      requiredDvDays: required,
      present: score != null,
      // A role configured as not required (required <= 0) is satisfied by definition — otherwise it
      // would permanently block decision-readiness for the whole cohort.
      complete: required <= 0 ? true : scores.length >= required,
      weight: weights[role] ?? 0,
      weightedContribution: score != null ? round((weights[role] ?? 0) * score) : null,
    };
  }

  // SFE / HR: component = assessment score; complete when a score exists.
  const sfePresent = input.sfeScore != null;
  components.sfe = {
    key: "sfe", score: sfePresent ? round(Number(input.sfeScore)) : null, count: sfePresent ? 1 : 0,
    present: sfePresent, complete: sfePresent, weight: weights.sfe ?? 0,
    weightedContribution: sfePresent ? round((weights.sfe ?? 0) * Number(input.sfeScore)) : null,
  };
  const hrPresent = input.hrScore != null;
  components.hr = {
    key: "hr", score: hrPresent ? round(Number(input.hrScore)) : null, count: hrPresent ? 1 : 0,
    // When HR assessment is disabled by config it is "unavailable" (not required) — mirror the
    // read/submit layers so a disabled HR component does not permanently block decision-readiness.
    present: hrPresent, complete: config.hrAssessmentEnabled ? hrPresent : true, weight: weights.hr ?? 0,
    weightedContribution: hrPresent ? round((weights.hr ?? 0) * Number(input.hrScore)) : null,
  };

  const allKeys = Object.keys(components) as ScoreComponentKey[];
  const presentComponents = allKeys.filter((k) => components[k].present);
  const presentWeightSum = presentComponents.reduce((sum, k) => sum + components[k].weight, 0);
  const totalWeightSum = allKeys.reduce((sum, k) => sum + components[k].weight, 0);

  // Weighted average over PRESENT components (normalized so it's on the score scale).
  const weightedNumerator = presentComponents.reduce((sum, k) => sum + (components[k].weightedContribution ?? 0), 0);
  const provisionalScore = presentWeightSum > 0 ? round(weightedNumerator / presentWeightSum) : null;

  const decisionReady = allKeys.every((k) => components[k].complete);

  const requiredDvDays = ROLE_KEYS.reduce((sum, r) => sum + (requirements[r] ?? 0), 0);
  const completedDvDays = ROLE_KEYS.reduce((sum, r) => sum + Math.min(components[r].count, requirements[r] ?? 0), 0);
  const missingComponents = allKeys.filter((k) => !components[k].complete);
  const missingByRole: Partial<Record<ProbationEvaluatorRole, number>> = {};
  for (const r of ROLE_KEYS) {
    const gap = (requirements[r] ?? 0) - components[r].count;
    if (gap > 0) missingByRole[r] = gap;
  }

  return {
    perDvDayScores,
    components,
    presentWeightSum: round(presentWeightSum, 4),
    totalWeightSum: round(totalWeightSum, 4),
    provisionalScore,
    finalScore: decisionReady ? provisionalScore : null,
    decisionReady,
    status: decisionReady ? "complete" : "incomplete",
    completeness: { requiredDvDays, completedDvDays, missingComponents, missingByRole },
  };
}
