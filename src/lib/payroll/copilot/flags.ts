import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { roundCurrency } from "@/lib/payroll/money";
import type { SalaryValidationRow } from "@/lib/payroll/salary-import";
import type { PayrollSalarySource } from "@/lib/payroll/salary-source-model";

import { dayOfMonth, isInPeriod } from "./proration.ts";
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

  // 2. joiner_leaver — the settlement is now fully auto-computed by assemble.ts
  // (day-25/day-15 cutoffs, Base-only day-rate, Part1/Part2 clawback), so this
  // warns for confirmation rather than blocking, showing the computed result.
  // Stays a block only when the date itself can't be parsed at all — nothing
  // was computed, so this genuinely needs a human to fix the data first.
  const isJoiner = isInPeriod(employee.hireDate, period);
  const leaverDate = feeder?.leaverLastWorkingDate ?? null;
  const isLeaver = Boolean(leaverDate);
  if (isJoiner) {
    const settlementComputable = employee.hireDate != null && dayOfMonth(employee.hireDate) != null;
    flags.push({
      employeeHrId: row.hrId,
      rule: "joiner_leaver",
      severity: settlementComputable ? "warn" : "block",
      question: settlementComputable
        ? `${name} joined on ${employee.hireDate} — a partial month. Settlement auto-calculated: EGP ${money(row.monthSalary)} this month. Confirm or override.`
        : `${name} joined on ${employee.hireDate} — a partial month, but the hire date couldn't be parsed. Enter or confirm the exact hire date before including them.`,
    });
  } else if (leaverDate) {
    const settlementComputable = dayOfMonth(leaverDate) != null;
    flags.push({
      employeeHrId: row.hrId,
      rule: "joiner_leaver",
      severity: settlementComputable ? "warn" : "block",
      question: settlementComputable
        ? `${name} is leaving (last working day ${leaverDate}). Settlement auto-calculated: EGP ${money(row.monthSalary)} this month. Confirm or override.`
        : `${name} is leaving, but the last working date couldn't be parsed. Enter or confirm the exact date before including them.`,
    });
  }

  // 5. unpaid_leave (block) — reduces salary; needs an amount. Skipped for a
  // leaver: resignation Rule 1 already nets unpaid days out of daysWorked
  // automatically, so asking again here would be redundant/confusing.
  const unpaidDays = feeder?.unpaidLeaveDays ?? 0;
  if (unpaidDays > 0 && row.unpaidVacations <= 0 && !isLeaver) {
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

  // 4. salary_role_change (warn) — base/line/role differs from last month.
  // Skipped for a joiner/leaver: their base this month is a deliberate
  // settlement figure (Rule 1/2), already explained by the joiner_leaver flag
  // above, not an unexplained anomaly.
  if (prior && !isJoiner && !isLeaver) {
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

  // 7. big_change (warn) — net swings sharply vs last month. Skipped for a
  // joiner/leaver: a partial-month swing is expected and already explained.
  if (prior && prior.netSalary > 0 && !isJoiner && !isLeaver) {
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
