import assert from "node:assert/strict";
import {
  getApprovedExpenseTotalsByHrId,
  summarizePayrollExpenses,
} from "../src/lib/outstation/expense-metrics.ts";
import { normalizeApprovedAmount, payableExpenseAmount } from "../src/lib/outstation/payable.ts";
import type { PayrollExpenseApproval } from "../src/lib/payroll/types.ts";

function approval(overrides: Partial<PayrollExpenseApproval>): PayrollExpenseApproval {
  return {
    allowance: 0,
    amWorkload: 0,
    approvedAmount: null,
    approvedAt: null,
    approvedBy: null,
    date: "2026-06-15T00:00:00.000Z",
    description: "",
    from: "",
    hr: "",
    hrApproved: true,
    hrComment: "",
    hrId: "HR-1",
    hrNotes: "",
    km: 0,
    location: "",
    meetingAmount: 0,
    open: "",
    other: 0,
    payoutMonth: 7,
    payoutYear: 2026,
    pmWorkload: 0,
    reportId: null,
    requestType: "",
    row: 1,
    sourceFileName: "",
    specialist: "",
    status: "",
    to: "",
    toDate: "",
    total: 2000,
    transportationType: "",
    travelCost: 0,
    tripId: "TRIP-1",
    tripType: "",
    ...overrides,
  };
}

export function runOutstationApprovedAmountTests() {
  // --- payableExpenseAmount: the single rule every payout path shares ---

  assert.equal(
    payableExpenseAmount(null, 2000),
    2000,
    "null approved amount means HR never adjusted the claim, so the claim is payable — this is what keeps every row written before the approved_amount column existed paying exactly what it always paid",
  );
  assert.equal(
    payableExpenseAmount(undefined, 2000),
    2000,
    "undefined behaves as null, so a read path that forgot to select approved_amount underpays nobody",
  );
  assert.equal(
    payableExpenseAmount(500, 2000),
    500,
    "HR reducing a 2,000 claim to 500 must pay 500 — the bug this pins paid the full 2,000",
  );
  assert.equal(
    payableExpenseAmount(0, 2000),
    0,
    "approving a trip at zero is a real decision (approve the trip, pay nothing) and must not fall back to the claim",
  );

  // --- normalizeApprovedAmount: what actually gets stored ---

  assert.equal(
    normalizeApprovedAmount(2000, 2000),
    null,
    "approving at exactly the claimed figure stores null, so 'never adjusted' stays distinguishable from 'adjusted to the same number'",
  );
  assert.equal(
    normalizeApprovedAmount(500, 2000),
    500,
    "a genuine adjustment is stored so payroll and a later reload can both see it",
  );
  assert.equal(
    normalizeApprovedAmount(0, 2000),
    0,
    "zero is stored, not collapsed to null — otherwise approving nothing would silently pay the full claim",
  );
  assert.equal(
    normalizeApprovedAmount(null, 2000),
    null,
    "a record that carries no approved amount leaves the column null rather than stamping a redundant copy of total",
  );
  assert.equal(
    normalizeApprovedAmount(-5, 2000),
    0,
    "a negative is not a payable amount and the column's check constraint rejects it, so it clamps instead of failing the whole batched save",
  );

  // --- the payroll totals that actually move money ---

  const totals = getApprovedExpenseTotalsByHrId([
    approval({ approvedAmount: 500, hrId: "HR-1", total: 2000, tripId: "TRIP-1" }),
    approval({ approvedAmount: null, hrId: "HR-1", total: 300, tripId: "TRIP-2" }),
  ]);
  assert.equal(
    totals.get("HR-1"),
    800,
    "payroll pays the approved 500 plus the unadjusted 300 — summing the raw claims would pay 2,300 and overpay by 1,500",
  );

  const summary = summarizePayrollExpenses([
    approval({ approvedAmount: 500, hrApproved: true, total: 2000 }),
  ]);
  assert.equal(
    summary.approvedAmount,
    500,
    "the reported approved amount must equal what payroll pays, or the dashboard and the payslip disagree",
  );
  assert.equal(
    summary.totalAmount,
    2000,
    "totalAmount stays the CLAIMED figure — the original claim must survive a reduction so a dispute is arguable",
  );

  const pending = summarizePayrollExpenses([
    approval({ approvedAmount: 500, hrApproved: false, total: 2000 }),
  ]);
  assert.equal(
    pending.approvedAmount,
    0,
    "an unapproved row contributes nothing to the approved total no matter what amount was typed into it",
  );
}
