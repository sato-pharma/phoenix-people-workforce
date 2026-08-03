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
import { scanVisitsForRangeIncludingDeparted } from "@/lib/crm/reads.ts";
import { calculatePaymentForRequest } from "@/lib/vacation/service.ts";
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

/**
 * iReports360's Annual Vacation code. `ireports360-source.ts` maps -4 to the "AV" status
 * and its own comment calls it "the only genuine leave type here" — the other negative
 * codes are excuses, health days and the like, which are NOT vacation and must not be
 * charged as one.
 */
const CRM_ANNUAL_VACATION_VISIT_TYPE = -4;

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

/**
 * VACATIONS ARE SUBMITTED IN TWO PLACES, AND THIS CONNECTOR ONLY EVER READ ONE.
 *
 * `v2_vacation_requests` is the HR system. But a vacation can also be entered on CRM —
 * iReports360 visit type -4, "Annual Vacation", which `ireports360-source.ts` maps to the
 * "AV" status. That second source was invisible here, so an employee who took leave on CRM
 * with no balance to cover it generated NO candidate at all.
 *
 * This is the only under-detection in the module: every other defect found on 2026-08-02
 * over-charged. Measured on July 2026 production: 84 CRM vacation days across 43 employees
 * had no matching HR request. Running each through the balance engine, 61 were covered by
 * balance and 23 were not — 15 Medical Reps hired Jan–May 2026, all `first_six_months`,
 * 10,725.76 EGP that should have been deducted and was not.
 *
 * WHY IT CALLS THE ENGINE RATHER THAN JUDGING BALANCE ITSELF
 *
 * There is no balance table. A balance is derived per employee from the hire-date-anchored
 * entitlement period, approved requests inside it, days consumed via payroll settlement,
 * and debt carried forward from prior periods. `calculatePaymentForRequest` is the same
 * function that runs when someone files a request, so calling it keeps this connector and
 * the vacation module in agreement by construction. Re-deriving the arithmetic is exactly
 * how two `calculateDeductionAmountFromBaseSalary` functions came to disagree on a divisor.
 *
 * The unpaid REASON the engine returns decides the category, so a CRM day lands in the same
 * bucket an identical HR request would.
 */
async function collectCrmSubmittedUnpaidVacationDays(input: {
  month: number;
  year: number;
  category: Extract<DeductionsCategory, "unpaid_vacation" | "insufficient_balance_vacation">;
  unpaidReasons: string[];
}): Promise<DeductionsCandidateDraft[]> {
  const monthKey = `${input.year}-${String(input.month).padStart(2, "0")}`;
  const start = `${monthKey}-01`;
  const end = `${monthKey}-${String(lastDayOfMonth(input.year, input.month)).padStart(2, "0")}`;
  const supabase = getSupabaseAdmin();

  const baseSalaryByCompact = await getBaseSalaryMap();
  assertBaseSalaryMapLoaded("Vacation connector (CRM source)", baseSalaryByCompact);

  // The CRM mirror is read through src/lib/crm's single door, never queried directly —
  // `tests/crm-single-source-door` enforces that, and it caught the first cut of this.
  //
  // INCLUDING DEPARTED on purpose. The plain scan hides a resigned rep's visits from
  // company-wide views, but that read's own doc says a caller looking up one person's own
  // history for payroll must not have it hidden. A leaver's unpaid vacation is still owed,
  // so excluding them would silently drop exactly the people whose final month matters.
  const [{ data: employeeRows, error: employeeError }, visits, { data: requestRows, error: requestError }] =
    await Promise.all([
      supabase.from("employees").select("hr_id,full_name,crm_id,hire_date"),
      // `ampm` and the NON-vacation rows are both needed to spot a part-day. A
      // rep can log AM annual leave and then work the afternoon — see the mixed
      // day below — and filtering to visit_type -4 before looking would throw
      // away the very evidence that says it was half a day.
      scanVisitsForRangeIncludingDeparted<{
        agent_crm_id: unknown;
        visit_date: unknown;
        visit_type: unknown;
        ampm: unknown;
      }>({
        columns: "agent_crm_id,visit_date,visit_type,ampm",
        dateFrom: start,
        dateTo: end,
      }),
      supabase.from("v2_vacation_requests").select("employee_hr_id,start_date,end_date").lte("start_date", end).gte("end_date", start),
    ]);
  // Fail closed on every read. A silent empty result here means "nobody took CRM leave",
  // which is indistinguishable from the outage that produced this gap in the first place.
  // (scanVisitsForRangeIncludingDeparted throws on failure rather than returning empty.)
  if (employeeError) throw new Error(`Vacation connector: employees read failed: ${employeeError.message}`);
  if (requestError) throw new Error(`Vacation connector: vacation request read failed: ${requestError.message}`);
  const visitRows = visits.filter((visit) => Number(visit.visit_type) === CRM_ANNUAL_VACATION_VISIT_TYPE);

  // MIXED DAYS: a date carrying BOTH a vacation record and real work.
  //
  // Owner's rule (2026-08-03): such a day must not be charged as a full day
  // unattended. Measured on July 2026 production, 19 days across 17 people look
  // like this — roughly one vacation day in four — and each was being charged at
  // 1.00 day. One rep logged AM annual leave and then filed 9 afternoon records;
  // he was charged a full day three times over.
  //
  // The `ampm` values are kept as evidence rather than acted on: the system can
  // see it was probably half a day, but the owner confirms full/AM/PM and the
  // applied value follows that decision, because this is pay.
  const workAmpmByDay = new Map<string, Set<string>>();
  const vacationAmpmByDay = new Map<string, Set<string>>();
  for (const visit of visits) {
    const crmId = String(visit.agent_crm_id ?? "").trim();
    const day = String(visit.visit_date ?? "").slice(0, 10);
    if (!crmId || !day) continue;
    const key = `${crmId}:${day}`;
    const ampm = String(visit.ampm ?? "").trim().toUpperCase();
    const bucket = Number(visit.visit_type) === CRM_ANNUAL_VACATION_VISIT_TYPE ? vacationAmpmByDay : workAmpmByDay;
    const set = bucket.get(key) ?? new Set<string>();
    if (ampm) set.add(ampm);
    bucket.set(key, set);
  }

  const employeeByCrmId = new Map<string, { hrId: string; name: string | null; hireDate: string | null }>();
  for (const row of (employeeRows ?? []) as Array<{ hr_id: string; full_name: string | null; crm_id: string | null; hire_date: string | null }>) {
    const crmId = row.crm_id != null ? String(row.crm_id).trim() : "";
    if (crmId) employeeByCrmId.set(crmId, { hrId: row.hr_id, name: row.full_name, hireDate: row.hire_date });
  }

  const coveredByHrId = new Map<string, Array<{ start: string; end: string }>>();
  for (const row of (requestRows ?? []) as Array<{ employee_hr_id: string | null; start_date: string | null; end_date: string | null }>) {
    const hrId = String(row.employee_hr_id ?? "").trim();
    if (!hrId || !row.start_date) continue;
    const list = coveredByHrId.get(hrId) ?? [];
    list.push({ start: String(row.start_date).slice(0, 10), end: String(row.end_date ?? row.start_date).slice(0, 10) });
    coveredByHrId.set(hrId, list);
  }

  // One entry per (employee, day): several -4 rows on one date is still one vacation day.
  const daysByHrId = new Map<
    string,
    { name: string | null; hireDate: string | null; crmId: string; days: Set<string> }
  >();
  for (const visit of (visitRows ?? []) as Array<{ agent_crm_id: unknown; visit_date: unknown }>) {
    const crmId = String(visit.agent_crm_id ?? "").trim();
    const employee = employeeByCrmId.get(crmId);
    if (!employee) continue;
    const day = String(visit.visit_date ?? "").slice(0, 10);
    if (!day) continue;
    const covered = (coveredByHrId.get(employee.hrId) ?? []).some((range) => day >= range.start && day <= range.end);
    // An HR request already covers this day — the request path above owns it, and taking
    // it here too would double-book the same absence.
    if (covered) continue;
    const entry = daysByHrId.get(employee.hrId) ?? {
      name: employee.name,
      hireDate: employee.hireDate,
      crmId,
      days: new Set<string>(),
    };
    entry.days.add(day);
    daysByHrId.set(employee.hrId, entry);
  }

  const drafts: DeductionsCandidateDraft[] = [];
  for (const [hrId, entry] of daysByHrId) {
    // No hire date means no entitlement period, so the balance is uncomputable. The HR
    // path treats that as `missing_hire_date`; here it would be a guess, so skip rather
    // than charge on an assumption.
    if (!entry.hireDate) continue;

    // Chronological, and consumption is tracked locally: these days are not persisted, so
    // the engine judges every one of them against the same untouched balance. Without this
    // a single remaining day would "cover" several dates at once.
    const orderedDays = [...entry.days].sort();
    let consumedSoFar = 0;
    for (const day of orderedDays) {
      const snapshot = await calculatePaymentForRequest({
        durationDays: 1,
        employeeHrId: hrId,
        hireDate: entry.hireDate,
        startDate: day,
        vacationType: "annual",
      });
      const balanceBefore = snapshot.balanceBeforeDays - consumedSoFar;
      consumedSoFar += 1;

      const unpaid = balanceBefore <= 0 || snapshot.unpaidDurationDays > 0;
      if (!unpaid) continue;
      // Route by the engine's own reason so a CRM day lands in the same category an
      // identical HR request would. A reason outside this collector's set belongs to the
      // sibling collector, not here.
      const reason = snapshot.unpaidReason ?? (balanceBefore <= 0 ? "insufficient_balance" : null);
      if (!reason || !input.unpaidReasons.includes(reason)) continue;

      const compactKey = compactDeductionsHrId(hrId);
      const baseSalary = compactKey ? (baseSalaryByCompact.get(compactKey) ?? null) : null;
      const estimatedAmount = calculateDeductionAmountFromBaseSalary({
        baseSalary,
        deductionDays: 1,
        month: input.month,
        year: input.year,
      });
      if (estimatedAmount == null) continue; // no salary basis => no salary-based deduction

      // Did this SAME day also carry real work? If so it is very likely a part
      // day, and it is flagged for the owner to confirm full/AM/PM rather than
      // charged at 1.00 on the connector's own authority.
      const dayKey = `${entry.crmId}:${day}`;
      const workAmpm = [...(workAmpmByDay.get(dayKey) ?? [])].sort();
      const vacationAmpm = [...(vacationAmpmByDay.get(dayKey) ?? [])].sort();
      const isMixedDay = workAmpm.length > 0;

      drafts.push({
        category: input.category,
        sourceSystem: "crm_vacation_signal",
        sourceRecordId: `crm-vacation:${hrId}:${day}:${input.category}`,
        employeeHrId: hrId,
        employeeName: entry.name,
        monthKey,
        month: input.month,
        year: input.year,
        unit: "days",
        // Still 1 — that is what was DETECTED. The reviewer lowers it to 0.5 via
        // the applied-days control if they judge it a half day. Pre-setting 0.5
        // here would be the connector deciding, which is what the flag exists to
        // avoid.
        rawValue: 1,
        estimatedAmount,
        // requires_review is the flag. A mixed day must never look settled.
        calculationStatus: isMixedDay ? "requires_review" : "calculated",
        severity: isMixedDay ? "Review" : "Medium",
        reason: isMixedDay
          ? `REVIEW: vacation AND work recorded on the same day (leave ${vacationAmpm.join("/") || "?"}, work ${workAmpm.join("/")}) — confirm full day, AM or PM before deducting`
          : `Vacation taken on CRM with no HR request, and not covered by balance (${reason})`,
        evidence: {
          source: "ireports360 visit_type -4 (Annual Vacation)",
          // The AM/PM split is recorded whether or not it is a mixed day, so a
          // reviewer can see WHY it was flagged without leaving the screen.
          mixedDay: isMixedDay,
          vacationAmpm,
          workAmpm,
          unpaidReason: reason,
          entitlementDays: snapshot.entitlementDays,
          balanceBeforeDays: Math.round(balanceBefore * 100) / 100,
          periodStart: snapshot.periodStart,
          periodEnd: snapshot.periodEnd,
          hireDate: entry.hireDate,
        },
        dates: [day],
      });
    }
  }

  return drafts;
}

export async function collectUnpaidVacationCandidates(input: {
  month: number;
  year: number;
}): Promise<DeductionsCandidateDraft[]> {
  const unpaidReasons = ["first_six_months", "missing_hire_date"];
  const [fromRequests, fromCrm] = await Promise.all([
    collectVacationCandidatesByReason({
      ...input,
      category: "unpaid_vacation",
      unpaidReasons,
      reasonLabel: "Approved vacation is unpaid (not yet entitled within first 6 months, or hire date missing)",
    }),
    collectCrmSubmittedUnpaidVacationDays({ ...input, category: "unpaid_vacation", unpaidReasons }),
  ]);
  return [...fromRequests, ...fromCrm];
}

export async function collectInsufficientBalanceVacationCandidates(input: {
  month: number;
  year: number;
}): Promise<DeductionsCandidateDraft[]> {
  const unpaidReasons = ["insufficient_balance"];
  const [fromRequests, fromCrm] = await Promise.all([
    collectVacationCandidatesByReason({
      ...input,
      category: "insufficient_balance_vacation",
      unpaidReasons,
      reasonLabel: "Approved vacation includes unpaid days because balance was insufficient",
    }),
    collectCrmSubmittedUnpaidVacationDays({ ...input, category: "insufficient_balance_vacation", unpaidReasons }),
  ]);
  return [...fromRequests, ...fromCrm];
}
