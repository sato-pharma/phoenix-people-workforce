import type { SalaryValidationRow } from "@/lib/payroll/salary-import";

/** Payroll period the Copilot assembles for. */
export type CopilotPeriod = { month: number; year: number };

export type CopilotRunStatus = "assembling" | "negotiating" | "drafted" | "cancelled";

/** The eight "not green" rules. See flags.ts for the exact signal per rule. */
export type CopilotFlagRule =
  | "pending_unapproved"
  | "joiner_leaver"
  | "attendance_conflict"
  | "salary_role_change"
  | "unpaid_leave"
  | "off_system"
  | "big_change"
  | "missing_data";

/** block = must resolve before materialize; warn = CEO may confirm as-is. */
export type CopilotFlagSeverity = "block" | "warn";

export type CopilotFlag = {
  employeeHrId: string;
  rule: CopilotFlagRule;
  severity: CopilotFlagSeverity;
  question: string;
};

/** An assembled employee row plus its Copilot metadata. */
export type CopilotDraftRow = {
  row: SalaryValidationRow;
  green: boolean;
  flags: CopilotFlag[];
};

/** Fields on a SalaryValidationRow the CEO may directly override via chat. */
export const COPILOT_OVERRIDE_FIELDS = [
  "bonus",
  "overtime",
  "otherAdditions",
  "loans",
  "otherDeductions",
  "unpaidVacations",
  // Auto-computed resignation/joiner settlement figures — overridable for a
  // one-off exception (e.g. negotiated severance); always explicit/audited.
  "baseSalary",
  "extraCostOfLiving",
  "fuelAllowance",
] as const;
export type CopilotOverrideField = (typeof COPILOT_OVERRIDE_FIELDS)[number];

/**
 * A structured instruction the deterministic engine can apply. The LLM only
 * PROPOSES these from the CEO's free text; it never computes money or writes
 * to the database directly. Every amount is applied by negotiation.ts.
 */
export type ProposedAction =
  | { kind: "bonus"; hrId: string; amount: number; reason: string }
  | { kind: "penalty"; hrId: string; amount: number; reason: string }
  | { kind: "loan"; hrId: string; monthlyAmount: number; installments: number; reason: string }
  | { kind: "advance"; hrId: string; amount: number; reason: string }
  | { kind: "prorate"; hrId: string; workedDays: number; reason: string }
  | { kind: "override"; hrId: string; field: CopilotOverrideField; value: number; reason: string }
  | { kind: "include"; hrId: string; reason?: string }
  | { kind: "defer"; hrId: string; reason?: string }
  | { kind: "confirm"; hrId: string; reason?: string };

export type ProposedActionKind = ProposedAction["kind"];

export type CopilotRun = {
  id: string;
  month: number;
  year: number;
  status: CopilotRunStatus;
  salaryBatchId: string | null;
  greenCount: number;
  flaggedCount: number;
  employeeCount: number;
  periodLabel: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CopilotFlagRecord = CopilotFlag & {
  id: string;
  runId: string;
  status: "open" | "answered" | "dismissed";
};

/** A persisted manual/resolved adjustment (audit of every draft change). */
export type CopilotAdjustment = {
  id: string;
  runId: string;
  employeeHrId: string;
  kind: ProposedActionKind;
  amount: number | null;
  field: string | null;
  workedDays: number | null;
  reason: string | null;
  recurringId: string | null;
  source: string;
  createdBy: string | null;
  createdAt: string;
};

export type RecurringAdjustment = {
  id: string;
  employeeHrId: string;
  kind: "loan" | "advance" | "allowance" | "penalty";
  monthlyAmount: number;
  remainingInstallments: number | null;
  startMonth: number;
  startYear: number;
  active: boolean;
  note: string | null;
};

/** Normalized per-employee feeder signals for the period (see feeders.ts). */
export type EmployeeFeederState = {
  unpaidLeaveDays: number;
  attendanceDeductionPending: boolean;
  leaverLastWorkingDate: string | null;
  /** Unpaid-leave days overlapping [period start, leaverLastWorkingDate] only — resignation Rule 1. */
  unpaidDaysBeforeLastWorkingDate: number;
  pendingExpense: boolean;
};

/** Minimal prior-period snapshot used for change/anomaly detection. */
export type PriorRecordSnapshot = {
  netSalary: number;
  baseSalary: number;
  line: string;
  jobTitle: string;
};
