import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { logError } from "@/lib/observability/log";
import { roundCurrency } from "@/lib/payroll/money";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { compactHrKey } from "./feeders.ts";
import type { CopilotPeriod } from "./types.ts";

/**
 * Bridges the Payroll Copilot to a NEW settlement table
 * (payroll_copilot_expense_decisions) that records the CEO's decision on
 * whether an HR-approved outstation expense request is included in this
 * payroll run or deferred to next month. Never touches
 * outstation_expense_requests — that table (and its `status` approval flow)
 * is owned by the outstation domain, decided by a different actor at a
 * different time. Only `status = 'approved'` requests are ever candidates
 * here; unapproved ones are simply not payroll's concern yet.
 *
 * Replaces the old vague "pending_unapproved" chat flag and the always-zero
 * `expenses` field in assemble.ts (see buildIncludedExpenseTotals below).
 *
 * EXPENSES LAG ONE MONTH (owner-dictated rule): a payroll period pays out
 * the PRIOR calendar month's approved outstation expenses — June payroll
 * settles May's approved trips, not June's. `sourceExpenseMonthBounds` below
 * resolves that prior-month window; every query in this file filters on it,
 * not on the payroll period's own month.
 */

export type ExpenseCandidate = {
  id: string;
  employeeHrId: string;
  employeeName: string | null;
  dateFrom: string;
  dateTo: string;
  locationFrom: string;
  locationTo: string;
  km: number | null;
  type: string;
  travelCost: number;
  allowance: number;
  existingDecision: { decision: "include" | "defer"; decidedAt: string } | null;
};

/** The {month, year} immediately BEFORE the payroll period (exported for tests and for labeling exports/UI). */
export function priorPeriod(period: CopilotPeriod): CopilotPeriod {
  return period.month === 1
    ? { month: 12, year: period.year - 1 }
    : { month: period.month - 1, year: period.year };
}

/** The calendar month immediately BEFORE the payroll period — the month whose approved outstation expenses this payroll pays out (exported for tests). */
export function sourceExpenseMonthBounds(period: CopilotPeriod): { start: string; end: string } {
  const prior = priorPeriod(period);
  const mm = String(prior.month).padStart(2, "0");
  const start = `${prior.year}-${mm}-01`;
  const lastDay = new Date(Date.UTC(prior.year, prior.month, 0)).getUTCDate();
  const end = `${prior.year}-${mm}-${String(lastDay).padStart(2, "0")}`;
  return { start, end };
}

function isoDateOnly(value: string): string {
  return value.slice(0, 10);
}

function joinLocation(city: unknown, area: unknown): string {
  return [city, area].map((part) => String(part ?? "").trim()).filter(Boolean).join(" / ") || "—";
}

async function loadExistingDecisions(
  period: CopilotPeriod,
): Promise<Map<string, { decision: "include" | "defer"; decidedAt: string }>> {
  const map = new Map<string, { decision: "include" | "defer"; decidedAt: string }>();
  const { start, end } = sourceExpenseMonthBounds(period);
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("payroll_copilot_expense_decisions")
      .select("outstation_expense_request_id,decision,decided_at")
      .is("superseded_at", null)
      .gte("request_trip_start_date", start)
      .lte("request_trip_start_date", end);
    if (error) {
      logError("Failed to load existing expense decisions for period", {
        labels: { event: "expense_review_existing_decisions_load_failed", month: period.month, year: period.year },
        error,
      });
      return map;
    }
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      map.set(String(row.outstation_expense_request_id ?? ""), {
        decision: row.decision === "defer" ? "defer" : "include",
        decidedAt: String(row.decided_at ?? ""),
      });
    }
  } catch (error) {
    logError("Existing expense decisions load threw an exception", {
      labels: { event: "expense_review_existing_decisions_load_threw", month: period.month, year: period.year },
      error,
    });
  }
  return map;
}

/** HR-approved outstation expense requests overlapping the period, with any already-decided include/defer choice. */
export async function listExpenseCandidates(period: CopilotPeriod): Promise<ExpenseCandidate[]> {
  const { start, end } = sourceExpenseMonthBounds(period);
  const supabase = getSupabaseAdmin();

  const [{ data: requests, error }, directory, existingDecisions] = await Promise.all([
    supabase
      .from("outstation_expense_requests")
      .select(
        "id,employee_hr_id,employee_name,trip_start_date,trip_end_date,residence_city,residence_area,to_city,to_area,distance_km,expense_type,fuel_amount,ticket_amount,allowance_amount",
      )
      .in("status", ["accepted_by_system", "accepted_by_admin", "approved"])
      .lte("trip_start_date", end)
      .gte("trip_end_date", start),
    getEmployeeDirectory(),
    loadExistingDecisions(period),
  ]);

  if (error) {
    logError("Failed to load outstation expense requests for period", {
      labels: { event: "expense_review_requests_load_failed", month: period.month, year: period.year },
      error,
    });
    return [];
  }

  const directoryByCompact = new Map(directory.employees.map((employee) => [compactHrKey(employee.hrId), employee]));
  const candidates: ExpenseCandidate[] = [];

  for (const row of (requests ?? []) as Array<Record<string, unknown>>) {
    const hrId = String(row.employee_hr_id ?? "").trim();
    const compact = compactHrKey(hrId);
    if (!compact) continue;
    const employee = directoryByCompact.get(compact);
    const id = String(row.id ?? "");

    candidates.push({
      id,
      employeeHrId: hrId,
      employeeName: employee?.fullName ?? (row.employee_name ? String(row.employee_name) : null),
      dateFrom: isoDateOnly(String(row.trip_start_date ?? "")),
      dateTo: isoDateOnly(String(row.trip_end_date ?? "")),
      locationFrom: joinLocation(row.residence_city, row.residence_area),
      locationTo: joinLocation(row.to_city, row.to_area),
      km: row.distance_km == null ? null : Number(row.distance_km),
      type: String(row.expense_type ?? "traveling"),
      travelCost: roundCurrency(Number(row.fuel_amount ?? 0) + Number(row.ticket_amount ?? 0)),
      allowance: roundCurrency(Number(row.allowance_amount ?? 0)),
      existingDecision: existingDecisions.get(id) ?? null,
    });
  }

  return candidates;
}

export type IncludedExpenseTotals = Map<string, number>;

/**
 * Per-employee sum of already-"include" expense decisions for the period,
 * keyed by compact HR id — wired into assemble.ts's `expenses` field, which
 * was hardcoded to 0 before this tab existed. Defensive: never throws, empty
 * map on failure.
 */
export async function buildIncludedExpenseTotals(period: CopilotPeriod): Promise<IncludedExpenseTotals> {
  const totals: IncludedExpenseTotals = new Map();
  const { start, end } = sourceExpenseMonthBounds(period);
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("payroll_copilot_expense_decisions")
      .select("employee_hr_id_compact,travel_cost,allowance")
      .eq("decision", "include")
      .is("superseded_at", null)
      .gte("request_trip_start_date", start)
      .lte("request_trip_start_date", end);
    if (error) {
      logError("Failed to load included expense totals for period", {
        labels: { event: "expense_review_included_totals_load_failed", month: period.month, year: period.year },
        error,
      });
      return totals;
    }
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const key = String(row.employee_hr_id_compact ?? "");
      if (!key) continue;
      const amount = Number(row.travel_cost ?? 0) + Number(row.allowance ?? 0);
      totals.set(key, (totals.get(key) ?? 0) + (Number.isFinite(amount) ? amount : 0));
    }
  } catch (error) {
    logError("Included expense totals load threw an exception", {
      labels: { event: "expense_review_included_totals_load_threw", month: period.month, year: period.year },
      error,
    });
  }
  return totals;
}

/**
 * Records the CEO's include/defer decision for one expense request.
 * Supersedes any existing live decision first — a re-decision (e.g.
 * defer -> include) must never leave two live rows.
 */
export async function recordExpenseDecision(input: {
  runId: string;
  candidate: ExpenseCandidate;
  decision: "include" | "defer";
  decidedBy: string;
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const compact = compactHrKey(input.candidate.employeeHrId);
  if (!compact) throw new Error("Invalid employee HR id for expense decision.");

  await supabase
    .from("payroll_copilot_expense_decisions")
    .update({ superseded_at: new Date().toISOString() })
    .eq("outstation_expense_request_id", input.candidate.id)
    .is("superseded_at", null);

  const { error } = await supabase.from("payroll_copilot_expense_decisions").insert({
    run_id: input.runId || null,
    employee_hr_id: input.candidate.employeeHrId,
    employee_hr_id_compact: compact,
    outstation_expense_request_id: input.candidate.id,
    request_trip_start_date: input.candidate.dateFrom,
    travel_cost: input.candidate.travelCost,
    allowance: input.candidate.allowance,
    decision: input.decision,
    decided_by: input.decidedBy,
  });
  if (error) throw error;
}
