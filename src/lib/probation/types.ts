export type TrafficStatus = "critical" | "warning" | "safe";

export type ProbationRow = {
  allowedActions?: ProbationWorkflowAction[];
  area_name: string;
  crm_id: string;
  employment_status?: string;
  has_durable_probation_record?: boolean;
  days_remaining: number;
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
  | "extended"
  | "passed"
  | "terminated";

export type ProbationDecision = "pass" | "extend" | "terminate";

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
  extensionEndDate: string | null;
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
