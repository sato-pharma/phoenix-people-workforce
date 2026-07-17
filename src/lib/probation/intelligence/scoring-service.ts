// Probation scoring service (Phase 6, P6-T06). Loads a case's captured evidence and runs the pure
// scoring + contradiction engines. Produces a PROVISIONAL, advisory readiness signal — it never
// decides an outcome (the human decision flow is Phase 10).

import { getSupabaseAdmin } from "@/lib/supabase/server";

import { getProbationConfig } from "./config";
import { computeProbationScore, type FeedbackScoreInput, type ProbationScoreResult } from "./scoring";
import { detectContradictions, type Contradiction } from "./contradictions";
import type { ProbationEvaluatorRole, ProbationRecommendation, ProbationScorecard } from "./types";

export type ProbationReadiness =
  | "not_decision_ready"
  | "lean_continue"
  | "review_recommended"
  | "lean_do_not_continue";

export type CaseScore = {
  caseId: string;
  score: ProbationScoreResult;
  contradictions: Contradiction[];
  /** Advisory only — NOT a decision. Reflects readiness + provisional band + contradictions. */
  provisionalReadiness: ProbationReadiness;
  generatedAt: string;
};

type FeedbackRow = {
  dv_day_id: string;
  evaluator_role: ProbationEvaluatorRole | null;
  scores: ProbationScorecard | null;
  recommendation: ProbationRecommendation | null;
};

type AssessmentRow = { kind: "sfe" | "hr"; score: number | null };

/** Band a decision-ready score into an advisory readiness label (never a decision). */
function readinessFrom(result: ProbationScoreResult, contradictions: Contradiction[]): ProbationReadiness {
  if (!result.decisionReady || result.finalScore == null) return "not_decision_ready";
  const hasHigh = contradictions.some((c) => c.severity === "high");
  if (result.finalScore >= 7 && !hasHigh) return "lean_continue";
  if (result.finalScore < 4) return "lean_do_not_continue";
  return "review_recommended";
}

export async function getCaseScore(
  caseId: string,
  generatedAt: string = new Date().toISOString(),
): Promise<CaseScore> {
  const supabase = getSupabaseAdmin();
  const config = await getProbationConfig();

  // Only completed feedback (feedback rows exist once submitted) contributes.
  const { data: feedbackData, error: fErr } = await supabase
    .from("probation_feedback")
    .select("dv_day_id, evaluator_role, scores, recommendation")
    .eq("case_id", caseId);
  if (fErr) throw new Error(fErr.message);

  const feedbacks: FeedbackScoreInput[] = ((feedbackData ?? []) as FeedbackRow[])
    .filter((r): r is FeedbackRow & { evaluator_role: ProbationEvaluatorRole } => r.evaluator_role != null)
    .map((r) => ({
      dvDayId: r.dv_day_id,
      role: r.evaluator_role,
      scores: r.scores ?? {},
      recommendation: r.recommendation,
    }));

  const { data: assessData, error: aErr } = await supabase
    .from("probation_assessments")
    .select("kind, score")
    .eq("case_id", caseId)
    .eq("status", "submitted");
  if (aErr) throw new Error(aErr.message);

  const assessments = (assessData ?? []) as AssessmentRow[];
  const sfeScore = assessments.find((a) => a.kind === "sfe")?.score ?? null;
  const hrScore = assessments.find((a) => a.kind === "hr")?.score ?? null;

  const score = computeProbationScore({ feedbacks, sfeScore, hrScore }, config);
  const contradictions = detectContradictions(score, feedbacks);
  const provisionalReadiness = readinessFrom(score, contradictions);

  return { caseId, score, contradictions, provisionalReadiness, generatedAt };
}
