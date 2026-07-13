export type TrafficStatus = "critical" | "warning" | "safe";

export type ProbationDvState = {
  dm_dv_done: boolean;
  dm_dv_done_at: string | null;
  dm_dv_done_manually: boolean;
  nsm_dv_done: boolean;
  nsm_dv_done_at: string | null;
  nsm_dv_done_manually: boolean;
  pm_gpm_dv_done: boolean | null; // null = CNS (not applicable)
  pm_gpm_dv_done_at: string | null;
  pm_gpm_dv_done_manually: boolean;
  tm_dv_done: boolean;
  tm_dv_done_at: string | null;
  tm_dv_done_manually: boolean;
};

export type ProbationRow = {
  allowedActions?: ProbationWorkflowAction[];
  area_name: string;
  crm_id: string;
  employment_status?: string;
  has_durable_probation_record?: boolean;
  days_remaining: number;
  dv_state?: ProbationDvState | null;
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
