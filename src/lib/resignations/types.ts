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

export type ResignationSettlementPreview = {
  /** The employee's full monthly base salary (not prorated). */
  baseSalary: number;
  /** Days paid in the resignation month under Rule 1. */
  daysWorked: number;
  /** "on_or_before_25" = Base-only day-rate proration; "after_25" = full Base + ECoL + Fuel. */
  branch: "on_or_before_25" | "after_25";
  /** Payable this month before other deductions. */
  total: number;
  firstPart: number;
  secondPart: number;
  paymentMode: "one_part" | "two_parts";
  /** True when Part 1 alone covers the whole settlement (secondPart is zero). */
  coveredByFirstPart: boolean;
};

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
   * Human name for `createdBy`, resolved by getResignationsDashboardData straight from the
   * employees table — NOT from getEmployeeDirectory(), which omits the PHX-1 / ADMIN-HR system
   * accounts that authored 32 of the 38 production records. Null only when the id names nobody.
   */
  createdByName: string | null;
  /**
   * The employee's hire date, resolved by getResignationsDashboardData from the employees table.
   * Not from getEmployeeDirectory() — that omits resigned people, which is nearly every subject
   * on this page.
   */
  hireDate: string | null;
  /**
   * Settlement preview for the month the employee resigned in — BEFORE fingerprint, medical
   * insurance and every other deduction. Computed server-side by getResignationsDashboardData
   * from the owner-locked helpers (computeResignationSettlement + calculateBasicSalary), never
   * re-derived in the UI. Null when the employee row carries no salary.
   */
  settlement: ResignationSettlementPreview | null;
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
