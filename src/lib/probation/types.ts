export type TrafficStatus = "critical" | "warning" | "safe";

/** The tracker's zones: the three day-count zones, plus a probation that ended with no decision. */
export type ProbationZone = TrafficStatus | "overdue";

// A `ProbationDvState` type, and the `dv_state` field on ProbationRow that carried it, stood here
// until 2026-09-01: twelve booleans and timestamps projected from `employee_probation`'s DV
// checkbox columns. That table stopped being filled when the Case model took over provisioning, so
// `dv_state` was `null` on every row it ever produced, and its last two readers went with the
// legacy feedback panels (#2844) and the DV watchlist (#2846).
//
// Probation DV state now lives in `probation_dv_days`, read through
// src/lib/probation/intelligence/dv-progress-lookup.ts. The database columns are LEFT IN PLACE --
// nothing reads them, dropping them would be a production migration, and they are the only record
// of what the checkbox era captured.

export type ProbationRow = {
  allowedActions?: ProbationWorkflowAction[];
  area_name: string;
  crm_id: string;
  employment_status?: string;
  /** Only what the "left" word beside their name needs. Leaving closes and decides nothing here. */
  last_working_date?: string | null;
  has_durable_probation_record?: boolean;
  days_remaining: number;
  /**
   * True only on a tracker row (`getProbationTrackerRows`): the probation END DATE HAS PASSED, the
   * employee is still employed and the case is open with no pass/terminate decision. `days_remaining`
   * is zero or negative on these rows; `getProbationRows` never returns one.
   */
  overdue_decision?: boolean;
  full_name: string;
  hire_date: string;
  hr_id: string;
  job_title: string;
  line_name: string;
  manager_hr_id?: string | null;
  manager_name?: string | null;
  manager_manager_hr_id?: string | null;
  manager_manager_name?: string | null;
  probation_end_date: string;
  probation_id?: string | null;
  team_name?: string | null;
  workflow?: ProbationWorkflowRecord | null;
};

export type ProbationWorkflowStatus =
  | "active"
  | "passed"
  | "terminated";

// `extend` intentionally removed by owner policy — probation is a fixed 90-day window with no
// extension. Supported final decisions are pass or terminate only.
export type ProbationDecision = "pass" | "terminate";

export type ProbationWorkflowAction =
  | "manager_feedback"
  | "pass"
  | "terminate";

export type ProbationReminderRecipient = {
  email: string | null;
  hrId: string;
  name: string | null;
  role: "HR Pilot Approver" | "Direct Manager" | "Manager of Manager";
};

export type ProbationWorkflowRecord = {
  allowedActions?: ProbationWorkflowAction[];
  id: string;
  employeeHrId: string;
  employeeName: string;
  jobTitle: string | null;
  lineName: string | null;
  areaName: string | null;
  probationId: string | null;
  probationEndDate: string;
  evaluationScores: Record<string, number | string | null>;
  managerFeedback: string | null;
  hrRecommendation: string | null;
  decision: ProbationDecision | null;
  decisionReason: string | null;
  probationLetterUrl: string | null;
  probationLetterName: string | null;
  workflowNotes: string | null;
  status: ProbationWorkflowStatus;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  managerReviewedAt: string | null;
  managerReviewedBy: string | null;
  hrReviewedAt: string | null;
  hrReviewedBy: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  completedAt: string | null;
  completedBy: string | null;
};

export type ProbationFeedbackReportRow = {
  areaName: string;
  directManager: string;
  directManagerHrId: string | null;
  employeeHrId: string;
  employeeName: string;
  feedbackDate: string | null;
  feedbackStatus: "pending" | "submitted";
  feedbackSubmittedBy: string | null;
  feedbackText: string | null;
  hireDate: string;
  lineName: string;
  managerOfManager: string;
  managerOfManagerHrId: string | null;
  probationDayStatus: string;
  recommendation: string | null;
  teamName: string;
};

export type CreateProbationEvaluationInput = {
  employeeHrId: string;
  evaluationScores?: Record<string, number | string | null>;
  managerFeedback?: string | null;
  workflowNotes?: string | null;
};
