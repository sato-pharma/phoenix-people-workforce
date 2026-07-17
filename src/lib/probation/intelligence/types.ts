// Probation Decision Intelligence — domain types (Phase 1).
//
// One-to-one with the tables in migration 20260713130000_probation_intelligence_domain.sql.
// These are the camelCase domain shapes; DB rows are snake_case and mapped in the repo layer.

/** Required-role slugs a DV-Day / feedback can count toward. */
export type ProbationEvaluatorRole = "dm" | "tm" | "pm_gpm" | "nsm";

/** Assessment kinds outside the field-DV flow. */
export type ProbationAssessmentKind = "sfe" | "hr";

/** Case lifecycle (distinct from the final human decision). */
export type ProbationCaseStatus = "active" | "decided" | "cancelled";

/** Final human decision. `extend` is intentionally absent — removed by owner policy. */
export type ProbationCaseDecision = "pass" | "terminate";

/** DV-Day validation lifecycle (spec-mandated). */
export type ProbationDvStatus =
  | "detected"
  | "validation_pending"
  | "validated"
  | "feedback_pending"
  | "feedback_completed"
  | "rejected"
  | "duplicate"
  | "invalid"
  | "manually_reviewed";

/** Structured evaluator recommendation outcomes. */
export type ProbationRecommendation = "on_track" | "needs_improvement" | "serious_concern";

export type ProbationFeedbackStatus = "submitted" | "edited";
export type ProbationAssessmentStatus = "pending" | "submitted" | "unavailable";
export type ProbationDevelopmentActionStatus = "open" | "in_progress" | "done" | "cancelled";
export type ProbationAmPm = "AM" | "PM";

export type ProbationCase = {
  id: string;
  employeeHrId: string;
  employeeName: string | null;
  jobTitle: string | null;
  lineName: string | null;
  areaName: string | null;
  managerHrId: string | null;
  hireDate: string | null;
  probationStartDate: string | null;
  probationEndDate: string | null;
  status: ProbationCaseStatus;
  decision: ProbationCaseDecision | null;
  decisionReason: string | null;
  decisionBy: string | null;
  decisionAt: string | null;
  evidenceAcknowledged: boolean;
  sideEffectsAppliedAt: string | null;
  legacyProbationId: number | null;
  source: string;
  lastCrmSyncAt: string | null;
  lastReportUpdateAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProbationDvDay = {
  id: string;
  caseId: string | null;
  employeeHrId: string;
  evaluatorHrId: string | null;
  evaluatorRole: ProbationEvaluatorRole | null;
  dvDate: string;
  ampm: ProbationAmPm | null;
  areaName: string | null;
  visitCount: number;
  dvStatus: ProbationDvStatus;
  validationReason: string | null;
  crmSourceIds: number[];
  syncedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProbationDvVisit = {
  id: string;
  dvDayId: string;
  crmVisitId: number | null;
  contactName: string | null;
  customerName: string | null;
  comment: string | null;
  visitType: number | null;
  visitTypeDescription: string | null;
  ampm: string | null;
  visitDate: string | null;
  createdAt: string;
};

/** Scorecard payload: { dimensionKey: score-on-configured-scale }. */
export type ProbationScorecard = Record<string, number>;

export type ProbationFeedback = {
  id: string;
  dvDayId: string;
  caseId: string | null;
  employeeHrId: string;
  evaluatorHrId: string;
  evaluatorRole: ProbationEvaluatorRole | null;
  scores: ProbationScorecard;
  strengths: string | null;
  developmentAreas: string | null;
  objectiveObservations: string | null;
  recommendation: ProbationRecommendation | null;
  confidentialNote: string | null;
  status: ProbationFeedbackStatus;
  currentVersion: number;
  submittedBy: string | null;
  submittedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type ProbationFeedbackVersion = {
  id: string;
  feedbackId: string;
  versionNumber: number;
  action: "submit" | "edit";
  editedBy: string | null;
  editReason: string | null;
  snapshot: Record<string, unknown>;
  scores: ProbationScorecard;
  recommendation: ProbationRecommendation | null;
  createdAt: string;
};

export type ProbationAssessment = {
  id: string;
  caseId: string;
  employeeHrId: string;
  kind: ProbationAssessmentKind;
  systemEvidence: Record<string, unknown>;
  score: number | null;
  comments: string | null;
  overrides: Record<string, unknown>;
  overrideReason: string | null;
  confidentialNote: string | null;
  status: ProbationAssessmentStatus;
  submittedBy: string | null;
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProbationDevelopmentAction = {
  id: string;
  caseId: string;
  dvDayId: string | null;
  employeeHrId: string;
  title: string;
  description: string | null;
  ownerHrId: string | null;
  dueDate: string | null;
  scoreCategory: string | null;
  status: ProbationDevelopmentActionStatus;
  followUpOutcome: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};
