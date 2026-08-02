import { logError } from "@/lib/observability/log";
import { payableExpenseAmount } from "@/lib/outstation/payable";
import { expenseApprovalState } from "@/lib/outstation/approval-state";

import { clearDraftExpenses, findActiveRun, listStepStates, upsertStepState } from "./draft-store.ts";
import type { MonthlySalaryRun } from "./types.ts";

/**
 * Keeps the payroll Expenses step honest when an expense decision changes underneath it.
 *
 * The Expenses step is a SNAPSHOT. Confirming it writes each employee's figure into
 * `automated_payroll_draft_rows.expenses`, and from that moment the payroll sheet is built from
 * that column alone (assemble.ts). The recommendation is still recalculated on every load and
 * then thrown away, because a saved draft value always wins (`pick` in recommend.ts).
 *
 * That is right while HR is working the step, and wrong the moment the approval it was derived
 * from changes. It cost a real July 2026 run: the step was confirmed on 1 Aug, HR partially
 * approved and rejected trips on the Expense Approvals page on 2 Aug, and payroll still carried
 * the 1 Aug figures for 7 of 15 employees — three of them above the employee's own claim,
 * because trips rejected on 2 Aug were still being counted.
 *
 * So every path that changes what an outstation expense pays calls this afterwards. It clears
 * the frozen figure for exactly the employees whose decision moved and re-opens the step, which
 * also blocks Part 2 (`assertAllStepsConfirmed`) until HR has looked again.
 */

/** The shape the diff needs — whatever the caller read before and after writing. */
export type ExpenseDecisionSnapshot = {
  tripId: string;
  hrId: string | null;
  total: number | null;
  approvedAmount: number | null;
  hrApproved: boolean | null;
  status: string | null;
  payoutMonth: number | null;
  payoutYear: number | null;
};

export type ExpenseResyncTarget = {
  hrIds: string[];
  periods: Array<{ month: number; year: number }>;
};

export type ExpenseResyncSkipReason = "no_active_run" | "part2_already_confirmed";

export type ExpenseResyncOutcome =
  | {
      action: "resync";
      month: number;
      year: number;
      runId: string;
      clearedHrIds: string[];
      reopenedStep: boolean;
    }
  | { action: "skip"; month: number; year: number; reason: ExpenseResyncSkipReason }
  | { action: "failed"; month: number; year: number; message: string };

/** Currency comparison tolerance — the figure round-trips through a number input and rounding. */
const AMOUNT_EPSILON = 0.005;

function payableOf(row: ExpenseDecisionSnapshot): number {
  return payableExpenseAmount(row.approvedAmount, row.total);
}

function periodKey(month: number, year: number): string {
  return `${year}-${month}`;
}

/**
 * Which employees and payout periods a write actually moved money for.
 *
 * The approvals screen saves a report's FULL record set on every save, not just the rows HR
 * touched, so diffing is what keeps the blast radius down to the trips that were really decided.
 * Without it, one save would blow away a hand-typed wizard figure for every employee in the
 * report — including the ones nobody looked at.
 *
 * A trip counts as changed when its payable amount moved, its approval state moved (a rejection
 * is not carried by the amount), its payout period moved, or it did not exist before. Deletions
 * count too: a rejected outstation request removes its expense row outright, and payroll must
 * stop paying it.
 */
export function expenseDecisionsThatChanged(
  before: ExpenseDecisionSnapshot[],
  after: ExpenseDecisionSnapshot[],
): ExpenseResyncTarget {
  const beforeByTrip = new Map(before.map((row) => [row.tripId, row]));
  const afterByTrip = new Map(after.map((row) => [row.tripId, row]));
  const hrIds = new Set<string>();
  const periods = new Map<string, { month: number; year: number }>();

  const note = (row: ExpenseDecisionSnapshot) => {
    const hrId = (row.hrId ?? "").trim();
    if (hrId) hrIds.add(hrId);
    const month = Number(row.payoutMonth);
    const year = Number(row.payoutYear);
    if (Number.isFinite(month) && Number.isFinite(year) && month > 0 && year > 0) {
      periods.set(periodKey(month, year), { month, year });
    }
  };

  for (const [tripId, next] of afterByTrip) {
    const previous = beforeByTrip.get(tripId);
    if (!previous) {
      note(next);
      continue;
    }
    const amountMoved = Math.abs(payableOf(next) - payableOf(previous)) > AMOUNT_EPSILON;
    const stateMoved =
      expenseApprovalState({ hrApproved: next.hrApproved, status: next.status }) !==
      expenseApprovalState({ hrApproved: previous.hrApproved, status: previous.status });
    const periodMoved =
      Number(next.payoutMonth) !== Number(previous.payoutMonth) ||
      Number(next.payoutYear) !== Number(previous.payoutYear);
    if (amountMoved || stateMoved || periodMoved) {
      note(next);
      // The old period matters as much as the new one when a trip moves between payroll months:
      // the run it LEFT is now overstated and has to recompute too.
      if (periodMoved) note(previous);
    }
  }

  // Rows that vanished (a rejected or deleted outstation request drops its expense row).
  for (const [tripId, previous] of beforeByTrip) {
    if (!afterByTrip.has(tripId)) note(previous);
  }

  return { hrIds: Array.from(hrIds), periods: Array.from(periods.values()) };
}

/**
 * Whether a run may be re-opened.
 *
 * A run whose Part 2 is already confirmed is deliberately left alone. Confirming Part 2 settles
 * the carry-forward ledger (markCarryForwardApplied / recordOverpaidCarryForward), and silently
 * rewinding that from an expense save would undo money decisions nobody asked to undo. Those are
 * reported as a skip so the caller can say so out loud rather than imply a resync happened.
 */
export function planExpenseResync(run: MonthlySalaryRun | null): { ok: boolean; reason?: ExpenseResyncSkipReason } {
  if (!run) return { ok: false, reason: "no_active_run" };
  if (run.part2ConfirmedAt) return { ok: false, reason: "part2_already_confirmed" };
  return { ok: true };
}

/**
 * Clear the frozen figures and re-open the step. Never throws: the approval decision itself has
 * already been written and is the user's actual intent, so a resync failure must not roll it back
 * or surface as "save failed". It is logged loudly and returned, because a silent no-op here is
 * the exact failure this module exists to end.
 */
export async function resyncPayrollExpenseStep(
  target: ExpenseResyncTarget,
): Promise<ExpenseResyncOutcome[]> {
  if (target.hrIds.length === 0 || target.periods.length === 0) return [];

  const outcomes: ExpenseResyncOutcome[] = [];
  for (const period of target.periods) {
    try {
      const run = await findActiveRun(period.month, period.year);
      const plan = planExpenseResync(run);
      if (!plan.ok || !run) {
        outcomes.push({
          action: "skip",
          month: period.month,
          year: period.year,
          reason: plan.reason ?? "no_active_run",
        });
        continue;
      }

      const clearedHrIds = await clearDraftExpenses(run.id, target.hrIds);

      // Re-open only a step that was actually confirmed. Writing "pending" over a step that is
      // already pending would create a step_state row for a step HR has never opened.
      const states = await listStepStates(run.id);
      const expensesStep = states.find((state) => state.stepKey === "p2_expenses");
      const reopenedStep = expensesStep?.status === "confirmed";
      if (reopenedStep) {
        await upsertStepState({
          runId: run.id,
          stepKey: "p2_expenses",
          status: "pending",
          confirmedAt: null,
          confirmedBy: null,
        });
      }

      outcomes.push({
        action: "resync",
        month: period.month,
        year: period.year,
        runId: run.id,
        clearedHrIds,
        reopenedStep,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logError("Automated payroll: expense step resync failed", {
        labels: {
          event: "automated_payroll_expense_resync_failed",
          month: period.month,
          year: period.year,
        },
        error,
      });
      outcomes.push({ action: "failed", month: period.month, year: period.year, message });
    }
  }
  return outcomes;
}
