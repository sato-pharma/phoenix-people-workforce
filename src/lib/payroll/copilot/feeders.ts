import { logError } from "@/lib/observability/log";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import type { CopilotPeriod, EmployeeFeederState } from "./types.ts";

/**
 * Read adapters over the existing feeder tables. Every query is defensive: a
 * failure (missing table/column, RLS, transient error) is logged and treated as
 * "no signal" rather than throwing — a missing feeder must never crash a payroll
 * run, and absence of data is itself surfaced by the missing_data flag.
 *
 * Column names verified against the live migrations (2026-07-06):
 *   v2_vacation_requests  → payment_status='unpaid', status, start_date/end_date, duration_days
 *                           (start_date/end_date also used to clip unpaid days to a leaver's
 *                           specific settlement span — see the resignation Rule 1 pass below)
 *   deduction_candidates  → employee_hr_id_compact, month, year, superseded_at
 *   employee_resignations → employee_hr_id, last_working_date, exit_status
 *
 * Expenses are NOT a feeder signal here — they're their own dedicated review
 * tab (see expense-review.ts), reading outstation_expense_requests directly.
 */

/** Lowercase alphanumeric key so all feeder ids match regardless of hyphen/case. */
export function compactHrKey(hrId: string | null | undefined): string {
  return String(hrId ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Map of compact HR key -> base salary (> 0), for estimating a day-based
 * deduction's value before it has a decided amount (governance candidates
 * store no amount until approval). Shared by the payroll-sheet assembler
 * (mandatory no-activity totals) and the deduction xlsx exports, so both
 * always show the same estimate. Defensive: never throws.
 */
export async function getBaseSalaryMap(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const supabase = getSupabaseAdmin();
    // The WHOLE roster, page by page: every deduction estimate prices a day from this map, and a
    // person cut off by a response ceiling would silently be priced at nothing. A failed page falls
    // to the catch below, which logs it and hands back the (empty) map as before.
    const rows = await fetchAllRows<{ hr_id: string; base_salary: number | null }>(
      () => supabase.from("employees").select("hr_id,base_salary"),
      "hr_id",
    );
    for (const row of rows) {
      const key = compactHrKey(String(row.hr_id ?? ""));
      const salary = Number(row.base_salary ?? 0);
      if (key && Number.isFinite(salary) && salary > 0) map.set(key, salary);
    }
  } catch (error) {
    logError("Base-salary map load threw an exception", {
      labels: { event: "feeders_base_salary_load_threw" },
      error,
    });
  }
  return map;
}

function periodBounds(period: CopilotPeriod): { start: string; end: string } {
  const mm = String(period.month).padStart(2, "0");
  const start = `${period.year}-${mm}-01`;
  const lastDay = new Date(Date.UTC(period.year, period.month, 0)).getUTCDate();
  const end = `${period.year}-${mm}-${String(lastDay).padStart(2, "0")}`;
  return { start, end };
}

async function safeRows(
  context: string,
  run: () => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<Array<Record<string, unknown>>> {
  try {
    const { data, error } = await run();
    if (error) {
      logError(`Payroll copilot feeder query failed: ${context}`, {
        labels: { event: "feeders_query_failed", feeder: context },
        error,
      });
      return [];
    }
    return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
  } catch (error) {
    logError(`Payroll copilot feeder query threw an exception: ${context}`, {
      labels: { event: "feeders_query_threw", feeder: context },
      error,
    });
    return [];
  }
}

function ensure(map: Map<string, EmployeeFeederState>, key: string): EmployeeFeederState {
  let state = map.get(key);
  if (!state) {
    state = {
      unpaidLeaveDays: 0,
      leaverLastWorkingDate: null,
    };
    map.set(key, state);
  }
  return state;
}

/**
 * Build the per-employee feeder snapshot for a period, keyed by compact HR id.
 */
export async function buildFeederStates(
  period: CopilotPeriod,
  /** Injected only by the test — production always uses the admin client. */
  client: Pick<ReturnType<typeof getSupabaseAdmin>, "from"> = getSupabaseAdmin(),
): Promise<Map<string, EmployeeFeederState>> {
  const supabase = client;
  const { start, end } = periodBounds(period);
  const states = new Map<string, EmployeeFeederState>();

  // Unpaid leave overlapping the period.
  const unpaidLeave = await safeRows("unpaid_leave", () =>
    supabase
      .from("v2_vacation_requests")
      .select("employee_hr_id,duration_days,status,start_date,end_date")
      .eq("payment_status", "unpaid")
      .in("status", ["approved", "pending_manager"])
      .lte("start_date", end)
      .gte("end_date", start),
  );
  for (const row of unpaidLeave) {
    const key = compactHrKey(String(row.employee_hr_id ?? ""));
    if (!key) continue;
    const days = Number(row.duration_days ?? 0);
    ensure(states, key).unpaidLeaveDays += Number.isFinite(days) ? days : 0;
  }

  // Leavers whose last working day falls in the period.
  //
  // THIS ONE FAILS CLOSED, unlike every other read in this function.
  //
  // An empty leaver set does not merely lose a signal, it REMOVES PEOPLE FROM THE RUN. The
  // population rule in recommend.ts keeps a payroll-ineligible employee only when they are a
  // leaver this month or are serving notice into a later one; `employment_status` flips to a
  // terminal value the moment a resignation is approved, so with no leaver rows every one of them
  // is ineligible, not a leaver, not on notice — and is skipped. Their final month disappears from
  // every step and every sheet, with no error and no empty state to notice it by.
  //
  // Measured on production: every leaver since June carries a terminal status, so all of them
  // would go. August 2026 alone is 30 people and 579,000 EGP of monthly net salary.
  //
  // A payroll run that cannot read its leavers must stop and say so. That is strictly better than
  // producing a sheet which looks complete and is missing thirty people.
  const leaverQuery = await supabase
    .from("employee_resignations")
    .select("employee_hr_id,last_working_date,exit_status")
    .gte("last_working_date", start)
    .lte("last_working_date", end)
    .in("exit_status", ["submitted", "approved", "completed"]);
  if (leaverQuery.error) {
    logError("Payroll copilot feeder query failed: leavers", {
      labels: { event: "feeders_query_failed", feeder: "leavers" },
      error: leaverQuery.error,
    });
    throw new Error(
      "Could not read this month's leavers, so the payroll population cannot be built. " +
        "Every already-resigned employee would be dropped from the run and their final month lost. " +
        `Retry once the database is reachable. (${leaverQuery.error.message ?? "unknown error"})`,
    );
  }
  const leavers = Array.isArray(leaverQuery.data)
    ? (leaverQuery.data as Array<Record<string, unknown>>)
    : [];
  for (const row of leavers) {
    const key = compactHrKey(String(row.employee_hr_id ?? ""));
    if (!key) continue;
    ensure(states, key).leaverLastWorkingDate = String(row.last_working_date ?? "") || null;
  }

  // REMOVED 2026-09-11: the unpaid-leave days clipped to [period start, last working date].
  //
  // This existed for exactly one consumer — computeResignationSettlement subtracted it from a
  // leaver's days worked — and that subtraction charged the same approved leave TWICE. The
  // Deductions module raises an unpaid-vacation candidate from the very same `v2_vacation_requests`
  // rows, and payroll charges it on the Unpaid Vacation tab. The days came off the pay, and the
  // money came off again.
  //
  // Unified on the figure a human actually edits (owner, 2026-09-11: "we must unify... what really
  // wins, admin edit outputs"). The deduction is reviewable and correctable; this was invisible
  // arithmetic, and it also moved the Days Worked figure the admin is asked to correct by hand.
  //
  // Deleted rather than left computed-but-unread: a field still being calculated is a second
  // opinion waiting to be re-wired, which is the thing being unified away. `state.unpaidLeaveDays`
  // above still carries the whole-month unpaid total for the callers that legitimately want it.

  return states;
}
