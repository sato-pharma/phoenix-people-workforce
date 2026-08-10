export type ResignationStatus =
  | "submitted"
  | "under_review"
  | "approved"
  | "rejected"
  | "completed"
  | "cancelled";

export type ResignationWorkflowAction =
  | "mark_review"
  | "approve"
  | "reject"
  | "complete"
  | "cancel"
  | "reopen";

export type ResignationRecord = {
  id: string;
  employeeHrId: string;
  employeeName: string;
  employeeStatus?: string | null;
  jobTitle: string | null;
  lineName: string | null;
  submittedDate: string;
  effectiveDate: string;
  reason: string | null;
  workflowNotes: string | null;
  status: ResignationStatus;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  /**
   * Human name for `createdBy`, resolved from the employee directory by
   * getResignationsDashboardData — the only read path that already holds the employee map.
   * Null when the actor is not a directory row (a system account or a deleted employee); the UI
   * then falls back to the raw HR_ID rather than showing nothing.
   */
  createdByName: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  rejectedAt: string | null;
  rejectedBy: string | null;
  rejectedReason: string | null;
  completedAt: string | null;
  completedBy: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
};

export type PayrollResignationCandidateRecord = {
  id: string;
  areaName: string | null;
  createdBy: string | null;
  employeeName: string;
  hireDate: string | null;
  hrId: string;
  jobTitle: string | null;
  lastPayoutMonth: number;
  lastPayoutYear: number;
  lineName: string | null;
  nameAr: string | null;
  sourceFileName: string | null;
  sourceRow: number | null;
  firstSeenAt: string;
  lastSeenAt: string;
  updatedAt: string;
};

export type ResignationEmployeeOption = {
  value: string;
  label: string;
  jobTitle: string | null;
  lineName: string | null;
};

export type ResignationDashboardData = {
  employees: ResignationEmployeeOption[];
  payrollCandidates: PayrollResignationCandidateRecord[];
  records: ResignationRecord[];
  summary: {
    active: number;
    approved: number;
    completed: number;
    payrollCandidates: number;
    pending: number;
    total: number;
  };
};

export type CreateResignationInput = {
  employeeHrId: string;
  submittedDate: string;
  effectiveDate: string;
  lastWorkingDate?: string | null;
  last_working_date?: string | null;
  submitted_date?: string | null;
  effective_date?: string | null;
  reason?: string | null;
  workflowNotes?: string | null;
};

export type EmployeeResignationInput = CreateResignationInput & {
  employeeStatus?: string | null;
};

export type UpdateResignationDatesInput = Partial<
  Pick<
    CreateResignationInput,
    | "effective_date"
    | "effectiveDate"
    | "last_working_date"
    | "lastWorkingDate"
    | "submitted_date"
    | "submittedDate"
  >
> & {
  resignationDate?: string | null;
};
