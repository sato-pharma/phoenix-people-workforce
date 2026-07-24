// Recruitment / ATS — interview scorecards (pure, unit-tested).
//
// Criteria per interview type mirror the recruitment spec (HR behavioural,
// hiring-manager technical, phone screen). Ratings are 1-5. These helpers
// normalize and summarize a score map; the service persists them as jsonb.

import type { InterviewType } from "@/lib/recruitment/types";

export type ScorecardCriterion = { key: string; label: string };

export const interviewScorecardCriteria: Record<InterviewType, ScorecardCriterion[]> = {
  phone: [
    { key: "communication", label: "Communication" },
    { key: "interest", label: "Interest level" },
    { key: "availability", label: "Availability" },
  ],
  hr: [
    { key: "communication", label: "Communication" },
    { key: "motivation", label: "Motivation" },
    { key: "professionalism", label: "Professionalism" },
    { key: "stability", label: "Stability" },
    { key: "career_goals", label: "Career goals" },
  ],
  hiring_manager: [
    { key: "territory_knowledge", label: "Territory knowledge" },
    { key: "sales_skills", label: "Sales skills" },
    { key: "business_awareness", label: "Business awareness" },
    { key: "product_knowledge", label: "Product knowledge" },
    { key: "customer_handling", label: "Customer handling" },
  ],
  // Rule 5 — CV screening review criteria (all rated 1-5).
  cv: [
    { key: "education", label: "Education" },
    { key: "area_match", label: "Area Match" },
    { key: "experience", label: "Experience" },
    { key: "industry_background", label: "Industry Background" },
    { key: "salary_expectation", label: "Salary Expectation" },
    { key: "stability", label: "Stability" },
  ],
  // NSM/RM/CEO tracking rounds — deliberately no numeric scorecard, free-text notes only.
  rm_interview: [],
  nsm_interview: [],
  ceo_interview: [],
};

export const interviewOutcomes = [
  "recommended",
  "hold",
  "on_hold",
  "rejected",
  "passed",
  "failed",
  "no_response",
  "call_back",
  // Rule 5 — CV screening outcomes
  "shortlisted",
  "need_phone_screening",
] as const;
export type InterviewOutcome = (typeof interviewOutcomes)[number];

export const minRating = 1;
export const maxRating = 5;

export function isInterviewOutcome(value: unknown): value is InterviewOutcome {
  return typeof value === "string" && (interviewOutcomes as readonly string[]).includes(value);
}

// Keep only criteria valid for the interview type; clamp ratings to [1,5],
// drop anything non-numeric or out of range.
export function normalizeScorecard(type: InterviewType, raw: unknown): Record<string, number> {
  const allowed = new Set((interviewScorecardCriteria[type] ?? []).map((criterion) => criterion.key));
  const out: Record<string, number> = {};
  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!allowed.has(key)) continue;
      const rating = Math.round(Number(value));
      if (Number.isFinite(rating) && rating >= minRating && rating <= maxRating) {
        out[key] = rating;
      }
    }
  }
  return out;
}

export type ScorecardSummary = {
  entries: Array<{ key: string; label: string; rating: number | null }>;
  average: number | null;
  ratedCount: number;
  totalCriteria: number;
};

export function summarizeScorecard(type: InterviewType, scores: Record<string, unknown>): ScorecardSummary {
  const criteria = interviewScorecardCriteria[type] ?? [];
  const entries = criteria.map((criterion) => ({
    key: criterion.key,
    label: criterion.label,
    rating: typeof scores[criterion.key] === "number" ? (scores[criterion.key] as number) : null,
  }));
  const rated = entries.filter((entry): entry is { key: string; label: string; rating: number } => entry.rating !== null);
  const average =
    rated.length > 0
      ? Math.round((rated.reduce((sum, entry) => sum + entry.rating, 0) / rated.length) * 10) / 10
      : null;
  return { entries, average, ratedCount: rated.length, totalCriteria: criteria.length };
}
