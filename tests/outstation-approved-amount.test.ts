import assert from "node:assert/strict";
import {
  getApprovedExpenseTotalsByHrId,
  summarizePayrollExpenses,
} from "../src/lib/outstation/expense-metrics.ts";
import {
  approvedAmountFromDeduction,
  deductionFromApprovedAmount,
  normalizeApprovedAmount,
  payableExpenseAmount,
} from "../src/lib/outstation/payable.ts";
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

  // --- the Deduction field: typing a cut and typing a payable must stay the same decision ---

  assert.equal(
    approvedAmountFromDeduction(2000, 500),
    1500,
    "deducting 500 from a 2,000 claim approves 1,500 — this is the whole point of the field",
  );
  assert.equal(
    approvedAmountFromDeduction(2000, 0),
    2000,
    "a zero deduction approves the claim untouched, so opening a trip and typing nothing changes nothing",
  );
  assert.equal(
    deductionFromApprovedAmount(2000, 1500),
    500,
    "the deduction shown for an already-reduced row is the gap, so reopening a saved trip shows what was actually cut",
  );
  assert.equal(
    deductionFromApprovedAmount(2000, 2000),
    0,
    "an unadjusted row shows a zero deduction rather than a blank or a NaN",
  );

  // The pair must be exact complements, or the two inputs drift and the panel shows an equation
  // that does not add up.
  for (const [claimed, cut] of [[2000, 500], [905, 905], [1234.56, 34.56], [0, 100]] as const) {
    const approved = approvedAmountFromDeduction(claimed, cut);
    assert.equal(
      deductionFromApprovedAmount(claimed, approved) + approved,
      claimed === 0 ? 0 : claimed,
      `claimed − deduction must equal approved for ${claimed}/${cut}`,
    );
  }

  assert.equal(
    approvedAmountFromDeduction(2000, 5000),
    0,
    "a deduction larger than the claim floors the payable at zero instead of paying a negative amount",
  );
  assert.equal(
    approvedAmountFromDeduction(2000, -100),
    2000,
    "a negative deduction is not a deduction — it must never inflate a claim above what the employee asked for",
  );
  assert.equal(
    deductionFromApprovedAmount(2000, 2500),
    0,
    "approving above the claim reports no deduction rather than a negative one",
  );
  assert.equal(
    approvedAmountFromDeduction(2000, Number.NaN),
    2000,
    "a half-typed or cleared deduction box must not silently zero somebody's payable amount",
  );
  assert.equal(
    approvedAmountFromDeduction(1000.5, 0.25),
    1000.25,
    "piastres survive the round-trip — the field is currency, not integers",
  );

  // The Deduction field only ever produces values `normalizeApprovedAmount` already understood,
  // so it cannot widen what reaches the database.
  assert.equal(
    normalizeApprovedAmount(approvedAmountFromDeduction(2000, 0), 2000),
    null,
    "typing 0 into Deduction stores null (never adjusted), not a redundant copy of the claim",
  );
  assert.equal(
    normalizeApprovedAmount(approvedAmountFromDeduction(2000, 2000), 2000),
    0,
    "deducting the entire claim stores a real zero, which payroll pays as nothing",
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
