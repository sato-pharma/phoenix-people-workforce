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
  bonus: number;
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
  grossSalary: number;
  hireDate: string | null;
  nameAr: string | null;
  id: string;
  incentive: number;
  jobTitle: string;
  line: string;
  loans: number;
  medicalInsurance: number;
  netSalary: number;
  otherAdditions: number;
  otherDeductions: number;
  overtime: number;
  payrollComment: string | null;
  secondPart: number;
  socialInsurance: number;
  totalAdditions: number;
  totalDeductions: number;
  unpaidVacations: number;
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
  date: string;
  description: string;
  hrId?: string | null;
  from: string;
  hr: string;
  hrNotes: string;
  km: number;
  location: string;
  meetingAmount: number;
  open: string;
  pmWorkload: number;
  requestType: string;
  row: number;
  specialist: string;
  status: string;
  to: string;
  toDate: string;
  total: number;
  transportationType: string;
  travelCost: number;
  tripId: string;
  tripType: string;
};

export type PayrollExpenseApproval = ExpenseTripRecord & {
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
  specialist: string;
  total: number;
  travelCost: number;
  trips: number;
};

export type ExpenseAnalysisResult = {
  columns: string[];
  fileName: string;
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
    totalTravelCost: number;
    trips: number;
  };
  warnings: string[];
};

export type PayrollDashboardData = {
  batch: SalaryBatch | null;
  batches: SalaryBatch[];
  flags: SalaryFlag[];
  previousRecords: SalaryRecord[];
  records: SalaryRecord[];
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
