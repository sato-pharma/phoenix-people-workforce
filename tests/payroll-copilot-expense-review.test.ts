import assert from "node:assert/strict";

import type { EmployeeDirectoryData } from "../src/lib/employees/employee-directory.ts";
import {
  buildIncludedExpenseTotals,
  listExpenseCandidates,
  priorPeriod,
  recordExpenseDecision,
  sourceExpenseMonthBounds,
  type ExpenseCandidate,
} from "../src/lib/payroll/copilot/expense-review.ts";
import { fakeSupabaseClient } from "./fixtures/fake-supabase-table.ts";

const PERIOD = { month: 6, year: 2026 };

function fakeDirectory(rows: Array<{ hrId: string; fullName: string }>): EmployeeDirectoryData {
  return {
    employees: rows.map((row) => ({ ...row, displayName: row.fullName })),
  } as unknown as EmployeeDirectoryData;
}

function candidate(overrides: Partial<ExpenseCandidate> = {}): ExpenseCandidate {
  return {
    id: "req-1",
    employeeHrId: "B-1",
    employeeName: "Test Employee",
    dateFrom: "2026-05-10",
    dateTo: "2026-05-11",
    locationFrom: "Cairo",
    locationTo: "Giza",
    km: 40,
    type: "traveling",
    travelCost: 200,
    allowance: 100,
    existingDecision: null,
    ...overrides,
  };
}

export async function runPayrollCopilotExpenseReviewTests() {
  // Expenses lag one month: June payroll pays out May's approved outstation trips.
  assert.deepEqual(priorPeriod({ month: 6, year: 2026 }), { month: 5, year: 2026 });
  assert.deepEqual(sourceExpenseMonthBounds({ month: 6, year: 2026 }), {
    start: "2026-05-01",
    end: "2026-05-31",
  });

  // January payroll pays out the PRIOR December (year rolls back too).
  assert.deepEqual(priorPeriod({ month: 1, year: 2026 }), { month: 12, year: 2025 });
  assert.deepEqual(sourceExpenseMonthBounds({ month: 1, year: 2026 }), {
    start: "2025-12-01",
    end: "2025-12-31",
  });

  // A short month (February, non-leap) resolves its correct last day.
  assert.deepEqual(sourceExpenseMonthBounds({ month: 3, year: 2026 }), {
    start: "2026-02-01",
    end: "2026-02-28",
  });

  // ---------------------------------------------------------------------------------------------
  // buildIncludedExpenseTotals — the money-summing function assemble.ts's `expenses` field reads.
  // A "defer" decision must NEVER contribute to what payroll actually pays out.
  // ---------------------------------------------------------------------------------------------
  const totalsClient = fakeSupabaseClient({
    payroll_copilot_expense_decisions: [
      {
        employee_hr_id_compact: "b1",
        decision: "include",
        superseded_at: null,
        request_trip_start_date: "2026-05-05",
        travel_cost: 200,
        allowance: 100,
      },
      {
        employee_hr_id_compact: "b1",
        decision: "include",
        superseded_at: null,
        request_trip_start_date: "2026-05-20",
        travel_cost: 50,
        allowance: 25,
      },
      // A DEFERRED expense for the same employee — must be excluded from the total.
      {
        employee_hr_id_compact: "b1",
        decision: "defer",
        superseded_at: null,
        request_trip_start_date: "2026-05-12",
        travel_cost: 9999,
        allowance: 9999,
      },
      // A SUPERSEDED include (an earlier, since-revised decision) — must also be excluded.
      {
        employee_hr_id_compact: "b1",
        decision: "include",
        superseded_at: "2026-06-01T00:00:00.000Z",
        request_trip_start_date: "2026-05-08",
        travel_cost: 8888,
        allowance: 8888,
      },
      // Outside the period's source window (April, not May) — must be excluded.
      {
        employee_hr_id_compact: "b1",
        decision: "include",
        superseded_at: null,
        request_trip_start_date: "2026-04-30",
        travel_cost: 7777,
        allowance: 7777,
      },
      // A different employee entirely — must not bleed into b1's total.
      {
        employee_hr_id_compact: "b2",
        decision: "include",
        superseded_at: null,
        request_trip_start_date: "2026-05-15",
        travel_cost: 300,
        allowance: 0,
      },
    ],
  });
  const totals = await buildIncludedExpenseTotals(PERIOD, totalsClient as never);
  assert.equal(
    totals.get("b1"),
    375,
    "only the two live 'include' rows inside May sum for b1: (200+100) + (50+25) = 375 — the deferred, superseded, and out-of-window rows must not count",
  );
  assert.equal(totals.get("b2"), 300, "b2's own include total is unaffected by b1's rows");
  assert.equal(totals.size, 2, "no phantom third key from a defer/superseded/out-of-window row");

  // ---------------------------------------------------------------------------------------------
  // recordExpenseDecision — must supersede any existing LIVE decision for the same request before
  // inserting the new one. A re-decision (e.g. defer -> include) must never leave two live rows.
  // ---------------------------------------------------------------------------------------------
  const decisionClient = fakeSupabaseClient({
    payroll_copilot_expense_decisions: [
      {
        id: "existing-1",
        outstation_expense_request_id: "req-1",
        employee_hr_id_compact: "b1",
        decision: "defer",
        superseded_at: null,
        request_trip_start_date: "2026-05-10",
        travel_cost: 200,
        allowance: 100,
      },
    ],
  });
  await recordExpenseDecision(
    { runId: "run-1", candidate: candidate(), decision: "include", decidedBy: "CEO" },
    decisionClient as never,
  );
  const rowsAfterFirstDecision = decisionClient.rows("payroll_copilot_expense_decisions");
  const liveAfterFirst = rowsAfterFirstDecision.filter((row) => row.superseded_at == null);
  assert.equal(
    liveAfterFirst.length,
    1,
    "recording a new decision for req-1 must supersede the prior live row, leaving exactly ONE live row — never two",
  );
  assert.equal(liveAfterFirst[0]?.decision, "include", "the live row reflects the NEW decision, not the old defer");
  assert.equal(
    rowsAfterFirstDecision.find((row) => row.id === "existing-1")?.superseded_at != null,
    true,
    "the old row is superseded (not deleted, not left live) rather than mutated in place",
  );

  // A second re-decision on the SAME request (include -> defer) must again leave exactly one live row.
  await recordExpenseDecision(
    { runId: "run-1", candidate: candidate(), decision: "defer", decidedBy: "CEO" },
    decisionClient as never,
  );
  const rowsAfterSecondDecision = decisionClient.rows("payroll_copilot_expense_decisions");
  const liveAfterSecond = rowsAfterSecondDecision.filter((row) => row.superseded_at == null);
  assert.equal(liveAfterSecond.length, 1, "a SECOND re-decision still leaves exactly one live row, not three");
  assert.equal(liveAfterSecond[0]?.decision, "defer", "the live row now reflects the latest decision");
  assert.equal(rowsAfterSecondDecision.length, 3, "each decision is a new row (audit trail), never an in-place overwrite");

  // A decision on a request with NO prior history simply inserts, with nothing to supersede.
  const freshClient = fakeSupabaseClient({ payroll_copilot_expense_decisions: [] });
  await recordExpenseDecision(
    { runId: "run-2", candidate: candidate({ id: "req-2", employeeHrId: "B-2" }), decision: "include", decidedBy: "CEO" },
    freshClient as never,
  );
  const freshRows = freshClient.rows("payroll_copilot_expense_decisions");
  assert.equal(freshRows.length, 1, "a request with no history inserts exactly one row");
  assert.equal(freshRows[0]?.employee_hr_id_compact, "b2", "the compact HR key is derived and stored correctly");

  // ---------------------------------------------------------------------------------------------
  // listExpenseCandidates — must reattach an existing decision (defer or include) to the right
  // candidate by request id, resolve the employee's name from the directory, and respect the
  // approval-status and date-range filters (proven for real against the fake table, not asserted
  // by inspecting the query source).
  // ---------------------------------------------------------------------------------------------
  const listClient = fakeSupabaseClient({
    outstation_expense_requests: [
      {
        id: "req-a",
        employee_hr_id: "B-1",
        employee_name: "Fallback Name",
        trip_start_date: "2026-05-10",
        trip_end_date: "2026-05-11",
        residence_city: "Cairo",
        residence_area: "Nasr City",
        to_city: "Giza",
        to_area: "Dokki",
        distance_km: 40,
        expense_type: "traveling",
        fuel_amount: 150,
        ticket_amount: 50,
        allowance_amount: 100,
        status: "approved",
      },
      // Not yet approved — must be excluded entirely.
      {
        id: "req-b",
        employee_hr_id: "B-2",
        trip_start_date: "2026-05-12",
        trip_end_date: "2026-05-13",
        status: "pending_hr",
      },
      // Outside the source month window — must be excluded.
      {
        id: "req-c",
        employee_hr_id: "B-1",
        trip_start_date: "2026-04-01",
        trip_end_date: "2026-04-02",
        status: "approved",
      },
    ],
    payroll_copilot_expense_decisions: [
      {
        outstation_expense_request_id: "req-a",
        decision: "defer",
        decided_at: "2026-06-01T00:00:00.000Z",
        superseded_at: null,
        request_trip_start_date: "2026-05-10",
      },
    ],
  });
  const listedCandidates = await listExpenseCandidates(PERIOD, {
    client: listClient as never,
    directory: fakeDirectory([{ hrId: "B-1", fullName: "Real Directory Name" }]),
  });
  assert.equal(listedCandidates.length, 1, "only the approved, in-window request is a candidate (req-b unapproved, req-c out of window)");
  const [onlyCandidate] = listedCandidates;
  assert.equal(onlyCandidate.employeeName, "Real Directory Name", "the directory's name wins over the request's own fallback name");
  assert.deepEqual(
    onlyCandidate.existingDecision,
    { decision: "defer", decidedAt: "2026-06-01T00:00:00.000Z" },
    "the prior defer decision is correctly reattached by request id",
  );
  assert.equal(onlyCandidate.travelCost, 200, "fuel + ticket amounts are summed into travelCost");
}
