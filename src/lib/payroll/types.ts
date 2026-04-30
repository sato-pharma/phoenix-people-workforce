export type PayrollWorkflowAction =
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
  rejectedReason: string | null;
  status: string;
  uploadedBy: string | null;
  year: number;
};

export type SalaryRecord = {
  area: string;
  batchId: string;
  bonus: number;
  crm: number;
  employeeCode: string;
  employmentIncomeTax: number;
  expenses: number;
  extraCostOfLiving: number;
  fingerPrint: number;
  firstPart: number;
  fuelAllowance: number;
  fullName: string;
  grossSalary: number;
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
  secondPart: number;
  socialInsurance: number;
  totalAdditions: number;
  totalDeductions: number;
  unpaidVacations: number;
};

export type SalaryFlag = {
  batchId: string;
  createdAt: string;
  employeeCode: string | null;
  flagType: string;
  id: string;
  message: string;
  severity: "info" | "warning" | "critical" | string;
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
