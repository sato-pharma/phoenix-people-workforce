import assert from "node:assert/strict";

import { balanceSettledDaysInPeriod } from "../src/lib/vacation/service.ts";
import { fakeSupabaseClient } from "./fixtures/fake-supabase-table.ts";

/**
 * CONFIRMING THE PART 2 VACATION STEP TWICE MUST REACH THE SAME ANSWER TWICE.
 *
 * THE RULE (owner, 2026-07-21). A vacation day, whether it came from a formal Phoenix request or
 * from the CRM, subtracts from the leave balance first; salary only covers what the balance cannot.
 * Confirming the step is the moment CRM-only leave becomes real: it writes a settlement row saying
 * how many balance days were consumed.
 *
 * THE DEFECT. That settlement was recomputed from the LIVE balance every time the step was
 * confirmed, and the live balance already included the row the previous confirm had written. So a
 * second confirm read a balance it had spent itself, concluded the balance now covered nothing,
 * and superseded the row that had consumed the days. The leave days came back. The payroll
 * deduction, which is held on the confirmed draft row, did not move. A third confirm saw the
 * restored balance and spent it again.
 *
 * Nothing about that is visible. There is no error, both confirms report success, and the payroll
 * sheet shows the same figure throughout — the only thing that moves is somebody's leave
 * entitlement, in a ledger nobody reads during a payroll run.
 *
 * Re-confirming is not an edge case. HR corrects a row and confirms the step again; that is the
 * normal way the wizard is used.
 *
 * THE FIX. A run's own settlements are excluded from the balance it is re-deciding, so the
 * computation is a function of its inputs rather than of how many times it has been run. Every
 * other reader still sees every live settlement, which is what a balance check should do.
 *
 * ARMED, NEVER FIRED. No CRM-sourced settlement has ever been written on production: the whole
 * ledger holds 8 rows, all from July, all carrying a formal request id.
 */

const PERIOD = { periodEnd: "2026-07-01", periodStart: "2026-06-01" };
const THIS_RUN = "run-august";
const ANOTHER_RUN = "run-july";

/**
 * The fixture is a real tiny query engine, not a SupabaseClient, so it is cast at the boundary —
 * the same way `payroll-copilot-vacation-settlement.test.ts` does. Only `.from` is ever reached.
 */
function ledger(rows: Array<Record<string, unknown>>) {
  return fakeSupabaseClient({ payroll_copilot_vacation_settlements: rows }) as never;
}

/** One consumed-balance settlement, as `settleCrmLeaveBalanceForPeriod` writes it. */
function settlement(overrides: Record<string, unknown> = {}) {
  return {
    employee_hr_id_compact: "b1",
    settlement_method: "partial_balance",
    superseded_at: null,
    start_date: "2026-06-10",
    balance_days_consumed: 5,
    run_id: THIS_RUN,
    ...overrides,
  };
}

export async function runAutomatedPayrollVacationReconfirmTests() {
  // ---- HEADLINE: a run does not read back its own answer -----------------------------------
  const own = ledger([settlement()]);
  assert.equal(
    await balanceSettledDaysInPeriod(
      { employeeHrId: "B-1", excludeSettlementRunId: THIS_RUN, ...PERIOD },
      own,
    ),
    0,
    "a run re-deciding its settlement must not see the 5 days its own previous confirm consumed. " +
      "Reading them back made the second confirm drop its balance coverage to zero and supersede " +
      "the row that had consumed them, handing the leave days back while the deduction stayed",
  );

  // And without the exclusion — every other caller — the same 5 days DO count. This is the half
  // that must not change: a balance check anywhere else in the system still sees every live
  // settlement, whoever wrote it.
  assert.equal(
    await balanceSettledDaysInPeriod({ employeeHrId: "B-1", ...PERIOD }, ledger([settlement()])),
    5,
    "an ordinary balance check still counts every live settlement",
  );

  // ---- Another run's settlement is somebody else's spending ----------------------------------
  // The exclusion is scoped to the ONE run asking. July's consumption is real and must still
  // reduce what August believes is available, or the same days get spent twice.
  assert.equal(
    await balanceSettledDaysInPeriod(
      { employeeHrId: "B-1", excludeSettlementRunId: THIS_RUN, ...PERIOD },
      ledger([settlement({ run_id: ANOTHER_RUN })]),
    ),
    5,
    "excluding THIS run must not excuse another run's consumption — that would spend the same " +
      "balance days twice",
  );

  // A settlement with no run at all (the Copilot's own settle-from-balance workflow) is likewise
  // somebody else's, and counts.
  assert.equal(
    await balanceSettledDaysInPeriod(
      { employeeHrId: "B-1", excludeSettlementRunId: THIS_RUN, ...PERIOD },
      ledger([settlement({ run_id: null })]),
    ),
    5,
    "a settlement written outside any payroll run still counts against the balance",
  );

  // ---- Mixed ledger: only this run's row is set aside ------------------------------------------
  const mixed = ledger([
    settlement({ balance_days_consumed: 5 }),
    settlement({ run_id: ANOTHER_RUN, start_date: "2026-06-20", balance_days_consumed: 2 }),
    settlement({ run_id: null, start_date: "2026-06-25", balance_days_consumed: 1.5 }),
  ]);
  assert.equal(
    await balanceSettledDaysInPeriod(
      { employeeHrId: "B-1", excludeSettlementRunId: THIS_RUN, ...PERIOD },
      mixed,
    ),
    3.5,
    "2 from the other run plus 1.5 from outside any run; only this run's own 5 are set aside",
  );

  // ---- The filters that already existed must survive --------------------------------------------
  // A superseded row is a decision that was replaced, and a row outside the period belongs to
  // another balance year. Neither has anything to do with the run exclusion, and both are easy to
  // break while adding a filter beside them.
  assert.equal(
    await balanceSettledDaysInPeriod(
      { employeeHrId: "B-1", excludeSettlementRunId: THIS_RUN, ...PERIOD },
      ledger([settlement({ run_id: ANOTHER_RUN, superseded_at: "2026-06-11T00:00:00Z" })]),
    ),
    0,
    "a superseded settlement is a replaced decision and never counts",
  );
  assert.equal(
    await balanceSettledDaysInPeriod(
      { employeeHrId: "B-1", excludeSettlementRunId: THIS_RUN, ...PERIOD },
      ledger([settlement({ run_id: ANOTHER_RUN, start_date: "2026-07-01" })]),
    ),
    0,
    "the period is half-open — a settlement dated the first of the next month is outside it",
  );
  assert.equal(
    await balanceSettledDaysInPeriod(
      { employeeHrId: "B-1", excludeSettlementRunId: THIS_RUN, ...PERIOD },
      ledger([settlement({ run_id: ANOTHER_RUN, settlement_method: "salary" })]),
    ),
    0,
    "a salary settlement consumed no balance, so it cannot reduce one",
  );

  // ---- The same question asked twice gives the same answer twice -------------------------------
  // This is the property the whole fix exists for, stated directly: run the read, write what it
  // implies into the ledger, run it again. Before the exclusion the second read returned 0.
  const stable = fakeSupabaseClient({ payroll_copilot_vacation_settlements: [] });
  const ask = () =>
    balanceSettledDaysInPeriod(
      { employeeHrId: "B-1", excludeSettlementRunId: THIS_RUN, ...PERIOD },
      stable as never,
    );
  const first = await ask();
  await stable.from("payroll_copilot_vacation_settlements").insert(settlement());
  const second = await ask();
  assert.equal(first, second, "confirming twice must reach the same answer twice");
}
