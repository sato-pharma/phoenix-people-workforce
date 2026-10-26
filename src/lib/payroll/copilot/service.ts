import { systemAccessContext } from "@/lib/auth/permissions";
import {
  getEmployeeDirectory,
  type EmployeeDirectoryRow,
} from "@/lib/employees/employee-directory";
import { describeUnifiedDeductionsConflict } from "@/lib/deductions/service.ts";
import { logError } from "@/lib/observability/log";
import { isPayrollIneligibleEmployee } from "@/lib/payroll/eligibility";
import { isResignationEmploymentStatus } from "@/lib/payroll/leaver-kind";
import { payrollPaymentModeLabel } from "@/lib/payroll/policy";
import {
  validateSalaryRows,
  type SalaryValidationIssue,
  type SalaryValidationRow,
} from "@/lib/payroll/salary-import";
import { getPayrollSalarySourcesByHrId } from "@/lib/payroll/salary-source";
import { getStatutoryConfigForPeriod } from "@/lib/payroll/statutory/config";
import { loadInsuranceWages } from "@/lib/payroll/statutory/insurance-wages";
import type { PayrollSalarySource } from "@/lib/payroll/salary-source-model";
import {
  createSalaryBatch,
  findSalaryBatchForPeriod,
  getLatestSalaryRecordsBefore,
} from "@/lib/payroll/service";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import {
  buildRowForEmployee,
  groupAdjustmentsByEmployee,
  indexRecurringByEmployee,
  isDeferred,
  isOnHold,
  lookupSource,
} from "./assemble.ts";
import { buildIncludedExpenseTotals, listExpenseCandidates } from "./expense-review.ts";
import { buildFeederStates, compactHrKey } from "./feeders.ts";
import { evaluateEmployeeFlags } from "./flags.ts";
import { buildHolidayBridgingSalaryTotals } from "./holiday-bridging.ts";
import { parseCeoReply } from "./llm.ts";
import { recommendResolution, type CopilotRecommendation } from "./recommend.ts";
import { answerCeoQuestion } from "./assistant.ts";
import { applyActions } from "./negotiation.ts";
import { consumeRecurringForPeriod, listRecurringForPeriod } from "./recurring.ts";
import { buildSettledSalaryDeductionTotals, listUnpaidVacationCandidates } from "./vacation-settlement.ts";
import type {
  CopilotAdjustment,
  CopilotFlag,
  CopilotPeriod,
  CopilotRun,
  PriorRecordSnapshot,
  ProposedAction,
} from "./types.ts";
import { isUuid } from "@/lib/http/uuid";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export class CopilotError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "CopilotError";
    this.status = status;
  }
}

export function copilotBigChangeThreshold(): number {
  const raw = Number(process.env.PAYROLL_COPILOT_BIG_CHANGE_THRESHOLD);
  return Number.isFinite(raw) && raw > 0 ? raw : 0.25;
}

// ---------------------------------------------------------------------------
// Draft assembly (pure function of live data + persisted adjustments)
// ---------------------------------------------------------------------------

export type CopilotDraftEmployee = {
  hrId: string;
  fullName: string;
  jobTitle: string;
  line: string;
  netSalary: number;
  monthSalary: number;
  row: SalaryValidationRow;
  flags: CopilotFlag[];
  openFlags: CopilotFlag[];
  hasAdjustment: boolean;
  onHold: boolean;
  green: boolean;
  /** One-click resolution the Copilot recommends for this row (null when green). */
  recommendation: CopilotRecommendation | null;
};

export type CopilotRecurringApplied = {
  hrId: string;
  kind: string;
  amount: number;
  note: string | null;
};

export type CopilotDraftState = {
  period: CopilotPeriod;
  employees: CopilotDraftEmployee[];
  rows: SalaryValidationRow[];
  sources: Map<string, PayrollSalarySource>;
  greenCount: number;
  flaggedOpenCount: number;
  employeeCount: number;
  openBlockCount: number;
  recurringApplied: CopilotRecurringApplied[];
};

function priorSnapshotMap(
  records: Awaited<ReturnType<typeof getLatestSalaryRecordsBefore>>,
): Map<string, PriorRecordSnapshot> {
  const map = new Map<string, PriorRecordSnapshot>();
  for (const record of records) {
    const key = compactHrKey(record.hrId || record.employeeCode);
    if (!key) continue;
    map.set(key, {
      netSalary: record.netSalary,
      baseSalary: record.baseSalary,
      line: record.line,
      jobTitle: record.jobTitle,
    });
  }
  return map;
}

export async function assembleDraft(
  period: CopilotPeriod,
  adjustments: CopilotAdjustment[],
): Promise<CopilotDraftState> {
  const [
    directory,
    sources,
    recurring,
    feeders,
    priorRecords,
    statutoryConfig,
    insuranceWages,
    settledVacationSalaryDeductions,
    includedExpenseTotals,
    holidayBridgingSalaryDeductions,
  ] = await Promise.all([
      getEmployeeDirectory(),
      getPayrollSalarySourcesByHrId(period),
      listRecurringForPeriod(period),
      buildFeederStates(period),
      getLatestSalaryRecordsBefore(period.month, period.year, systemAccessContext),
      getStatutoryConfigForPeriod(period),
      loadInsuranceWages(),
      buildSettledSalaryDeductionTotals(period),
      buildIncludedExpenseTotals(period),
      buildHolidayBridgingSalaryTotals(period),
    ]);

  const lastDay = new Date(Date.UTC(period.year, period.month, 0)).getUTCDate();
  const periodEndStr = `${period.year}-${String(period.month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  const eligible = directory.employees.filter(
    (employee: EmployeeDirectoryRow) => {
      if (isPayrollIneligibleEmployee({
        employmentStatus: employee.employmentStatus,
        payrollEligible: employee.payrollEligible,
      })) {
        return false;
      }
      if (employee.hireDate && employee.hireDate.substring(0, 10) > periodEndStr) {
        return false;
      }
      return true;
    }
  );

  const priorMap = priorSnapshotMap(priorRecords);
  const adjByEmp = groupAdjustmentsByEmployee(adjustments);
  const recurringByEmp = indexRecurringByEmployee(recurring);
  const threshold = copilotBigChangeThreshold();

  const employees: CopilotDraftEmployee[] = [];
  const rows: SalaryValidationRow[] = [];
  let index = 1;

  for (const employee of eligible) {
    const compact = compactHrKey(employee.hrId);
    const empAdjustments = adjByEmp.get(compact) ?? [];
    if (isDeferred(empAdjustments)) continue;

    const source = lookupSource(sources, employee.hrId);
    const feeder = feeders.get(compact);
    const row = buildRowForEmployee({
      employee,
      source,
      recurring: recurringByEmp.get(compact) ?? [],
      adjustments: empAdjustments,
      period,
      index,
      statutory: { config: statutoryConfig, insuranceWage: insuranceWages.get(compact) ?? null },
      resignation: feeder?.leaverLastWorkingDate
        ? {
            lastWorkingDate: feeder.leaverLastWorkingDate,
            // The feeder finds leavers in the exit workflow, which records dismissals too. Only
            // the employee's own status separates the two, and a dismissal keeps neither allowance.
            isResignation: isResignationEmploymentStatus(employee.employmentStatus),
          }
        : null,
      settledUnpaidVacationSalaryDeduction: settledVacationSalaryDeductions.get(compact),
      holidayBridgingSalaryDeduction: holidayBridgingSalaryDeductions.get(compact),
      approvedExpenses: includedExpenseTotals.get(compact),
    });
    if (!row) continue;

    const flags = evaluateEmployeeFlags({
      row,
      employee,
      source,
      prior: priorMap.get(compact) ?? null,
      feeder: feeders.get(compact),
      period,
      bigChangeThreshold: threshold,
    });
    const hasAdjustment = empAdjustments.length > 0;
    const openFlags = hasAdjustment ? [] : flags;

    // Deterministic one-click recommendation for this row (null when green or
    // already resolved by an adjustment). Computed here where the feeder, prior
    // snapshot, and row all coexist.
    const recommendation =
      openFlags.length > 0
        ? recommendResolution({
            hrId: employee.hrId,
            openFlags,
            row,
            monthSalary: row.monthSalary,
            unpaidLeaveDays: feeders.get(compact)?.unpaidLeaveDays ?? 0,
            prior: priorMap.get(compact) ?? null,
            period,
          })
        : null;

    employees.push({
      hrId: employee.hrId,
      fullName: row.fullName,
      jobTitle: row.jobTitle,
      line: row.line,
      netSalary: row.netSalary,
      monthSalary: row.monthSalary,
      row,
      flags,
      openFlags,
      hasAdjustment,
      onHold: isOnHold(empAdjustments),
      green: flags.length === 0,
      recommendation,
    });
    rows.push(row);
    index += 1;
  }

  const recurringApplied: CopilotRecurringApplied[] = recurring
    .filter((item) => eligible.some((e) => compactHrKey(e.hrId) === compactHrKey(item.employeeHrId)))
    .map((item) => ({
      hrId: item.employeeHrId,
      kind: item.kind,
      amount: item.monthlyAmount,
      note: item.note,
    }));

  return {
    period,
    employees,
    rows,
    sources,
    greenCount: employees.filter((e) => e.green).length,
    flaggedOpenCount: employees.filter((e) => e.openFlags.length > 0).length,
    employeeCount: employees.length,
    openBlockCount: employees.filter((e) => e.openFlags.some((f) => f.severity === "block")).length,
    recurringApplied,
  };
}

// ---------------------------------------------------------------------------
// Run store
// ---------------------------------------------------------------------------

function mapRun(row: Record<string, unknown>): CopilotRun {
  return {
    id: String(row.id),
    month: Number(row.month),
    year: Number(row.year),
    status: String(row.status) as CopilotRun["status"],
    salaryBatchId: row.salary_batch_id ? String(row.salary_batch_id) : null,
    greenCount: Number(row.green_count ?? 0),
    flaggedCount: Number(row.flagged_count ?? 0),
    employeeCount: Number(row.employee_count ?? 0),
    periodLabel: row.period_label ? String(row.period_label) : null,
    createdBy: row.created_by ? String(row.created_by) : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at ?? row.created_at)).toISOString(),
  };
}

function mapAdjustment(row: Record<string, unknown>): CopilotAdjustment {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    employeeHrId: String(row.employee_hr_id ?? ""),
    kind: String(row.kind) as CopilotAdjustment["kind"],
    amount: row.amount === null || row.amount === undefined ? null : Number(row.amount),
    field: row.field ? String(row.field) : null,
    workedDays: row.worked_days === null || row.worked_days === undefined ? null : Number(row.worked_days),
    reason: row.reason ? String(row.reason) : null,
    recurringId: row.recurring_id ? String(row.recurring_id) : null,
    source: String(row.source ?? "chat"),
    createdBy: row.created_by ? String(row.created_by) : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

async function loadRun(runId: string): Promise<CopilotRun | null> {
  // A malformed id is NOT FOUND, not a fault: this is a uuid column, and Postgres answers a
  // non-uuid with 22P02 from the WHERE clause instead of with no rows, which leaves as a 500.
  // Null here, so requireRun raises its own 404 and every copilot route inherits the fix.
  if (!isUuid(runId)) return null;
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("payroll_copilot_runs")
    .select("*")
    .eq("id", runId)
    .maybeSingle();
  if (error) throw error;
  return data ? mapRun(data as Record<string, unknown>) : null;
}

async function loadAdjustments(runId: string): Promise<CopilotAdjustment[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("payroll_copilot_adjustments")
    .select("*")
    .eq("run_id", runId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map(mapAdjustment);
}

async function findActiveRun(period: CopilotPeriod): Promise<CopilotRun | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("payroll_copilot_runs")
    .select("*")
    .eq("month", period.month)
    .eq("year", period.year)
    .in("status", ["assembling", "negotiating"])
    .maybeSingle();
  if (error) throw error;
  return data ? mapRun(data as Record<string, unknown>) : null;
}

/** Re-sync the open-flags table to the freshly assembled draft (audit + queue). */
async function syncFlags(runId: string, draft: CopilotDraftState): Promise<void> {
  const supabase = getSupabaseAdmin();
  await supabase.from("payroll_copilot_flags").delete().eq("run_id", runId);
  const rows = draft.employees.flatMap((employee) =>
    employee.openFlags.map((flag) => ({
      run_id: runId,
      employee_hr_id: flag.employeeHrId,
      rule: flag.rule,
      severity: flag.severity,
      question: flag.question,
      status: "open",
    })),
  );
  if (rows.length > 0) {
    const { error } = await supabase.from("payroll_copilot_flags").insert(rows);
    if (error) {
      logError("Failed to sync open payroll copilot flags", {
        labels: { event: "copilot_flag_sync_failed", runId },
        error,
      });
    }
  }
}

async function updateRunCounts(runId: string, draft: CopilotDraftState): Promise<void> {
  const supabase = getSupabaseAdmin();
  await supabase
    .from("payroll_copilot_runs")
    .update({
      green_count: draft.greenCount,
      flagged_count: draft.flaggedOpenCount,
      employee_count: draft.employeeCount,
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId);
}

// ---------------------------------------------------------------------------
// Public API used by routes
// ---------------------------------------------------------------------------

export type OtherTabBlocking = { label: string; count: number };

export type CopilotRunView = {
  run: CopilotRun;
  draft: ReturnType<typeof serializeDraft> & { otherTabsBlocking: OtherTabBlocking[] };
  resumed?: boolean;
};

/**
 * Pending-item counts for the Unpaid Vacation/Expenses tabs — folded into
 * `canMaterialize` so "Generate payroll sheet" can no longer be clicked while
 * those tabs still have real, undecided items sitting untouched. Before this,
 * `canMaterialize` only looked at the Negotiation tab's blocking flags; a CEO
 * could generate the sheet having never opened the other tabs. Defensive:
 * never throws — a data outage must not permanently block payroll assembly, it
 * just means this run's gate can't see that tab.
 */
async function countOtherTabsPending(period: CopilotPeriod): Promise<OtherTabBlocking[]> {
  const blocking: OtherTabBlocking[] = [];
  try {
    const [vacation, expenses] = await Promise.all([
      listUnpaidVacationCandidates(period),
      listExpenseCandidates(period),
    ]);

    const vacationPending = vacation.filter((candidate) => candidate.existingSettlement === null).length;
    if (vacationPending > 0) blocking.push({ label: "Unpaid Vacation", count: vacationPending });

    const expensesPending = expenses.filter((candidate) => candidate.existingDecision === null).length;
    if (expensesPending > 0) blocking.push({ label: "Expenses", count: expensesPending });
  } catch (error) {
    logError("Failed to count other payroll copilot tabs pending items", {
      labels: { event: "copilot_other_tabs_pending_count_failed", month: period.month, year: period.year },
      error,
    });
  }
  return blocking;
}

async function finalizeRunView(run: CopilotRun, draft: CopilotDraftState): Promise<CopilotRunView> {
  const serialized = serializeDraft(draft);
  const otherTabsBlocking = await countOtherTabsPending(draft.period);
  return {
    run,
    draft: {
      ...serialized,
      canMaterialize: serialized.canMaterialize && otherTabsBlocking.length === 0,
      otherTabsBlocking,
    },
  };
}

export type CopilotEmployeeStatus = "green" | "answered" | "question" | "hold";

function employeeStatus(e: CopilotDraftEmployee): CopilotEmployeeStatus {
  if (e.openFlags.length > 0) return "question";
  if (e.onHold) return "hold";
  if (e.hasAdjustment) return "answered";
  return "green";
}

/**
 * One row per employee — the shape mirrors the canonical post-upload payroll
 * sheet (`SalaryReportTable`, src/components/payroll/dashboard/) so the
 * Copilot's table looks and sorts like the sheet HR already knows, instead of
 * an invented layout. Replaces the old three-way split (flagged/resolved/
 * green lists with three different shapes) with one consistent list plus a
 * `status` field the UI can filter/badge on.
 */
export function serializeDraft(draft: CopilotDraftState) {
  return {
    period: draft.period,
    employeeCount: draft.employeeCount,
    greenCount: draft.greenCount,
    flaggedOpenCount: draft.flaggedOpenCount,
    openBlockCount: draft.openBlockCount,
    canMaterialize: draft.openBlockCount === 0 && draft.employeeCount > 0,
    recurringApplied: draft.recurringApplied,
    employees: draft.employees.map((e) => ({
      hrId: e.hrId,
      fullName: e.fullName,
      hireDate: e.row.hireDate,
      calendarDays: e.row.calendarDays,
      workingDays: e.row.workingDays,
      line: e.line,
      area: e.row.area,
      jobTitle: e.jobTitle,
      baseSalary: e.row.baseSalary,
      expenses: e.row.expenses,
      incentive: e.row.incentive,
      extraCostOfLiving: e.row.extraCostOfLiving,
      fuelAllowance: e.row.fuelAllowance,
      otherAdditions: e.row.otherAdditions,
      totalAdditions: e.row.totalAdditions,
      crm: e.row.crm,
      fingerPrint: e.row.fingerPrint,
      unpaidVacations: e.row.unpaidVacations,
      medicalInsurance: e.row.medicalInsurance,
      loans: e.row.loans,
      otherDeductions: e.row.otherDeductions,
      // NOTE: totalDeductions on the row is already the internal-only sum
      // (crm+fingerPrint+unpaidVacations+medicalInsurance+loans+otherDeductions) —
      // it never included socialInsurance/employmentIncomeTax, so it must be
      // used as-is here. A prior version of this mapping subtracted those two
      // statutory fields from it a second time, understating this figure.
      totalDeductions: e.row.totalDeductions,
      netSalary: e.netSalary,
      firstPart: e.row.firstPart,
      secondPart: e.row.secondPart,
      monthSalary: e.monthSalary,
      paymentGroup: payrollPaymentModeLabel(e.row.paymentMode),
      status: employeeStatus(e),
      flags: e.openFlags,
      recommendation: e.recommendation,
    })),
  };
}

export async function startRun(period: CopilotPeriod, actor: string | null): Promise<CopilotRunView> {
  const existingActive = await findActiveRun(period);
  if (existingActive) {
    // Resume the in-progress run rather than dead-ending on a conflict — the CEO
    // may have navigated away; re-opening loses no work.
    const view = await getRunView(existingActive.id);
    return { ...view, resumed: true };
  }
  const existingBatch = await findSalaryBatchForPeriod(period.month, period.year);
  if (existingBatch) {
    throw new CopilotError(
      `A payroll batch already exists for ${MONTH_NAMES[period.month - 1]} ${period.year}.`,
      409,
    );
  }

  // NOT WHILE AUTOMATED PAYROLL HAS THIS MONTH OPEN (audit 2026-10-23, F-11). Automated Payroll refuses
  // to start while a Copilot run is active, because both write the same expense and vacation decision
  // tables; this is the other half, which was missing. Fails closed, as that one does: not being able
  // to look is not the same as finding nothing.
  const { data: automatedRuns, error: automatedRunsError } = await getSupabaseAdmin()
    .from("automated_payroll_runs")
    .select("id")
    .eq("month", period.month)
    .eq("year", period.year)
    .in("phase", ["part1", "part2", "ready"])
    .limit(1);
  if (automatedRunsError) {
    logError("Payroll Copilot: could not check for an active Automated Payroll run", {
      labels: { event: "payroll_copilot_automated_exclusion_read_failed", month: String(period.month), year: String(period.year) },
      error: automatedRunsError,
    });
    throw new CopilotError(
      "Could not confirm that no Automated Payroll run is open for this month, so nothing was started. Try again in a moment.",
      503,
    );
  }
  if (automatedRuns && automatedRuns.length > 0) {
    throw new CopilotError(
      `Automated Payroll has ${MONTH_NAMES[period.month - 1]} ${period.year} open. Cancel that run before using Payroll Copilot (they share deduction and expense decisions).`,
      409,
    );
  }

  const draft = await assembleDraft(period, []);
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("payroll_copilot_runs")
    .insert({
      month: period.month,
      year: period.year,
      status: "negotiating",
      green_count: draft.greenCount,
      flagged_count: draft.flaggedOpenCount,
      employee_count: draft.employeeCount,
      period_label: `${MONTH_NAMES[period.month - 1]} ${period.year}`,
      created_by: actor,
    })
    .select("*")
    .single();
  if (error) throw error;

  const run = mapRun(data as Record<string, unknown>);
  await syncFlags(run.id, draft);
  return finalizeRunView(run, draft);
}

async function requireRun(runId: string): Promise<CopilotRun> {
  const run = await loadRun(runId);
  if (!run) throw new CopilotError("Payroll run not found.", 404);
  return run;
}

/** The run's payroll period — used by the vacation-settlement and expense-review routes. */
export async function getRunPeriod(runId: string): Promise<CopilotPeriod> {
  const run = await requireRun(runId);
  return { month: run.month, year: run.year };
}

export async function getRunView(runId: string): Promise<CopilotRunView> {
  const run = await requireRun(runId);
  const adjustments = await loadAdjustments(runId);
  const draft = await assembleDraft({ month: run.month, year: run.year }, adjustments);
  await syncFlags(runId, draft);
  await updateRunCounts(runId, draft);
  return finalizeRunView(run, draft);
}

/**
 * Handle a CEO chat message. First try to parse it into proposed actions
 * (a command like "give B-100 2000 bonus"). If nothing parses, treat it as a
 * QUESTION ("why is Ahmed flagged?") and answer in prose from the draft — so
 * the box stops dead-ending on anything that isn't a command. No mutation.
 */
export async function proposeFromMessage(
  runId: string,
  text: string,
): Promise<{ proposedActions: ProposedAction[]; answer: string | null }> {
  const run = await requireRun(runId);
  const adjustments = await loadAdjustments(runId);
  const draft = await assembleDraft({ month: run.month, year: run.year }, adjustments);
  const candidates = draft.employees.map((e) => ({ hrId: e.hrId, name: e.fullName }));
  const proposedActions = await parseCeoReply(text, { candidates });

  let answer: string | null = null;
  if (proposedActions.length === 0) {
    answer = await answerCeoQuestion({
      text,
      periodLabel: `${MONTH_NAMES[run.month - 1]} ${run.year}`,
      employees: draft.employees.map((e) => ({
        hrId: e.hrId,
        name: e.fullName,
        status: employeeStatus(e),
        netSalary: e.netSalary,
        monthSalary: e.monthSalary,
        totalAdditions: e.row.totalAdditions,
        totalDeductions: e.row.totalDeductions,
        flags: e.openFlags.map((flag) => ({ rule: flag.rule, question: flag.question })),
        recommendation: e.recommendation
          ? { why: e.recommendation.why, confidence: e.recommendation.confidence }
          : null,
      })),
    }).catch((error) => {
      logError("Payroll copilot assistant answer failed", {
        labels: { event: "copilot_assistant_answer_failed", runId },
        error,
      });
      return null;
    });
  }

  return { proposedActions, answer };
}

/** Apply confirmed actions deterministically, then return the refreshed view. */
export async function applyActionsToRun(
  runId: string,
  actions: ProposedAction[],
  actor: string | null,
): Promise<CopilotRunView> {
  const run = await requireRun(runId);
  if (run.status === "drafted" || run.status === "cancelled") {
    throw new CopilotError("This run is already finalized and cannot be edited.", 409);
  }
  await applyActions({ runId, period: { month: run.month, year: run.year }, actions, actor });
  return getRunView(runId);
}

export async function cancelRun(runId: string): Promise<void> {
  const run = await requireRun(runId);
  const supabase = getSupabaseAdmin();
  await supabase
    .from("payroll_copilot_runs")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", run.id);
}

/** Convert open warn flags into batch-level governance notes. */
function draftWarningsForBatch(draft: CopilotDraftState): SalaryValidationIssue[] {
  const issues: SalaryValidationIssue[] = [];
  draft.employees.forEach((employee) => {
    employee.openFlags
      .filter((flag) => flag.severity === "warn")
      .forEach((flag) => {
        issues.push({
          code: `copilot_${flag.rule}`,
          hrId: employee.hrId,
          message: flag.question,
          row: employee.row.row,
        });
      });
  });
  return issues;
}

export async function materializeRun(
  runId: string,
  actor: string | null,
): Promise<{ batchId: string; importedRecords: number }> {
  const run = await requireRun(runId);
  if (run.status === "drafted" && run.salaryBatchId) {
    return { batchId: run.salaryBatchId, importedRecords: run.employeeCount };
  }
  if (run.status === "cancelled") {
    throw new CopilotError("This run was cancelled.", 409);
  }

  // This path prices deductions from the LEGACY deduction_* tables, not from the Deductions module
  // HR actually works in. Refuse rather than write a sheet nobody reviewed — see
  // describeUnifiedDeductionsConflict for the measured exposure. Checked before assembleDraft so the
  // cheapest exit wins and no partial work is done.
  const unifiedDeductionsConflict = await describeUnifiedDeductionsConflict({
    month: run.month,
    year: run.year,
  });
  if (unifiedDeductionsConflict) {
    throw new CopilotError(unifiedDeductionsConflict, 409);
  }

  const period = { month: run.month, year: run.year };
  const adjustments = await loadAdjustments(runId);
  const draft = await assembleDraft(period, adjustments);

  if (draft.employeeCount === 0) {
    throw new CopilotError("No eligible employees to pay for this period.", 400);
  }
  if (draft.openBlockCount > 0) {
    throw new CopilotError(
      `${draft.openBlockCount} employee(s) still have blocking questions. Answer them before generating the sheet.`,
      409,
    );
  }

  const otherTabsBlocking = await countOtherTabsPending(period);
  if (otherTabsBlocking.length > 0) {
    throw new CopilotError(
      `Still has open items: ${otherTabsBlocking.map((tab) => `${tab.label} (${tab.count})`).join(", ")}. Resolve those tabs before generating the sheet.`,
      409,
    );
  }

  const issues = validateSalaryRows(draft.rows, draft.sources);
  const hardIssues = issues.filter((issue) => {
    if (
      issue.code === "base_salary_source_of_truth_mismatch" ||
      issue.code === "gross_salary_formula_mismatch" ||
      issue.code === "net_salary_formula_mismatch"
    ) {
      const hrId = issue.hrId || "";
      const row = draft.rows.find((r) => r.hrId === hrId);
      const source = draft.sources.get(compactHrKey(hrId));

      const isProratedOrLegacy = !source || !source.baseSalary || (row && row.baseSalary !== source.baseSalary);
      if (isProratedOrLegacy) {
        return false;
      }
    }
    return true;
  });
  if (hardIssues.length > 0) {
    throw new CopilotError(
      `The assembled sheet failed validation: ${hardIssues.slice(0, 5).map((i) => `${i.hrId ?? "?"} ${i.message}`).join("; ")}`,
      400,
    );
  }

  const result = await createSalaryBatch({
    fileContentHash: null,
    fileName: `copilot:${runId}`,
    month: period.month,
    records: draft.rows,
    uploadedBy: actor,
    validationWarnings: draftWarningsForBatch(draft),
    year: period.year,
  });

  await consumeRecurringForPeriod(period);

  const supabase = getSupabaseAdmin();
  await supabase
    .from("payroll_copilot_runs")
    .update({
      status: "drafted",
      salary_batch_id: result.batch.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId);

  return { batchId: result.batch.id, importedRecords: result.importedRecords };
}
