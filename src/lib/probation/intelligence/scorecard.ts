// Probation structured scorecard validation (Phase 4, P4-T03).
//
// A DV-Day feedback is a structured scorecard: every configured dimension scored on the
// configured integer scale (owner-locked 1..10), plus a required evaluator recommendation and
// supporting text. Vague feedback ("good"/"poor" with no scores) is rejected here. Pure logic.

import type { ProbationConfig } from "./config";
import type { ProbationRecommendation, ProbationScorecard } from "./types";

export const RECOMMENDATIONS: readonly ProbationRecommendation[] = [
  "on_track",
  "needs_improvement",
  "serious_concern",
];

export type ScorecardInput = {
  scores: Record<string, unknown>;
  recommendation?: string | null;
  strengths?: string | null;
  developmentAreas?: string | null;
  objectiveObservations?: string | null;
  confidentialNote?: string | null;
};

export type ScorecardValidation =
  | { ok: true; scores: ProbationScorecard; recommendation: ProbationRecommendation }
  | { ok: false; errors: string[] };

function isRecommendation(value: unknown): value is ProbationRecommendation {
  return typeof value === "string" && (RECOMMENDATIONS as readonly string[]).includes(value);
}

/**
 * Validate a scorecard submission against the config:
 *  - every configured dimension present with an INTEGER score within [min, max];
 *  - no unknown dimensions;
 *  - a valid recommendation;
 *  - at least one substantive supporting note (strengths or development areas) so a bare number
 *    can't stand alone.
 * Returns normalized {scores, recommendation} on success, else the list of errors.
 */
export function validateScorecard(input: ScorecardInput, config: ProbationConfig): ScorecardValidation {
  const errors: string[] = [];
  const { min, max } = config.scoringScale;
  const dimensions = config.scorecardDimensions;
  const scores: ProbationScorecard = {};

  const provided = input.scores && typeof input.scores === "object" ? input.scores : {};

  for (const dim of dimensions) {
    const raw = (provided as Record<string, unknown>)[dim];
    if (raw === undefined || raw === null || raw === "") {
      errors.push(`Missing score for "${dim}".`);
      continue;
    }
    const n = Number(raw);
    if (!Number.isInteger(n)) {
      errors.push(`Score for "${dim}" must be a whole number.`);
      continue;
    }
    if (n < min || n > max) {
      errors.push(`Score for "${dim}" must be between ${min} and ${max}.`);
      continue;
    }
    scores[dim] = n;
  }

  // Reject unknown dimensions (keeps the scorecard aligned to config).
  for (const key of Object.keys(provided)) {
    if (!dimensions.includes(key)) errors.push(`Unknown scorecard dimension "${key}".`);
  }

  if (!isRecommendation(input.recommendation)) {
    errors.push(`Recommendation must be one of: ${RECOMMENDATIONS.join(", ")}.`);
  }

  const hasNarrative =
    Boolean(input.strengths && input.strengths.trim()) ||
    Boolean(input.developmentAreas && input.developmentAreas.trim());
  if (!hasNarrative) {
    errors.push("Provide at least strengths or development areas (a score alone is not enough).");
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, scores, recommendation: input.recommendation as ProbationRecommendation };
}
