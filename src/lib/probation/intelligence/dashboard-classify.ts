// Probation dashboard risk classification + exception flags (Phase 8, P8-T02/T03). Pure.
//
// Classification uses a text label ALONGSIDE the colour (never colour alone — accessibility).
//   Green  = On Track
//   Amber  = Action Required
//   Red    = Deadline Risk / Serious Concern
//   Grey   = Insufficient Data

export type RiskLevel = "green" | "amber" | "red" | "grey";

export const RISK_LABEL: Record<RiskLevel, string> = {
  green: "On Track",
  amber: "Action Required",
  red: "Deadline Risk / Serious Concern",
  grey: "Insufficient Data",
};

export type CaseSignals = {
  daysRemaining: number | null;
  dvRequired: number;
  dvFeedbackCompleted: number;
  feedbackOverdue: number;
  provisionalScore: number | null;
  decisionReady: boolean;
  hasHighContradiction: boolean;
  hrSubmitted: boolean;
  sfeSubmitted: boolean;
  day30: boolean;
  day60: boolean;
  day75: boolean;
  contradictionsCount: number;
};

export type ExceptionFlags = {
  onTrack: boolean;
  atRisk: boolean;
  seriousConcern: boolean;
  missingDvDays: boolean;
  pendingFeedback: boolean;
  overdueFeedback: boolean;
  day30Reached: boolean;
  day60Reached: boolean;
  day75Reached: boolean;
  hrPending: boolean;
  sfePending: boolean;
  contradictionsDetected: boolean;
  readyForDecision: boolean;
  insufficientData: boolean;
};

// Score bands (on the 1..10 scale).
const SERIOUS_CONCERN_SCORE = 4;
const ON_TRACK_SCORE = 7;
// A case is "deadline at risk" when it is close to the end with unmet DV requirements.
const DEADLINE_RISK_DAYS = 15;

export function classifyRisk(s: CaseSignals): RiskLevel {
  const dvGap = Math.max(0, s.dvRequired - s.dvFeedbackCompleted);
  const noData = s.provisionalScore == null && s.dvFeedbackCompleted === 0;
  if (noData) return "grey";

  // Red: overdue feedback, a serious-concern score, a high-severity contradiction, or a
  // deadline crunch (near the end with DV requirements still unmet).
  if (
    s.feedbackOverdue > 0 ||
    (s.provisionalScore != null && s.provisionalScore < SERIOUS_CONCERN_SCORE) ||
    s.hasHighContradiction ||
    (s.daysRemaining != null && s.daysRemaining <= DEADLINE_RISK_DAYS && dvGap > 0)
  ) {
    return "red";
  }

  // Green: decision-ready with a strong score and no open gaps, OR clearly on pace with no gaps.
  const noGaps = dvGap === 0 && s.hrSubmitted && s.sfeSubmitted;
  if (s.provisionalScore != null && s.provisionalScore >= ON_TRACK_SCORE && noGaps && s.contradictionsCount === 0) {
    return "green";
  }

  // Amber: anything with an open action (missing DV/feedback/HR/SFE, or a contradiction).
  return "amber";
}

export function exceptionFlags(s: CaseSignals): ExceptionFlags {
  const dvGap = Math.max(0, s.dvRequired - s.dvFeedbackCompleted);
  const risk = classifyRisk(s);
  return {
    onTrack: risk === "green",
    atRisk: risk === "amber" || risk === "red",
    seriousConcern: s.provisionalScore != null && s.provisionalScore < SERIOUS_CONCERN_SCORE,
    missingDvDays: dvGap > 0,
    pendingFeedback: s.dvFeedbackCompleted < s.dvRequired,
    overdueFeedback: s.feedbackOverdue > 0,
    day30Reached: s.day30,
    day60Reached: s.day60,
    day75Reached: s.day75,
    hrPending: !s.hrSubmitted,
    sfePending: !s.sfeSubmitted,
    contradictionsDetected: s.contradictionsCount > 0,
    readyForDecision: s.decisionReady,
    insufficientData: risk === "grey",
  };
}
