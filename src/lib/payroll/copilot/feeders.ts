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
 *   deduction_candidates  → employee_hr_id_compact, month, year, superseded_at
 *   employee_resignations → employee_hr_id, last_working_date, exit_status
 *   payroll_expenses      → hr_id, payout_month, payout_year, hr_approved
 */

/** Lowercase alphanumeric key so all feeder ids match regardless of hyphen/case. */
export function compactHrKey(hrId: string | null | undefined): string {
  return String(hrId ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
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
      console.error(`[payroll-copilot:feeders:${context}] query failed:`, error);
      return [];
    }
    return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
  } catch (error) {
    console.error(`[payroll-copilot:feeders:${context}] query threw:`, error);
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
      pendingExpense: false,
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
      .select("employee_hr_id,duration_days,status")
      .eq("payment_status", "unpaid")
      .in("status", ["approved", "pending_manager"])
      .lte("start_date", end)
      .gte("end_date", start),
  );
  for (const row of unpaidLeave) {
    const key = compactHrKey(String(row.employee_hr_id ?? ""));
    if (!key) continue;
    const days = Number(row.duration_days ?? 0);
    const state = ensure(states, key);
    state.unpaidLeaveDays += Number.isFinite(days) ? days : 0;
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

  // Expenses tied to this payout period that are not yet HR-approved.
  const pendingExpenses = await safeRows("pending_expenses", () =>
    supabase
      .from("payroll_expenses")
      .select("hr_id,hr_approved,payout_month,payout_year")
      .eq("payout_month", period.month)
      .eq("payout_year", period.year)
      .eq("hr_approved", false),
  );
  for (const row of pendingExpenses) {
    const key = compactHrKey(String(row.hr_id ?? ""));
    if (!key) continue;
    ensure(states, key).pendingExpense = true;
  }

  return states;
}
