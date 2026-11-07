import type { OutstationCapturedLocationSummary } from "@/lib/outstation/types";

export type PayrollWorkflowAction =
  | "mark_part1_ready"
  | "mark_part1_paid"
  | "open_adjustments"
  | "mark_part2_ready"
  | "mark_review"
  | "approve"
  | "lock"
  | "reject"
  | "reopen";

export type SalaryBatch = {
  approvedAt: string | null;
  approvedBy: string | null;
  createdAt: string;
  fileName: string;
  id: string;
  lockedAt: string | null;
  month: number;
  part1PaidAt: string | null;
  part1PaidBy: string | null;
  part2ReadyAt: string | null;
  part2ReadyBy: string | null;
  rejectedReason: string | null;
  status: string;
  uploadedBy: string | null;
  year: number;
};

export type PayrollPeriodConflict = {
  batchId: string;
  fileName?: string;
  message: string;
  month: number;
  replaceable: boolean;
  status: string;
  year: number;
};

export type SalaryRecord = {
  area: string;
  batchId: string;
  /**
   * The FULL contractual base salary — never prorated (owner rule 2026-09-04).
   * Applies equally to grossSalary, netSalary, extraCostOfLiving and
   * fuelAllowance. What the employee is actually PAID for a part month is in
   * monthSalary/firstPart/secondPart; `workingDays` explains the difference.
   */
  baseSalary: number;
  bonus: number;
  /** Calendar days in the payroll period (28-31) — the proration denominator. */
  calendarDays: number;
  crm: number;
  employeeCode: string;
  hrId: string;
  employmentIncomeTax: number;
  expenses: number;
  extraCostOfLiving: number;
  fingerPrint: number;
  firstPart: number;
  fuelAllowance: number;
  fullName: string;
  governmentalDeductions: number;
  grossSalary: number;
  hireDate: string | null;
  nameAr: string | null;
  id: string;
  incentive: number;
  jobTitle: string;
  line: string;
  loans: number;
  medicalInsurance: number;
  monthSalary: number;
  netSalary: number;
  otherAdditions: number;
  otherDeductions: number;
  overtime: number;
  payrollComment: string | null;
  paymentMode: string;
  secondPart: number;
  socialInsurance: number;
  totalAdditions: number;
  totalDeductions: number;
  unpaidVacations: number;
  /**
   * Days of the period the employee was on payroll — the "Working Days" column.
   * Equals `calendarDays` for a regular employee (factor 1, nothing prorated).
   */
  workingDays: number;
};

export type SalaryFlag = {
  batchId: string;
  createdAt: string;
  hrId?: string | null;
  flagType: string;
  id: string;
  message: string;
  severity: "info" | "warning" | "critical" | string;
};

export type ExpenseTripRecord = {
  allowance: number;
  amWorkload: number;
  /** Raw GPS captured at submission — present only for Phoenix-submitted requests (same
   * "absent, not zero" rule as doctorVisits below: Excel-imported historical rows never
   * carry these). Resolved into `capturedLocation` at read time; see captured-location.ts. */
  capturedLatitude?: number | null;
  capturedLongitude?: number | null;
  /** Brick/area/region the captured GPS point resolves to, derived at read time from
   * capturedLatitude/capturedLongitude — see resolveOutstationCapturedLocation. Optional
   * because a historical row (or one still missing coordinates) has nothing to resolve. */
  capturedLocation?: OutstationCapturedLocationSummary | null;
  date: string;
  /** True when the departure photo's stored metadata carries a flag (taken far from the arrival
   * photo, after the trip, not live, …). Phoenix-submitted requests only; absent on an imported row.
   * Read by the Expense Approvals rail's "Needs a look" filter (expense-approval-triage.ts). */
  departurePhotoFlagged?: boolean;
  /** True when a departure photo is on file but holds no GPS position, so it could never be checked
   * against the arrival photo. Phoenix-submitted requests only. Read by the same rail filter. */
  departurePhotoNoGps?: boolean;
  description: string;
  /** Doctor/pharmacy/institution split of the trip's REGULAR CRM visits — display-only context,
   * present only for Phoenix-submitted outstation requests whose workload snapshot recorded it
   * (post pharmacy-split change). Excel-imported historical rows never carry these. */
  doctorVisits?: number;
  /** What the EMPLOYEE typed in the claim's notes box at submission (`outstation_expense_requests.notes`)
   * — present only on Phoenix-submitted requests, null when they typed nothing. Display-only: never
   * `description`, which falls back to a placeholder or the system's approval reason, and never
   * `hrComment`, which is HR's decision box. */
  employeeNote?: string | null;
  /** The allowance guard's sentences ("No allowance — a trip to Cairo from a regional base …"),
   * split out of the stored notes by parseOutstationDescription so the employee's note holds only
   * the employee's words. Display-only; Phoenix-submitted requests only. */
  allowanceNotices?: string[];
  hrId?: string | null;
  from: string;
  hr: string;
  hrNotes: string;
  institutionVisits?: number;
  km: number;
  location: string;
  meetingAmount: number;
  other: number;
  pharmacyVisits?: number;
  /** The third workload figure (AM · PM · Pharmacies). NULL/absent = not counted separately: a
   * trip stamped before the 2026-09-21 split (pharmacies still inside AM/PM), a hand-typed
   * workload, or an Excel row whose Pharmacy Workload cell is blank or whose sheet predates that
   * column. See outstationPharmacyWorkload. */
  pharmacyWorkload?: number | null;
  pmWorkload: number;
  requestType: string;
  /** The version of a Phoenix-submitted request this row was loaded at (its `updated_at`, see
   * claim-revision.ts). Present only on request rows; a decision on one is refused if the claim has
   * moved since, so a screen posts it back unchanged. Excel-imported historical rows never carry it. */
  requestRevision?: string;
  row: number;
  specialist: string;
  status: string;
  /** When the employee submitted the claim (`created_at`) — the queue's "awaiting N days" and
   * "Oldest first". Phoenix-submitted requests only; absent on an imported row. */
  submittedAt?: string;
  to: string;
  toDate: string;
  total: number;
  transportationType: string;
  travelCost: number;
  tripId: string;
  tripType: string;
  /** The stored `workload_match_status` (matched · partial · no_activity · manual · manual_override ·
   * stale_import). Phoenix-submitted requests only; absent on an imported row. Display and triage
   * only — it decides nothing about pay. */
  workloadMatchStatus?: string;
};

export type PayrollExpenseApproval = ExpenseTripRecord & {
  /** HR-approved payable figure. null = HR did not adjust the claim, so `total` is payable. */
  approvedAmount: number | null;
  approvedAt: string | null;
  approvedBy: string | null;
  hrId: string | null;
  hrApproved: boolean;
  hrComment: string;
  payoutMonth: number;
  payoutYear: number;
  reportId: string | null;
  sourceFileName: string;
};

export type PayrollExpenseReport = {
  approvedRows: number;
  createdAt: string;
  fileName: string;
  id: string;
  rowCount: number;
  totalExpenses: number;
  tripDateFrom: string | null;
  tripDateTo: string | null;
  updatedAt: string;
};

export type ExpenseSpecialistSummary = {
  allowance: number;
  meetingAmount: number;
  other: number;
  specialist: string;
  total: number;
  travelCost: number;
  trips: number;
};

export type ExpenseTemplateIdentity = {
  key: string;
  name: string;
  recognized: boolean;
};

export type ExpenseAnalysisValidation = {
  errors: string[];
  invalidRows: number;
  missingDestinationRows: number;
  missingHrIdRows: number;
  missingRequiredColumns: string[];
  missingTripDateRows: number;
  payrollReadyRows: number;
  recognizedColumns: number;
  requiredColumns: number;
  status: "failed" | "passed" | "warning";
  totalMismatchRows: number;
  totalRows: number;
  warnings: string[];
  zeroTotalRows: number;
};

export type ExpenseAnalysisResult = {
  columns: string[];
  fileName: string;
  template?: ExpenseTemplateIdentity;
  records: ExpenseTripRecord[];
  specialists: ExpenseSpecialistSummary[];
  summary: {
    confirmedByFinance: number;
    refusedByHr: number;
    specialists: number;
    systemApproved: number;
    totalAllowance: number;
    totalExpenses: number;
    totalKm: number;
    totalMeetingAmount: number;
    totalOther: number;
    totalTravelCost: number;
    trips: number;
  };
  validation: ExpenseAnalysisValidation;
  warnings: string[];
};

export type PayrollDashboardData = {
  batch: SalaryBatch | null;
  batches: SalaryBatch[];
  flags: SalaryFlag[];
  previousRecords: SalaryRecord[];
  records: SalaryRecord[];
  resignationCandidateCount: number;
  resignationCandidates: Array<{
    fullName: string;
    hrId: string;
    lastPayoutMonth: number;
    lastPayoutYear: number;
  }>;
  scope: "all_time" | "batch";
  summary: {
    anomalyCount: number;
    readinessRate: number;
    totalAdditions: number;
    totalEmployees: number;
    totalGovernmentDeductions: number;
    totalGross: number;
    totalNet: number;
  };
};
