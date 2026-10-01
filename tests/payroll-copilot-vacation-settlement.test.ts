import assert from "node:assert/strict";

import {
  buildSettledSalaryDeductionTotals,
  recordVacationSettlementDecision,
  type UnpaidVacationCandidate,
} from "../src/lib/payroll/copilot/vacation-settlement.ts";
import { fakeSupabaseClient } from "./fixtures/fake-supabase-table.ts";

const PERIOD = { month: 6, year: 2026 };

/**
 * NOT covered here, deliberately: `listUnpaidVacationCandidates` (a much deeper dependency chain —
 * `calculatePaymentForRequest`, `getPayrollSalarySourcesByHrId` — beyond what this fixture is built
 * for), and the `"balance"`/`"partial_balance"` paths of `recordVacationSettlementDecision`, which
 * additionally send a notification email via `getEmployeeDirectory()` + `sendVacationBalanceSettlementEmail`.
 * What IS covered — the defer/salary/reject decision recording and the salary-deduction total —
 * is exactly the "deferred payroll module" surface this file exists to close.
 */
function candidate(overrides: Partial<UnpaidVacationCandidate> = {}): UnpaidVacationCandidate {
  return {
    requestId: "vac-1",
    employeeHrId: "B-1",
    employeeName: "Test Employee",
    vacationType: "annual",
    startDate: "2026-06-05",
    endDate: "2026-06-07",
    unpaidDays: 3,
    salaryDeductionAmount: 1500,
    balanceAvailable: false,
    balanceDaysAvailable: 0,
    balanceDaysToConsume: 0,
    remainingSalaryDays: 3,
    remainingSalaryDeductionAmount: 1500,
    existingSettlement: null,
    ...overrides,
  };
}

export async function runPayrollCopilotVacationSettlementTests() {
  // -------------------------------------------------------------------------------------------
  // buildSettledSalaryDeductionTotals — the money-summing function assemble.ts's unpaidVacations
  // reads. A "defer_to_balance" or "balance" settlement must NEVER contribute a salary deduction —
  // that is the entire point of choosing balance over salary.
  // -------------------------------------------------------------------------------------------
  const totalsClient = fakeSupabaseClient({
    payroll_copilot_vacation_settlements: [
      {
        employee_hr_id_compact: "b1",
        settlement_method: "salary",
        superseded_at: null,
        start_date: "2026-06-05",
        salary_deduction_amount: 1500,
      },
      {
        employee_hr_id_compact: "b1",
        settlement_method: "partial_balance",
        superseded_at: null,
        start_date: "2026-06-12",
        salary_deduction_amount: 400,
      },
      // Fully covered by balance — no salary deduction owed, must be excluded.
      {
        employee_hr_id_compact: "b1",
        settlement_method: "balance",
        superseded_at: null,
        start_date: "2026-06-20",
        salary_deduction_amount: 9999,
      },
      // Deferred to balance — same as above, must be excluded.
      {
        employee_hr_id_compact: "b1",
        settlement_method: "defer_to_balance",
        superseded_at: null,
        start_date: "2026-06-22",
        salary_deduction_amount: 9999,
      },
      // Superseded salary settlement (a since-revised decision) — must be excluded.
      {
        employee_hr_id_compact: "b1",
        settlement_method: "salary",
        superseded_at: "2026-06-25T00:00:00.000Z",
        start_date: "2026-06-08",
        salary_deduction_amount: 8888,
      },
      // Outside the period — must be excluded.
      {
        employee_hr_id_compact: "b1",
        settlement_method: "salary",
        superseded_at: null,
        start_date: "2026-07-01",
        salary_deduction_amount: 7777,
      },
    ],
  });
  const totals = await buildSettledSalaryDeductionTotals(PERIOD, totalsClient as never);
  assert.equal(
    totals.get("b1"),
    1900,
    "only the live salary + partial_balance rows inside June sum: 1500 + 400 = 1900 — balance, defer_to_balance, superseded, and out-of-period rows must not count",
  );
  assert.equal(totals.size, 1, "no phantom second key from an excluded row");

  // -------------------------------------------------------------------------------------------
  // recordVacationSettlementDecision — "defer_to_balance" path. Must supersede any existing live
  // settlement for the same employee+date first (never two live rows), and must record a null
  // salary_deduction_amount (the whole point of deferring to balance is $0 hits the payroll sheet).
  // -------------------------------------------------------------------------------------------
  const deferClient = fakeSupabaseClient({
    payroll_copilot_vacation_settlements: [
      {
        id: "existing-1",
        employee_hr_id_compact: "b1",
        start_date: "2026-06-05",
        settlement_method: "salary",
        superseded_at: null,
        salary_deduction_amount: 1500,
        // THIS REQUEST's own earlier answer, which is what makes it this decision's to supersede.
        // recordVacationSettlementDecision always stores [requestId]; a CRM-sourced correction
        // stores [], and that is the documented discriminator between the two. The field was
        // missing from this fixture, which no production row ever is — and with it absent the row
        // reads as somebody else's decision and is correctly left alone.
        vacation_request_ids: ["vac-1"],
      },
    ],
  });
  await recordVacationSettlementDecision(
    { runId: "run-1", candidate: candidate(), method: "defer_to_balance", decidedBy: "CEO" },
    deferClient as never,
  );
  const rowsAfterDefer = deferClient.rows("payroll_copilot_vacation_settlements");
  const liveAfterDefer = rowsAfterDefer.filter((row) => row.superseded_at == null);
  assert.equal(liveAfterDefer.length, 1, "deferring must supersede the prior live salary settlement, leaving exactly one live row");
  assert.equal(liveAfterDefer[0]?.settlement_method, "defer_to_balance", "the live row is the new defer decision");
  assert.equal(liveAfterDefer[0]?.salary_deduction_amount, null, "a deferred settlement must carry NO salary deduction");
  assert.equal(liveAfterDefer[0]?.balance_days_consumed, 3, "the full unpaid-days count is recorded as balance consumption");
  assert.equal(
    rowsAfterDefer.find((row) => row.id === "existing-1")?.superseded_at != null,
    true,
    "the old salary settlement is superseded, not deleted or left live",
  );

  // -------------------------------------------------------------------------------------------
  // "salary" path — the ordinary case, on the shared insert-into-slot code path.
  // -------------------------------------------------------------------------------------------
  const salaryClient = fakeSupabaseClient({ payroll_copilot_vacation_settlements: [] });
  await recordVacationSettlementDecision(
    { runId: "run-2", candidate: candidate({ employeeHrId: "B-2", requestId: "vac-2" }), method: "salary", decidedBy: "CEO" },
    salaryClient as never,
  );
  const salaryRows = salaryClient.rows("payroll_copilot_vacation_settlements");
  assert.equal(salaryRows.length, 1, "a fresh salary decision inserts exactly one row");
  assert.equal(salaryRows[0]?.salary_deduction_amount, 1500, "the salary path records the full deduction amount");
  assert.equal(salaryRows[0]?.balance_days_consumed, null, "the salary path consumes no balance");

  // -------------------------------------------------------------------------------------------
  // "reject" path — must supersede any existing live settlement and insert NOTHING further,
  // reverting the request to a plain unpaid absence with no payroll consequence from this tab.
  // -------------------------------------------------------------------------------------------
  const rejectClient = fakeSupabaseClient({
    payroll_copilot_vacation_settlements: [
      {
        id: "existing-2",
        employee_hr_id_compact: "b1",
        start_date: "2026-06-05",
        settlement_method: "salary",
        superseded_at: null,
        salary_deduction_amount: 1500,
        // THIS REQUEST's own earlier answer, which is what makes it this decision's to supersede.
        // recordVacationSettlementDecision always stores [requestId]; a CRM-sourced correction
        // stores [], and that is the documented discriminator between the two. The field was
        // missing from this fixture, which no production row ever is — and with it absent the row
        // reads as somebody else's decision and is correctly left alone.
        vacation_request_ids: ["vac-1"],
      },
    ],
  });
  await recordVacationSettlementDecision(
    { runId: "run-3", candidate: candidate(), method: "reject", decidedBy: "CEO" },
    rejectClient as never,
  );
  const rowsAfterReject = rejectClient.rows("payroll_copilot_vacation_settlements");
  assert.equal(rowsAfterReject.length, 1, "reject supersedes the old row but inserts no new one — no second row appears");
  assert.equal(
    rowsAfterReject[0]?.superseded_at != null,
    true,
    "the prior live settlement is superseded so the request reads as undecided again",
  );
  assert.equal(
    rowsAfterReject.filter((row) => row.superseded_at == null).length,
    0,
    "after a reject, NO live settlement remains for this employee+date",
  );
}
