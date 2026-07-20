import type { AccessContext } from "@/lib/auth/permissions";
import {
  getEmployeeDirectory,
  type EmployeeDirectoryRow,
} from "@/lib/employees/employee-directory";
import { lookupSource } from "@/lib/payroll/copilot/assemble.ts";
import {
  listCrmDeductionCandidates,
  listFingerprintDeductionCandidates,
} from "@/lib/payroll/copilot/deductions-review.ts";
import { listExpenseCandidates } from "@/lib/payroll/copilot/expense-review.ts";
import { buildFeederStates, compactHrKey } from "@/lib/payroll/copilot/feeders.ts";
import {
  computeJoinerPay,
  computeResignationSettlement,
  isInPeriod,
} from "@/lib/payroll/copilot/proration.ts";
import { listUnpaidVacationCandidates } from "@/lib/payroll/copilot/vacation-settlement.ts";
import type { DeductionInboxRow } from "@/lib/deductions-governance/service";
import { resolveDayBasedDeductionAmount } from "@/lib/deductions-governance/calculations";
import { isPayrollIneligibleEmployee } from "@/lib/payroll/eligibility.ts";
import { roundCurrency } from "@/lib/payroll/money";
import {
  getPayrollSalarySourcesByHrId,
  type PayrollSalarySource,
} from "@/lib/payroll/salary-source.ts";

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
  const candidates = await listExpenseCandidates(period);
  const totals = new Map<string, { amount: number; trips: number }>();
  for (const candidate of candidates) {
    const compact = compactHrKey(candidate.employeeHrId);
    if (!compact) continue;
    const existing = totals.get(compact) ?? { amount: 0, trips: 0 };
    existing.amount += roundCurrency(candidate.travelCost + candidate.allowance);
    existing.trips += 1;
    totals.set(compact, existing);
  }
  const byCompact = new Map(members.map((member) => [member.compact, member]));
  const rows: StepRow[] = [];
  for (const [compact, total] of totals) {
    const member = byCompact.get(compact);
    if (!member) continue;
    const draft = drafts.get(compact);
    const amount = roundCurrency(total.amount);
    const row = baseRow(member);
    row.context = { Trips: total.trips };
    row.recommended = { expenses: amount };
    row.values = { expenses: pick(draft?.expenses, amount) };
    rows.push(row);
  }
  return rows;
}

async function recommendVacation(
  members: PopulationMember[],
  period: PayrollPeriod,
  drafts: Map<string, DraftRow>,
): Promise<StepRow[]> {
  const candidates = await listUnpaidVacationCandidates(period);
  const totals = new Map<string, { days: number; amount: number }>();
  for (const candidate of candidates) {
    const compact = compactHrKey(candidate.employeeHrId);
    if (!compact) continue;
    const existing = totals.get(compact) ?? { days: 0, amount: 0 };
    existing.days += Number(candidate.unpaidDays ?? 0);
    existing.amount += roundCurrency(candidate.salaryDeductionAmount);
    totals.set(compact, existing);
  }
  const byCompact = new Map(members.map((member) => [member.compact, member]));
  const rows: StepRow[] = [];
  for (const [compact, total] of totals) {
    const member = byCompact.get(compact);
    if (!member) continue;
    const draft = drafts.get(compact);
    const amount = roundCurrency(total.amount);
    const row = baseRow(member);
    row.context = { "Unpaid Days": roundCurrency(total.days) };
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
  const totals = aggregateDeductionRows(candidates, sources);
  const byCompact = new Map(members.map((member) => [member.compact, member]));
  const rows: StepRow[] = [];
  for (const [compact, total] of totals) {
    const member = byCompact.get(compact);
    if (!member) continue;
    const draft = drafts.get(compact);
    const value = roundCurrency(total.value);
    const row = baseRow(member);
    row.context = { "No-Activity Days": roundCurrency(total.days) };
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
      return recommendVacation(input.members, input.period, drafts);
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
