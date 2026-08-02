// Unified Deductions module: Unpaid Vacation + Insufficient Balance Vacation
// category connectors — one shared query builder, split by
// v2_vacation_requests.unpaid_reason (a real, already-coded enum:
// 'first_six_months' | 'insufficient_balance' | 'missing_hire_date').
//
// insufficient_balance is the one reason that's a genuine balance-math
// shortfall; first_six_months (a flat policy block, pre-entitlement) and
// missing_hire_date (a data-quality fallback with no balance period to
// compute) both represent "not entitled to paid leave right now" for reasons
// unrelated to balance math, so they land together as plain Unpaid Vacation.
// Ported from deductions-governance/connectors/vacation.ts's query shape,
// which took every unpaid_duration_days > 0 row with no reason filter at all.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getBaseSalaryMap } from "@/lib/payroll/copilot/feeders.ts";
import { assertBaseSalaryMapLoaded } from "./health.ts";
import { calculateDeductionAmountFromBaseSalary } from "../calculations.ts";
import { compactDeductionsHrId } from "../candidate-key.ts";
import type { DeductionsCandidateDraft, DeductionsCategory } from "../types.ts";

type VacationRequestRow = {
  id: string;
  employee_hr_id: string | null;
  employee_name: string | null;
  start_date: string | null;
  end_date: string | null;
  status: string | null;
  payment_status: string | null;
  unpaid_duration_days: number | string | null;
  unpaid_reason: string | null;
  vacation_type: string | null;
  manager_hr_id: string | null;
  manager_of_manager_hr_id: string | null;
};

function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function unpaidDays(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) / 100 : 0;
}

/** Every ISO date from start..end inclusive. Small ranges only (a leave request). */
export function expandDateRange(startDate: string, endDate: string): string[] {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return [];
  const dates: string[] = [];
  const cursor = new Date(start);
  // Hard cap: a single leave request spanning more than a year is a data error,
  // not something to loop over indefinitely.
  while (cursor <= end && dates.length < 400) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export type MonthClippedLeave = {
  datesInMonth: string[];
  daysInMonth: number;
  totalSpanDays: number;
  spansMonthBoundary: boolean;
};

/**
 * Clips a leave request to one month and apportions its unpaid days.
 *
 * A request overlapping the month boundary (e.g. 25 May – 5 Jun) previously
 * produced a candidate carrying the request's FULL unpaid_duration_days in BOTH
 * months — 11 unpaid days became 22 days deducted. The candidate_key includes
 * monthKey, so the unique index saw two legitimately distinct keys and allowed
 * both.
 *
 * Unpaid days are apportioned pro-rata across the span rather than assumed to
 * fall in either month, because v2_vacation_requests records only a total —
 * it does not say WHICH days within the range were the unpaid ones.
 */
export function clipLeaveToMonth(input: {
  startDate: string;
  endDate: string;
  monthKey: string;
  totalUnpaidDays: number;
}): MonthClippedLeave {
  const allDates = expandDateRange(input.startDate, input.endDate);
  const datesInMonth = allDates.filter((date) => date.startsWith(`${input.monthKey}-`));
  const totalSpanDays = allDates.length;
  if (totalSpanDays === 0 || datesInMonth.length === 0) {
    return { datesInMonth: [], daysInMonth: 0, totalSpanDays, spansMonthBoundary: false };
  }
  const spansMonthBoundary = datesInMonth.length < totalSpanDays;
  const daysInMonth = spansMonthBoundary
    ? Math.round(input.totalUnpaidDays * (datesInMonth.length / totalSpanDays) * 100) / 100
    : input.totalUnpaidDays;
  return { datesInMonth, daysInMonth, totalSpanDays, spansMonthBoundary };
}

async function collectVacationCandidatesByReason(input: {
  month: number;
  year: number;
  category: Extract<DeductionsCategory, "unpaid_vacation" | "insufficient_balance_vacation">;
  unpaidReasons: string[];
  reasonLabel: string;
}): Promise<DeductionsCandidateDraft[]> {
  const monthKey = `${input.year}-${String(input.month).padStart(2, "0")}`;
  const start = `${monthKey}-01`;
  const end = `${monthKey}-${String(lastDayOfMonth(input.year, input.month)).padStart(2, "0")}`;

  const { data, error } = await getSupabaseAdmin()
    .from("v2_vacation_requests")
    .select(
      "id,employee_hr_id,employee_name,start_date,end_date,status,payment_status,unpaid_duration_days,unpaid_reason,vacation_type,manager_hr_id,manager_of_manager_hr_id",
    )
    .eq("status", "approved")
    .gt("unpaid_duration_days", 0)
    .in("unpaid_reason", input.unpaidReasons)
    .lte("start_date", end)
    .gte("end_date", start);
  if (error) throw new Error(`Failed to load vacation requests: ${error.message}`);

  // B6. This connector used to emit no estimatedAmount at all, so every approved
  // unpaid-vacation candidate landed as a NULL amount — and publishMonth refuses a
  // month containing one. A single 0.5-day request therefore blocked the WHOLE
  // month's publish with no in-app way to resolve it (July 2026: Hany Saad Mohamed
  // Omar). Compute the money here, exactly as the CRM and No-Records connectors do.
  const baseSalaryByCompact = await getBaseSalaryMap();
  // Fail closed: an empty map is a feeder outage, not "nobody has a salary".
  assertBaseSalaryMapLoaded("Vacation connector", baseSalaryByCompact);

  const drafts: DeductionsCandidateDraft[] = [];
  for (const row of (data ?? []) as VacationRequestRow[]) {
    const totalUnpaidDays = unpaidDays(row.unpaid_duration_days);
    if (totalUnpaidDays <= 0 || !row.employee_hr_id) continue;
    const startDate = row.start_date?.slice(0, 10) ?? start;
    const endDate = row.end_date?.slice(0, 10) ?? startDate;

    // Clip to THIS month. A request spanning the boundary must not contribute
    // its whole unpaid total to both months.
    const clipped = clipLeaveToMonth({ startDate, endDate, monthKey, totalUnpaidDays });
    if (clipped.daysInMonth <= 0 || clipped.datesInMonth.length === 0) continue;

    // getBaseSalaryMap is keyed by the COMPACT hr-id (hyphens stripped), not the
    // canonical one — using the wrong key silently misses every lookup, a bug the
    // CRM connector already hit once.
    const compactKey = compactDeductionsHrId(row.employee_hr_id);
    const baseSalary = compactKey ? (baseSalaryByCompact.get(compactKey) ?? null) : null;
    const estimatedAmount = calculateDeductionAmountFromBaseSalary({
      baseSalary,
      deductionDays: clipped.daysInMonth,
      month: input.month,
      year: input.year,
    });

    drafts.push({
      category: input.category,
      sourceSystem: "vacation_balance",
      sourceRecordId: `vacation:${row.id}:${input.category}`,
      employeeHrId: row.employee_hr_id,
      employeeName: row.employee_name,
      monthKey,
      month: input.month,
      year: input.year,
      unit: "days",
      rawValue: clipped.daysInMonth,
      estimatedAmount,
      calculationStatus: estimatedAmount != null ? "calculated" : "requires_review",
      severity: "Medium",
      reason: clipped.spansMonthBoundary
        ? `${input.reasonLabel} — ${clipped.daysInMonth} of ${totalUnpaidDays} unpaid day(s) fall in this month (request runs ${startDate} to ${endDate})`
        : input.reasonLabel,
      evidence: {
        requestId: row.id,
        paymentStatus: row.payment_status,
        status: row.status,
        unpaidReason: row.unpaid_reason,
        vacationType: row.vacation_type,
        requestStartDate: startDate,
        requestEndDate: endDate,
        totalUnpaidDaysOnRequest: totalUnpaidDays,
        spansMonthBoundary: clipped.spansMonthBoundary,
        // Apportioned pro-rata: v2_vacation_requests stores only a total, never
        // which specific days were the unpaid ones.
        apportionment: clipped.spansMonthBoundary
          ? `${clipped.datesInMonth.length} of ${clipped.totalSpanDays} calendar day(s) in this month`
          : null,
        // A data-quality flag, not a business outcome — lets a future report
        // surface "N unpaid-vacation rows exist only because hire_date is missing".
        dataQualityFlag: row.unpaid_reason === "missing_hire_date" ? "missing_hire_date" : null,
      },
      // Every real in-month calendar day, not just [start, end]. The old two-date
      // form made days 2..n-1 invisible to same-day overlap detection.
      dates: clipped.datesInMonth,
      hierarchySnapshot: {
        managerHrId: row.manager_hr_id,
        managerOfManagerHrId: row.manager_of_manager_hr_id,
      },
    });
  }
  return drafts;
}

export async function collectUnpaidVacationCandidates(input: {
  month: number;
  year: number;
}): Promise<DeductionsCandidateDraft[]> {
  return collectVacationCandidatesByReason({
    ...input,
    category: "unpaid_vacation",
    unpaidReasons: ["first_six_months", "missing_hire_date"],
    reasonLabel: "Approved vacation is unpaid (not yet entitled within first 6 months, or hire date missing)",
  });
}

export async function collectInsufficientBalanceVacationCandidates(input: {
  month: number;
  year: number;
}): Promise<DeductionsCandidateDraft[]> {
  return collectVacationCandidatesByReason({
    ...input,
    category: "insufficient_balance_vacation",
    unpaidReasons: ["insufficient_balance"],
    reasonLabel: "Approved vacation includes unpaid days because balance was insufficient",
  });
}
