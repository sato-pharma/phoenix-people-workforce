import { logError } from "@/lib/observability/log";
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
    const { data, error } = await supabase.from("employees").select("hr_id,base_salary");
    if (error) {
      logError("Failed to load base-salary map for payroll copilot feeders", {
        labels: { event: "feeders_base_salary_load_failed" },
        error,
      });
      return map;
    }
    for (const row of (data ?? []) as Array<{ hr_id: string; base_salary: number | null }>) {
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

function isoDateOnly(value: string): string {
  return value.slice(0, 10);
}

function daysBetweenInclusive(startIso: string, endIso: string): number {
  const start = Date.parse(`${isoDateOnly(startIso)}T00:00:00Z`);
  const end = Date.parse(`${isoDateOnly(endIso)}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.round((end - start) / 86400000) + 1;
}

/** Inclusive-day overlap between [aStart, aEnd] and [bStart, bEnd] (ISO date strings). */
function overlapDays(aStart: string, aEnd: string, bStart: string, bEnd: string): number {
  const start = aStart > bStart ? aStart : bStart;
  const end = aEnd < bEnd ? aEnd : bEnd;
  return daysBetweenInclusive(start, end);
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
      attendanceDeductionPending: false,
      leaverLastWorkingDate: null,
      unpaidDaysBeforeLastWorkingDate: 0,
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
): Promise<Map<string, EmployeeFeederState>> {
  const supabase = getSupabaseAdmin();
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
  type UnpaidLeaveRow = { key: string; startDate: string; endDate: string; days: number };
  const unpaidLeaveRows: UnpaidLeaveRow[] = [];
  for (const row of unpaidLeave) {
    const key = compactHrKey(String(row.employee_hr_id ?? ""));
    if (!key) continue;
    const days = Number(row.duration_days ?? 0);
    const state = ensure(states, key);
    state.unpaidLeaveDays += Number.isFinite(days) ? days : 0;
    const startDate = row.start_date ? isoDateOnly(String(row.start_date)) : "";
    const endDate = row.end_date ? isoDateOnly(String(row.end_date)) : "";
    if (startDate && endDate) {
      unpaidLeaveRows.push({ key, startDate, endDate, days: Number.isFinite(days) ? days : 0 });
    }
  }

  // Active attendance-device deduction candidates for the period.
  const attendance = await safeRows("attendance", () =>
    supabase
      .from("deduction_candidates")
      .select("employee_hr_id_compact,source_module,superseded_at")
      .eq("month", period.month)
      .eq("year", period.year)
      .is("superseded_at", null),
  );
  for (const row of attendance) {
    const key = compactHrKey(String(row.employee_hr_id_compact ?? ""));
    if (!key) continue;
    ensure(states, key).attendanceDeductionPending = true;
  }

  // Leavers whose last working day falls in the period.
  const leavers = await safeRows("leavers", () =>
    supabase
      .from("employee_resignations")
      .select("employee_hr_id,last_working_date,exit_status")
      .gte("last_working_date", start)
      .lte("last_working_date", end)
      .in("exit_status", ["submitted", "approved", "completed"]),
  );
  for (const row of leavers) {
    const key = compactHrKey(String(row.employee_hr_id ?? ""));
    if (!key) continue;
    ensure(states, key).leaverLastWorkingDate = String(row.last_working_date ?? "") || null;
  }

  // Resignation Rule 1 needs unpaid-leave days clipped to [period start, last
  // working date] specifically — not the whole-month total above. Prorate each
  // unpaid-leave row's duration_days by how much of its own span overlaps that
  // narrower window, in case only part of a leave request falls before exit.
  for (const row of unpaidLeaveRows) {
    const state = states.get(row.key);
    const lastWorkingDate = state?.leaverLastWorkingDate;
    if (!state || !lastWorkingDate) continue;
    const spanDays = daysBetweenInclusive(row.startDate, row.endDate);
    if (spanDays <= 0) continue;
    const clip = overlapDays(row.startDate, row.endDate, start, lastWorkingDate);
    if (clip <= 0) continue;
    state.unpaidDaysBeforeLastWorkingDate += row.days * (clip / spanDays);
  }

  return states;
}
