import { compactHrKey } from "@/lib/payroll/copilot/feeders.ts";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import type {
  DraftRow,
  DraftRowPatch,
  MonthlySalaryRun,
  RunPhase,
  StepInputMode,
  StepKey,
  StepState,
  StepStatus,
} from "./types.ts";

/**
 * Persistence for the Automated Payroll staging tables. Pure data access via the
 * service-role client (RLS is defense-in-depth; the service layer already gates
 * the caller). No business rules here.
 *
 * Tables:
 *   automated_payroll_runs, automated_payroll_step_state,
 *   automated_payroll_draft_rows, automated_payroll_audit
 */

const RUNS = "automated_payroll_runs";
const STEP_STATE = "automated_payroll_step_state";
const DRAFT_ROWS = "automated_payroll_draft_rows";

type RunRow = Record<string, unknown>;

function mapRun(row: RunRow): MonthlySalaryRun {
  return {
    id: String(row.id),
    month: Number(row.month),
    year: Number(row.year),
    monthKey: String(row.month_key ?? ""),
    phase: String(row.phase ?? "part1") as RunPhase,
    part1ConfirmedAt: (row.part1_confirmed_at as string | null) ?? null,
    part1ConfirmedBy: (row.part1_confirmed_by as string | null) ?? null,
    part2ConfirmedAt: (row.part2_confirmed_at as string | null) ?? null,
    part2ConfirmedBy: (row.part2_confirmed_by as string | null) ?? null,
    publishedBatchId: (row.published_batch_id as string | null) ?? null,
    publishedAt: (row.published_at as string | null) ?? null,
    publishedBy: (row.published_by as string | null) ?? null,
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

function mapStepState(row: RunRow): StepState {
  return {
    runId: String(row.run_id),
    stepKey: String(row.step_key) as StepKey,
    status: String(row.status ?? "pending") as StepStatus,
    inputMode: (row.input_mode as StepInputMode | null) ?? null,
    summary: (row.summary as Record<string, unknown> | null) ?? {},
    confirmedAt: (row.confirmed_at as string | null) ?? null,
    confirmedBy: (row.confirmed_by as string | null) ?? null,
    updatedAt: String(row.updated_at ?? ""),
  };
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapDraftRow(row: RunRow): DraftRow {
  return {
    runId: String(row.run_id),
    employeeHrId: String(row.employee_hr_id ?? ""),
    employeeHrIdCompact: String(row.employee_hr_id_compact ?? ""),
    baseForMonth: numeric(row.base_for_month),
    ecolPaid: numeric(row.ecol_paid),
    fuelPaid: numeric(row.fuel_paid),
    fingerprintDays: numeric(row.fingerprint_days),
    fingerprintValue: numeric(row.fingerprint_value),
    expenses: numeric(row.expenses),
    incentive: numeric(row.incentive),
    bonus: numeric(row.bonus),
    overtime: numeric(row.overtime),
    unpaidVacations: numeric(row.unpaid_vacations),
    resignationCrmDays: numeric(row.resignation_crm_days),
    crm: numeric(row.crm),
    manualOtherDeductions: numeric(row.manual_other_deductions),
    manualReason: (row.manual_reason as string | null) ?? null,
    p1odCrmDays: numeric(row.p1od_crm_days),
    p1odCrmValue: numeric(row.p1od_crm_value),
    p1odCrmReason: (row.p1od_crm_reason as string | null) ?? null,
    p1odVacationDays: numeric(row.p1od_vacation_days),
    p1odVacationValue: numeric(row.p1od_vacation_value),
    p1odVacationReason: (row.p1od_vacation_reason as string | null) ?? null,
    p1odNoRecordDays: numeric(row.p1od_no_record_days),
    p1odNoRecordValue: numeric(row.p1od_no_record_value),
    p1odNoRecordReason: (row.p1od_no_record_reason as string | null) ?? null,
    p1odLoanDays: numeric(row.p1od_loan_days),
    p1odLoanValue: numeric(row.p1od_loan_value),
    p1odLoanReason: (row.p1od_loan_reason as string | null) ?? null,
    p1odOtherDays: numeric(row.p1od_other_days),
    p1odOtherValue: numeric(row.p1od_other_value),
    p1odOtherReason: (row.p1od_other_reason as string | null) ?? null,
    specialDeductionDays: numeric(row.special_deduction_days),
    specialDeductionValue: numeric(row.special_deduction_value),
    specialAdditionDays: numeric(row.special_addition_days),
    specialAdditionValue: numeric(row.special_addition_value),
    specialSituationPart: (row.special_situation_part as "first" | "second" | null) ?? null,
    firstPartFrozen: numeric(row.first_part_frozen),
    onHold: Boolean(row.on_hold),
    holdReason: (row.hold_reason as string | null) ?? null,
    source: (String(row.source ?? "inline") as StepInputMode) ?? "inline",
    editedBy: (row.edited_by as string | null) ?? null,
    updatedAt: String(row.updated_at ?? ""),
  };
}

/** The single active (non-terminal) run for a period, if any. */
export async function findActiveRun(month: number, year: number): Promise<MonthlySalaryRun | null> {
  const { data, error } = await getSupabaseAdmin()
    .from(RUNS)
    .select("*")
    .eq("month", month)
    .eq("year", year)
    .in("phase", ["part1", "part2", "ready"])
    .maybeSingle();
  if (error) throw error;
  return data ? mapRun(data as RunRow) : null;
}

/** The published run for a period, if any (for the Salary Changes comparison tab). */
export async function findPublishedRun(month: number, year: number): Promise<MonthlySalaryRun | null> {
  const { data, error } = await getSupabaseAdmin()
    .from(RUNS)
    .select("*")
    .eq("month", month)
    .eq("year", year)
    .eq("phase", "published")
    .order("published_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? mapRun(data as RunRow) : null;
}

/** Any run for a period regardless of phase (includes published/cancelled). Newest first. */
export async function findLatestRun(month: number, year: number): Promise<MonthlySalaryRun | null> {
  const { data, error } = await getSupabaseAdmin()
    .from(RUNS)
    .select("*")
    .eq("month", month)
    .eq("year", year)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? mapRun(data as RunRow) : null;
}

export async function getRunById(id: string): Promise<MonthlySalaryRun | null> {
  const { data, error } = await getSupabaseAdmin().from(RUNS).select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? mapRun(data as RunRow) : null;
}

export async function createRun(input: {
  month: number;
  year: number;
  createdBy: string;
}): Promise<MonthlySalaryRun> {
  const { data, error } = await getSupabaseAdmin()
    .from(RUNS)
    .insert({ month: input.month, year: input.year, phase: "part1", created_by: input.createdBy })
    .select("*")
    .single();
  if (error) throw error;
  return mapRun(data as RunRow);
}

export async function updateRun(
  id: string,
  patch: {
    phase?: RunPhase;
    part1ConfirmedAt?: string | null;
    part1ConfirmedBy?: string | null;
    part2ConfirmedAt?: string | null;
    part2ConfirmedBy?: string | null;
    publishedBatchId?: string | null;
    publishedAt?: string | null;
    publishedBy?: string | null;
  },
): Promise<MonthlySalaryRun> {
  const dbPatch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.phase !== undefined) dbPatch.phase = patch.phase;
  if (patch.part1ConfirmedAt !== undefined) dbPatch.part1_confirmed_at = patch.part1ConfirmedAt;
  if (patch.part1ConfirmedBy !== undefined) dbPatch.part1_confirmed_by = patch.part1ConfirmedBy;
  if (patch.part2ConfirmedAt !== undefined) dbPatch.part2_confirmed_at = patch.part2ConfirmedAt;
  if (patch.part2ConfirmedBy !== undefined) dbPatch.part2_confirmed_by = patch.part2ConfirmedBy;
  if (patch.publishedBatchId !== undefined) dbPatch.published_batch_id = patch.publishedBatchId;
  if (patch.publishedAt !== undefined) dbPatch.published_at = patch.publishedAt;
  if (patch.publishedBy !== undefined) dbPatch.published_by = patch.publishedBy;

  const { data, error } = await getSupabaseAdmin()
    .from(RUNS)
    .update(dbPatch)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return mapRun(data as RunRow);
}

export async function listStepStates(runId: string): Promise<StepState[]> {
  const { data, error } = await getSupabaseAdmin().from(STEP_STATE).select("*").eq("run_id", runId);
  if (error) throw error;
  return ((data ?? []) as RunRow[]).map(mapStepState);
}

export async function upsertStepState(input: {
  runId: string;
  stepKey: StepKey;
  status?: StepStatus;
  inputMode?: StepInputMode | null;
  summary?: Record<string, unknown>;
  confirmedAt?: string | null;
  confirmedBy?: string | null;
}): Promise<StepState> {
  const payload: Record<string, unknown> = {
    run_id: input.runId,
    step_key: input.stepKey,
    updated_at: new Date().toISOString(),
  };
  if (input.status !== undefined) payload.status = input.status;
  if (input.inputMode !== undefined) payload.input_mode = input.inputMode;
  if (input.summary !== undefined) payload.summary = input.summary;
  if (input.confirmedAt !== undefined) payload.confirmed_at = input.confirmedAt;
  if (input.confirmedBy !== undefined) payload.confirmed_by = input.confirmedBy;

  const { data, error } = await getSupabaseAdmin()
    .from(STEP_STATE)
    .upsert(payload, { onConflict: "run_id,step_key" })
    .select("*")
    .single();
  if (error) throw error;
  return mapStepState(data as RunRow);
}

export async function listDraftRows(runId: string): Promise<DraftRow[]> {
  const { data, error } = await getSupabaseAdmin().from(DRAFT_ROWS).select("*").eq("run_id", runId);
  if (error) throw error;
  return ((data ?? []) as RunRow[]).map(mapDraftRow);
}

function draftPatchToDb(runId: string, patch: DraftRowPatch): Record<string, unknown> {
  const compact = compactHrKey(patch.employeeHrId);
  const db: Record<string, unknown> = {
    run_id: runId,
    employee_hr_id: patch.employeeHrId,
    employee_hr_id_compact: compact,
    updated_at: new Date().toISOString(),
  };
  const num = (
    field: keyof DraftRowPatch,
    column: string,
  ) => {
    if (patch[field] !== undefined) db[column] = patch[field];
  };
  num("baseForMonth", "base_for_month");
  num("ecolPaid", "ecol_paid");
  num("fuelPaid", "fuel_paid");
  num("fingerprintDays", "fingerprint_days");
  num("fingerprintValue", "fingerprint_value");
  num("expenses", "expenses");
  num("incentive", "incentive");
  num("bonus", "bonus");
  num("overtime", "overtime");
  num("unpaidVacations", "unpaid_vacations");
  num("resignationCrmDays", "resignation_crm_days");
  num("crm", "crm");
  num("manualOtherDeductions", "manual_other_deductions");
  num("p1odCrmDays", "p1od_crm_days");
  num("p1odCrmValue", "p1od_crm_value");
  num("p1odVacationDays", "p1od_vacation_days");
  num("p1odVacationValue", "p1od_vacation_value");
  num("p1odNoRecordDays", "p1od_no_record_days");
  num("p1odNoRecordValue", "p1od_no_record_value");
  num("p1odLoanDays", "p1od_loan_days");
  num("p1odLoanValue", "p1od_loan_value");
  num("p1odOtherDays", "p1od_other_days");
  num("p1odOtherValue", "p1od_other_value");
  num("specialDeductionDays", "special_deduction_days");
  num("specialDeductionValue", "special_deduction_value");
  num("specialAdditionDays", "special_addition_days");
  num("specialAdditionValue", "special_addition_value");
  num("firstPartFrozen", "first_part_frozen");
  if (patch.manualReason !== undefined) db.manual_reason = patch.manualReason;
  if (patch.p1odCrmReason !== undefined) db.p1od_crm_reason = patch.p1odCrmReason;
  if (patch.p1odVacationReason !== undefined) db.p1od_vacation_reason = patch.p1odVacationReason;
  if (patch.p1odNoRecordReason !== undefined) db.p1od_no_record_reason = patch.p1odNoRecordReason;
  if (patch.p1odLoanReason !== undefined) db.p1od_loan_reason = patch.p1odLoanReason;
  if (patch.p1odOtherReason !== undefined) db.p1od_other_reason = patch.p1odOtherReason;
  if (patch.specialSituationPart !== undefined) db.special_situation_part = patch.specialSituationPart;
  if (patch.onHold !== undefined) db.on_hold = patch.onHold;
  if (patch.holdReason !== undefined) db.hold_reason = patch.holdReason;
  if (patch.source !== undefined) db.source = patch.source;
  if (patch.editedBy !== undefined) db.edited_by = patch.editedBy;
  return db;
}

/** Upsert a batch of per-employee draft edits (one step's worth). */
export async function upsertDraftRows(runId: string, patches: DraftRowPatch[]): Promise<void> {
  if (patches.length === 0) return;
  const rows = patches
    .filter((patch) => compactHrKey(patch.employeeHrId))
    .map((patch) => draftPatchToDb(runId, patch));
  if (rows.length === 0) return;
  const { error } = await getSupabaseAdmin()
    .from(DRAFT_ROWS)
    .upsert(rows, { onConflict: "run_id,employee_hr_id_compact" });
  if (error) throw error;
}

export async function deleteRunDraftRows(runId: string): Promise<void> {
  const { error } = await getSupabaseAdmin().from(DRAFT_ROWS).delete().eq("run_id", runId);
  if (error) throw error;
}
