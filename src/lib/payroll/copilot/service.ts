import {
  getEmployeeDirectory,
  type EmployeeDirectoryRow,
} from "@/lib/employees/employee-directory";
import { isPayrollIneligibleEmployee } from "@/lib/payroll/eligibility";
import {
  validateSalaryRows,
  type SalaryValidationIssue,
  type SalaryValidationRow,
} from "@/lib/payroll/salary-import";
import { getPayrollSalarySourcesByHrId } from "@/lib/payroll/salary-source";
import { getStatutoryConfigForPeriod } from "@/lib/payroll/statutory/config";
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
  lookupSource,
} from "./assemble.ts";
import { buildFeederStates, compactHrKey } from "./feeders.ts";
import { evaluateEmployeeFlags } from "./flags.ts";
import { parseCeoReply } from "./llm.ts";
import { applyActions } from "./negotiation.ts";
import { consumeRecurringForPeriod, listRecurringForPeriod } from "./recurring.ts";
import type {
  CopilotAdjustment,
  CopilotFlag,
  CopilotPeriod,
  CopilotRun,
  PriorRecordSnapshot,
  ProposedAction,
} from "./types.ts";

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
  green: boolean;
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

/**
 * Map of compact HR id -> per-employee social-insurance (subject) wage. Defensive:
 * if the column/table is missing (migration not yet applied) it returns empty, so
 * statutory computation simply doesn't apply and the carried values are kept.
 */
async function loadInsuranceWages(): Promise<Map<string, number | null>> {
  const map = new Map<string, number | null>();
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.from("employees").select("hr_id,social_insurance_wage");
    if (error) {
      console.error("[payroll-copilot:service] insurance wage load failed:", error);
      return map;
    }
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const key = compactHrKey(String(row.hr_id ?? ""));
      if (!key) continue;
      const wage = row.social_insurance_wage;
      map.set(key, wage === null || wage === undefined ? null : Number(wage));
    }
  } catch (error) {
    console.error("[payroll-copilot:service] insurance wage load threw:", error);
  }
  return map;
}

export async function assembleDraft(
  period: CopilotPeriod,
  adjustments: CopilotAdjustment[],
): Promise<CopilotDraftState> {
  const [directory, sources, recurring, feeders, priorRecords, statutoryConfig, insuranceWages] =
    await Promise.all([
      getEmployeeDirectory(),
      getPayrollSalarySourcesByHrId(period),
      listRecurringForPeriod(period),
      buildFeederStates(period),
      getLatestSalaryRecordsBefore(period.month, period.year),
      getStatutoryConfigForPeriod(period),
      loadInsuranceWages(),
    ]);

  const eligible = directory.employees.filter(
    (employee: EmployeeDirectoryRow) =>
      !isPayrollIneligibleEmployee({
        employmentStatus: employee.employmentStatus,
        payrollEligible: employee.payrollEligible,
      }),
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
    const row = buildRowForEmployee({
      employee,
      source,
      recurring: recurringByEmp.get(compact) ?? [],
      adjustments: empAdjustments,
      period,
      index,
      statutory: { config: statutoryConfig, insuranceWage: insuranceWages.get(compact) ?? null },
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
      green: flags.length === 0,
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
    if (error) console.error("[payroll-copilot:service] flag sync failed:", error);
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

export type CopilotRunView = {
  run: CopilotRun;
  draft: ReturnType<typeof serializeDraft>;
};

export function serializeDraft(draft: CopilotDraftState) {
  return {
    period: draft.period,
    employeeCount: draft.employeeCount,
    greenCount: draft.greenCount,
    flaggedOpenCount: draft.flaggedOpenCount,
    openBlockCount: draft.openBlockCount,
    canMaterialize: draft.openBlockCount === 0 && draft.employeeCount > 0,
    recurringApplied: draft.recurringApplied,
    flagged: draft.employees
      .filter((e) => e.openFlags.length > 0)
      .map((e) => ({
        hrId: e.hrId,
        fullName: e.fullName,
        jobTitle: e.jobTitle,
        line: e.line,
        netSalary: e.netSalary,
        flags: e.openFlags,
      })),
    resolved: draft.employees
      .filter((e) => e.hasAdjustment)
      .map((e) => ({ hrId: e.hrId, fullName: e.fullName, netSalary: e.netSalary, monthSalary: e.monthSalary })),
    green: draft.employees
      .filter((e) => e.green && !e.hasAdjustment)
      .map((e) => ({ hrId: e.hrId, fullName: e.fullName, netSalary: e.netSalary, monthSalary: e.monthSalary })),
  };
}

export async function startRun(period: CopilotPeriod, actor: string | null): Promise<CopilotRunView> {
  const existingActive = await findActiveRun(period);
  if (existingActive) {
    throw new CopilotError(
      `A payroll run for ${MONTH_NAMES[period.month - 1]} ${period.year} is already in progress.`,
      409,
    );
  }
  const existingBatch = await findSalaryBatchForPeriod(period.month, period.year);
  if (existingBatch) {
    throw new CopilotError(
      `A payroll batch already exists for ${MONTH_NAMES[period.month - 1]} ${period.year}.`,
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
  return { run, draft: serializeDraft(draft) };
}

async function requireRun(runId: string): Promise<CopilotRun> {
  const run = await loadRun(runId);
  if (!run) throw new CopilotError("Payroll run not found.", 404);
  return run;
}

export async function getRunView(runId: string): Promise<CopilotRunView> {
  const run = await requireRun(runId);
  const adjustments = await loadAdjustments(runId);
  const draft = await assembleDraft({ month: run.month, year: run.year }, adjustments);
  await syncFlags(runId, draft);
  await updateRunCounts(runId, draft);
  return { run, draft: serializeDraft(draft) };
}

/** Parse the CEO's chat message into proposed actions (no mutation). */
export async function proposeFromMessage(
  runId: string,
  text: string,
): Promise<{ proposedActions: ProposedAction[] }> {
  const run = await requireRun(runId);
  const adjustments = await loadAdjustments(runId);
  const draft = await assembleDraft({ month: run.month, year: run.year }, adjustments);
  const candidates = draft.employees.map((e) => ({ hrId: e.hrId, name: e.fullName }));
  const proposedActions = await parseCeoReply(text, { candidates });
  return { proposedActions };
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

  const issues = validateSalaryRows(draft.rows, draft.sources);
  const hardIssues = issues.filter((issue) => issue.code !== "base_salary_source_of_truth_mismatch");
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
