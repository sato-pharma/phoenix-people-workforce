import assert from "node:assert/strict";

import { aggregateDeductionRows } from "../src/lib/automated-payroll/recommend.ts";
import type { DeductionInboxRow } from "../src/lib/deductions-governance/service.ts";
import type { PayrollSalarySource } from "../src/lib/payroll/salary-source-model.ts";

// Regression coverage for a real bug found via PR review (2026-07-24): a candidate
// rejected ("Do Not Take Action") anywhere in the system was still counted in
// Automated Payroll's Part 1 "Fingerprint deductions" step, because
// resolveDayBasedDeductionAmount falls back to the ORIGINAL system-flagged value
// whenever appliedAmount/appliedDeductionValue are null - which they always are on
// rejection. Rejecting a deduction had zero effect on what actually got deducted.

const BASE_SALARY = 30000; // → daily rate 1000

function candidate(overrides: Partial<DeductionInboxRow>): DeductionInboxRow {
  return {
    id: overrides.id ?? "candidate-id",
    sourceModule: "ATTENDANCE_DEVICE",
    sourceRecordId: "fingerprint:2026-07-08:a-1:late",
    candidateKey: "candidate-key",
    employeeCode: "A-1",
    employeeHrIdCompact: "a1",
    employeeName: "Test Employee",
    monthKey: "2026-07",
    month: 7,
    year: 2026,
    deductionType: "late_arrival",
    deductionUnit: "days",
    deductionValue: 0.5,
    estimatedAmount: null,
    calculationStatus: "calculated",
    severity: "Medium",
    reason: "Fingerprint attendance policy deduction",
    evidence: {},
    holidayContext: null,
    dates: ["2026-07-08"],
    hierarchySnapshot: {},
    createdBy: "system",
    createdAt: "2026-07-08T00:00:00.000Z",
    supersededAt: null,
    supersededByCandidateId: null,
    decision: null,
    ...overrides,
  };
}

function decision(overrides: Partial<NonNullable<DeductionInboxRow["decision"]>>) {
  return {
    id: "decision-id",
    candidateId: "candidate-id",
    decisionStatus: "Pending" as const,
    decisionReason: "",
    hrNote: "",
    appliedDeductionValue: null,
    appliedAmount: null,
    payrollColumn: null,
    decidedBy: null,
    decidedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    payrollHandoffStatus: "Not pushed" as const,
    lastExportId: null,
    finalizedSummaryId: null,
    actorRoleAtDecision: null,
    actorScopeAtDecision: null,
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}

export function runAutomatedPayrollFingerprintAggregationTests() {
  const sources = new Map<string, PayrollSalarySource>([
    [
      "a1",
      {
        baseSalary: BASE_SALARY,
        employmentIncomeTax: null,
        extraCostOfLiving: null,
        fuelAllowance: null,
        grossSalary: null,
        netSalary: null,
        paymentMode: null,
        socialInsurance: null,
      },
    ],
  ]);

  // ---- Rejected candidate must contribute NOTHING, not the original estimate ----
  const rejected = candidate({
    id: "rejected-1",
    deductionValue: 0.5,
    decision: decision({ id: "d1", candidateId: "rejected-1", decisionStatus: "Do Not Take Action" }),
  });
  const rejectedTotals = aggregateDeductionRows([rejected], sources);
  assert.equal(rejectedTotals.size, 0, "a rejected candidate must not create any employee total at all");

  // ---- Approved candidate with an explicit applied value/amount is honored -----
  const approved = candidate({
    id: "approved-1",
    deductionValue: 0.5,
    decision: decision({
      id: "d2",
      candidateId: "approved-1",
      decisionStatus: "Approved for Payroll",
      appliedDeductionValue: 0.5,
      appliedAmount: 500, // 0.5 x 1000/day
    }),
  });
  const approvedTotals = aggregateDeductionRows([approved], sources);
  assert.deepEqual(approvedTotals.get("a1"), { days: 0.5, value: 500 });

  // ---- Undecided (Pending / no decision row) still falls back to the estimate --
  // This is existing, correct behavior — the fix must not regress it.
  const pending = candidate({ id: "pending-1", deductionValue: 0.5, decision: null });
  const pendingTotals = aggregateDeductionRows([pending], sources);
  assert.deepEqual(pendingTotals.get("a1"), { days: 0.5, value: 500 }); // 0.5 x 1000/day

  // ---- Mixed: one rejected + one approved for the SAME employee sums correctly -
  const rejectedSameEmployee = candidate({
    id: "rejected-2",
    deductionValue: 1,
    decision: decision({ id: "d3", candidateId: "rejected-2", decisionStatus: "Do Not Take Action" }),
  });
  const approvedSameEmployee = candidate({
    id: "approved-2",
    deductionValue: 0.25,
    decision: decision({
      id: "d4",
      candidateId: "approved-2",
      decisionStatus: "Approved for Payroll",
      appliedDeductionValue: 0.25,
      appliedAmount: 250,
    }),
  });
  const mixedTotals = aggregateDeductionRows([rejectedSameEmployee, approvedSameEmployee], sources);
  assert.deepEqual(mixedTotals.get("a1"), { days: 0.25, value: 250 }); // only the approved 0.25/250 counts
}
