import { strict as assert } from "node:assert";

import {
  calculateDeductionAmountFromBaseSalary,
  isDeductionsGovernanceDecisionActor,
  payrollColumnForDeduction,
} from "../src/lib/deductions-governance/calculations.ts";
import { __attendanceDeviceConnectorTestables } from "../src/lib/deductions-governance/connectors/attendance-device.ts";
import { __vacationDeductionConnectorTestables } from "../src/lib/deductions-governance/connectors/vacation.ts";
import {
  buildDeductionsPayrollPreview,
} from "../src/lib/deductions-governance/payroll-handoff.ts";
import type {
  DeductionMonthlySummary,
  DeductionMonthlySummaryLine,
} from "../src/lib/deductions-governance/types.ts";
import {
  isFieldWorkforceWeeklyOff,
} from "../src/lib/field-workforce-compliance/weekend-policy.ts";

function summary(overrides: Partial<DeductionMonthlySummary> = {}): DeductionMonthlySummary {
  return {
    id: "summary-1",
    monthKey: "2026-05",
    month: 5,
    year: 2026,
    status: "finalized",
    finalizedBy: "admin-HR",
    finalizedAt: "2026-05-31T12:00:00.000Z",
    candidateCount: 2,
    employeeCount: 2,
    totalDays: 2,
    totalAmount: 220,
    sourceCounts: {},
    notes: null,
    createdAt: "2026-05-31T12:00:00.000Z",
    ...overrides,
  };
}

function line(overrides: Partial<DeductionMonthlySummaryLine>): DeductionMonthlySummaryLine {
  return {
    id: overrides.id ?? "line-1",
    summaryId: "summary-1",
    candidateId: overrides.candidateId ?? "candidate-1",
    decisionId: overrides.decisionId ?? "decision-1",
    employeeCode: overrides.employeeCode ?? "A-1",
    employeeHrIdCompact: overrides.employeeHrIdCompact ?? "a1",
    employeeName: overrides.employeeName ?? "Employee One",
    monthKey: "2026-05",
    sourceModule: overrides.sourceModule ?? "FIELD_WORKFORCE",
    deductionType: overrides.deductionType ?? "no_activity",
    payrollColumn: overrides.payrollColumn ?? "crm",
    deductionUnit: "days",
    originalDeductionValue: overrides.originalDeductionValue ?? 2,
    appliedDeductionValue: overrides.appliedDeductionValue ?? 1,
    appliedAmount: overrides.appliedAmount ?? 100,
    dates: overrides.dates ?? ["2026-05-10"],
    reason: overrides.reason ?? "Policy violation",
    hrNote: overrides.hrNote ?? null,
    createdAt: "2026-05-31T12:00:00.000Z",
  };
}

export async function runDeductionsGovernanceCompletionTests(): Promise<void> {
  // Title-aware weekend policy: only Medical Rep and District Manager work Saturday.
  {
    assert.equal(isFieldWorkforceWeeklyOff({ dateIso: "2026-01-02", title: "Medical Rep" }), true);
    assert.equal(isFieldWorkforceWeeklyOff({ dateIso: "2026-01-03", title: "Medical Rep" }), false);
    assert.equal(isFieldWorkforceWeeklyOff({ dateIso: "2026-01-03", title: "District Manager" }), false);
    assert.equal(isFieldWorkforceWeeklyOff({ dateIso: "2026-01-03", title: "National Sales Manager" }), true);
    assert.equal(isFieldWorkforceWeeklyOff({ dateIso: "2026-01-03", title: "Regional Manager" }), true);
    assert.equal(isFieldWorkforceWeeklyOff({ dateIso: "2026-01-03", title: "Office Co-ordinator" }), true);
  }

  // Formula: base salary / 30 * deduction days.
  {
    assert.equal(calculateDeductionAmountFromBaseSalary({ baseSalary: 15000, deductionDays: 2 }), 1000);
    assert.equal(calculateDeductionAmountFromBaseSalary({ baseSalary: 15000, deductionDays: 0.25 }), 125);
    assert.equal(calculateDeductionAmountFromBaseSalary({ baseSalary: 0, deductionDays: 1 }), null);
  }

  // Decision actor gate: only admin-HR and B-10 can write governance decisions.
  {
    assert.equal(isDeductionsGovernanceDecisionActor({ hrId: "admin-HR", loginId: null }), true);
    assert.equal(isDeductionsGovernanceDecisionActor({ hrId: "B-10", loginId: null }), true);
    assert.equal(isDeductionsGovernanceDecisionActor({ hrId: "B-11", loginId: "ceo" }), false);
    assert.equal(isDeductionsGovernanceDecisionActor({ hrId: null, loginId: "super-admin" }), false);
  }

  // Payroll mapping by source.
  {
    assert.equal(payrollColumnForDeduction({ sourceModule: "FIELD_WORKFORCE", deductionType: "no_activity" }), "crm");
    assert.equal(payrollColumnForDeduction({ sourceModule: "ATTENDANCE_DEVICE", deductionType: "late_arrival" }), "finger_print");
    assert.equal(payrollColumnForDeduction({ sourceModule: "VACATION", deductionType: "leave_without_balance" }), "unpaid_vacations");
    assert.equal(payrollColumnForDeduction({ sourceModule: "DISCIPLINARY", deductionType: "disciplinary_deduction" }), null);
  }

  // Connector pure helpers.
  {
    assert.equal(__attendanceDeviceConnectorTestables.deductionTypeForStatus("Late arrival"), "late_arrival");
    assert.equal(__attendanceDeviceConnectorTestables.deductionTypeForStatus("Single punch"), "missing_punch");
    assert.equal(__attendanceDeviceConnectorTestables.deductionTypeForStatus("Early leave"), "early_leave");
    assert.deepEqual(__attendanceDeviceConnectorTestables.monthRange("2026/5"), {
      end: "2026-05-31",
      month: 5,
      monthKey: "2026-05",
      start: "2026-05-01",
      year: 2026,
    });
    assert.equal(__attendanceDeviceConnectorTestables.parseAmount("123.456"), 123.46);
    assert.equal(__vacationDeductionConnectorTestables.unpaidDays("2.333"), 2.33);
    assert.equal(__vacationDeductionConnectorTestables.unpaidDays(null), 0);
  }

  // Payroll preview: add-on-top totals (existing + applied = resulting), amount-added delta,
  // fallback matching by employee_code, and blockers.
  {
    const preview = buildDeductionsPayrollPreview({
      batch: { id: "batch-1", month: 5, year: 2026, status: "adjustments_open" },
      summary: summary(),
      lines: [
        line({ id: "line-a1-crm", employeeCode: "A-1", payrollColumn: "crm", appliedAmount: 100 }),
        line({ id: "line-a1-fp", employeeCode: "A-1", payrollColumn: "finger_print", appliedAmount: 50, sourceModule: "ATTENDANCE_DEVICE", deductionType: "late_arrival" }),
        line({ id: "line-b2-unpaid", employeeCode: "B-2", employeeName: "Employee Two", payrollColumn: "unpaid_vacations", appliedAmount: 70, sourceModule: "VACATION", deductionType: "leave_without_balance" }),
      ],
      payrollRecords: [
        {
          id: "record-a1",
          hr_id: "A-1",
          employee_code: null,
          full_name: "Employee One",
          base_salary: 15000,
          crm: 20,
          finger_print: 10,
          unpaid_vacations: 0,
          total_deductions: 30,
          second_part: 1000,
          month_salary: 12000,
        },
        {
          id: "record-b2",
          hr_id: null,
          employee_code: "B-2",
          full_name: "Employee Two",
          base_salary: 15000,
          crm: 0,
          finger_print: 0,
          unpaid_vacations: 0,
          total_deductions: 0,
          second_part: 1000,
          month_salary: 12000,
        },
      ],
    });
    assert.equal(preview.canImport, true);
    assert.equal(preview.totals.crm, 100);
    assert.equal(preview.totals.fingerPrint, 50);
    assert.equal(preview.totals.unpaidVacations, 70);
    assert.equal(preview.totals.total, 220);
    // Add-on-top: A-1 already has CRM 20 + Finger Print 10; the import ADDS CRM 100 + FP 50.
    const a1 = preview.rows.find((row) => row.employeeCode === "A-1");
    assert.equal(a1?.delta, 150); // amount added (100 + 50), not the replace-delta (150 - 30)
    assert.equal(a1?.resultingTotals.crm, 120); // 20 existing + 100 added
    assert.equal(a1?.resultingTotals.fingerPrint, 60); // 10 existing + 50 added
    assert.equal(a1?.resultingTotals.unpaidVacations, 0);
    assert.equal(preview.rows.find((row) => row.employeeCode === "B-2")?.matched, true);

    const locked = buildDeductionsPayrollPreview({
      batch: { id: "batch-locked", month: 5, year: 2026, status: "approved" },
      summary: summary(),
      lines: [line({ employeeCode: "A-1" })],
      payrollRecords: [],
    });
    assert.equal(locked.canImport, false);
    assert.ok(locked.blockers.some((blocker) => blocker.includes("not open")));

    const unmatched = buildDeductionsPayrollPreview({
      batch: { id: "batch-1", month: 5, year: 2026, status: "adjustments_open" },
      summary: summary(),
      lines: [line({ employeeCode: "X-9" })],
      payrollRecords: [],
    });
    assert.equal(unmatched.canImport, false);
    assert.equal(unmatched.unmatchedEmployees.length, 1);
  }
}
