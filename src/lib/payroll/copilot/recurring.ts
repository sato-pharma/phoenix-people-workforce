import { logError } from "@/lib/observability/log";
import { roundCurrency } from "@/lib/payroll/money";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import type { CopilotPeriod, RecurringAdjustment } from "./types.ts";

/**
 * Cross-month recurring items (loans/advances/allowances/penalties) that
 * auto-apply each run. The CEO sets one once ("loan 1000/month x 6") and it is
 * applied every period and counted down until exhausted.
 */

function mapRecurring(row: Record<string, unknown>): RecurringAdjustment {
  return {
    id: String(row.id),
    employeeHrId: String(row.employee_hr_id ?? ""),
    kind: String(row.kind ?? "loan") as RecurringAdjustment["kind"],
    monthlyAmount: roundCurrency(Number(row.monthly_amount ?? 0)),
    remainingInstallments:
      row.remaining_installments === null || row.remaining_installments === undefined
        ? null
        : Number(row.remaining_installments),
    startMonth: Number(row.start_month ?? 1),
    startYear: Number(row.start_year ?? 2000),
    active: row.active !== false,
    note: row.note ? String(row.note) : null,
  };
}

function periodIndex(month: number, year: number): number {
  return year * 12 + (month - 1);
}

/** True when a recurring item should apply in the given period. */
export function isRecurringActiveForPeriod(
  item: RecurringAdjustment,
  period: CopilotPeriod,
): boolean {
  if (!item.active) return false;
  if (periodIndex(period.month, period.year) < periodIndex(item.startMonth, item.startYear)) {
    return false;
  }
  if (item.remainingInstallments !== null && item.remainingInstallments <= 0) return false;
  return true;
}

/** Active recurring items that apply to this period (does not mutate counters). */
export async function listRecurringForPeriod(
  period: CopilotPeriod,
): Promise<RecurringAdjustment[]> {
  const supabase = getSupabaseAdmin();
  try {
    const { data, error } = await supabase
      .from("payroll_recurring_adjustments")
      .select("*")
      .eq("active", true);
    if (error) {
      logError("Failed to list recurring payroll adjustments", {
        labels: { event: "recurring_list_failed", month: period.month, year: period.year },
        error,
      });
      return [];
    }
    return ((data ?? []) as Array<Record<string, unknown>>)
      .map(mapRecurring)
      .filter((item) => isRecurringActiveForPeriod(item, period));
  } catch (error) {
    logError("Listing recurring payroll adjustments threw an exception", {
      labels: { event: "recurring_list_threw", month: period.month, year: period.year },
      error,
    });
    return [];
  }
}

/** Create a recurring item (used when the CEO sets up a loan/advance in chat). */
export async function createRecurringAdjustment(input: {
  employeeHrId: string;
  kind: RecurringAdjustment["kind"];
  monthlyAmount: number;
  installments: number | null;
  startMonth: number;
  startYear: number;
  createdBy: string | null;
  note?: string | null;
}): Promise<string | null> {
  const supabase = getSupabaseAdmin();
  try {
    const { data, error } = await supabase
      .from("payroll_recurring_adjustments")
      .insert({
        employee_hr_id: input.employeeHrId,
        kind: input.kind,
        monthly_amount: roundCurrency(input.monthlyAmount),
        remaining_installments: input.installments,
        start_month: input.startMonth,
        start_year: input.startYear,
        active: true,
        note: input.note ?? null,
        created_by: input.createdBy,
      })
      .select("id")
      .single();
    if (error) {
      logError("Failed to create recurring payroll adjustment", {
        labels: { event: "recurring_create_failed", hrId: input.employeeHrId, kind: input.kind },
        error,
      });
      return null;
    }
    return data ? String((data as Record<string, unknown>).id) : null;
  } catch (error) {
    logError("Creating recurring payroll adjustment threw an exception", {
      labels: { event: "recurring_create_threw", hrId: input.employeeHrId, kind: input.kind },
      error,
    });
    return null;
  }
}

/**
 * Consume one installment of each finite recurring item for a period. Called
 * exactly once, at materialization, so re-assembling a draft never double-counts.
 */
export async function consumeRecurringForPeriod(period: CopilotPeriod): Promise<void> {
  const items = await listRecurringForPeriod(period);
  const supabase = getSupabaseAdmin();
  for (const item of items) {
    if (item.remainingInstallments === null) continue;
    const remaining = item.remainingInstallments - 1;
    try {
      const { error } = await supabase
        .from("payroll_recurring_adjustments")
        .update({
          remaining_installments: remaining,
          active: remaining > 0,
          updated_at: new Date().toISOString(),
        })
        .eq("id", item.id);
      if (error) {
        logError("Failed to consume recurring payroll adjustment installment", {
          labels: { event: "recurring_consume_failed", recurringId: item.id, hrId: item.employeeHrId },
          error,
        });
      }
    } catch (error) {
      logError("Consuming recurring payroll adjustment installment threw an exception", {
        labels: { event: "recurring_consume_threw", recurringId: item.id, hrId: item.employeeHrId },
        error,
      });
    }
  }
}
