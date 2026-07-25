import type { AccessContext } from "@/lib/auth/permissions";
import {
  getEmployeeDirectoryRows,
  type EmployeeDirectoryRow,
} from "@/lib/employees/employee-directory";
import { loadEmployeeDayPunchMinutes } from "@/lib/attendance/punch-minutes";
import { resolveStandardSalaryAllowances } from "@/lib/payroll/allowance-policy";
import { lookupSource } from "@/lib/payroll/copilot/assemble.ts";
import {
  listCrmDeductionCandidates,
  listFingerprintDeductionCandidates,
} from "@/lib/payroll/copilot/deductions-review.ts";
import { buildFeederStates, compactHrKey } from "@/lib/payroll/copilot/feeders.ts";
import {
  computeJoinerPay,
  computeResignationSettlement,
  isInPeriod,
} from "@/lib/payroll/copilot/proration.ts";
import { listUnpaidVacationCandidates } from "@/lib/payroll/copilot/vacation-settlement.ts";
import type { DeductionInboxRow } from "@/lib/deductions-governance/service";
import {
  calculateDeductionAmountFromBaseSalary,
  resolveDayBasedDeductionAmount,
} from "@/lib/deductions-governance/calculations";
import { isPayrollIneligibleEmployee } from "@/lib/payroll/eligibility.ts";
import { roundCurrency } from "@/lib/payroll/money";
import { normalizePayrollPaymentMode, resolveFixedSalaryAmounts } from "@/lib/payroll/policy";
import {
  salarySourceLookupKeys,
  type PayrollSalarySource,
} from "@/lib/payroll/salary-source-model.ts";
import { buildFieldWorkforceCompliancePreviewFromVisitsReport } from "@/lib/field-workforce-compliance/ireports360-source.ts";
import { isFieldWorkforceComplianceEligibleTitle } from "@/lib/field-workforce-compliance/eligibility.ts";
import { isFieldWorkforceWeeklyOff } from "@/lib/field-workforce-compliance/weekend-policy.ts";
import { scanVisitsForRangeIncludingDeparted } from "@/lib/crm/reads.ts";
import { getConfirmedNationalHolidays } from "@/lib/vacation/national-holidays.ts";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { calculatePaymentForRequest } from "@/lib/vacation/service";

import type { DraftRow, PayrollPeriod, RowLifecycle, StepKey, StepRow } from "./types.ts";

/**
 * Builds each wizard step's recommendation table from the existing payroll
 * feeders (joiner/leaver proration, fingerprint/CRM/expense/vacation candidates),
 * then overlays any HR edits already saved to the run's draft rows. The wizard
 * confirms/edits these; the confirmed values become the single source of truth.
 */

export type PopulationMember = {
  employee: EmployeeDirectoryRow;
  compact: string;
  lifecycle: RowLifecycle;
  /**
   * Leaver only — the exit falls INSIDE this period, so this drives real
   * settlement proration in effectiveSalary. Deliberately stays null for anyone
   * leaving in a future month: see noticeLastWorkingDate.
   */
  lastWorkingDate: string | null;
  /**
   * Serving notice into a FUTURE month (owner case 2026-07-25, B-157: resigned
   * effective 31 Aug while being paid a normal full July salary).
   *
   * Kept strictly separate from `lastWorkingDate` because that field feeds
   * `computeResignationSettlement` — putting a future date there would prorate
   * this month's pay as though the employee had already left and UNDERPAY them.
   * This one is display-only: it exists so HR can see "resigned, leaving 31 Aug"
   * instead of the employee looking completely ordinary.
   */
  noticeLastWorkingDate: string | null;
  /** Leaver only — unpaid-leave days inside the settlement span (resignation Rule 1). */
  unpaidDaysInSpan: number;
};

function numberOrNull(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function moneyOrNull(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Mirrors getPayrollSalarySourcesByHrId's per-employee derivation exactly, but built
 * from an EmployeeDirectoryRow already in hand rather than re-fetching the directory.
 * Deliberately NOT calling the shared getPayrollSalarySourcesByHrId here: that function
 * always fetches the ACTIVE-ONLY directory internally, so a leaver would silently get no
 * salary source (base=0) even after the population fix below lets them through. This
 * keeps the fix fully self-contained to the Automated Payroll module — no edit to the
 * shared salary-source.ts file, per the "don't touch existing payroll files" rule.
 */
function buildSalarySource(employee: EmployeeDirectoryRow, period: PayrollPeriod): PayrollSalarySource {
  const standardAllowances = resolveStandardSalaryAllowances({
    departmentName: employee.departmentName,
    employeeHrId: employee.hrId,
    jobTitle: employee.jobTitle,
    lineName: employee.lineName,
    month: period.month,
    positionTitle: employee.positionTitle,
    year: period.year,
  });
  const extraCostOfLiving = standardAllowances.extraCostOfLiving;
  const fuelAllowance = standardAllowances.fuelAllowance;
  const socialInsurance = numberOrNull(employee.socialInsurance);
  const employmentIncomeTax = numberOrNull(employee.taxes);
  const fixedSalary = resolveFixedSalaryAmounts({
    baseSalary: numberOrNull(employee.baseSalary),
    basicSalary: numberOrNull(employee.basicSalary),
    employmentIncomeTax,
    extraCostOfLiving,
    fuelAllowance,
    grossSalary: numberOrNull(employee.grossSalary),
    netSalary: numberOrNull(employee.netSalary),
    socialInsurance,
  });
  const baseSalary = moneyOrNull(fixedSalary.baseSalary);
  return {
    baseSalary,
    employmentIncomeTax,
    extraCostOfLiving,
    fuelAllowance,
    grossSalary: baseSalary === null ? null : moneyOrNull(fixedSalary.grossSalary),
    netSalary: baseSalary === null ? null : moneyOrNull(fixedSalary.netSalary),
    paymentMode: normalizePayrollPaymentMode(employee.salaryPaymentMode),
    socialInsurance,
  };
}

/**
 * The employees a run covers: every active + payroll-eligible employee, plus this
 * month's joiners and leavers (a leaver may already be terminal but must still be
 * settled). Shared by recommend + assemble so both see the exact same population.
 *
 * Uses getEmployeeDirectoryRows({includeInactive:true}) deliberately, not the plain
 * getEmployeeDirectory() — the latter is active-only and silently drops leavers before
 * this function's own isLeaver bypass ever runs (a leaver's employment_status is
 * typically already flipped to resigned by the time payroll processes their exit
 * month), which is exactly why the Resignations step showed no rows.
 */
/**
 * True when dateText's year-month is strictly AFTER the given period — i.e. still in
 * the future relative to the run being processed. Used to tell "already departed
 * before this period" apart from "departing later, still owed this period's pay."
 * Exported for tests.
 */
export function isAfterPeriod(dateText: string | null, period: PayrollPeriod): boolean {
  if (!dateText) return false;
  const match = /^(\d{4})-(\d{2})/.exec(dateText.trim());
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return false;
  return year > period.year || (year === period.year && month > period.month);
}

export async function resolvePayrollPopulation(period: PayrollPeriod): Promise<PopulationMember[]> {
  const { members } = await resolvePayrollPopulationAndSources(period);
  return members;
}

export async function resolvePayrollPopulationAndSources(period: PayrollPeriod): Promise<{
  members: PopulationMember[];
  sources: Map<string, PayrollSalarySource>;
}> {
  const [employees, feeders] = await Promise.all([
    getEmployeeDirectoryRows({ includeInactive: true }),
    buildFeederStates(period),
  ]);
  const members: PopulationMember[] = [];
  const sources = new Map<string, PayrollSalarySource>();

  for (const employee of employees) {
    const compact = compactHrKey(employee.hrId);
    if (!compact) continue;
    const feeder = feeders.get(compact);
    const leaverLastWorkingDate = feeder?.leaverLastWorkingDate ?? null;
    const isLeaver = Boolean(leaverLastWorkingDate);
    const isJoiner = !isLeaver && isInPeriod(employee.hireDate, period);
    // A resignation already SUBMITTED with a last working date in a LATER period is
    // still serving notice — not yet departed as of THIS period. employment_status
    // flips to a terminal value (e.g. "resigned") the moment the resignation is
    // approved, often well before the employee's actual last day, and
    // isPayrollIneligibleEmployee() alone can't distinguish "already left" from
    // "leaving later" — only `leaverLastWorkingDate` (scoped to THIS period by
    // buildFeederStates) can. Confirmed live 2026-07-25 against a real case: B-157
    // had employment_status=resigned for the July run but last_working_date=2026-08-31
    // — a full month of pay silently dropped from the entire population, every step,
    // with no error or empty-state to notice it by.
    const stillActiveThroughFutureExit = isAfterPeriod(employee.lastWorkingDate, period);

    // Include: active/eligible employees, a leaver this month (even if terminal now),
    // or someone serving notice into a future month (still owed this month's pay).
    if (isPayrollIneligibleEmployee(employee) && !isLeaver && !stillActiveThroughFutureExit) continue;

    members.push({
      employee,
      compact,
      lifecycle: isLeaver ? "leaver" : isJoiner ? "joiner" : "regular",
      lastWorkingDate: leaverLastWorkingDate,
      // Display-only. Never feeds proration — see the field's doc comment.
      noticeLastWorkingDate: stillActiveThroughFutureExit ? employee.lastWorkingDate : null,
      unpaidDaysInSpan: feeder?.unpaidDaysBeforeLastWorkingDate ?? 0,
    });

    const source = buildSalarySource(employee, period);
    for (const key of salarySourceLookupKeys(employee.hrId)) sources.set(key, source);
  }

  return { members, sources };
}

function baseRow(member: PopulationMember): StepRow {
  return {
    hrId: member.employee.hrId,
    fullName: member.employee.fullName,
    jobTitle: member.employee.jobTitle,
    line: member.employee.lineName,
    context: {},
    values: {},
    recommended: {},
    reason: null,
    onHold: false,
    lifecycle: member.lifecycle,
  };
}

function draftMap(draftRows: DraftRow[]): Map<string, DraftRow> {
  return new Map(draftRows.map((row) => [row.employeeHrIdCompact, row]));
}

/** value from the draft when the HR already saved one, else the system recommendation. */
function pick(draftValue: number | null | undefined, recommended: number): number {
  return draftValue == null ? recommended : draftValue;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function periodBounds(period: PayrollPeriod): { start: string; end: string } {
  const lastDay = new Date(Date.UTC(period.year, period.month, 0)).getUTCDate();
  return {
    start: `${period.year}-${pad2(period.month)}-01`,
    end: `${period.year}-${pad2(period.month)}-${pad2(lastDay)}`,
  };
}

/**
 * Owner-corrected expense source (2026-07-20): the real payroll expenses live in the
 * legacy `outstation_expenses` table keyed by payout_month/payout_year — the new
 * `outstation_expense_requests` table the Copilot feeder reads is near-empty. Sums
 * HR-approved rows per employee. Defensive: empty map on any failure.
 */
async function loadPayoutExpenses(period: PayrollPeriod): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  try {
    // All expenses whose payout period is this payroll month. The wizard IS the HR
    // confirmation point (recommend → confirm/edit), so pending-approval rows are surfaced
    // too; HR zeroes out anything that shouldn't pay. Already-imported rows are skipped so a
    // re-run never double-pays.
    const { data, error } = await getSupabaseAdmin()
      .from("outstation_expenses")
      .select("hr_id,total,imported_payroll_batch_id")
      .eq("payout_month", period.month)
      .eq("payout_year", period.year)
      .is("imported_payroll_batch_id", null);
    if (error) {
      logError("Automated payroll: payout expenses load failed", {
        labels: { event: "automated_payroll_payout_expenses_load_failed", month: period.month, year: period.year },
        error,
      });
      return totals;
    }
    for (const row of (data ?? []) as Array<{ hr_id: string | null; total: number | null }>) {
      const compact = compactHrKey(row.hr_id ?? "");
      if (!compact) continue;
      totals.set(compact, roundCurrency((totals.get(compact) ?? 0) + Number(row.total ?? 0)));
    }
  } catch (error) {
    logError("Automated payroll: payout expenses load threw an exception", {
      labels: { event: "automated_payroll_payout_expenses_load_threw", month: period.month, year: period.year },
      error,
    });
  }
  return totals;
}

/** Compact-keyed set of dates on which each employee has a fingerprint punch (office day). */
async function loadPunchedDatesByCompact(
  period: PayrollPeriod,
  hrIds: string[],
): Promise<Map<string, Set<string>>> {
  const byCompact = new Map<string, Set<string>>();
  if (hrIds.length === 0) return byCompact;
  try {
    const { start, end } = periodBounds(period);
    const punchMap = await loadEmployeeDayPunchMinutes({
      dateFromIso: start,
      dateToIso: end,
      employeeHrIds: hrIds,
    });
    for (const [hrId, byDate] of punchMap) {
      const compact = compactHrKey(hrId);
      if (!compact) continue;
      const dates = byCompact.get(compact) ?? new Set<string>();
      for (const dateIso of byDate.keys()) dates.add(dateIso);
      byCompact.set(compact, dates);
    }
  } catch (error) {
    logError("Automated payroll: punch-date load threw an exception", {
      labels: { event: "automated_payroll_punch_date_load_threw", month: period.month, year: period.year },
      error,
    });
  }
  return byCompact;
}

function eachDateInclusive(startIso: string, endIso: string): string[] {
  const dates: string[] = [];
  const start = startIso.slice(0, 10);
  const end = endIso.slice(0, 10);
  let ms = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(ms) || !Number.isFinite(endMs)) return dates;
  for (; ms <= endMs; ms += 86400000) dates.push(new Date(ms).toISOString().slice(0, 10));
  return dates;
}

/**
 * CRM-recorded leave (AV / vacation-signal) dates per employee, reusing the FWC live engine
 * so the visit-type→AV mapping + excuse nuances stay identical to the Field Workforce
 * Compliance report (owner rule 2026-07-20: treat CRM leave as real vacation). Defensive.
 */
async function loadCrmLeaveDatesByCompact(period: PayrollPeriod): Promise<Map<string, Set<string>>> {
  const byCompact = new Map<string, Set<string>>();
  try {
    const preview = await buildFieldWorkforceCompliancePreviewFromVisitsReport({
      month: period.month,
      year: period.year,
    });
    for (const candidate of preview.reviewCandidates) {
      if (candidate.type !== "vacation_signal" || !candidate.dateIso) continue;
      const compact = compactHrKey(candidate.hrId);
      if (!compact) continue;
      const dates = byCompact.get(compact) ?? new Set<string>();
      dates.add(candidate.dateIso);
      byCompact.set(compact, dates);
    }
  } catch (error) {
    logError("Automated payroll: CRM leave load failed (non-fatal)", {
      labels: { event: "automated_payroll_crm_leave_load_failed", month: period.month, year: period.year },
      error,
    });
  }
  return byCompact;
}

/** Approved/pending v2 vacation dates per employee — used to de-dup CRM leave already on Phoenix. */
async function loadV2VacationDatesByCompact(period: PayrollPeriod): Promise<Map<string, Set<string>>> {
  const byCompact = new Map<string, Set<string>>();
  try {
    const { start, end } = periodBounds(period);
    const { data, error } = await getSupabaseAdmin()
      .from("v2_vacation_requests")
      .select("employee_hr_id,start_date,end_date,status")
      .in("status", ["approved", "pending_manager"])
      .lte("start_date", end)
      .gte("end_date", start);
    if (error) {
      logError("Automated payroll: v2 vacation dates load failed", {
        labels: { event: "automated_payroll_v2_vacation_dates_load_failed", month: period.month, year: period.year },
        error,
      });
      return byCompact;
    }
    for (const row of (data ?? []) as Array<{
      employee_hr_id: string | null;
      start_date: string | null;
      end_date: string | null;
    }>) {
      const compact = compactHrKey(row.employee_hr_id ?? "");
      if (!compact || !row.start_date || !row.end_date) continue;
      const dates = byCompact.get(compact) ?? new Set<string>();
      for (const date of eachDateInclusive(row.start_date, row.end_date)) {
        if (date >= start && date <= end) dates.add(date);
      }
      byCompact.set(compact, dates);
    }
  } catch (error) {
    logError("Automated payroll: v2 vacation dates load threw an exception", {
      labels: { event: "automated_payroll_v2_vacation_dates_load_threw", month: period.month, year: period.year },
      error,
    });
  }
  return byCompact;
}

/**
 * Faithful copy of ireports360-source.ts's VISIT_TYPE_TO_STATUS map (owner-confirmed
 * 2026-07-20; that map is private to that file, so it's duplicated here — keep in sync if
 * it ever changes). visitType 0 = a regular visit, handled separately below.
 */
const LEAVER_VISIT_TYPE_TO_STATUS = new Map<number, "AV" | "CP">([
  [-1, "CP"], // Conference
  [-2, "CP"], // Group Meeting
  [-4, "AV"], // Annual Vacation
  [-8, "CP"], // Campaign (Prospection)
  [-9, "CP"], // Training
  [-11, "CP"], // Meeting
  [-12, "CP"], // Traveling
  [-15, "AV"], // Health Day
]);

type LeaverVisitRow = {
  visit_date: string | null;
  visit_type: number | null;
  agent_hr_id: string | null;
  double_hr_id: string | null;
  agent_crm_id: number | string | null;
  double_crm_id: number | string | null;
};

/**
 * Per-day CRM classification for ONE leaver's employed span this period, computed directly
 * from the CRM visits mirror rather than through any of the three existing paths — ALL THREE
 * silently exclude a resigned employee before computing anything:
 *  - listCrmDeductionCandidates reads the pre-synced `deduction_candidates` cache, whose own
 *    sync job produced nothing for a leaver's exit month (verified 2026-07-20 against real
 *    production leavers: rows exist for prior months, none for the resignation month).
 *  - buildFieldWorkforceCompliancePreviewFromVisitsReport filters its employee population to
 *    classifyEmployeeNode(employee).eligible_for_headcount, which is explicitly false for a
 *    resigned employee — see that file's own comment: "Employees who have left the company
 *    ... are not rendered in the monthly report."
 *  - scanVisitsForRange itself (the sanctioned CRM reader) additionally excludes the visits of
 *    ANY resigned employee at the row level (the "live departed-agent exclusion", so a departed
 *    rep's history doesn't pollute company-wide/live dashboards) — which silently ate a leaver's
 *    OWN visits from THIS function too, since the leaver being looked up is by definition
 *    resigned. Verified 2026-07-20 against a real production leaver (B-111): 8 real field-visit
 *    days in her final week were all reported as "no activity" because her own crm_id was in the
 *    exclusion list. Fixed by reading through scanVisitsForRangeIncludingDeparted instead, which
 *    is the same full scan minus that one exclusion — see its doc comment.
 *
 * Reuses the exact same exported eligibility/weekly-off/holiday rules those paths use, and
 * the same visit-type-to-status mapping (see LEAVER_VISIT_TYPE_TO_STATUS above), applied only
 * to this one leaver's own visits via the sanctioned CRM reader rather than a raw query — no
 * module outside src/lib/crm may query the mirror table directly.
 */
async function computeLeaverCrmDates(input: {
  hrId: string;
  crmId: string | null;
  jobTitle: string | null;
  hireDate: string | null;
  lastWorkingDate: string;
  period: PayrollPeriod;
}): Promise<{ noActivityDates: string[]; avDates: string[] }> {
  const empty = { noActivityDates: [], avDates: [] };
  if (!isFieldWorkforceComplianceEligibleTitle(input.jobTitle)) return empty;

  try {
    const { start, end } = periodBounds(input.period);
    const hireIso = input.hireDate ? input.hireDate.slice(0, 10) : null;
    const loopStart = hireIso && hireIso > start ? hireIso : start;
    const loopEnd = input.lastWorkingDate < end ? input.lastWorkingDate : end;
    if (loopStart > loopEnd) return empty;

    const hrKey = compactHrKey(input.hrId);
    const crmIdText = input.crmId != null ? String(input.crmId).trim() : "";

    const [visits, holidayResult] = await Promise.all([
      scanVisitsForRangeIncludingDeparted<LeaverVisitRow>({
        dateFrom: loopStart,
        dateTo: loopEnd,
        columns: "visit_date,visit_type,agent_hr_id,double_hr_id,agent_crm_id,double_crm_id",
      }),
      getConfirmedNationalHolidays({ month: input.period.month, year: input.period.year }),
    ]);

    const byDay = new Map<string, LeaverVisitRow[]>();
    for (const visit of visits) {
      const agentKey = compactHrKey(visit.agent_hr_id ?? "");
      const doubleKey = compactHrKey(visit.double_hr_id ?? "");
      const isMine =
        (agentKey && agentKey === hrKey) ||
        (doubleKey && doubleKey === hrKey) ||
        (!agentKey && crmIdText && String(visit.agent_crm_id ?? "").trim() === crmIdText) ||
        (!doubleKey && crmIdText && String(visit.double_crm_id ?? "").trim() === crmIdText);
      if (!isMine) continue;
      const dateIso = (visit.visit_date ?? "").slice(0, 10);
      if (!dateIso) continue;
      const list = byDay.get(dateIso) ?? [];
      list.push(visit);
      byDay.set(dateIso, list);
    }

    const holidayDates = new Set<string>();
    for (const holiday of holidayResult.holidays) {
      for (const date of eachDateInclusive(holiday.startDate, holiday.endDate ?? holiday.startDate)) {
        holidayDates.add(date);
      }
    }

    const noActivityDates: string[] = [];
    const avDates: string[] = [];
    for (const dateIso of eachDateInclusive(loopStart, loopEnd)) {
      if (isFieldWorkforceWeeklyOff({ dateIso, title: input.jobTitle })) continue;
      if (holidayDates.has(dateIso)) continue;

      const dayVisits = byDay.get(dateIso) ?? [];
      if (dayVisits.length === 0) {
        noActivityDates.push(dateIso);
        continue;
      }

      // Mirrors dayCellValue exactly: regular visits win, then CP, then AV (owner decision
      // 2026-07-20) — a day with ANY recorded visit is never "no activity".
      let regularCount = 0;
      let hasAv = false;
      for (const visit of dayVisits) {
        const visitType = Number(visit.visit_type ?? 0);
        if (visitType === 0) {
          regularCount += 1;
        } else if (LEAVER_VISIT_TYPE_TO_STATUS.get(visitType) === "AV") {
          hasAv = true;
        }
      }
      if (regularCount === 0 && hasAv) avDates.push(dateIso);
    }

    return { noActivityDates, avDates };
  } catch (error) {
    logError("Automated payroll: leaver CRM classification failed", {
      labels: { event: "automated_payroll_leaver_crm_classification_failed", hrId: input.hrId },
      error,
    });
    return empty;
  }
}

// ---- Part 1 -----------------------------------------------------------------

function recommendNewHires(
  members: PopulationMember[],
  sources: Map<string, PayrollSalarySource>,
  period: PayrollPeriod,
  drafts: Map<string, DraftRow>,
): StepRow[] {
  const rows: StepRow[] = [];
  for (const member of members) {
    if (member.lifecycle !== "joiner") continue;
    const source = lookupSource(sources, member.employee.hrId);
    const joiner = computeJoinerPay({
      baseSalary: roundCurrency(source?.baseSalary ?? 0),
      extraCostOfLiving: roundCurrency(source?.extraCostOfLiving ?? 0),
      fuelAllowance: roundCurrency(source?.fuelAllowance ?? 0),
      hireDate: member.employee.hireDate ?? "",
      period,
    });
    if (!joiner) continue;
    const draft = drafts.get(member.compact);
    const row = baseRow(member);
    row.context = {
      "Hire Date": member.employee.hireDate ?? "",
      "Days Worked": joiner.daysWorked,
      "Net (month)": pick(draft?.baseForMonth, joiner.baseForMonth) + pick(draft?.ecolPaid, joiner.ecolPaid) + pick(draft?.fuelPaid, joiner.fuelPaid),
    };
    row.recommended = { baseForMonth: joiner.baseForMonth, ecolPaid: joiner.ecolPaid, fuelPaid: joiner.fuelPaid };
    row.values = {
      baseForMonth: pick(draft?.baseForMonth, joiner.baseForMonth),
      ecolPaid: pick(draft?.ecolPaid, joiner.ecolPaid),
      fuelPaid: pick(draft?.fuelPaid, joiner.fuelPaid),
    };
    rows.push(row);
  }
  return rows;
}

async function recommendResignations(
  members: PopulationMember[],
  sources: Map<string, PayrollSalarySource>,
  period: PayrollPeriod,
  drafts: Map<string, DraftRow>,
): Promise<StepRow[]> {
  const leavers = members.filter((member) => member.lifecycle === "leaver" && member.lastWorkingDate);
  if (leavers.length === 0) return [];

  // Owner request 2026-07-25: CRM no-activity and unpaid-vacation deductions
  // moved OUT of this step into the dedicated p1_crm / p1_unpaid_vacation tabs
  // (see recommendP1Crm / recommendP1UnpaidVacation) — they were showing up in
  // both places, which read as duplication even though it wasn't a double
  // deduction. This step now settles ONLY Base/ECoL/Fuel; the leaver's own
  // Second-Part-netting rule (owner 2026-07-20) still applies, just driven from
  // the tab that now owns the computation.
  const rows: StepRow[] = [];
  for (const member of leavers) {
    if (!member.lastWorkingDate) continue;
    const source = lookupSource(sources, member.employee.hrId);
    const settlement = computeResignationSettlement({
      baseSalary: roundCurrency(source?.baseSalary ?? 0),
      extraCostOfLiving: roundCurrency(source?.extraCostOfLiving ?? 0),
      fuelAllowance: roundCurrency(source?.fuelAllowance ?? 0),
      lastWorkingDate: member.lastWorkingDate,
      period,
      unpaidDaysInSpan: member.unpaidDaysInSpan,
      otherAdditions: 0,
      otherDeductions: 0,
    });
    if (!settlement) continue;
    const draft = drafts.get(member.compact);
    const baseSalary = roundCurrency(source?.baseSalary ?? 0);

    const row = baseRow(member);
    row.context = {
      "Hire Date": member.employee.hireDate ?? "",
      "Last Working Date": member.lastWorkingDate,
      // Divisor for the client-side Days Worked -> Base (month) auto-calc. Must
      // be the month's ACTUAL calendar days to match dailyRate() in proration.ts;
      // the default 30 used for deduction day-rates would overpay in a 31-day month.
      "Days In Month": daysInPeriodMonth(period),
      // "Base Salary" is kept in context (NOT in this step's displayed contextColumns —
      // see step-definitions.ts) purely because the client-side Days→Value auto-calc
      // reads row.context["Base Salary"]. "Net Salary" is what HR actually sees
      // displayed (owner request 2026-07-25).
      "Base Salary": baseSalary,
      "Net Salary": roundCurrency(source?.netSalary ?? 0),
    };
    // Days Worked has no column of its own in the DB — Base (month) is what
    // persists. So when HR has already overridden the settlement, derive the day
    // count back OUT of the saved amount, otherwise the two would disagree on
    // reload (days showing the system's calendar count, base showing HR's edit).
    const perDay = daysInPeriodMonth(period) > 0 ? baseSalary / daysInPeriodMonth(period) : 0;
    const displayedDaysWorked =
      draft?.baseForMonth != null && perDay > 0
        ? Math.round((draft.baseForMonth / perDay) * 100) / 100
        : settlement.daysWorked;

    row.recommended = {
      daysWorked: settlement.daysWorked,
      baseForMonth: settlement.baseForMonth,
      ecolPaid: settlement.ecolPaid,
      fuelPaid: settlement.fuelPaid,
    };
    row.values = {
      daysWorked: displayedDaysWorked,
      baseForMonth: pick(draft?.baseForMonth, settlement.baseForMonth),
      ecolPaid: pick(draft?.ecolPaid, settlement.ecolPaid),
      fuelPaid: pick(draft?.fuelPaid, settlement.fuelPaid),
    };
    rows.push(row);
  }

  // ---- employees serving notice into a FUTURE month (owner request 2026-07-25)
  // They belong here visually — HR needs to see that they have resigned — but
  // they are still working this whole month and earn a normal full salary, so
  // they get NO settlement. `values` and `recommended` are deliberately EMPTY:
  // stepEditToPatch only writes numeric fields present in `values`, so confirming
  // this step can never stamp a prorated baseForMonth (or a zero) onto them. The
  // real settlement happens in the month they actually leave.
  for (const member of members) {
    if (!member.noticeLastWorkingDate) continue;
    const source = lookupSource(sources, member.employee.hrId);
    const row = baseRow(member);
    row.readOnly = true;
    row.readOnlyNote = `Still employed — settles ${monthNameOf(member.noticeLastWorkingDate)}`;
    row.context = {
      "Hire Date": member.employee.hireDate ?? "",
      "Last Working Date": member.noticeLastWorkingDate,
      "Net Salary": roundCurrency(source?.netSalary ?? 0),
      "Base Salary": roundCurrency(source?.baseSalary ?? 0),
      "Days In Month": daysInPeriodMonth(period),
    };
    row.recommended = {};
    row.values = {};
    rows.push(row);
  }

  return rows;
}

/** Calendar days in the run's month — the proration divisor (see dailyRate in proration.ts). */
function daysInPeriodMonth(period: PayrollPeriod): number {
  return new Date(Date.UTC(period.year, period.month, 0)).getUTCDate();
}

/** "August 2026" for a yyyy-mm-dd date — used to say when a notice-period employee actually settles. */
function monthNameOf(dateText: string): string {
  const match = /^(\d{4})-(\d{2})/.exec(dateText.trim());
  if (!match) return "later";
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return "later";
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** Aggregate day-based deduction candidates per employee → { days, value }. Exported for tests. */
export function aggregateDeductionRows(
  candidates: DeductionInboxRow[],
  sources: Map<string, PayrollSalarySource>,
): Map<string, { days: number; value: number }> {
  const totals = new Map<string, { days: number; value: number }>();
  for (const candidate of candidates) {
    // A rejected candidate must not fall back to the original system-flagged value —
    // resolveDayBasedDeductionAmount only looks at appliedAmount/appliedDeductionValue
    // (both null on rejection) and would otherwise re-apply the un-rejected estimate.
    // Mirrors the same guard Payroll Copilot's CRM aggregation already uses.
    if (candidate.decision?.decisionStatus === "Do Not Take Action") continue;
    const compact = compactHrKey(candidate.employeeHrIdCompact || candidate.employeeCode);
    if (!compact) continue;
    const source = lookupSource(sources, candidate.employeeCode);
    const value =
      resolveDayBasedDeductionAmount({
        decision: candidate.decision,
        deductionValue: candidate.deductionValue,
        baseSalary: source?.baseSalary ?? undefined,
      }) ?? candidate.estimatedAmount ?? 0;
    const existing = totals.get(compact) ?? { days: 0, value: 0 };
    existing.days += Number(candidate.deductionValue ?? 0);
    existing.value += value;
    totals.set(compact, existing);
  }
  return totals;
}

async function recommendFingerprint(
  access: AccessContext,
  members: PopulationMember[],
  sources: Map<string, PayrollSalarySource>,
  period: PayrollPeriod,
  drafts: Map<string, DraftRow>,
): Promise<StepRow[]> {
  const { rows: candidates } = await listFingerprintDeductionCandidates(access, period);
  const totals = aggregateDeductionRows(candidates, sources);
  const byCompact = new Map(members.map((member) => [member.compact, member]));
  const rows: StepRow[] = [];
  for (const [compact, total] of totals) {
    const member = byCompact.get(compact);
    if (!member) continue;
    const draft = drafts.get(compact);
    const row = baseRow(member);
    const days = roundCurrency(total.days);
    const value = roundCurrency(total.value);
    row.context = { "Hire Date": member.employee.hireDate ?? "" };
    row.recommended = { fingerprintDays: days, fingerprintValue: value };
    row.values = {
      fingerprintDays: pick(draft?.fingerprintDays, days),
      fingerprintValue: pick(draft?.fingerprintValue, value),
    };
    rows.push(row);
  }
  return rows;
}

// ---- Part 2 -----------------------------------------------------------------

async function recommendExpenses(
  members: PopulationMember[],
  period: PayrollPeriod,
  drafts: Map<string, DraftRow>,
): Promise<StepRow[]> {
  const totals = await loadPayoutExpenses(period);
  const byCompact = new Map(members.map((member) => [member.compact, member]));
  const rows: StepRow[] = [];
  for (const [compact, amount] of totals) {
    const member = byCompact.get(compact);
    if (!member) continue;
    const draft = drafts.get(compact);
    const value = roundCurrency(amount);
    const row = baseRow(member);
    row.context = { "Hire Date": member.employee.hireDate ?? "" };
    row.recommended = { expenses: value };
    row.values = { expenses: pick(draft?.expenses, value) };
    rows.push(row);
  }
  return rows;
}

type VacationDeductionTotal = {
  v2Days: number;
  v2Amount: number;
  crmDays: number;
  crmUnpaidDays: number;
  crmAmount: number;
};

/**
 * One employee's CRM-only-leave balance breakdown for a period — the detail
 * `settleCrmLeaveBalanceForPeriod` needs to durably record, beyond the
 * aggregated `VacationDeductionTotal` used for the payroll-sheet number.
 */
export type CrmLeaveBalanceSettlement = {
  employeeHrId: string;
  compact: string;
  /** Earliest CRM-only AV date this period — the settlement row's anchor date. */
  startDate: string;
  /** Count of CRM-only AV dates this period (no Phoenix v2 request covering them). */
  totalDays: number;
  /** Days actually covered by the employee's live balance (<= totalDays). */
  balanceDaysConsumed: number;
  /** Days beyond balance, deducted from salary instead. */
  unpaidDays: number;
  salaryDeductionAmount: number;
};

/**
 * Vacation deduction totals for every member (Phoenix v2 unpaid days + CRM-recorded leave,
 * balance-first). Shared by the Part-2 Vacation step (everyone except leavers, who are
 * settled at resignation time instead) and the Resignation step (leavers only).
 *
 * Also returns crmLeaveSettlements — the same CRM-only-leave figures broken out per employee,
 * consumed by settleCrmLeaveBalanceForPeriod to durably record the balance draw-down when the
 * Part-2 Vacation step is confirmed (owner rule 2026-07-21: a vacation day, whether sourced
 * from CRM or a formal Phoenix request, must subtract from balance first and salary only for
 * what balance doesn't cover — durably, not just as a one-off payroll-sheet number that
 * disappears next period).
 */
export async function computeVacationDeductionTotals(
  members: PopulationMember[],
  sources: Map<string, PayrollSalarySource>,
  period: PayrollPeriod,
): Promise<{ totals: Map<string, VacationDeductionTotal>; crmLeaveSettlements: CrmLeaveBalanceSettlement[] }> {
  const byCompact = new Map(members.map((member) => [member.compact, member]));
  const totals = new Map<string, VacationDeductionTotal>();
  const crmLeaveSettlements: CrmLeaveBalanceSettlement[] = [];
  const ensure = (compact: string) => {
    const existing =
      totals.get(compact) ?? { v2Days: 0, v2Amount: 0, crmDays: 0, crmUnpaidDays: 0, crmAmount: 0 };
    totals.set(compact, existing);
    return existing;
  };

  // 1) Phoenix-submitted unpaid vacations (existing v2 balance-aware settlement).
  const v2Candidates = await listUnpaidVacationCandidates(period);
  for (const candidate of v2Candidates) {
    const compact = compactHrKey(candidate.employeeHrId);
    if (!compact) continue;
    const entry = ensure(compact);
    entry.v2Days += Number(candidate.unpaidDays ?? 0);
    entry.v2Amount += roundCurrency(candidate.salaryDeductionAmount);
  }

  // 2) CRM-recorded leave (owner rule 2026-07-20): the balance covers what it can; the
  //    remainder is a salary deduction. CRM dates already covered by a Phoenix vacation are
  //    excluded so the same leave day is never counted twice.
  const [crmLeaveDates, v2Dates] = await Promise.all([
    loadCrmLeaveDatesByCompact(period),
    loadV2VacationDatesByCompact(period),
  ]);
  for (const [compact, avDates] of crmLeaveDates) {
    const member = byCompact.get(compact);
    if (!member) continue;
    const covered = v2Dates.get(compact);
    const crmOnly = [...avDates].filter((date) => !covered?.has(date)).sort();
    if (crmOnly.length === 0) continue;

    let balanceDays = 0;
    try {
      const snapshot = await calculatePaymentForRequest({
        durationDays: crmOnly.length,
        employeeHrId: member.employee.hrId,
        hireDate: member.employee.hireDate,
        startDate: crmOnly[0],
        vacationType: "annual",
      });
      balanceDays = Math.max(0, Number(snapshot.balanceBeforeDays ?? 0));
    } catch (error) {
      logError("Automated payroll: CRM leave balance check failed", {
        labels: { event: "automated_payroll_crm_leave_balance_check_failed", hrId: member.employee.hrId },
        error,
      });
    }
    const unpaidDays = Math.max(0, crmOnly.length - balanceDays);
    const base = roundCurrency(lookupSource(sources, member.employee.hrId)?.baseSalary ?? 0);
    const amount =
      unpaidDays > 0
        ? calculateDeductionAmountFromBaseSalary({ baseSalary: base, deductionDays: unpaidDays }) ?? 0
        : 0;
    const entry = ensure(compact);
    entry.crmDays += crmOnly.length;
    entry.crmUnpaidDays += unpaidDays;
    entry.crmAmount += amount;
    crmLeaveSettlements.push({
      balanceDaysConsumed: roundCurrency(Math.min(balanceDays, crmOnly.length)),
      compact,
      employeeHrId: member.employee.hrId,
      salaryDeductionAmount: amount,
      startDate: crmOnly[0],
      totalDays: crmOnly.length,
      unpaidDays,
    });
  }

  return { crmLeaveSettlements, totals };
}

/**
 * Durably records the balance-first-else-salary settlement for each employee's CRM-only
 * leave days this period, reusing the SAME payroll_copilot_vacation_settlements ledger a
 * formal Phoenix unpaid-request settlement writes to (balanceSettledDaysInPeriod in
 * vacation/service.ts already sums it, regardless of source) — so a CRM-only AV day counts
 * against the employee's real balance in every FUTURE balance check, not just this month's
 * payroll sheet. vacation_request_ids stays [] (no formal request exists); that's also how a
 * CRM-sourced row is told apart from a Copilot-decided one when reviewing the table directly.
 * Idempotent: re-confirming the same step supersedes the prior live row for that
 * employee+startDate before inserting, so a re-run never double-counts.
 */
export async function settleCrmLeaveBalanceForPeriod(input: {
  crmLeaveSettlements: CrmLeaveBalanceSettlement[];
  actorHrId: string;
  runId?: string | null;
}): Promise<{ settled: number }> {
  const supabase = getSupabaseAdmin();
  let settled = 0;
  for (const settlement of input.crmLeaveSettlements) {
    if (settlement.totalDays <= 0) continue;

    await supabase
      .from("payroll_copilot_vacation_settlements")
      .update({ superseded_at: new Date().toISOString() })
      .eq("employee_hr_id_compact", settlement.compact)
      .eq("start_date", settlement.startDate)
      .is("superseded_at", null);

    const method: "balance" | "partial_balance" | "salary" =
      settlement.unpaidDays <= 0 ? "balance" : settlement.balanceDaysConsumed > 0 ? "partial_balance" : "salary";

    const { error } = await supabase.from("payroll_copilot_vacation_settlements").insert({
      balance_days_consumed: method === "salary" ? null : settlement.balanceDaysConsumed,
      decided_by: input.actorHrId,
      employee_hr_id: settlement.employeeHrId,
      employee_hr_id_compact: settlement.compact,
      run_id: input.runId ?? null,
      salary_deduction_amount: method === "balance" ? null : settlement.salaryDeductionAmount,
      settlement_method: method,
      start_date: settlement.startDate,
      unpaid_days: settlement.totalDays,
      vacation_request_ids: [],
    });
    if (error) {
      logError("Automated payroll: CRM leave balance settlement insert failed", {
        labels: {
          event: "automated_payroll_crm_leave_balance_settlement_insert_failed",
          hrId: settlement.employeeHrId,
          runId: input.runId ?? null,
        },
        error,
      });
      continue;
    }
    settled += 1;
  }
  return { settled };
}

async function recommendVacation(
  members: PopulationMember[],
  sources: Map<string, PayrollSalarySource>,
  period: PayrollPeriod,
  drafts: Map<string, DraftRow>,
): Promise<StepRow[]> {
  const { totals } = await computeVacationDeductionTotals(members, sources, period);
  const byCompact = new Map(members.map((member) => [member.compact, member]));
  const rows: StepRow[] = [];
  for (const [compact, total] of totals) {
    const member = byCompact.get(compact);
    // Leavers AND one-part employees are settled in Part 1 — never here, to avoid
    // double-deducting the same days. See isSettledInPart1.
    if (!member || isSettledInPart1(member, lookupSource(sources, member.employee.hrId))) continue;
    const draft = drafts.get(compact);
    const amount = roundCurrency(total.v2Amount + total.crmAmount);
    const row = baseRow(member);
    row.context = {
      "Hire Date": member.employee.hireDate ?? "",
      "Unpaid Days (Phoenix)": roundCurrency(total.v2Days),
      "CRM Leave Days": roundCurrency(total.crmDays),
      "CRM Unpaid (no balance)": roundCurrency(total.crmUnpaidDays),
    };
    row.recommended = { unpaidVacations: amount };
    row.values = { unpaidVacations: pick(draft?.unpaidVacations, amount) };
    rows.push(row);
  }
  return rows;
}

type CrmDeductionTotal = { days: number; value: number; officeExcluded: number };

/**
 * CRM no-activity deduction totals for every member (punch-excluded, owner rule
 * 2026-07-20). Shared by the Part-2 CRM step (everyone except leavers) and the
 * Resignation step (leavers only).
 */
async function computeCrmDeductionTotals(
  access: AccessContext,
  members: PopulationMember[],
  sources: Map<string, PayrollSalarySource>,
  period: PayrollPeriod,
): Promise<Map<string, CrmDeductionTotal>> {
  const { rows: candidates } = await listCrmDeductionCandidates(access, period);
  // Owner rule (2026-07-20): a no-CRM-activity day with a fingerprint punch is an office
  // day, not an absence — drop punched dates before deducting (field reps show CRM activity
  // only on field-visit days; office days have a punch and no CRM visit).
  const punchedByCompact = await loadPunchedDatesByCompact(
    period,
    members.map((member) => member.employee.hrId),
  );

  const totals = new Map<string, CrmDeductionTotal>();
  for (const candidate of candidates) {
    const compact = compactHrKey(candidate.employeeHrIdCompact || candidate.employeeCode);
    if (!compact) continue;
    const punched = punchedByCompact.get(compact);
    const candidateDates = Array.isArray(candidate.dates) ? candidate.dates : [];
    // Prefer explicit per-day dates so punched (office) days can be excluded; fall back to
    // the raw day count only when a candidate carries no dates.
    const keptDates = punched ? candidateDates.filter((date) => !punched.has(date)) : candidateDates;
    const days = candidateDates.length > 0 ? keptDates.length : Number(candidate.deductionValue ?? 0);
    const excluded = candidateDates.length - keptDates.length;
    if (days <= 0) continue;
    const source = lookupSource(sources, candidate.employeeCode);
    const value =
      calculateDeductionAmountFromBaseSalary({
        baseSalary: source?.baseSalary ?? undefined,
        deductionDays: days,
      }) ?? 0;
    const existing = totals.get(compact) ?? { days: 0, value: 0, officeExcluded: 0 };
    existing.days += days;
    existing.value += value;
    existing.officeExcluded += excluded;
    totals.set(compact, existing);
  }

  return totals;
}

async function recommendCrm(
  access: AccessContext,
  members: PopulationMember[],
  sources: Map<string, PayrollSalarySource>,
  period: PayrollPeriod,
  drafts: Map<string, DraftRow>,
): Promise<StepRow[]> {
  const totals = await computeCrmDeductionTotals(access, members, sources, period);
  const byCompact = new Map(members.map((member) => [member.compact, member]));
  const rows: StepRow[] = [];
  for (const [compact, total] of totals) {
    const member = byCompact.get(compact);
    // Leavers AND one-part employees are settled in Part 1 — never here, to avoid
    // double-deducting the same days. See isSettledInPart1.
    if (!member || isSettledInPart1(member, lookupSource(sources, member.employee.hrId))) continue;
    const draft = drafts.get(compact);
    const value = roundCurrency(total.value);
    const row = baseRow(member);
    row.context = {
      "Hire Date": member.employee.hireDate ?? "",
      "No-Activity Days": roundCurrency(total.days),
      "Office (punched)": total.officeExcluded,
    };
    row.recommended = { crm: value };
    row.values = { crm: pick(draft?.crm, value) };
    rows.push(row);
  }
  return rows;
}

function recommendAdditions(members: PopulationMember[], drafts: Map<string, DraftRow>): StepRow[] {
  return members.map((member) => {
    const draft = drafts.get(member.compact);
    const row = baseRow(member);
    row.context = { "Hire Date": member.employee.hireDate ?? "" };
    row.recommended = { incentive: 0, bonus: 0, overtime: 0 };
    row.values = {
      incentive: pick(draft?.incentive, 0),
      bonus: pick(draft?.bonus, 0),
      overtime: pick(draft?.overtime, 0),
    };
    return row;
  });
}

function recommendManualDeductions(members: PopulationMember[], drafts: Map<string, DraftRow>): StepRow[] {
  return members.map((member) => {
    const draft = drafts.get(member.compact);
    const row = baseRow(member);
    row.context = { "Hire Date": member.employee.hireDate ?? "" };
    row.recommended = { manualOtherDeductions: 0 };
    row.values = { manualOtherDeductions: pick(draft?.manualOtherDeductions, 0) };
    row.reason = draft?.manualReason ?? null;
    return row;
  });
}

/**
 * THE PART 1 / PART 2 SPLIT RULE (owner-decided 2026-07-25). Whether an employee's
 * CRM / unpaid-vacation deduction is settled in Part 1 rather than Part 2:
 *
 *  - leaver    → settled in Part 1 (they won't be present for Part 2 at all; their
 *                CRM + vacation are auto-computed on the Resignations step).
 *  - one_part  → settled in Part 1. They have no meaningful Second Part to net a
 *                Part-2 deduction against, so deducting there clamps their Second
 *                Part to 0 and strands the remainder in `overpaidResidual` (money
 *                the company never recovers). Reducing the frozen First Part
 *                directly — via the Part 1 manual tabs — actually lands.
 *  - two_parts → NOT settled in Part 1; handled automatically in Part 2.
 *
 * This single predicate is deliberately used in BOTH directions so the two
 * populations stay disjoint and no employee can be deducted twice for the same
 * thing: the Part 1 manual tabs show only employees where this is true, and
 * recommendVacation / recommendCrm (Part 2) skip exactly those same employees.
 * Guarded by tests/automated-payroll-part1-scope.test.ts — if you change this,
 * change both call sites or you reintroduce a double-deduction.
 */
export function isSettledInPart1(
  member: Pick<PopulationMember, "lifecycle">,
  source: Pick<PayrollSalarySource, "paymentMode"> | undefined,
): boolean {
  return member.lifecycle === "leaver" || source?.paymentMode === "one_part";
}

function part1ManualDeductionBaseRow(
  member: PopulationMember,
  source: PayrollSalarySource | undefined,
): StepRow {
  const row = baseRow(member);
  row.context = {
    "Hire Date": member.employee.hireDate ?? "",
    // "Base Salary" is kept in context (NOT in this step's displayed contextColumns —
    // see step-definitions.ts) purely because the client-side Days→Value auto-calc
    // reads row.context["Base Salary"] to compute Base/30 × days (recommendation-step.tsx
    // setDaysValue) — that formula is untouched. "Net Salary" is the number HR actually
    // sees displayed (owner request 2026-07-25: show Net, not Base, in the UI).
    "Base Salary": roundCurrency(source?.baseSalary ?? 0),
    "Net Salary": roundCurrency(source?.netSalary ?? 0),
    // Blank for continuing (non-leaver) one-part employees — only leavers have one.
    "Resignation Date": member.lastWorkingDate ?? "",
  };
  return row;
}

async function recommendP1Crm(
  members: PopulationMember[],
  sources: Map<string, PayrollSalarySource>,
  period: PayrollPeriod,
  drafts: Map<string, DraftRow>,
): Promise<StepRow[]> {
  const rows: StepRow[] = [];
  for (const member of members) {
    const source = lookupSource(sources, member.employee.hrId);
    if (!isSettledInPart1(member, source)) continue;
    // This month's resignations moved to their own dedicated Resignations CRM
    // tab (owner request 2026-07-26 — see recommendResignationCrm), because a
    // leaver's CRM rules differ: the Working/Non-Working split caps at his DAYS
    // WORKED (not the whole month) and the deduction divides by the month's
    // ACTUAL calendar days (not /30). This tab is now one-part CONTINUING
    // employees only, keeping the old whole-month /30 behavior for them.
    if (member.lifecycle === "leaver") continue;
    const draft = drafts.get(member.compact);
    const row = part1ManualDeductionBaseRow(member, source);
    // Working/Non-Working Days cap (owner request 2026-07-25) — the real
    // calendar day count, deliberately NOT the fixed /30 the money formula uses.
    // See StepFieldSpec.complementTotalContextKey's doc for why these must stay separate.
    const daysInMonth = daysInPeriodMonth(period);
    row.context["Days In Month"] = daysInMonth;

    const nonWorkingDays = pick(draft?.p1odCrmDays, 0);
    row.recommended = { p1odCrmWorkingDays: daysInMonth, p1odCrmDays: 0, p1odCrmValue: 0 };
    row.values = {
      p1odCrmWorkingDays: Math.max(0, daysInMonth - nonWorkingDays),
      p1odCrmDays: nonWorkingDays,
      p1odCrmValue: pick(draft?.p1odCrmValue, 0),
    };
    row.reasons = { p1odCrmReason: draft?.p1odCrmReason ?? "" };
    rows.push(row);
  }
  return rows;
}

/**
 * Leaver CRM deduction rate — UNIFIED with the resignation settlement (owner
 * rule 2026-07-26): Base ÷ the month's ACTUAL calendar days × days, NOT the /30
 * used for continuing employees. One no-activity day therefore costs exactly one
 * day of his prorated pay. Exported for direct unit testing (pure/deterministic).
 */
export function resignationCrmDeduction(baseSalary: number, days: number, period: PayrollPeriod): number {
  const monthDays = daysInPeriodMonth(period);
  if (baseSalary <= 0 || days <= 0 || monthDays <= 0) return 0;
  return roundCurrency((baseSalary / monthDays) * days);
}

/**
 * Dedicated Resignations CRM tab (owner request 2026-07-26): this month's
 * leavers only. Fixes the bug where the shared CRM tab's Working/Non-Working
 * split ran against the whole month (31), so a 9-day employee could show 22
 * "non-working" days — the 22 days AFTER he had already left — and be deducted
 * for them.
 *
 * Here Working + Non-Working cap at DAYS WORKED (his employment span this month,
 * from the settlement), so no post-resignation day can ever be deducted. The
 * deduction uses `resignationCrmDeduction` (Base ÷ actual month days), matching
 * the settlement's own daily rate. Fields are keyed directly to the
 * resignationCrmDays/crm draft columns, so the generic persist-loop in
 * run-service.ts writes them with no remap, and leaverDeductionFor's
 * Second-Part-netting rule (owner 2026-07-20) keeps working unchanged.
 */
async function recommendResignationCrm(
  members: PopulationMember[],
  sources: Map<string, PayrollSalarySource>,
  period: PayrollPeriod,
  drafts: Map<string, DraftRow>,
): Promise<StepRow[]> {
  const leavers = members.filter((member) => member.lifecycle === "leaver" && member.lastWorkingDate);
  if (leavers.length === 0) return [];
  const daysInMonth = daysInPeriodMonth(period);

  const rows: StepRow[] = [];
  for (const member of leavers) {
    if (!member.lastWorkingDate) continue;
    const source = lookupSource(sources, member.employee.hrId);
    const baseSalary = roundCurrency(source?.baseSalary ?? 0);
    const draft = drafts.get(member.compact);

    // Days worked = the paid-days count from the settlement — the cap for his
    // Working + Non-Working CRM days. He can never be marked non-working for a
    // day he was no longer employed.
    const settlement = computeResignationSettlement({
      baseSalary,
      extraCostOfLiving: roundCurrency(source?.extraCostOfLiving ?? 0),
      fuelAllowance: roundCurrency(source?.fuelAllowance ?? 0),
      lastWorkingDate: member.lastWorkingDate,
      period,
      unpaidDaysInSpan: member.unpaidDaysInSpan,
      otherAdditions: 0,
      otherDeductions: 0,
    });
    const daysWorked = Math.max(0, settlement?.daysWorked ?? 0);

    // Recommended no-activity days from his real CRM history within the days he
    // actually worked (computeLeaverCrmDates only scans up to his last working
    // date), clamped to days worked as a final guard.
    const crmDates = await computeLeaverCrmDates({
      hrId: member.employee.hrId,
      crmId: member.employee.crmId,
      jobTitle: member.employee.jobTitle,
      hireDate: member.employee.hireDate,
      lastWorkingDate: member.lastWorkingDate,
      period,
    });
    const recommendedNonWorking = Math.min(daysWorked, crmDates.noActivityDates.length);
    const recommendedValue = resignationCrmDeduction(baseSalary, recommendedNonWorking, period);

    // Trust a saved day count only if it is within the valid span. A stored
    // value greater than days worked can only be the old whole-month bug (e.g.
    // 22 saved for a 9-day leaver) — discard it and re-recommend, self-healing
    // the stale data without a DB write. The money always re-derives from the
    // (clamped) day count so the displayed value can never disagree with it.
    const storedDays = draft?.resignationCrmDays;
    const nonWorking =
      storedDays != null && storedDays >= 0 && storedDays <= daysWorked ? storedDays : recommendedNonWorking;
    const value = resignationCrmDeduction(baseSalary, nonWorking, period);

    const row = part1ManualDeductionBaseRow(member, source);
    row.context["Days In Month"] = daysInMonth; // deduction divisor (Base ÷ actual month days)
    row.context["Days Worked"] = daysWorked; // complement cap for Working/Non-Working

    row.recommended = {
      resigCrmWorkingDays: Math.max(0, daysWorked - recommendedNonWorking),
      resignationCrmDays: recommendedNonWorking,
      crm: recommendedValue,
    };
    row.values = {
      resigCrmWorkingDays: Math.max(0, daysWorked - nonWorking),
      resignationCrmDays: nonWorking,
      crm: value,
    };
    row.reasons = { resigCrmReason: draft?.p1odCrmReason ?? "" };
    rows.push(row);
  }
  return rows;
}

async function recommendP1UnpaidVacation(
  members: PopulationMember[],
  sources: Map<string, PayrollSalarySource>,
  period: PayrollPeriod,
  drafts: Map<string, DraftRow>,
): Promise<StepRow[]> {
  // Bulk fetches — same two calls recommendResignations used to make before the
  // computation moved here (owner request 2026-07-25). One fetch for the whole
  // population, not per-employee.
  const [{ totals: vacationTotals }, v2Dates] = await Promise.all([
    computeVacationDeductionTotals(members, sources, period),
    loadV2VacationDatesByCompact(period),
  ]);

  const rows: StepRow[] = [];
  for (const member of members) {
    const source = lookupSource(sources, member.employee.hrId);
    if (!isSettledInPart1(member, source)) continue;
    const draft = drafts.get(member.compact);
    const row = part1ManualDeductionBaseRow(member, source);

    if (member.lifecycle === "leaver" && member.lastWorkingDate) {
      // Real settlement — a balance-aware Phoenix-vacation amount plus a
      // separate CRM-leave amount, NOT a flat day rate (unchanged reasoning from
      // when this lived in the Resignations step). p1odVacationValue is
      // presented here for the generic grid but reads from/writes to the SAME
      // unpaidVacations draft column Resignations always used — see
      // run-service.ts's leaver remap — so leaverDeductionFor's Second-Part-
      // netting rule (owner 2026-07-20) keeps working unchanged.
      const baseSalary = roundCurrency(source?.baseSalary ?? 0);
      const crmDates = await computeLeaverCrmDates({
        hrId: member.employee.hrId,
        crmId: member.employee.crmId,
        jobTitle: member.employee.jobTitle,
        hireDate: member.employee.hireDate,
        lastWorkingDate: member.lastWorkingDate,
        period,
      });
      // CRM-recorded leave (AV), balance-first, de-duped against any Phoenix v2
      // vacation already covering the same date (owner rule 2026-07-20, same as
      // the Part-2 Vacation step).
      const covered = v2Dates.get(member.compact);
      const crmOnlyAvDates = crmDates.avDates.filter((date) => !covered?.has(date)).sort();
      let crmLeaveBalanceDays = 0;
      if (crmOnlyAvDates.length > 0) {
        try {
          const snapshot = await calculatePaymentForRequest({
            durationDays: crmOnlyAvDates.length,
            employeeHrId: member.employee.hrId,
            hireDate: member.employee.hireDate,
            startDate: crmOnlyAvDates[0],
            vacationType: "annual",
          });
          crmLeaveBalanceDays = Math.max(0, Number(snapshot.balanceBeforeDays ?? 0));
        } catch (error) {
          logError("Automated payroll: leaver CRM leave balance check failed", {
            labels: { event: "automated_payroll_leaver_crm_leave_balance_check_failed", hrId: member.employee.hrId },
            error,
          });
        }
      }
      const crmLeaveUnpaidDays = Math.max(0, crmOnlyAvDates.length - crmLeaveBalanceDays);
      const crmLeaveAmount =
        crmLeaveUnpaidDays > 0
          ? calculateDeductionAmountFromBaseSalary({ baseSalary, deductionDays: crmLeaveUnpaidDays }) ?? 0
          : 0;

      const vacationTotal = vacationTotals.get(member.compact);
      const v2Days = vacationTotal?.v2Days ?? 0;
      const v2Amount = vacationTotal?.v2Amount ?? 0;
      const vacationValue = roundCurrency(v2Amount + crmLeaveAmount);

      // Read-only reference days shown via the step's own contextColumns entry
      // (not the editable p1odVacationDays field — see the field's doc comment
      // for why a leaver's day count must never drive the money via auto-calc).
      row.context["Unpaid Vacation Days"] = roundCurrency(v2Days + crmLeaveUnpaidDays);
      row.recommended = { p1odVacationDays: 0, p1odVacationValue: vacationValue };
      row.values = {
        p1odVacationDays: pick(draft?.p1odVacationDays, 0),
        p1odVacationValue: pick(draft?.unpaidVacations, vacationValue),
      };
      row.reasons = { p1odVacationReason: draft?.p1odVacationReason ?? "" };
      rows.push(row);
      continue;
    }

    row.recommended = { p1odVacationDays: 0, p1odVacationValue: 0 };
    row.values = {
      p1odVacationDays: pick(draft?.p1odVacationDays, 0),
      p1odVacationValue: pick(draft?.p1odVacationValue, 0),
    };
    row.reasons = { p1odVacationReason: draft?.p1odVacationReason ?? "" };
    rows.push(row);
  }
  return rows;
}

function recommendP1NoRecord(
  members: PopulationMember[],
  sources: Map<string, PayrollSalarySource>,
  drafts: Map<string, DraftRow>,
): StepRow[] {
  const rows: StepRow[] = [];
  for (const member of members) {
    const source = lookupSource(sources, member.employee.hrId);
    if (!isSettledInPart1(member, source)) continue;
    const draft = drafts.get(member.compact);
    const row = part1ManualDeductionBaseRow(member, source);
    row.recommended = { p1odNoRecordDays: 0, p1odNoRecordValue: 0 };
    row.values = {
      p1odNoRecordDays: pick(draft?.p1odNoRecordDays, 0),
      p1odNoRecordValue: pick(draft?.p1odNoRecordValue, 0),
    };
    row.reasons = { p1odNoRecordReason: draft?.p1odNoRecordReason ?? "" };
    rows.push(row);
  }
  return rows;
}

function recommendP1OtherDeductions(
  members: PopulationMember[],
  sources: Map<string, PayrollSalarySource>,
  drafts: Map<string, DraftRow>,
): StepRow[] {
  const rows: StepRow[] = [];
  for (const member of members) {
    const source = lookupSource(sources, member.employee.hrId);
    if (!isSettledInPart1(member, source)) continue;
    const draft = drafts.get(member.compact);
    const row = part1ManualDeductionBaseRow(member, source);
    row.recommended = { p1odLoanDays: 0, p1odLoanValue: 0, p1odOtherDays: 0, p1odOtherValue: 0 };
    row.values = {
      p1odLoanDays: pick(draft?.p1odLoanDays, 0),
      p1odLoanValue: pick(draft?.p1odLoanValue, 0),
      p1odOtherDays: pick(draft?.p1odOtherDays, 0),
      p1odOtherValue: pick(draft?.p1odOtherValue, 0),
    };
    row.reasons = {
      p1odLoanReason: draft?.p1odLoanReason ?? "",
      p1odOtherReason: draft?.p1odOtherReason ?? "",
    };
    rows.push(row);
  }
  return rows;
}

/**
 * Special Situations (owner rule 2026-07-25): unlike the 4 manual deduction tabs
 * above, this shows EVERY employee regardless of payment mode — it exists
 * precisely for cases that fall outside the normal one-part/two-part rules. One
 * shared "Apply To" choice per employee routes BOTH their deduction and their
 * addition to the same installment (see split.ts's FreezeFirstPartInput doc and
 * assemble.ts's specialRoutedToFirst). Defaults to "second" — the safer default,
 * since it never touches the frozen First Part unless HR explicitly opts in.
 */
function recommendSpecialSituations(
  members: PopulationMember[],
  sources: Map<string, PayrollSalarySource>,
  drafts: Map<string, DraftRow>,
): StepRow[] {
  const rows: StepRow[] = [];
  for (const member of members) {
    const source = lookupSource(sources, member.employee.hrId);
    const draft = drafts.get(member.compact);
    const row = part1ManualDeductionBaseRow(member, source);
    row.recommended = {
      specialDeductionDays: 0,
      specialDeductionValue: 0,
      specialAdditionDays: 0,
      specialAdditionValue: 0,
    };
    row.values = {
      specialDeductionDays: pick(draft?.specialDeductionDays, 0),
      specialDeductionValue: pick(draft?.specialDeductionValue, 0),
      specialAdditionDays: pick(draft?.specialAdditionDays, 0),
      specialAdditionValue: pick(draft?.specialAdditionValue, 0),
    };
    row.selects = { specialSituationPart: draft?.specialSituationPart ?? "second" };
    rows.push(row);
  }
  return rows;
}

function recommendHolds(members: PopulationMember[], drafts: Map<string, DraftRow>): StepRow[] {
  return members.map((member) => {
    const draft = drafts.get(member.compact);
    const row = baseRow(member);
    row.context = { "Hire Date": member.employee.hireDate ?? "" };
    row.onHold = draft?.onHold ?? false;
    row.reason = draft?.holdReason ?? null;
    return row;
  });
}

/** Build one step's recommendation rows (system recommendation overlaid with saved edits). */
export async function recommendStep(input: {
  access: AccessContext;
  period: PayrollPeriod;
  stepKey: StepKey;
  members: PopulationMember[];
  sources: Map<string, PayrollSalarySource>;
  draftRows: DraftRow[];
}): Promise<StepRow[]> {
  const drafts = draftMap(input.draftRows);
  switch (input.stepKey) {
    case "p1_new_hires":
      return recommendNewHires(input.members, input.sources, input.period, drafts);
    case "p1_resignations":
      return recommendResignations(input.members, input.sources, input.period, drafts);
    case "p1_fingerprint":
      return recommendFingerprint(input.access, input.members, input.sources, input.period, drafts);
    case "p1_crm":
      return recommendP1Crm(input.members, input.sources, input.period, drafts);
    case "p1_resignation_crm":
      return recommendResignationCrm(input.members, input.sources, input.period, drafts);
    case "p1_unpaid_vacation":
      return recommendP1UnpaidVacation(input.members, input.sources, input.period, drafts);
    case "p1_no_record":
      return recommendP1NoRecord(input.members, input.sources, drafts);
    case "p1_other_deductions":
      return recommendP1OtherDeductions(input.members, input.sources, drafts);
    case "p1_special_situations":
      return recommendSpecialSituations(input.members, input.sources, drafts);
    case "p2_expenses":
      return recommendExpenses(input.members, input.period, drafts);
    case "p2_vacation":
      return recommendVacation(input.members, input.sources, input.period, drafts);
    case "p2_crm":
      return recommendCrm(input.access, input.members, input.sources, input.period, drafts);
    case "p2_additions":
      return recommendAdditions(input.members, drafts);
    case "p2_manual_deductions":
      return recommendManualDeductions(input.members, drafts);
    case "p1_holds":
    case "p2_holds":
      return recommendHolds(input.members, drafts);
    default:
      return [];
  }
}

/** Convenience for callers that don't already hold the population/sources. */
export async function loadStepContext(period: PayrollPeriod): Promise<{
  members: PopulationMember[];
  sources: Map<string, PayrollSalarySource>;
}> {
  return resolvePayrollPopulationAndSources(period);
}
