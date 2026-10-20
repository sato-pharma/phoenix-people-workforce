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
  /**
   * "on_or_before_25" = day-rate proration of the whole net; "after_25" = full Base + ECoL + Fuel;
   * "non_resignation" = a company-ended departure, Base prorated with NEITHER allowance and no
   * >25th waiver (owner ruling 2026-08-14).
   */
  branch: "on_or_before_25" | "after_25" | "non_resignation";
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
   * re-derived in the UI. Null when the employee row carries no salary, and always null for the
   * seat that never sees one (ResignationDashboardData.settlementWithheld).
   */
  settlement: ResignationSettlementPreview | null;
  /**
   * Company devices this leaver has still not returned.
   *
   * IT SITS BESIDE THE SETTLEMENT ON PURPOSE. The custody receipt's return protocol states that
   * final dues are not paid before it is completed — «ولا يجوز صرف المستحقات النهائية قبل
   * استيفائه» — and البند (7) has the device returned «قبل استلام مستحقاتي النهائية». So the one
   * screen where somebody reads a settlement figure is the screen that has to show what is still
   * outstanding against it.
   *
   * IT IS A FLAG, NOT A BLOCK. Nothing here reduces a settlement or stops it being paid: البند (10)
   * caps any recovery at a value on a signed receipt, and how much to actually recover is a human
   * decision. Phoenix flags and a person decides — the same rule the expense module follows.
   *
   * Empty when the register holds nothing for them, and ALSO empty when the register could not be
   * read: `getOutstandingDevicesByEmployee` never throws, because this page is how somebody finds
   * out that a person left at all and must render without it.
   */
  outstandingDevices: Array<{
    assignmentId: string;
    assetTag: string;
    category: string;
    /** Serial or IMEI, whichever the device carries — what a police report asks for. */
    identifier: string;
    agreedValueEgp: number | null;
  }>;
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
  /**
   * Exit sub-classification independent of employeeStatus/reason — currently only
   * "declined_offer" (see src/lib/resignations/decline-offer-eligibility.ts). Null for
   * every ordinary resignation/termination.
   */
  exitCategory: string | null;
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
  /**
   * True for the seat that never sees a salary (isSalaryBlindRole). Every `settlement` is then null
   * and every device's `agreedValueEgp` is null BY WITHHOLDING, not because nothing is owed — so the
   * screen says so in a plain line and drops the money columns, and never prints a 0 or a dash in
   * their place. Absent or false: a null settlement still means the employee row carries no salary.
   */
  settlementWithheld?: boolean;
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

/**
 * The "declined offer / did not join" shortcut — an employee who backed out within
 * DECLINE_OFFER_WINDOW_DAYS of hiring. Distinct from CreateResignationInput: HR
 * chooses per case whether the person is entered into payroll for the days worked
 * (`includeInPayroll`), and the service resolves that to the employment_status the RPC
 * receives ("terminated" when true, "declined_offer" when false) — callers never pass
 * a raw status string.
 */
export type DeclineOfferInput = {
  employeeHrId: string;
  lastWorkingDate: string;
  note?: string | null;
  includeInPayroll: boolean;
  submittedDate?: string | null;
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
