import { logError } from "@/lib/observability/log";
import { payableExpenseAmount } from "@/lib/outstation/payable";
import { expenseApprovalState } from "@/lib/outstation/approval-state";

import { clearDraftExpenses, findActiveRun, listStepStates, upsertStepState } from "./draft-store.ts";
import { maybeDrainPayrollResyncOutbox, queuePayrollResyncRetry } from "./resync-outbox.ts";
import { holdRun } from "./run-hold.ts";
import { RUN_HOLD_ACTIONS } from "./transition-claim.ts";
import { monthNameAndYear } from "./step-definitions.ts";
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
  /** Every employee whose decision moved, whatever its payout period. */
  hrIds: string[];
  /** Every payout period a moved decision touched. */
  periods: Array<{ month: number; year: number }>;
  /**
   * Each touched period with ONLY the employees whose decision moved IN THAT PERIOD (audit finding 44).
   *
   * The resync clears by this list. It used to clear every changed employee in every changed period,
   * because the two lists above were never paired: one approvals save covering two payout months
   * wiped a hand-typed figure in the month where nothing of that person's had moved, and a hand-added
   * row cleared that way re-rendered as nothing and was paid zero.
   */
  byPeriod: Array<{ month: number; year: number; hrIds: string[] }>;
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
  | {
      action: "failed";
      month: number;
      year: number;
      message: string;
      /** Parked in the resync outbox and retried under the hold (resync-outbox.ts). */
      queued?: boolean;
    };

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
 *
 * The fifth case is the quiet one: the CLAIM moved while HR's own adjusted figure stayed put. An
 * employee adding an extra ticket to a trip HR already cut from 800 to 500 leaves the payable
 * amount at 500 and every other test above unmoved, so nothing here would fire — and HR would go
 * on paying a figure they arrived at by judging a different claim. Keeping the reduction is the
 * deliberate choice (reverting to the full claim is what the re-push used to do, and it is how
 * money leaks); re-opening the step is how HR gets told to look again. Only meaningful while an
 * adjustment is stored — with `approvedAmount` null the payable IS the claim, so a moved claim
 * already registers as a moved amount above.
 */
export function expenseDecisionsThatChanged(
  before: ExpenseDecisionSnapshot[],
  after: ExpenseDecisionSnapshot[],
): ExpenseResyncTarget {
  const beforeByTrip = new Map(before.map((row) => [row.tripId, row]));
  const afterByTrip = new Map(after.map((row) => [row.tripId, row]));
  const hrIds = new Set<string>();
  const periods = new Map<string, { month: number; year: number }>();
  const byPeriod = new Map<string, { month: number; year: number; hrIds: Set<string> }>();

  // One call per side of a change, so an employee is filed under the period of THAT row. A trip
  // moving between months is noted once per side, which files the employee under both months.
  const note = (row: ExpenseDecisionSnapshot) => {
    const hrId = (row.hrId ?? "").trim();
    if (hrId) hrIds.add(hrId);
    const month = Number(row.payoutMonth);
    const year = Number(row.payoutYear);
    if (Number.isFinite(month) && Number.isFinite(year) && month > 0 && year > 0) {
      const key = periodKey(month, year);
      periods.set(key, { month, year });
      if (hrId) {
        const entry = byPeriod.get(key) ?? { month, year, hrIds: new Set<string>() };
        entry.hrIds.add(hrId);
        byPeriod.set(key, entry);
      }
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
    const claimMovedUnderAdjustment =
      next.approvedAmount !== null &&
      Math.abs(Number(next.total ?? 0) - Number(previous.total ?? 0)) > AMOUNT_EPSILON;
    if (amountMoved || stateMoved || periodMoved || claimMovedUnderAdjustment) {
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

  return {
    hrIds: Array.from(hrIds),
    periods: Array.from(periods.values()),
    byPeriod: Array.from(byPeriod.values()).map((entry) => ({
      month: entry.month,
      year: entry.year,
      hrIds: Array.from(entry.hrIds),
    })),
  };
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
  /**
   * `fromOutbox`: this IS the queued retry, so a failure must not park a second copy of it.
   * `queueRetry`: a test passes one that records the parked resync instead of writing it.
   */
  options: { fromOutbox?: boolean; queueRetry?: typeof queuePayrollResyncRetry } = {},
): Promise<ExpenseResyncOutcome[]> {
  if (target.byPeriod.length === 0) return [];
  const queueRetry = options.queueRetry ?? queuePayrollResyncRetry;

  const outcomes: ExpenseResyncOutcome[] = [];
  for (const period of target.byPeriod) {
    try {
      const run = await findActiveRun(period.month, period.year);
      const plan = planExpenseResync(run);
      if (!plan.ok || !run) {
        const reason = plan.reason ?? "no_active_run";
        // A skip because Part 2 is already confirmed leaves payroll paying a decision that has since
        // changed, until someone reopens Part 2. It used to be returned to callers that discarded it
        // and logged nowhere (audit finding 47). No open run for the month is ordinary and stays quiet.
        if (reason === "part2_already_confirmed" && run) {
          logError("Automated payroll: an expense decision changed after Part 2 was confirmed and did not reach payroll", {
            labels: {
              event: "automated_payroll_expense_resync_skipped_part2_confirmed",
              runId: run.id,
              month: period.month,
              year: period.year,
              employees: period.hrIds.length,
              hrIds: period.hrIds.join(","),
            },
          });
        }
        outcomes.push({ action: "skip", month: period.month, year: period.year, reason });
        continue;
      }

      // Under the run's hold (audit 2026-10-23, S-PAY-06): a Part 2 confirm landing between the check
      // above and these writes used to have the clear arrive after its stamp. The hold re-checks the
      // phase as it is taken; a run that reached `ready` meanwhile is reported as the skip below.
      // A wait that runs out is refused too — never cleared unheld (audit 2026-10-26, P2-02) — and the
      // catch below parks this period in the outbox, which retries it under the hold.
      let held: { clearedHrIds: string[]; reopenedStep: boolean };
      try {
        held = await holdRun({
            runId: run.id,
            expected: ["part1", "part2"],
            action: RUN_HOLD_ACTIONS.expenseResync,
            waitMs: 5_000,
          }, async () => {
          const clearedHrIds = await clearDraftExpenses(run.id, period.hrIds);

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
          return { clearedHrIds, reopenedStep };
        });
      } catch (holdError) {
        const after = await findActiveRun(period.month, period.year).catch(() => null);
        if (!after?.part2ConfirmedAt) throw holdError;
        logError("Automated payroll: an expense decision changed after Part 2 was confirmed and did not reach payroll", {
          labels: {
            event: "automated_payroll_expense_resync_skipped_part2_confirmed",
            runId: after.id,
            month: period.month,
            year: period.year,
            employees: period.hrIds.length,
            hrIds: period.hrIds.join(","),
          },
        });
        outcomes.push({ action: "skip", month: period.month, year: period.year, reason: "part2_already_confirmed" });
        continue;
      }
      const { clearedHrIds, reopenedStep } = held;
      // The run's hold was free just now, which is the best moment for a resync parked earlier.
      if (!options.fromOutbox) maybeDrainPayrollResyncOutbox();

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
      // Parked with ONLY this period and its own people, so the retry clears nothing the save did not move.
      const queued = options.fromOutbox
        ? false
        : await queueRetry(
            {
              kind: "expense",
              target: {
                hrIds: period.hrIds,
                periods: [{ month: period.month, year: period.year }],
                byPeriod: [period],
              },
            },
            error,
          ).catch(() => false);
      logError("Automated payroll: expense step resync failed", {
        labels: {
          event: "automated_payroll_expense_resync_failed",
          month: period.month,
          year: period.year,
          queued,
          retry: Boolean(options.fromOutbox),
        },
        error,
      });
      outcomes.push({ action: "failed", month: period.month, year: period.year, message, queued });
    }
  }
  return outcomes;
}

/**
 * Plain-language lines for every outcome where a saved expense decision did NOT reach payroll, for
 * the save's own response (audit finding 47). Without them the approvals page reads "Approvals saved"
 * while payroll goes on paying the old figure. No open run for the month says nothing: that is normal.
 */
export function describeExpenseResyncNotApplied(outcomes: ExpenseResyncOutcome[]): string[] {
  const lines: string[] = [];
  for (const outcome of outcomes) {
    const month = monthNameAndYear(outcome.month, outcome.year);
    if (outcome.action === "skip" && outcome.reason === "part2_already_confirmed") {
      lines.push(
        `Payroll for ${month} already has Part 2 confirmed, so this decision did not reach it. ` +
          "Reopen Part 2 in Automated Payroll for the change to apply.",
      );
    } else if (outcome.action === "failed" && outcome.queued) {
      lines.push(
        `Payroll for ${month} was busy, so this decision is queued and will reach it automatically ` +
          "within a few minutes; until it does, the payroll run shows it as waiting. The decision itself is saved.",
      );
    } else if (outcome.action === "failed") {
      lines.push(`Payroll for ${month} could not be updated with this decision. The decision itself is saved.`);
    }
  }
  return lines;
}
