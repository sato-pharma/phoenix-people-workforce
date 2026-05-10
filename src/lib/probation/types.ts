export type TrafficStatus = "critical" | "warning" | "safe";

export type ProbationRow = {
  area_name: string;
  crm_id: string;
  employment_status?: string;
  days_remaining: number;
  full_name: string;
  hire_date: string;
  hr_id: string;
  job_title: string;
  line_name: string;
  probation_end_date: string;
  probation_id?: string | null;
  workflow?: ProbationWorkflowRecord | null;
};

export type ProbationWorkflowStatus =
  | "evaluation_requested"
  | "manager_feedback"
  | "hr_recommendation"
  | "approved"
  | "completed"
  | "cancelled";

export type ProbationDecision = "pass" | "extend" | "terminate";

export type ProbationWorkflowAction =
  | "manager_feedback"
  | "hr_recommendation"
  | "approve_pass"
  | "approve_extend"
  | "approve_terminate"
  | "upload_letter"
  | "complete"
  | "cancel"
  | "reopen";

export type ProbationWorkflowRecord = {
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

export type CreateProbationEvaluationInput = {
  employeeHrId: string;
  probationEndDate?: string | null;
  evaluationScores?: Record<string, number | string | null>;
  managerFeedback?: string | null;
  workflowNotes?: string | null;
};
