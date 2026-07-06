import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { roundCurrency } from "@/lib/payroll/money";
import type { SalaryValidationRow } from "@/lib/payroll/salary-import";
import type { PayrollSalarySource } from "@/lib/payroll/salary-source-model";

import type {
  CopilotFlag,
  CopilotPeriod,
  EmployeeFeederState,
  PriorRecordSnapshot,
} from "./types.ts";

/**
 * The green / not-green engine.
 *
 * Seven rules auto-fire from real module signals below. The eighth rule,
 * `off_system`, is not auto-detected — it is the channel through which the CEO
 * ADDS a manual bonus/penalty/loan/advance in chat (recorded as an adjustment,
 * not a detected flag). Recurring items auto-apply silently and do NOT flag the
 * employee; they are surfaced separately in the run summary.
 *
 * A person is "green" (auto-filled, no question) when this returns [].
 */

const CHANGE_TOLERANCE = 1;

function changed(a: number, b: number): boolean {
  return Math.abs(roundCurrency(a) - roundCurrency(b)) > CHANGE_TOLERANCE;
}

function money(value: number): string {
  return roundCurrency(value).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function isInPeriod(dateText: string | null, period: CopilotPeriod): boolean {
  if (!dateText) return false;
  const match = /^(\d{4})-(\d{2})/.exec(dateText.trim());
  if (!match) return false;
  return Number(match[1]) === period.year && Number(match[2]) === period.month;
}

export function evaluateEmployeeFlags(input: {
  row: SalaryValidationRow;
  employee: EmployeeDirectoryRow;
  source: PayrollSalarySource | undefined;
  prior: PriorRecordSnapshot | null;
  feeder: EmployeeFeederState | undefined;
  period: CopilotPeriod;
  bigChangeThreshold: number;
}): CopilotFlag[] {
  const { row, employee, source, prior, feeder, period, bigChangeThreshold } = input;
  const flags: CopilotFlag[] = [];
  const name = row.fullName || row.hrId;

  // 8. missing_data (block) — no/incomplete compensation to pay from.
  const incompleteSource =
    !source || source.baseSalary === null || row.grossSalary <= 0 || row.netSalary <= 0;
  if (incompleteSource) {
    flags.push({
      employeeHrId: row.hrId,
      rule: "missing_data",
      severity: "block",
      question: `${name} (${row.hrId}) has no or incomplete compensation data (base/gross/net). Enter or confirm the figures before including them.`,
    });
  }

  // 2. joiner_leaver (block) — proration / final settlement needed.
  const isJoiner = isInPeriod(employee.hireDate, period);
  const leaverDate = feeder?.leaverLastWorkingDate ?? null;
  if (isJoiner) {
    flags.push({
      employeeHrId: row.hrId,
      rule: "joiner_leaver",
      severity: "block",
      question: `${name} joined on ${employee.hireDate} — a partial month. How many days should they be paid (prorate), or pay a full month?`,
    });
  } else if (leaverDate) {
    flags.push({
      employeeHrId: row.hrId,
      rule: "joiner_leaver",
      severity: "block",
      question: `${name} is leaving (last working day ${leaverDate}). Confirm the final settlement — days to pay and any final deductions.`,
    });
  }

  // 5. unpaid_leave (block) — reduces salary; needs an amount.
  const unpaidDays = feeder?.unpaidLeaveDays ?? 0;
  if (unpaidDays > 0 && row.unpaidVacations <= 0) {
    flags.push({
      employeeHrId: row.hrId,
      rule: "unpaid_leave",
      severity: "block",
      question: `${name} has ${unpaidDays} unpaid leave day(s) this month. How much should be deducted (or prorate to worked days)?`,
    });
  }

  // 3. attendance_conflict (warn) — pending attendance-device deduction.
  if (feeder?.attendanceDeductionPending) {
    flags.push({
      employeeHrId: row.hrId,
      rule: "attendance_conflict",
      severity: "warn",
      question: `${name} has an attendance deduction awaiting governance approval. Deduct now, wait for approval, or waive it?`,
    });
  }

  // 1. pending_unapproved (warn) — expense tied to this period not yet approved.
  if (feeder?.pendingExpense) {
    flags.push({
      employeeHrId: row.hrId,
      rule: "pending_unapproved",
      severity: "warn",
      question: `${name} has an expense for this period that is not yet HR-approved. Include it once approved, or defer to next month?`,
    });
  }

  // 4. salary_role_change (warn) — base/line/role differs from last month.
  if (prior) {
    const baseChanged = changed(prior.baseSalary, row.baseSalary);
    const lineChanged = (prior.line || "") !== (row.line || "");
    const roleChanged = (prior.jobTitle || "") !== (row.jobTitle || "");
    if (baseChanged || lineChanged || roleChanged) {
      const parts: string[] = [];
      if (baseChanged) parts.push(`base salary ${money(prior.baseSalary)} → ${money(row.baseSalary)}`);
      if (lineChanged) parts.push(`line ${prior.line || "—"} → ${row.line || "—"}`);
      if (roleChanged) parts.push(`role ${prior.jobTitle || "—"} → ${row.jobTitle || "—"}`);
      flags.push({
        employeeHrId: row.hrId,
        rule: "salary_role_change",
        severity: "warn",
        question: `${name} changed since last month (${parts.join("; ")}). Confirm which figure applies this month.`,
      });
    }
  }

  // 7. big_change (warn) — net swings sharply vs last month.
  if (prior && prior.netSalary > 0) {
    const swing = Math.abs(row.netSalary - prior.netSalary) / prior.netSalary;
    if (swing > bigChangeThreshold) {
      flags.push({
        employeeHrId: row.hrId,
        rule: "big_change",
        severity: "warn",
        question: `${name}'s net pay moved ${(swing * 100).toFixed(0)}% (${money(prior.netSalary)} → ${money(row.netSalary)}) vs last month. Confirm this is correct.`,
      });
    }
  }

  return flags;
}
