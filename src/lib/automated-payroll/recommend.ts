import type { AccessContext } from "@/lib/auth/permissions";
import {
  getEmployeeDirectory,
  type EmployeeDirectoryRow,
} from "@/lib/employees/employee-directory";
import { loadEmployeeDayPunchMinutes } from "@/lib/attendance/punch-minutes";
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
import {
  getPayrollSalarySourcesByHrId,
  type PayrollSalarySource,
} from "@/lib/payroll/salary-source.ts";
import { buildFieldWorkforceCompliancePreviewFromVisitsReport } from "@/lib/field-workforce-compliance/ireports360-source.ts";
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
  /** Leaver only. */
  lastWorkingDate: string | null;
  /** Leaver only — unpaid-leave days inside the settlement span (resignation Rule 1). */
  unpaidDaysInSpan: number;
};

/**
 * The employees a run covers: every active + payroll-eligible employee, plus this
 * month's joiners and leavers (a leaver may already be terminal but must still be
 * settled). Shared by recommend + assemble so both see the exact same population.
 */
export async function resolvePayrollPopulation(period: PayrollPeriod): Promise<PopulationMember[]> {
  const [directory, feeders] = await Promise.all([getEmployeeDirectory(), buildFeederStates(period)]);
  const members: PopulationMember[] = [];

  for (const employee of directory.employees) {
    const compact = compactHrKey(employee.hrId);
    if (!compact) continue;
    const feeder = feeders.get(compact);
    const leaverLastWorkingDate = feeder?.leaverLastWorkingDate ?? null;
    const isLeaver = Boolean(leaverLastWorkingDate);
    const isJoiner = !isLeaver && isInPeriod(employee.hireDate, period);

    // Include: active/eligible employees, OR a leaver this month (even if terminal now).
    if (isPayrollIneligibleEmployee(employee) && !isLeaver) continue;

    members.push({
      employee,
      compact,
      lifecycle: isLeaver ? "leaver" : isJoiner ? "joiner" : "regular",
      lastWorkingDate: leaverLastWorkingDate,
      unpaidDaysInSpan: feeder?.unpaidDaysBeforeLastWorkingDate ?? 0,
    });
  }

  return members;
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
      console.error("[automated-payroll:recommend] payout expenses load failed:", error.message);
      return totals;
    }
    for (const row of (data ?? []) as Array<{ hr_id: string | null; total: number | null }>) {
      const compact = compactHrKey(row.hr_id ?? "");
      if (!compact) continue;
      totals.set(compact, roundCurrency((totals.get(compact) ?? 0) + Number(row.total ?? 0)));
    }
  } catch (error) {
    console.error("[automated-payroll:recommend] payout expenses load threw:", error);
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
    console.error("[automated-payroll:recommend] punch-date load threw:", error);
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
    console.error(
      "[automated-payroll:recommend] CRM leave load failed (non-fatal):",
      error instanceof Error ? error.message : error,
    );
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
      console.error("[automated-payroll:recommend] v2 vacation dates load failed:", error.message);
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
    console.error("[automated-payroll:recommend] v2 vacation dates load threw:", error);
  }
  return byCompact;
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

function recommendResignations(
  members: PopulationMember[],
  sources: Map<string, PayrollSalarySource>,
  period: PayrollPeriod,
  drafts: Map<string, DraftRow>,
): StepRow[] {
  const rows: StepRow[] = [];
  for (const member of members) {
    if (member.lifecycle !== "leaver" || !member.lastWorkingDate) continue;
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
    const row = baseRow(member);
    row.context = {
      "Last Working Date": member.lastWorkingDate,
      Branch: settlement.branch === "on_or_before_25" ? "≤ 25th (Base prorated)" : "> 25th (Full)",
      "Days Worked": settlement.daysWorked,
    };
    row.recommended = {
      baseForMonth: settlement.baseForMonth,
      ecolPaid: settlement.ecolPaid,
      fuelPaid: settlement.fuelPaid,
    };
    row.values = {
      baseForMonth: pick(draft?.baseForMonth, settlement.baseForMonth),
      ecolPaid: pick(draft?.ecolPaid, settlement.ecolPaid),
      fuelPaid: pick(draft?.fuelPaid, settlement.fuelPaid),
    };
    rows.push(row);
  }
  return rows;
}

/** Aggregate day-based deduction candidates per employee → { days, value }. */
function aggregateDeductionRows(
  candidates: DeductionInboxRow[],
  sources: Map<string, PayrollSalarySource>,
): Map<string, { days: number; value: number }> {
  const totals = new Map<string, { days: number; value: number }>();
  for (const candidate of candidates) {
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
    row.context = {};
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
    row.recommended = { expenses: value };
    row.values = { expenses: pick(draft?.expenses, value) };
    rows.push(row);
  }
  return rows;
}

async function recommendVacation(
  members: PopulationMember[],
  sources: Map<string, PayrollSalarySource>,
  period: PayrollPeriod,
  drafts: Map<string, DraftRow>,
): Promise<StepRow[]> {
  const byCompact = new Map(members.map((member) => [member.compact, member]));
  const totals = new Map<
    string,
    { v2Days: number; v2Amount: number; crmDays: number; crmUnpaidDays: number; crmAmount: number }
  >();
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
      console.error("[automated-payroll:recommend] CRM leave balance check failed:", error);
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
  }

  const rows: StepRow[] = [];
  for (const [compact, total] of totals) {
    const member = byCompact.get(compact);
    if (!member) continue;
    const draft = drafts.get(compact);
    const amount = roundCurrency(total.v2Amount + total.crmAmount);
    const row = baseRow(member);
    row.context = {
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

async function recommendCrm(
  access: AccessContext,
  members: PopulationMember[],
  sources: Map<string, PayrollSalarySource>,
  period: PayrollPeriod,
  drafts: Map<string, DraftRow>,
): Promise<StepRow[]> {
  const { rows: candidates } = await listCrmDeductionCandidates(access, period);
  // Owner rule (2026-07-20): a no-CRM-activity day with a fingerprint punch is an office
  // day, not an absence — drop punched dates before deducting (field reps show CRM activity
  // only on field-visit days; office days have a punch and no CRM visit).
  const punchedByCompact = await loadPunchedDatesByCompact(
    period,
    members.map((member) => member.employee.hrId),
  );
  const byCompact = new Map(members.map((member) => [member.compact, member]));

  const totals = new Map<string, { days: number; value: number; officeExcluded: number }>();
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

  const rows: StepRow[] = [];
  for (const [compact, total] of totals) {
    const member = byCompact.get(compact);
    if (!member) continue;
    const draft = drafts.get(compact);
    const value = roundCurrency(total.value);
    const row = baseRow(member);
    row.context = { "No-Activity Days": roundCurrency(total.days), "Office (punched)": total.officeExcluded };
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
    row.recommended = { manualOtherDeductions: 0 };
    row.values = { manualOtherDeductions: pick(draft?.manualOtherDeductions, 0) };
    row.reason = draft?.manualReason ?? null;
    return row;
  });
}

function recommendHolds(members: PopulationMember[], drafts: Map<string, DraftRow>): StepRow[] {
  return members.map((member) => {
    const draft = drafts.get(member.compact);
    const row = baseRow(member);
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
  const [members, sources] = await Promise.all([
    resolvePayrollPopulation(period),
    getPayrollSalarySourcesByHrId(period),
  ]);
  return { members, sources };
}
