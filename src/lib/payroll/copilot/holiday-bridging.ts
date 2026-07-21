import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { logError } from "@/lib/observability/log";
import { roundCurrency } from "@/lib/payroll/money";
import { getPayrollSalarySourcesByHrId } from "@/lib/payroll/salary-source";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getConfirmedNationalHolidays } from "@/lib/vacation/national-holidays";
import type { VacationType } from "@/lib/vacation/types";

import { lookupSource } from "./assemble.ts";
import { compactHrKey } from "./feeders.ts";
import { dailyRate } from "./proration.ts";
import type { CopilotPeriod } from "./types.ts";

/**
 * National-holiday-bridging leave — owner-dictated rule (2026-07-07): a leave
 * day taken directly before or directly after a national holiday is a
 * MANDATORY salary deduction, whether or not the employee has leave balance.
 * This does not touch the employee's vacation-balance ledger (v2_vacation_
 * requests / the core vacation module's own balance accounting) — it is a
 * payroll-sheet-only deduction layered on top, exactly like the mandatory
 * no-activity (CRM) deduction. Bridging applies to the SINGLE calendar day
 * immediately adjacent to the holiday, not the whole leave request — a
 * multi-day request's other days are unaffected and still follow the normal
 * balance-first rule via the existing Unpaid Vacation tab.
 *
 * Mandatory unless excluded: every bridging candidate counts by default; HR
 * can EXCLUDE a specific one (e.g. the holiday date was wrong, or the leave
 * shouldn't count) via a `holiday_bridge_excluded` row in
 * payroll_copilot_vacation_settlements (see migration
 * 20260708020000_vacation_settlements_allow_holiday_bridge_excluded.sql).
 * There is nothing to "confirm" or edit — the amount is fully deterministic
 * (one day's rate) — so unlike CRM there is only one decision: exclude, or
 * leave it be.
 */

export type BridgingWindow = {
  holidayName: string;
  holidayStartDate: string;
  holidayEndDate: string;
  bridgingDate: string;
  adjacentTo: "before" | "after";
};

export type HolidayBridgingCandidate = {
  /** Composite key: the underlying vacation request + which bridging window it matched (a request could match two windows in rare cases). */
  id: string;
  requestId: string;
  employeeHrId: string;
  employeeName: string | null;
  vacationType: VacationType;
  bridgingDate: string;
  adjacentTo: "before" | "after";
  holidayName: string;
  holidayStartDate: string;
  holidayEndDate: string;
  salaryDeductionAmount: number;
  excluded: boolean;
  existingExclusion: { decidedAt: string; decidedBy: string } | null;
};

function addDaysIso(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function monthBounds(period: CopilotPeriod): { start: string; end: string } {
  const mm = String(period.month).padStart(2, "0");
  const start = `${period.year}-${mm}-01`;
  const lastDay = new Date(Date.UTC(period.year, period.month, 0)).getUTCDate();
  const end = `${period.year}-${mm}-${String(lastDay).padStart(2, "0")}`;
  return { start, end };
}

function adjacentPeriod(period: CopilotPeriod, delta: -1 | 1): CopilotPeriod {
  const m = period.month + delta;
  if (m < 1) return { month: 12, year: period.year - 1 };
  if (m > 12) return { month: 1, year: period.year + 1 };
  return { month: m, year: period.year };
}

/**
 * Confirmed national holidays touching this payroll period, deduped, drawn
 * from the period's own month plus the adjacent months — a holiday landing
 * right at a month boundary can produce a bridging day that falls in THIS
 * month even though the holiday itself is officially in the next/prior one.
 */
async function confirmedHolidaysNear(period: CopilotPeriod) {
  const [prior, current, next] = await Promise.all([
    getConfirmedNationalHolidays(adjacentPeriod(period, -1)),
    getConfirmedNationalHolidays(period),
    getConfirmedNationalHolidays(adjacentPeriod(period, 1)),
  ]);
  const seen = new Set<string>();
  const holidays = [];
  for (const holiday of [...prior.holidays, ...current.holidays, ...next.holidays]) {
    if (seen.has(holiday.id)) continue;
    seen.add(holiday.id);
    holidays.push(holiday);
  }
  return holidays;
}

/**
 * Pure core: given a set of confirmed holidays and a payroll period, compute
 * the bridging windows whose bridging DATE falls inside that period (exported
 * for tests — no I/O, so unit-testable without a live holiday-calendar call).
 */
export function computeBridgingWindows(
  holidays: Array<{ id: string; name: string; startDate: string; endDate: string | null }>,
  period: CopilotPeriod,
): BridgingWindow[] {
  const { start, end } = monthBounds(period);
  const windows: BridgingWindow[] = [];
  for (const holiday of holidays) {
    const holidayEnd = holiday.endDate ?? holiday.startDate;
    const dayBefore = addDaysIso(holiday.startDate, -1);
    const dayAfter = addDaysIso(holidayEnd, 1);
    if (dayBefore >= start && dayBefore <= end) {
      windows.push({
        holidayName: holiday.name,
        holidayStartDate: holiday.startDate,
        holidayEndDate: holidayEnd,
        bridgingDate: dayBefore,
        adjacentTo: "before",
      });
    }
    if (dayAfter >= start && dayAfter <= end) {
      windows.push({
        holidayName: holiday.name,
        holidayStartDate: holiday.startDate,
        holidayEndDate: holidayEnd,
        bridgingDate: dayAfter,
        adjacentTo: "after",
      });
    }
  }
  return windows;
}

/** The bridging windows (one per holiday edge) whose bridging DATE falls inside this payroll period, drawn from live confirmed-holiday data. */
export async function resolveBridgingWindows(period: CopilotPeriod): Promise<BridgingWindow[]> {
  const holidays = await confirmedHolidaysNear(period);
  return computeBridgingWindows(holidays, period);
}

async function loadExistingExclusions(
  period: CopilotPeriod,
): Promise<Map<string, { decidedAt: string; decidedBy: string }>> {
  const map = new Map<string, { decidedAt: string; decidedBy: string }>();
  const { start, end } = monthBounds(period);
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("payroll_copilot_vacation_settlements")
      .select("employee_hr_id_compact,start_date,decided_at,decided_by")
      .eq("settlement_method", "holiday_bridge_excluded")
      .is("superseded_at", null)
      .gte("start_date", start)
      .lte("start_date", end);
    if (error) {
      logError("Failed to load existing holiday-bridging exclusions for period", {
        labels: { event: "holiday_bridging_exclusions_load_failed", month: period.month, year: period.year },
        error,
      });
      return map;
    }
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const key = `${String(row.employee_hr_id_compact ?? "")}:${String(row.start_date ?? "")}`;
      map.set(key, { decidedAt: String(row.decided_at ?? ""), decidedBy: String(row.decided_by ?? "") });
    }
  } catch (error) {
    logError("Existing holiday-bridging exclusions load threw an exception", {
      labels: { event: "holiday_bridging_exclusions_load_threw", month: period.month, year: period.year },
      error,
    });
  }
  return map;
}

/** Approved vacation requests overlapping any bridging date in this period, matched to their holiday window(s), with amount + exclusion status. */
export async function listHolidayBridgingCandidates(period: CopilotPeriod): Promise<HolidayBridgingCandidate[]> {
  const windows = await resolveBridgingWindows(period);
  if (windows.length === 0) return [];

  const bridgingDates = windows.map((w) => w.bridgingDate);
  const minDate = bridgingDates.reduce((a, b) => (a < b ? a : b));
  const maxDate = bridgingDates.reduce((a, b) => (a > b ? a : b));

  const supabase = getSupabaseAdmin();
  const [{ data: requests, error }, directory, sources, exclusions] = await Promise.all([
    supabase
      .from("v2_vacation_requests")
      .select("id,employee_hr_id,employee_name,vacation_type,start_date,end_date")
      // Only fully-approved leave counts toward a real, mandatory deduction —
      // unlike the Unpaid Vacation review tab, this never includes
      // pending_manager requests (not yet a finalized commitment).
      .eq("status", "approved")
      .lte("start_date", maxDate)
      .gte("end_date", minDate),
    getEmployeeDirectory(),
    getPayrollSalarySourcesByHrId(period),
    loadExistingExclusions(period),
  ]);

  if (error) {
    logError("Failed to load vacation requests for holiday-bridging candidates", {
      labels: { event: "holiday_bridging_vacation_requests_load_failed", month: period.month, year: period.year },
      error,
    });
    return [];
  }

  const directoryByCompact = new Map(directory.employees.map((employee) => [compactHrKey(employee.hrId), employee]));
  const candidates: HolidayBridgingCandidate[] = [];

  for (const row of (requests ?? []) as Array<Record<string, unknown>>) {
    const hrId = String(row.employee_hr_id ?? "").trim();
    const compact = compactHrKey(hrId);
    if (!compact) continue;
    const requestStart = String(row.start_date ?? "");
    const requestEnd = String(row.end_date ?? "");
    const employee = directoryByCompact.get(compact);
    const source = lookupSource(sources, hrId);
    const baseSalary = roundCurrency(source?.baseSalary ?? 0);
    const salaryDeductionAmount = roundCurrency(dailyRate(baseSalary, period));
    const vacationType = (String(row.vacation_type ?? "annual") as VacationType) || "annual";
    const requestId = String(row.id ?? "");

    for (const window of windows) {
      if (window.bridgingDate < requestStart || window.bridgingDate > requestEnd) continue;
      const exclusionKey = `${compact}:${window.bridgingDate}`;
      const existingExclusion = exclusions.get(exclusionKey) ?? null;
      candidates.push({
        id: `${requestId}:${window.bridgingDate}`,
        requestId,
        employeeHrId: hrId,
        employeeName: employee?.fullName ?? (row.employee_name ? String(row.employee_name) : null),
        vacationType,
        bridgingDate: window.bridgingDate,
        adjacentTo: window.adjacentTo,
        holidayName: window.holidayName,
        holidayStartDate: window.holidayStartDate,
        holidayEndDate: window.holidayEndDate,
        salaryDeductionAmount,
        excluded: existingExclusion !== null,
        existingExclusion,
      });
    }
  }

  return candidates;
}

export type HolidayBridgingSalaryTotals = Map<string, number>;

/**
 * Per-employee mandatory holiday-bridging salary-deduction totals for the
 * period, keyed by compact HR id — wired into assemble.ts's unpaidVacations
 * alongside the existing settled-unpaid-vacation total. Every candidate
 * counts UNLESS explicitly excluded. Defensive: never throws, empty map on
 * failure (a computation error must never block payroll assembly).
 */
export async function buildHolidayBridgingSalaryTotals(period: CopilotPeriod): Promise<HolidayBridgingSalaryTotals> {
  const totals: HolidayBridgingSalaryTotals = new Map();
  try {
    const candidates = await listHolidayBridgingCandidates(period);
    for (const candidate of candidates) {
      if (candidate.excluded) continue;
      const key = compactHrKey(candidate.employeeHrId);
      if (!key) continue;
      totals.set(key, roundCurrency((totals.get(key) ?? 0) + candidate.salaryDeductionAmount));
    }
  } catch (error) {
    logError("Failed to build holiday-bridging salary-deduction totals", {
      labels: { event: "holiday_bridging_salary_totals_build_failed", month: period.month, year: period.year },
      error,
    });
  }
  return totals;
}

/**
 * Records or reverts HR's exclusion of one bridging candidate (one employee +
 * one bridging date). Supersedes any existing live exclusion for that pair
 * first — a re-decision must never leave two live rows. `action: "include"`
 * simply supersedes (back to the default mandatory-include state); no new row.
 */
export async function recordHolidayBridgingDecision(input: {
  runId: string;
  requestId: string;
  employeeHrId: string;
  bridgingDate: string;
  action: "exclude" | "include";
  decidedBy: string;
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const compact = compactHrKey(input.employeeHrId);
  if (!compact) throw new Error("Invalid employee HR id for holiday-bridging decision.");

  await supabase
    .from("payroll_copilot_vacation_settlements")
    .update({ superseded_at: new Date().toISOString() })
    .eq("employee_hr_id_compact", compact)
    .eq("start_date", input.bridgingDate)
    .eq("settlement_method", "holiday_bridge_excluded")
    .is("superseded_at", null);

  if (input.action === "include") return;

  const { error } = await supabase.from("payroll_copilot_vacation_settlements").insert({
    run_id: input.runId || null,
    employee_hr_id: input.employeeHrId,
    employee_hr_id_compact: compact,
    vacation_request_ids: [input.requestId],
    start_date: input.bridgingDate,
    unpaid_days: 1,
    settlement_method: "holiday_bridge_excluded",
    decided_by: input.decidedBy,
  });
  if (error) throw error;
}
