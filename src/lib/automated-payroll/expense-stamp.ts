import { expenseApprovalState } from "@/lib/outstation/approval-state";
import { payableExpenseAmount } from "@/lib/outstation/payable";
import { compactHrKey } from "@/lib/payroll/copilot/feeders";
import { roundCurrency } from "@/lib/payroll/money";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { lateExpenseChanges, loadLateExpenseRowsById } from "./late-expenses.ts";

/** A late-approved trip of an earlier payout month this run carried and paid, at the amount Part 2 recorded. */
export type CarriedExpenseToStamp = { id: string; compact: string; payoutMonth: number; payoutYear: number; amount: number };

/**
 * Publishing a month MARKS the outstation trips it paid.
 *
 * Owner ruling, 2026-09-12, answering the outstation-expense meaning sheet: "Yes — stamp them
 * automatically", and on the amount: "I review and edit some values of outstation in expense
 * approvals u take the value that I edited not the original and if no edit my side then take the
 * original".
 *
 * Until now the wizard read the stamp (recommend.ts skips a stamped trip) and never wrote one, so not
 * one of the 374 trips in production carried it. The stamp is what locks a paid trip against a later
 * change on the approvals screen, and what the legacy import checks before paying a trip again (see
 * 20260910160000_outstation_import_refuses_wizard_paid_months.sql, which closed that door while this
 * ruling was outstanding).
 *
 * WHICH TRIPS. Exactly the ones the Expenses step's proposed figure is built from
 * (recommend.ts, owner decision 2026-09-08): this payout period's APPROVED trips, for an employee who
 * was actually paid expenses in the published rows.
 *   - A HELD employee is not published, so none of their trips is marked.
 *   - A PENDING trip is not in the figure, so it is not marked. It stays visible and payable.
 *   - A REJECTED trip is never paid, so it is never marked.
 *   - A trip already carrying a stamp is left as it is.
 *
 * THE AMOUNT is payableExpenseAmount — HR's edited figure when there is one, the claim otherwise —
 * which is the owner's rule and the one every payout path already shares. Where the figure paid in
 * the run differs from the trips' total (HR typed a different amount in the step), the trips are
 * still marked, as the ruling says, and the difference is reported per employee so it is visible.
 *
 * HISTORY IS NOT BACKFILLED. The July and August runs stay unmarked: the same sheet ruled that trips
 * up to June are values only (see src/lib/outstation/imported-history.ts).
 */

export type StampCandidateRow = {
  approved_amount: number | null;
  hr_approved: boolean | null;
  hr_id: string | null;
  id: string;
  imported_payroll_batch_id: string | null;
  imported_to_payroll_at: string | null;
  status: string | null;
  total: number | null;
};

/** One published (not held) employee and the expenses the run paid them. */
export type PaidExpenseEmployee = { compact: string; expenses: number };

export type ExpenseStampPlan = {
  /** Employees whose paid figure is not the total of the trips being marked. */
  differing: Array<{ compact: string; paid: number; tripsTotal: number }>;
  employees: number;
  rowIds: string[];
  total: number;
};

/** Pure: which trips a publish marks. No database, so the rule is testable on its own. */
export function planPaidExpenseStamp(input: {
  paid: ReadonlyArray<PaidExpenseEmployee>;
  rows: ReadonlyArray<StampCandidateRow>;
}): ExpenseStampPlan {
  const paidByCompact = new Map<string, number>();
  for (const entry of input.paid) {
    const compact = compactHrKey(entry.compact);
    const expenses = roundCurrency(Number(entry.expenses) || 0);
    if (!compact || expenses <= 0) continue;
    paidByCompact.set(compact, roundCurrency((paidByCompact.get(compact) ?? 0) + expenses));
  }

  const tripsTotalByCompact = new Map<string, number>();
  const rowIds: string[] = [];
  for (const row of input.rows) {
    if (row.imported_payroll_batch_id || row.imported_to_payroll_at) continue;
    if (expenseApprovalState({ hrApproved: row.hr_approved, status: row.status }) !== "approved") continue;
    const compact = compactHrKey(row.hr_id ?? "");
    if (!compact || !paidByCompact.has(compact)) continue;
    rowIds.push(String(row.id));
    const payable = payableExpenseAmount(row.approved_amount, row.total);
    tripsTotalByCompact.set(compact, roundCurrency((tripsTotalByCompact.get(compact) ?? 0) + payable));
  }

  const differing = [...tripsTotalByCompact.entries()]
    .map(([compact, tripsTotal]) => ({ compact, paid: paidByCompact.get(compact) ?? 0, tripsTotal }))
    .filter((entry) => Math.abs(entry.paid - entry.tripsTotal) > 0.5)
    .sort((left, right) => left.compact.localeCompare(right.compact));

  return {
    differing,
    employees: tripsTotalByCompact.size,
    rowIds,
    total: roundCurrency([...tripsTotalByCompact.values()].reduce((sum, value) => sum + value, 0)),
  };
}

export type ExpenseStampResult = ExpenseStampPlan & {
  stamped: number;
  /** Late-approved trips of earlier payout months this run carried and paid, marked by row id (late-expenses.ts). */
  carriedStamped: number;
  /** Carried trips NOT marked because they no longer stood as recorded (approval or amount changed). */
  carriedSkipped: string[];
};

const PAGE_SIZE = 1000;
const UPDATE_CHUNK = 200;

/**
 * Marks the trips `planPaidExpenseStamp` selects. Idempotent: the update itself re-checks that a
 * trip is still unmarked, so a second call for the same batch marks nothing twice. Throws on any
 * failed read or write — the caller decides what a failure means for a month already published.
 */
export async function stampPaidExpenseTrips(input: {
  actorHrId: string;
  batchId: string;
  /**
   * Late-approved trips from EARLIER payout months that this run carried and paid (the
   * `lateExpensesCarried` list of its `published` record). Each is marked only while it is still approved
   * and unpaid at the amount recorded, besides the month's own never-twice guards.
   */
  carried?: ReadonlyArray<CarriedExpenseToStamp>;
  month: number;
  paid: ReadonlyArray<PaidExpenseEmployee>;
  year: number;
}): Promise<ExpenseStampResult> {
  const supabase = getSupabaseAdmin();
  const rows: StampCandidateRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("outstation_expenses")
      .select("id,hr_id,total,approved_amount,hr_approved,status,imported_payroll_batch_id,imported_to_payroll_at")
      .eq("payout_month", input.month)
      .eq("payout_year", input.year)
      .is("imported_payroll_batch_id", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Reading the paid outstation trips failed: ${error.message}`);
    const page = (data ?? []) as StampCandidateRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  const plan = planPaidExpenseStamp({ paid: input.paid, rows });
  const now = new Date().toISOString();
  const stampChunk = async (chunk: string[]): Promise<number> => {
    const { data, error } = await supabase
      .from("outstation_expenses")
      .update({
        imported_payroll_batch_id: input.batchId,
        imported_to_payroll_at: now,
        imported_to_payroll_by: input.actorHrId,
      })
      .in("id", chunk)
      .is("imported_payroll_batch_id", null)
      .is("imported_to_payroll_at", null)
      .select("id");
    if (error) throw new Error(`Marking the paid outstation trips failed: ${error.message}`);
    return (data ?? []).length;
  };
  let stamped = 0;
  for (let index = 0; index < plan.rowIds.length; index += UPDATE_CHUNK) {
    stamped += await stampChunk(plan.rowIds.slice(index, index + UPDATE_CHUNK));
  }
  // The carried trips are named by id, not found by payout month: their month is an earlier one. Each is
  // re-read, and marked only if it still stands exactly as recorded; the update repeats those values as
  // guards, so a decision landing between the read and the write marks nothing.
  const carried = [...new Map((input.carried ?? []).filter((entry) => entry.id).map((entry) => [entry.id, entry])).values()];
  const current = carried.length > 0 ? await loadLateExpenseRowsById(carried.map((entry) => entry.id)) : [];
  const changed = new Set(lateExpenseChanges(carried, current).map((change) => change.entry.id));
  const byId = new Map(current.map((row) => [String(row.id), row]));
  let carriedStamped = 0;
  const carriedSkipped: string[] = [];
  for (const entry of carried) {
    const row = byId.get(entry.id);
    if (!row || changed.has(entry.id)) {
      carriedSkipped.push(entry.id);
      continue;
    }
    let update = supabase
      .from("outstation_expenses")
      .update({ imported_payroll_batch_id: input.batchId, imported_to_payroll_at: now, imported_to_payroll_by: input.actorHrId })
      .eq("id", entry.id)
      .eq("hr_approved", true)
      .is("imported_payroll_batch_id", null)
      .is("imported_to_payroll_at", null);
    update = row.total === null ? update.is("total", null) : update.eq("total", row.total);
    update = row.approved_amount === null ? update.is("approved_amount", null) : update.eq("approved_amount", row.approved_amount);
    const { data, error } = await update.select("id");
    if (error) throw new Error(`Marking the paid outstation trips failed: ${error.message}`);
    if ((data ?? []).length > 0) carriedStamped += 1;
    else carriedSkipped.push(entry.id);
  }

  return { ...plan, stamped, carriedStamped, carriedSkipped };
}

/**
 * The published employees and what the run paid each. A HELD row is dropped at publish
 * (publishToPayslips filters `!onHold`), so its trips are not paid and must stay unmarked.
 */
export function paidExpenseEmployees(
  entries: ReadonlyArray<{ compact: string; onHold: boolean; row: { expenses: number } }>,
): PaidExpenseEmployee[] {
  return entries
    .filter((entry) => !entry.onHold)
    .map((entry) => ({ compact: entry.compact, expenses: entry.row.expenses }));
}

/** What the publish audit row records: the stamp's outcome, or why it failed. */
export type ExpenseStampAudit =
  | {
      differing: ExpenseStampPlan["differing"];
      employees: number;
      stamped: number;
      total: number;
      carriedStamped: number;
      carriedSkipped: string[];
    }
  | { error: string };

/**
 * What publishToPayslips calls, right after the run is marked published. It NEVER throws, for the
 * same reason as the payslip notice there: the money and the payslips exist by then, so a failed
 * stamp must not present a completed payroll as failed or invite a second publish. Nothing is paid
 * twice while a stamp is missing — the legacy import already refuses a wizard-paid month — so a
 * failure is logged loudly and returned for the run's audit row instead.
 */
export async function recordPaidExpenseStamp(input: {
  actorHrId: string;
  batchId: string;
  /** Late-approved trips of earlier months this run paid (late-expenses.ts); marked by id at the recorded amount. */
  carried?: ReadonlyArray<CarriedExpenseToStamp>;
  entries: ReadonlyArray<{ compact: string; onHold: boolean; row: { expenses: number } }>;
  month: number;
  runId: string;
  year: number;
}): Promise<ExpenseStampAudit> {
  try {
    const result = await stampPaidExpenseTrips({
      actorHrId: input.actorHrId,
      batchId: input.batchId,
      carried: input.carried,
      month: input.month,
      paid: paidExpenseEmployees(input.entries),
      year: input.year,
    });
    return {
      differing: result.differing,
      employees: result.employees,
      stamped: result.stamped,
      total: result.total,
      carriedStamped: result.carriedStamped,
      carriedSkipped: result.carriedSkipped,
    };
  } catch (error) {
    logError("Automated payroll: marking the paid outstation trips failed", {
      labels: { event: "automated_payroll_expense_stamp_failed", runId: input.runId },
      error,
    });
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
