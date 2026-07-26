import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  calculateDeductionAmountFromBaseSalary,
  isDeductionsGovernanceDecisionActor,
  payrollColumnForDeduction,
  resolveDayBasedDeductionAmount,
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

  // resolveDayBasedDeductionAmount: mandatory no-activity deductions must count
  // toward payroll even before HR decides them (owner rule: "N must be deducted").
  {
    // Decided (approved) row: use the applied amount as-is, ignore base salary/days.
    assert.equal(
      resolveDayBasedDeductionAmount({
        decision: { appliedDeductionValue: 2, appliedAmount: 850 },
        deductionValue: 3,
        baseSalary: 99999,
      }),
      850,
    );
    // Undecided (pending) row: estimate from base salary / 30 x the original days.
    assert.equal(
      resolveDayBasedDeductionAmount({ decision: null, deductionValue: 3, baseSalary: 9000 }),
      900,
    );
    // Undecided row with an edited-but-not-yet-saved applied value is not possible here
    // (appliedDeductionValue only exists once a decision exists) — falls back to deductionValue.
    assert.equal(
      resolveDayBasedDeductionAmount({
        decision: { appliedDeductionValue: null, appliedAmount: null },
        deductionValue: 2,
        baseSalary: 9000,
      }),
      600,
    );
    // No base salary and no decided amount: null (undeductible, not zero — caller decides the zero fallback).
    assert.equal(
      resolveDayBasedDeductionAmount({ decision: null, deductionValue: 2, baseSalary: null }),
      null,
    );
  }

  // Decision actor gate: only Super Admin (HR governance) can write deduction decisions.
  {
    assert.equal(isDeductionsGovernanceDecisionActor({ role: "Super Admin" }), true);
    assert.equal(isDeductionsGovernanceDecisionActor({ role: "CEO" }), false);
    assert.equal(isDeductionsGovernanceDecisionActor({ role: "Finance Manager" }), false);
    assert.equal(isDeductionsGovernanceDecisionActor({ role: "District Manager" }), false);
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
    // Deductions stay scoped to field roles even though the fingerprint report now
    // surfaces office/HQ staff for visibility (owner decision: office staff not auto-deducted).
    assert.equal(__attendanceDeviceConnectorTestables.isDeductionEligibleRow({ jobTitle: "Medical Representative" }), true);
    assert.equal(__attendanceDeviceConnectorTestables.isDeductionEligibleRow({ jobTitle: "District Sales Manager" }), true);
    assert.equal(__attendanceDeviceConnectorTestables.isDeductionEligibleRow({ jobTitle: "Hr Manager" }), false);
    assert.equal(__attendanceDeviceConnectorTestables.isDeductionEligibleRow({ jobTitle: "Finance Manager" }), false);
    assert.equal(__attendanceDeviceConnectorTestables.isDeductionEligibleRow({ jobTitle: "" }), false);
    assert.equal(__vacationDeductionConnectorTestables.unpaidDays("2.333"), 2.33);
    assert.equal(__vacationDeductionConnectorTestables.unpaidDays(null), 0);
  }

  // CRM/leave/excuse-aware gating (2026-07-24 fix): syncAttendanceDeviceDeductionCandidates
  // must not draft a candidate for a day covered by an approved leave/excuse or a CRM-recorded
  // leave/field-visit — the fingerprint report itself has no awareness of any of these (only a
  // narrow "attendance exceptions" table and half-day vacations), so without this gate a field
  // rep with a real CRM-logged visit that day could still get a wrongly-approved-looking
  // deduction candidate. isCandidateDayCovered reuses reconcileDay's own universal-cancel
  // precedence (digest-reconcile.ts) rather than re-deriving it.
  {
    const notCovered = __attendanceDeviceConnectorTestables.isCandidateDayCovered({
      hasApprovedLeave: false,
      hasApprovedExcuse: false,
      hasCrmLeave: false,
      hasCrmFieldVisit: false,
    });
    assert.equal(notCovered, false, "a day with none of the four signals must still be judged (create a candidate)");

    assert.equal(
      __attendanceDeviceConnectorTestables.isCandidateDayCovered({
        hasApprovedLeave: true,
        hasApprovedExcuse: false,
        hasCrmLeave: false,
        hasCrmFieldVisit: false,
      }),
      true,
      "an approved full-day leave must cancel the candidate",
    );
    assert.equal(
      __attendanceDeviceConnectorTestables.isCandidateDayCovered({
        hasApprovedLeave: false,
        hasApprovedExcuse: true,
        hasCrmLeave: false,
        hasCrmFieldVisit: false,
      }),
      true,
      "an approved excuse must cancel the candidate",
    );
    assert.equal(
      __attendanceDeviceConnectorTestables.isCandidateDayCovered({
        hasApprovedLeave: false,
        hasApprovedExcuse: false,
        hasCrmLeave: true,
        hasCrmFieldVisit: false,
      }),
      true,
      "a CRM-recorded leave day must cancel the candidate even with no matching Phoenix vacation_requests row",
    );
    assert.equal(
      __attendanceDeviceConnectorTestables.isCandidateDayCovered({
        hasApprovedLeave: false,
        hasApprovedExcuse: false,
        hasCrmLeave: false,
        hasCrmFieldVisit: true,
      }),
      true,
      "a real CRM field visit (regular visit or CP-type activity) must cancel the candidate — this is the confirmed B-155 2026-07-13 gap",
    );
  }

  // Wiring regression guard: syncAttendanceDeviceDeductionCandidates itself is entirely
  // Supabase-backed (report + three day-maps) and cannot be unit-tested without DB infra —
  // matching the established pattern for this domain (see attendance-employee-day-report.test.ts),
  // this pins the exact source wiring so the CRM/leave/excuse gate above can't silently stop
  // being called from the sync path.
  {
    const source = readFileSync("src/lib/deductions-governance/connectors/attendance-device.ts", "utf8");
    assert.match(
      source,
      /getApprovedLeaveDayMap\(\{ dateFromIso: range\.start, dateToIso: range\.end, employeeHrIds: candidateHrIds \}\)/,
      "must fetch approved full-day leave for the candidates' own hrIds/month range",
    );
    assert.match(
      source,
      /getApprovedExcuseDayMap\(\{ dateFromIso: range\.start, dateToIso: range\.end, employeeHrIds: candidateHrIds \}\)/,
      "must fetch approved excuses for the candidates' own hrIds/month range",
    );
    assert.match(
      source,
      /getCrmActivityDayMaps\(\{ dateFromIso: range\.start, dateToIso: range\.end, employeeHrIds: candidateHrIds \}\)/,
      "must fetch CRM leave/field-visit activity for the candidates' own hrIds/month range",
    );
    assert.match(
      source,
      /const covered = isCandidateDayCovered\(\{[\s\S]*?\}\);\s*if \(covered\) \{\s*skippedCovered \+= 1;\s*continue;\s*\}/,
      "a covered candidate must be skipped (not drafted) before drafts.push",
    );
    // The gate must run BEFORE drafts.push, not after — otherwise a covered day would still
    // reach insertDeductionCandidateDrafts.
    const gateIndex = source.indexOf("if (covered) {");
    const pushIndex = source.indexOf("drafts.push({");
    assert.ok(gateIndex > 0 && pushIndex > gateIndex, "the covered-day skip must come before drafts.push");
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
    // Arithmetic is still computed correctly regardless of the double-count guard below.
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

    // A-1 already carries a non-zero CRM/Finger Print total BEFORE this import. Import is
    // strictly add-on-top, and the RPC can only detect the SAME summary re-imported -- not a
    // DIFFERENT path (e.g. Automated Payroll) having already applied the same governance data --
    // so this must block until a human confirms it isn't the same deduction counted twice.
    assert.equal(a1?.hasExistingGovernanceAmount, true);
    assert.equal(preview.rows.find((row) => row.employeeCode === "B-2")?.hasExistingGovernanceAmount, false);
    assert.equal(preview.employeesWithExistingGovernance.length, 1);
    assert.equal(preview.employeesWithExistingGovernance[0]?.employeeCode, "A-1");
    assert.equal(preview.canImport, false);
    assert.ok(preview.blockers.some((blocker) => blocker.includes("already have a non-zero")));

    // The clean/expected case: nothing has touched these columns yet, so import proceeds with
    // no double-count blocker.
    const clean = buildDeductionsPayrollPreview({
      batch: { id: "batch-clean", month: 5, year: 2026, status: "adjustments_open" },
      summary: summary(),
      lines: [line({ employeeCode: "A-1", payrollColumn: "crm", appliedAmount: 100 })],
      payrollRecords: [
        {
          id: "record-a1-clean",
          hr_id: "A-1",
          employee_code: null,
          full_name: "Employee One",
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
    assert.equal(clean.canImport, true);
    assert.equal(clean.employeesWithExistingGovernance.length, 0);

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
