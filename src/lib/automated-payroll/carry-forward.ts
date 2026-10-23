import { compactHrKey } from "@/lib/payroll/copilot/feeders.ts";
import { roundCurrency } from "@/lib/payroll/money";
import { quotedInList } from "@/lib/supabase/search-filter";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import type { AssembledRow } from "./assemble.ts";

/**
 * Overpaid carry-forward ledger (owner decision 2026-07-25: carry forward, not
 * write off).
 *
 * When Part-2 deductions push an employee's total payable below the First Part
 * already disbursed, `assembleParts` clamps Second Part to 0 and reports the
 * difference as `overpaidResidual`. Before this module existed nothing consumed
 * that number, so the company silently absorbed the loss every month.
 *
 * Lifecycle of one balance:
 *   1. Run N's Part 2 is confirmed  -> recorded here (amount > 0, unapplied).
 *   2. A LATER run assembles        -> the amount is added to that employee's
 *                                      deductions (visible, not silent).
 *   3. That later run is PUBLISHED  -> marked applied to it.
 *
 * A run never consumes its own residual (that would be circular) — see the
 * `source_run_id <> currentRunId` filter in `outstandingCarryForwardFor`.
 *
 * STEP 3 MOVED FROM PART-2 CONFIRM TO PUBLISH on 2026-09-10, because settling a debt at confirm
 * marked it collected from money that had not been written yet, and in three of the four places
 * that build a payable artifact it was never collected at all:
 *
 *   - confirmPart2 assembled WITH the balance, deducted it, then marked it applied;
 *   - the finance sheet, the FAB file and the CIB file each re-assembled WITHOUT it, so none of
 *     the three artifacts finance actually executes carried the deduction;
 *   - publish then re-assembled a third time, and by then `outstandingCarryForwardFor` could no
 *     longer see the balance (it filters `applied_run_id is null`), so the published salary record
 *     did not carry it either.
 *
 * Net effect: the ledger read settled, the bank transfer and the payslip both paid the
 * un-recovered amount, and the money was never taken back. Nothing has been lost in production —
 * the ledger is empty against two published months — so this is armed rather than fired, and it
 * arms the first time any employee's Part-2 deductions exceed their first instalment.
 *
 * Marking at publish also makes CANCELLATION simpler and safer: a run cancelled before publish now
 * has nothing to un-settle, because it never settled anything.
 */

const TABLE = "automated_payroll_carry_forward";

export type CarryForwardEntry = {
  id: string;
  sourceRunId: string;
  employeeHrId: string;
  employeeHrIdCompact: string;
  amount: number;
  appliedRunId: string | null;
  appliedAt: string | null;
};

type Row = Record<string, unknown>;

function mapRow(row: Row): CarryForwardEntry {
  return {
    id: String(row.id),
    sourceRunId: String(row.source_run_id),
    employeeHrId: String(row.employee_hr_id ?? ""),
    employeeHrIdCompact: String(row.employee_hr_id_compact ?? ""),
    amount: Number(row.amount ?? 0),
    appliedRunId: (row.applied_run_id as string | null) ?? null,
    appliedAt: (row.applied_at as string | null) ?? null,
  };
}

/**
 * True when the error means the ledger table isn't migrated into this
 * environment yet (Postgres 42P01 / PostgREST PGRST205). Keeps every existing
 * payroll path working on an environment where this migration hasn't landed —
 * same add-only tolerance used elsewhere in this codebase.
 */
function isMissingTableError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  const message = String((error as { message?: string } | null)?.message ?? error ?? "").toLowerCase();
  return code === "42P01" || code === "PGRST205" || (message.includes("relation") && message.includes("does not exist"));
}

/**
 * Outstanding balances owed by each employee, keyed by compact HR id, EXCLUDING
 * anything this run itself created. Empty map if the ledger isn't migrated yet.
 */
export async function outstandingCarryForwardFor(currentRunId: string): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select("employee_hr_id_compact,amount,source_run_id")
    .is("applied_run_id", null)
    .neq("source_run_id", currentRunId);
  if (error) {
    if (isMissingTableError(error)) return totals;
    throw error;
  }
  for (const row of (data ?? []) as Row[]) {
    const compact = String(row.employee_hr_id_compact ?? "");
    if (!compact) continue;
    totals.set(compact, roundCurrency((totals.get(compact) ?? 0) + Number(row.amount ?? 0)));
  }
  return totals;
}

/**
 * The balances a given run must assemble against — the ONE loader every payable artifact uses.
 *
 * Two states, and the distinction is the whole point:
 *
 *   - Before publish, the run has settled nothing, so the answer is the outstanding balances
 *     (`outstandingCarryForwardFor`). Every artifact built in this window — the grid, the finance
 *     sheet, both bank files, the pre-flight — sees the same deduction.
 *   - After publish, those balances read as applied TO THIS RUN, so `outstandingCarryForwardFor`
 *     would return nothing and a re-downloaded sheet would silently lose a deduction that a real
 *     payslip carries. So a published run assembles against what it itself applied.
 *
 * Without the second half, the same run answers two different numbers either side of publish, and
 * only one of them matches the money. That is the shape of the defect this whole module now guards.
 */
export async function carryForwardForRunAssembly(runId: string): Promise<Map<string, number>> {
  const applied = await carryForwardAppliedByRun(runId);
  if (applied.size > 0) return applied;
  return outstandingCarryForwardFor(runId);
}

/** Balances this run has already settled, keyed by compact HR id. Empty before publish. */
async function carryForwardAppliedByRun(runId: string): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select("employee_hr_id_compact,amount")
    .eq("applied_run_id", runId);
  if (error) {
    if (isMissingTableError(error)) return totals;
    throw error;
  }
  for (const row of (data ?? []) as Row[]) {
    const compact = String(row.employee_hr_id_compact ?? "");
    if (!compact) continue;
    totals.set(compact, roundCurrency((totals.get(compact) ?? 0) + Number(row.amount ?? 0)));
  }
  return totals;
}

/** Every ledger entry created by a run (for reporting/audit on that run's sheet). */
export async function carryForwardCreatedBy(runId: string): Promise<CarryForwardEntry[]> {
  const { data, error } = await getSupabaseAdmin().from(TABLE).select("*").eq("source_run_id", runId);
  if (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }
  return ((data ?? []) as Row[]).map(mapRow);
}

/**
 * Record this run's overpayments. Idempotent per (run, employee) via the unique
 * constraint, so re-confirming Part 2 updates the amount rather than stacking a
 * second debt for the same month.
 */
export async function recordOverpaidCarryForward(input: {
  runId: string;
  rows: AssembledRow[];
  actorHrId: string;
}): Promise<number> {
  const payload = input.rows
    .filter((entry) => entry.overpaidResidual > 0)
    .map((entry) => ({
      source_run_id: input.runId,
      employee_hr_id: entry.row.hrId,
      employee_hr_id_compact: compactHrKey(entry.row.hrId),
      amount: roundCurrency(entry.overpaidResidual),
      created_by: input.actorHrId,
      updated_at: new Date().toISOString(),
    }))
    .filter((row) => row.employee_hr_id_compact);

  if (payload.length === 0) {
    // A previously-overpaid employee may have been corrected before re-confirm;
    // clear any stale unapplied balances this run had recorded earlier.
    await releaseUnappliedCarryForward(input.runId);
    return 0;
  }

  const { error } = await getSupabaseAdmin()
    .from(TABLE)
    .upsert(payload, { onConflict: "source_run_id,employee_hr_id_compact" });
  if (error) {
    if (isMissingTableError(error)) return 0;
    throw error;
  }

  // Drop balances this run recorded on an earlier confirm that are no longer
  // overpaid, so a corrected sheet doesn't leave a phantom debt behind.
  const keep = new Set(payload.map((row) => row.employee_hr_id_compact));
  await releaseUnappliedCarryForward(input.runId, keep);
  return payload.length;
}

/** Remove this run's still-unapplied balances, optionally keeping a set of employees. */
async function releaseUnappliedCarryForward(runId: string, keepCompacts?: Set<string>): Promise<void> {
  let query = getSupabaseAdmin().from(TABLE).delete().eq("source_run_id", runId).is("applied_run_id", null);
  if (keepCompacts && keepCompacts.size > 0) {
    query = query.not("employee_hr_id_compact", "in", `(${quotedInList(Array.from(keepCompacts))})`);
  }
  const { error } = await query;
  if (error && !isMissingTableError(error)) throw error;
}

/**
 * Mark every balance this run actually consumed as applied. Called at the
 * consuming run's Part 2 confirm, after its rows (which already include the
 * carried deduction) have passed validation.
 */
export async function markCarryForwardApplied(input: {
  runId: string;
  appliedCompacts: string[];
}): Promise<number> {
  const compacts = input.appliedCompacts.filter(Boolean);
  if (compacts.length === 0) return 0;
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .update({ applied_run_id: input.runId, applied_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .is("applied_run_id", null)
    .neq("source_run_id", input.runId)
    .in("employee_hr_id_compact", compacts)
    .select("id");
  if (error) {
    if (isMissingTableError(error)) return 0;
    throw error;
  }
  return (data ?? []).length;
}

/**
 * Undo everything a run did to the ledger, because that run is being cancelled.
 *
 * Without this, cancelling a run AFTER its Part 2 confirm silently forgives real
 * money: `confirmPart2` marks previous months' balances as recovered by this
 * run, but a cancelled run never pays anybody — so those debts would vanish
 * having been collected from no one. (A `ready` run is still cancellable:
 * `assertActiveRun` only blocks `published`/`cancelled`.)
 *
 * Two halves, both required:
 *   - balances this run CONSUMED  -> released back to outstanding, so the next
 *     real run collects them.
 *   - balances this run CREATED   -> deleted, because they were derived from a
 *     sheet that is being thrown away. Only unapplied ones: if a later run has
 *     already recovered a debt, that recovery is real and must not be undone.
 */
export async function releaseCarryForwardForCancelledRun(runId: string): Promise<{
  released: number;
  discarded: number;
}> {
  const admin = getSupabaseAdmin();

  const { data: released, error: releaseError } = await admin
    .from(TABLE)
    .update({ applied_run_id: null, applied_at: null, updated_at: new Date().toISOString() })
    .eq("applied_run_id", runId)
    .select("id");
  if (releaseError) {
    if (isMissingTableError(releaseError)) return { released: 0, discarded: 0 };
    throw releaseError;
  }

  const { data: discarded, error: discardError } = await admin
    .from(TABLE)
    .delete()
    .eq("source_run_id", runId)
    .is("applied_run_id", null)
    .select("id");
  if (discardError) {
    if (isMissingTableError(discardError)) return { released: (released ?? []).length, discarded: 0 };
    throw discardError;
  }

  return { released: (released ?? []).length, discarded: (discarded ?? []).length };
}

/** Sum of a carry-forward map — the total the company is recovering this run. */
export function sumCarryForward(totals: Map<string, number>): number {
  let sum = 0;
  for (const amount of totals.values()) sum += amount;
  return roundCurrency(sum);
}
