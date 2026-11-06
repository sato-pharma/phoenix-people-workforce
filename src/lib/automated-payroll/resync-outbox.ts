import { logError } from "@/lib/observability/log";
import {
  drainOutbox,
  makeOpportunisticDrain,
  OUTBOX_RETRY_TIMEOUT_MS,
  type OutboxQueue,
  queueOutboxWrite,
} from "@/lib/platform/write-outbox";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import type { DeductionResyncEmployee, DeductionResyncOutcome, DeductionResyncTarget } from "./deduction-resync.ts";
import type { ExpenseResyncOutcome, ExpenseResyncTarget } from "./expense-resync.ts";

/**
 * A RESYNC THAT CANNOT TAKE THE RUN'S HOLD IS QUEUED, NEVER RUN UNHELD (audit 2026-10-26, P2-02).
 *
 * A Deductions or expense decision that changed after a payroll step froze its figure has to clear
 * that figure, and the clear runs under the run's hold (run-hold.ts) so it can never land inside a
 * Part confirm. Until 26 Oct a resync whose 5-second wait ran out went ahead WITHOUT the hold
 * (`whenWaitRunsOut: "proceed"`), because failing would leave the old figure in payroll — which put
 * back exactly the race the hold was built to close.
 *
 * Now the wait refuses, and the refused resync is parked here with its whole target and retried
 * under the hold by the shared outbox (`src/lib/platform/write-outbox.ts`): never lost, and never
 * written without the hold. Several callers (an outstation request rejected or deleted) ignore the
 * outcome, so the queue — not the caller — is what makes the decision reach payroll.
 *
 * A retry re-runs the same resync, which re-checks everything; a figure a person saved by hand is
 * still kept. Re-running a clear that had in fact landed clears nothing new, so `alreadyLanded`
 * answers "no" and the re-run is its own probe.
 *
 * 🔴 A RETRY THAT FINDS PART 2 ALREADY CONFIRMED STAYS PARKED (risk review, 26 Oct). It used to count
 * as landed, so the row was deleted and the decision vanished — while the run went on paying the old
 * figure and nobody was told: the person who saved it had been told it would arrive. So that skip now
 * keeps the row, the run page lists it (`queuedPayrollResyncsForPeriod`), and a Part 2 reopen lets it
 * land. Confirming Part 2 lands the period's rows first and refuses while any remain (run-service.ts).
 *
 * Drained off the Automated Payroll run page and off every resync that succeeds — no cron.
 */

export const PAYROLL_RESYNC_OUTBOX_TABLE = "automated_payroll_resync_outbox";

export type QueuedPayrollResync =
  | { kind: "deduction"; target: DeductionResyncTarget }
  | { kind: "expense"; target: ExpenseResyncTarget };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPeriod(value: unknown): value is { month: number; year: number } {
  if (!value || typeof value !== "object") return false;
  const period = value as { month?: unknown; year?: unknown };
  return Number.isInteger(period.month) && Number.isInteger(period.year);
}

/**
 * A stored payload is usable only if it still carries a whole resync target.
 *
 * Read as `unknown`: it came back out of a `jsonb` column a previous release wrote, so the declared
 * type is a claim about what should be there rather than a fact about what is.
 */
export function readQueuedPayrollResync(payload: unknown): QueuedPayrollResync | null {
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload as { kind?: unknown; target?: unknown };
  const target = candidate.target as Record<string, unknown> | null | undefined;
  if (!target || typeof target !== "object") return null;

  if (candidate.kind === "deduction") {
    if (typeof target.monthKey !== "string" || !/^\d{4}-\d{2}$/.test(target.monthKey)) return null;
    if (!Array.isArray(target.employees) || target.employees.length === 0) return null;
    const employees: DeductionResyncEmployee[] = [];
    for (const employee of target.employees as unknown[]) {
      const row = employee as { hrIdCompact?: unknown; categories?: unknown } | null;
      if (!row || typeof row.hrIdCompact !== "string" || !isStringArray(row.categories)) return null;
      employees.push({
        hrIdCompact: row.hrIdCompact,
        categories: row.categories as DeductionResyncEmployee["categories"],
      });
    }
    return { kind: "deduction", target: { monthKey: target.monthKey, employees } };
  }

  if (candidate.kind === "expense") {
    if (!isStringArray(target.hrIds) || !Array.isArray(target.periods) || !Array.isArray(target.byPeriod)) {
      return null;
    }
    if (!target.periods.every(isPeriod)) return null;
    const byPeriod: ExpenseResyncTarget["byPeriod"] = [];
    for (const entry of target.byPeriod as unknown[]) {
      if (!isPeriod(entry) || !isStringArray((entry as { hrIds?: unknown }).hrIds)) return null;
      const period = entry as { month: number; year: number; hrIds: string[] };
      byPeriod.push({ month: period.month, year: period.year, hrIds: period.hrIds });
    }
    if (byPeriod.length === 0) return null;
    return {
      kind: "expense",
      target: { hrIds: target.hrIds, periods: target.periods as ExpenseResyncTarget["periods"], byPeriod },
    };
  }

  return null;
}

/** Does this parked resync carry a decision for the payroll month `month`/`year`? */
export function queuedPayrollResyncIsForPeriod(payload: QueuedPayrollResync, month: number, year: number): boolean {
  if (payload.kind === "deduction") {
    return payload.target.monthKey === `${year}-${String(month).padStart(2, "0")}`;
  }
  return payload.target.byPeriod.some((period) => period.month === month && period.year === year);
}

/**
 * What a retry's outcome means for its row: throws to KEEP it parked, returns to let the drain
 * delete it.
 *
 *   failed again                       kept: the drain backs it off and tries again.
 *   Part 2 already confirmed           kept: the decision has NOT reached payroll, and deleting the
 *                                      row was the silent loss. A Part 2 reopen lets it land.
 *   no open run for the month          deleted, loudly: the run it was parked for was published or
 *                                      cancelled, so there is nothing left for it to reach.
 *   resynced                           deleted: it landed.
 */
export function settleQueuedPayrollResyncOutcome(
  payload: QueuedPayrollResync,
  outcomes: Array<DeductionResyncOutcome | ExpenseResyncOutcome>,
): void {
  const failed = outcomes.find((outcome) => outcome.action === "failed");
  if (failed && failed.action === "failed") throw new Error(failed.message);
  if (outcomes.some((outcome) => outcome.action === "skip" && outcome.reason === "part2_already_confirmed")) {
    throw new Error(
      "Part 2 of this payroll run is already confirmed, so this decision has not reached it. " +
        "It stays queued until Part 2 is reopened.",
    );
  }
  if (outcomes.some((outcome) => outcome.action === "skip" && outcome.reason === "no_active_run")) {
    logError("Automated payroll: a queued payroll decision found no open run and did not reach payroll", {
      labels: {
        event: "automated_payroll_queued_resync_no_open_run",
        kind: payload.kind,
        period:
          payload.kind === "deduction"
            ? payload.target.monthKey
            : payload.target.byPeriod.map((period) => `${period.year}-${period.month}`).join(","),
      },
    });
  }
}

/**
 * Run a queued resync once more, under the hold. Throws when its row must stay parked — see
 * `settleQueuedPayrollResyncOutcome` — so the drain pushes it out on its back-off; otherwise the
 * drain deletes it.
 *
 * `fromOutbox: true` stops a failure from parking a SECOND copy of the row being retried. The
 * imports are dynamic because both resyncs import this file to queue themselves.
 */
export async function landQueuedPayrollResync(payload: QueuedPayrollResync): Promise<void> {
  if (payload.kind === "deduction") {
    const { resyncPayrollDeductionSteps } = await import("./deduction-resync.ts");
    const outcome = await resyncPayrollDeductionSteps(payload.target, undefined, { fromOutbox: true });
    settleQueuedPayrollResyncOutcome(payload, [outcome]);
    return;
  }
  const { resyncPayrollExpenseStep } = await import("./expense-resync.ts");
  settleQueuedPayrollResyncOutcome(payload, await resyncPayrollExpenseStep(payload.target, { fromOutbox: true }));
}

export const payrollResyncQueue: OutboxQueue<QueuedPayrollResync> = {
  alreadyLanded: async () => false,
  land: (payload) => landQueuedPayrollResync(payload),
  read: readQueuedPayrollResync,
  table: PAYROLL_RESYNC_OUTBOX_TABLE,
};

/** Fire-and-forget, at most once per process every 30 seconds (write-outbox.ts). */
export const maybeDrainPayrollResyncOutbox = makeOpportunisticDrain(payrollResyncQueue);

/** One parked resync as the run page shows it: what kind of decision, for how many people, since when. */
export type ParkedPayrollResync = {
  kind: QueuedPayrollResync["kind"];
  people: number;
  queuedAt: string;
  attempts: number;
};

const QUEUE_READ_PAGE = 500;

/**
 * Every parked resync for one payroll month, due or not. THROWS when the queue cannot be read: a
 * caller deciding whether Part 2 may be confirmed must refuse on "unknown", never read it as none.
 */
export async function queuedPayrollResyncsForPeriod(month: number, year: number): Promise<ParkedPayrollResync[]> {
  const supabase = getSupabaseAdmin({ requestTimeoutMs: OUTBOX_RETRY_TIMEOUT_MS });
  const parked: ParkedPayrollResync[] = [];
  for (let from = 0; ; from += QUEUE_READ_PAGE) {
    const { data, error } = await supabase
      .from(PAYROLL_RESYNC_OUTBOX_TABLE)
      .select("payload, attempts, created_at")
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + QUEUE_READ_PAGE - 1);
    if (error) throw new Error(`The payroll decision queue could not be read: ${error.message}`);
    const rows = (data ?? []) as Array<{ payload: unknown; attempts: number | null; created_at: string }>;
    for (const row of rows) {
      const payload = readQueuedPayrollResync(row.payload);
      if (!payload || !queuedPayrollResyncIsForPeriod(payload, month, year)) continue;
      parked.push({
        kind: payload.kind,
        people:
          payload.kind === "deduction"
            ? payload.target.employees.length
            : payload.target.byPeriod
                .filter((period) => period.month === month && period.year === year)
                .reduce((sum, period) => sum + period.hrIds.length, 0),
        queuedAt: row.created_at,
        attempts: row.attempts ?? 0,
      });
    }
    if (rows.length < QUEUE_READ_PAGE) return parked;
  }
}

/**
 * Land every parked resync for one payroll month NOW, back-off ignored — the moment before Part 2 is
 * confirmed, when an hour's wait would let the run be confirmed without them. Each one still runs
 * under the run's hold; one that fails again stays parked and the caller's own check refuses.
 */
export function landQueuedPayrollResyncsForPeriod(month: number, year: number) {
  return drainOutbox(payrollResyncQueue, QUEUE_READ_PAGE, (payload) =>
    queuedPayrollResyncIsForPeriod(payload, month, year),
  );
}

/**
 * Park a resync that could not run under the hold. Returns whether it is safely queued; `false`
 * leaves the caller's own "could not be updated" line and log as the only record, as before.
 */
export function queuePayrollResyncRetry(payload: QueuedPayrollResync, error: unknown): Promise<boolean> {
  return queueOutboxWrite(payrollResyncQueue, payload, error);
}
