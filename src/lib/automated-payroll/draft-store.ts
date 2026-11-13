import { compactHrKey } from "@/lib/payroll/copilot/feeders.ts";

import { TRANSITION_CLAIM_LOST } from "./transition-claim.ts";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { groupRowsByColumnSet } from "@/lib/imports/upsert-by-column-set.ts";

import { normalizeHoldReason, previousPeriod } from "./hold-reason.ts";
import type {
  DraftCellChange,
  DraftRow,
  DraftRowPatch,
  DraftWriteReason,
  MonthlySalaryRun,
  PayrollPeriod,
  PriorHold,
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
    transitionAction: (row.transition_action as string | null) ?? null,
    transitionStartedAt: (row.transition_started_at as string | null) ?? null,
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
    daysWorked: numeric(row.days_worked),
    baseForMonth: numeric(row.base_for_month),
    ecolPaid: numeric(row.ecol_paid),
    fuelPaid: numeric(row.fuel_paid),
    fingerprintDays: numeric(row.fingerprint_days),
    fingerprintValue: numeric(row.fingerprint_value),
    expenses: numeric(row.expenses),
    expensesNote: (row.expenses_note as string | null) ?? null,
    incentive: numeric(row.incentive),
    bonus: numeric(row.bonus),
    overtime: numeric(row.overtime),
    otherAdditions: numeric(row.other_additions),
    heldReleaseValue: numeric(row.held_release_value),
    payDeferralValue: numeric(row.pay_deferral_value),
    payDeferralMonth:
      row.pay_deferral_month === "next" || row.pay_deferral_month === "after_next" ? row.pay_deferral_month : null,
    heldReleaseP1Value: numeric(row.held_release_p1_value),
    payDeferralP1Value: numeric(row.pay_deferral_p1_value),
    payDeferralP1Month:
      row.pay_deferral_p1_month === "next" || row.pay_deferral_p1_month === "after_next"
        ? row.pay_deferral_p1_month
        : null,
    unpaidVacations: numeric(row.unpaid_vacations),
    resignationCrmDays: numeric(row.resignation_crm_days),
    crm: numeric(row.crm),
    manualOtherDeductions: numeric(row.manual_other_deductions),
    manualReason: (row.manual_reason as string | null) ?? null,
    additionsReason: (row.additions_reason as string | null) ?? null,
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
    settledInPart1: row.settled_in_part1 == null ? null : Boolean(row.settled_in_part1),
    part1Withheld: row.part1_withheld == null ? null : Boolean(row.part1_withheld),
    onHold: Boolean(row.on_hold),
    holdReason: (row.hold_reason as string | null) ?? null,
    excluded: Boolean(row.excluded),
    excludedReason: (row.excluded_reason as string | null) ?? null,
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
  /**
   * `transitionToken`: the write is conditioned on the claim this transition holds, and clears it in the
   * same statement (audit finding 50). A claim that lapsed and was taken over matches nothing, and that
   * is refused rather than written over the transition that took the run.
   */
  options: { transitionToken?: string } = {},
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
  if (options.transitionToken) {
    dbPatch.transition_token = null;
    dbPatch.transition_action = null;
    dbPatch.transition_started_at = null;
  }

  let query = getSupabaseAdmin().from(RUNS).update(dbPatch).eq("id", id);
  if (options.transitionToken) query = query.eq("transition_token", options.transitionToken);
  const { data, error } = await query.select("*");
  if (error) throw error;
  const row = ((data ?? []) as RunRow[])[0];
  if (!row) {
    throw new Error(
      options.transitionToken
        ? `Conflict: ${TRANSITION_CLAIM_LOST} this action's hold on the run lapsed before the run could be ` +
            "marked, and another action has taken the run. Work this action had already saved may still " +
            "stand — refresh the page and read where the run is before repeating it."
        : "Not found: payroll run does not exist.",
    );
  }
  return mapRun(row);
}

/**
 * Claim a run for one phase transition (audit finding 50). Returns the claim token, or null when the run
 * is not in one of `expectedPhases` or a live transition already holds it. One atomic statement: see
 * phx_claim_automated_payroll_run_transition.
 */
export async function claimRunTransition(
  runId: string,
  expectedPhases: RunPhase[],
  action: string,
): Promise<string | null> {
  const { data, error } = await getSupabaseAdmin().rpc("phx_claim_automated_payroll_run_transition", {
    p_run_id: runId,
    p_expected_phases: expectedPhases,
    p_action: action,
  });
  if (error) throw error;
  return typeof data === "string" && data.length > 0 ? data : null;
}

/**
 * PUBLISH'S PHASE WRITE AND ITS HELD-SALARY RECORD ARE ONE DATABASE CALL (enterprise audit 2026-11-13,
 * F-PAY-002). Who is still owed held salary is rebuilt from the `published` audit row; it used to be
 * written best-effort after the run was already marked, so one failed insert left a published month
 * whose held people vanished from every later release. phx_mark_automated_payroll_run_published marks
 * the run and inserts the row in one transaction, conditioned on this publish's claim, and refuses a
 * detail with no `held` list — so a run is never published without the record, and a failure leaves
 * the run in `ready` for the publish to be retried.
 */
export async function markRunPublished(
  id: string,
  input: {
    batchId: string;
    publishedBy: string;
    action: "published";
    detail: Record<string, unknown>;
  },
  options: { transitionToken: string },
): Promise<MonthlySalaryRun> {
  const { data, error } = await getSupabaseAdmin().rpc("phx_mark_automated_payroll_run_published", {
    p_run_id: id,
    p_transition_token: options.transitionToken,
    p_batch_id: input.batchId,
    p_published_by: input.publishedBy,
    p_actor_hr_id: input.publishedBy,
    p_detail: input.detail,
  });
  if (error) {
    const message = String(error.message ?? "");
    if (message.includes("automated_payroll_transition_claim_lost")) {
      throw new Error(
        `Conflict: ${TRANSITION_CLAIM_LOST} this action's hold on the run lapsed before the run could be ` +
          "marked, and another action has taken the run. Work this action had already saved may still " +
          "stand — refresh the page and read where the run is before repeating it.",
      );
    }
    throw new Error(
      "Could not record who was held this month, so the run was NOT marked published. The payslips already " +
        `written stay as they are; publish again to finish. (${message})`,
    );
  }
  const row = ((Array.isArray(data) ? data : data ? [data] : []) as RunRow[])[0];
  if (!row) throw new Error("Not found: payroll run does not exist.");
  return mapRun(row);
}

/** Let go of a claim a transition could not finish. Matches nothing when the phase write already cleared it. */
export async function releaseRunTransition(runId: string, token: string): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from(RUNS)
    .update({ transition_token: null, transition_action: null, transition_started_at: null })
    .eq("id", runId)
    .eq("transition_token", token);
  if (error) throw error;
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

/**
 * Everyone the PREVIOUS month's run held, keyed by compact HR id.
 *
 * Reads the latest run for that month whatever its phase — the month before an
 * open run is normally `published`, which `findActiveRun` would skip and
 * `findPublishedRun` would find only after it shipped. A month with no run at
 * all, or a run whose rows carry no holds, answers with an empty map, and the
 * caller then simply has nothing to carry forward.
 *
 * Rows with a blank reason are deliberately KEPT: "held last month, no reason
 * recorded" is itself worth showing the reviewer, and dropping it would report a
 * fresh hold for someone who has been held for months. What is missing is the
 * explanation, not the hold.
 *
 * Keyed by `employee_hr_id_compact` because HR ids are mixed case — a plain
 * equality on the raw id silently under-returns.
 */
export async function listPriorMonthHolds(period: PayrollPeriod): Promise<Map<string, PriorHold>> {
  const prior = previousPeriod(period);
  const run = await findLatestRun(prior.month, prior.year);
  if (!run) return new Map();

  const { data, error } = await getSupabaseAdmin()
    .from(DRAFT_ROWS)
    .select("employee_hr_id,employee_hr_id_compact,on_hold,hold_reason")
    .eq("run_id", run.id)
    .eq("on_hold", true);
  if (error) throw error;

  const holds = new Map<string, PriorHold>();
  for (const row of (data ?? []) as RunRow[]) {
    const compact = String(row.employee_hr_id_compact ?? "") || compactHrKey(String(row.employee_hr_id ?? ""));
    if (!compact) continue;
    holds.set(compact, {
      hrId: String(row.employee_hr_id ?? ""),
      reason: normalizeHoldReason(row.hold_reason as string | null),
      month: prior.month,
      year: prior.year,
    });
  }
  return holds;
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
  num("daysWorked", "days_worked");
  num("baseForMonth", "base_for_month");
  num("ecolPaid", "ecol_paid");
  num("fuelPaid", "fuel_paid");
  num("fingerprintDays", "fingerprint_days");
  num("fingerprintValue", "fingerprint_value");
  num("expenses", "expenses");
  num("incentive", "incentive");
  num("bonus", "bonus");
  num("overtime", "overtime");
  num("otherAdditions", "other_additions");
  num("heldReleaseValue", "held_release_value");
  num("payDeferralValue", "pay_deferral_value");
  num("heldReleaseP1Value", "held_release_p1_value");
  num("payDeferralP1Value", "pay_deferral_p1_value");
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
  if (patch.settledInPart1 !== undefined) db.settled_in_part1 = patch.settledInPart1;
  if (patch.part1Withheld !== undefined) db.part1_withheld = patch.part1Withheld;
  if (patch.payDeferralMonth !== undefined) db.pay_deferral_month = patch.payDeferralMonth;
  if (patch.payDeferralP1Month !== undefined) db.pay_deferral_p1_month = patch.payDeferralP1Month;
  if (patch.expensesNote !== undefined) db.expenses_note = patch.expensesNote;
  if (patch.manualReason !== undefined) db.manual_reason = patch.manualReason;
  if (patch.additionsReason !== undefined) db.additions_reason = patch.additionsReason;
  if (patch.p1odCrmReason !== undefined) db.p1od_crm_reason = patch.p1odCrmReason;
  if (patch.p1odVacationReason !== undefined) db.p1od_vacation_reason = patch.p1odVacationReason;
  if (patch.p1odNoRecordReason !== undefined) db.p1od_no_record_reason = patch.p1odNoRecordReason;
  if (patch.p1odLoanReason !== undefined) db.p1od_loan_reason = patch.p1odLoanReason;
  if (patch.p1odOtherReason !== undefined) db.p1od_other_reason = patch.p1odOtherReason;
  if (patch.specialSituationPart !== undefined) db.special_situation_part = patch.specialSituationPart;
  if (patch.onHold !== undefined) db.on_hold = patch.onHold;
  if (patch.holdReason !== undefined) db.hold_reason = patch.holdReason;
  if (patch.excluded !== undefined) db.excluded = patch.excluded;
  if (patch.excludedReason !== undefined) db.excluded_reason = patch.excludedReason;
  if (patch.source !== undefined) db.source = patch.source;
  // WHO AND WHY ARE WRITTEN ON EVERY WRITE, never left to carry over. The cell-history trigger reads
  // them off the row, so a write that omitted them would be recorded under the PREVIOUS write's
  // name and reason — the exact misattribution the history exists to end.
  db.edited_by = patch.editedBy ?? null;
  db.write_reason = patch.writeReason ?? "unspecified";
  db.write_step_key = patch.writeStepKey ?? null;
  return db;
}

/**
 * True when the error means a column isn't in this environment yet (Postgres
 * 42703 / PostgREST's PGRST204 schema-cache miss) rather than a real failure.
 */
function isMissingColumnError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "42703" || code === "PGRST204";
}

/**
 * Columns that carry no money and may legitimately be absent on an environment
 * whose migrations haven't caught up with the deployed code. Dropped and retried
 * rather than failing the whole write: `expenses_note` is an HR annotation, and
 * losing the note is a far smaller harm than an entire payroll step refusing to
 * save because one text column is missing. Anything that affects an amount is
 * deliberately NOT in this list — a silently dropped figure is a wrong sheet.
 */
const OPTIONAL_DRAFT_COLUMNS = ["expenses_note"] as const;

/**
 * Upsert a batch of per-employee draft edits (one step's worth).
 *
 * Sent in groups whose rows carry exactly the same columns (upsert-by-column-set.ts). One bulk upsert
 * names the UNION of every row's columns, and PostgREST writes NULL into a named column a row left out
 * — over the stored figure, on a merge. A save leaves an untouched row's figures out on purpose
 * (saved-figures.ts), and a leaver's vacation lands on other columns than everybody else's, so one
 * request would erase the figures it was told to keep.
 */
export async function upsertDraftRows(runId: string, patches: DraftRowPatch[]): Promise<void> {
  if (patches.length === 0) return;
  const rows = patches
    .filter((patch) => compactHrKey(patch.employeeHrId))
    .map((patch) => draftPatchToDb(runId, patch));
  if (rows.length === 0) return;
  const client = getSupabaseAdmin();
  for (const group of groupRowsByColumnSet(rows)) {
    const { error } = await client.from(DRAFT_ROWS).upsert(group, { onConflict: "run_id,employee_hr_id_compact" });
    if (!error) continue;
    if (!isMissingColumnError(error)) throw error;

    const stripped = group.map((row) => {
      const copy = { ...row };
      for (const column of OPTIONAL_DRAFT_COLUMNS) delete copy[column];
      return copy;
    });
    const retry = await client.from(DRAFT_ROWS).upsert(stripped, { onConflict: "run_id,employee_hr_id_compact" });
    if (retry.error) throw retry.error;
  }
}

/**
 * Who and why for a write no person made: a resync after a Deductions push or an expense change.
 * Recorded as "system" rather than left to inherit the row's last editor, who did not make it.
 */
function SYSTEM_WRITE(reason: DraftWriteReason): Record<string, unknown> {
  return { edited_by: "system", write_reason: reason, write_step_key: null };
}

const CELL_HISTORY = "automated_payroll_draft_cell_history";

/**
 * Every recorded change to one employee's cells on a run, newest first. History starts from the
 * day the trigger shipped (2026-10-07): a figure written before then has no entry, and that is
 * shown as "no history", never guessed at.
 */
export async function listDraftCellHistory(runId: string, hrId: string): Promise<DraftCellChange[]> {
  const compact = compactHrKey(hrId);
  if (!compact) return [];
  // Paged, never capped: "every recorded change" must not stop at a fixed row count.
  const client = getSupabaseAdmin();
  const data = await fetchAllRows<RunRow>(
    () =>
      client
        .from(CELL_HISTORY)
        .select("employee_hr_id, column_name, old_value, new_value, changed_by, write_reason, step_key, input_mode, changed_at")
        .eq("run_id", runId)
        .eq("employee_hr_id_compact", compact)
        .order("changed_at", { ascending: false })
        .order("id", { ascending: false }),
    "id",
  );
  return data.map((row) => ({
    employeeHrId: String(row.employee_hr_id ?? ""),
    column: String(row.column_name ?? ""),
    oldValue: (row.old_value as string | null) ?? null,
    newValue: (row.new_value as string | null) ?? null,
    changedBy: (row.changed_by as string | null) ?? null,
    changedByName: null,
    writeReason: (row.write_reason as string | null) ?? null,
    stepKey: (row.step_key as string | null) ?? null,
    inputMode: (row.input_mode as string | null) ?? null,
    changedAt: String(row.changed_at ?? ""),
  }));
}

/**
 * The LATEST recorded write to each (employee, column) asked for on a run, keyed
 * `${compact}|${column}`. A pair with no entry is absent — the figure predates the history.
 */
export async function listLatestCellWrites(
  runId: string,
  compacts: string[],
  columns: string[],
): Promise<Map<string, DraftCellChange>> {
  const latest = new Map<string, DraftCellChange>();
  if (compacts.length === 0 || columns.length === 0) return latest;
  // Paged, never capped: a missing newest write would read as "no history" for that figure.
  const client = getSupabaseAdmin();
  const data = await fetchAllRows<RunRow>(
    () =>
      client
        .from(CELL_HISTORY)
        .select("employee_hr_id, employee_hr_id_compact, column_name, old_value, new_value, changed_by, write_reason, step_key, input_mode, changed_at")
        .eq("run_id", runId)
        .in("employee_hr_id_compact", compacts)
        .in("column_name", columns)
        .order("changed_at", { ascending: false })
        .order("id", { ascending: false }),
    "id",
  );
  for (const row of data) {
    const key = `${String(row.employee_hr_id_compact ?? "")}|${String(row.column_name ?? "")}`;
    if (latest.has(key)) continue;
    latest.set(key, {
      employeeHrId: String(row.employee_hr_id ?? ""),
      column: String(row.column_name ?? ""),
      oldValue: (row.old_value as string | null) ?? null,
      newValue: (row.new_value as string | null) ?? null,
      changedBy: (row.changed_by as string | null) ?? null,
      changedByName: null,
      writeReason: (row.write_reason as string | null) ?? null,
      stepKey: (row.step_key as string | null) ?? null,
      inputMode: (row.input_mode as string | null) ?? null,
      changedAt: String(row.changed_at ?? ""),
    });
  }
  return latest;
}

export async function deleteRunDraftRows(runId: string): Promise<void> {
  const { error } = await getSupabaseAdmin().from(DRAFT_ROWS).delete().eq("run_id", runId);
  if (error) throw error;
}

/**
 * The draft columns a deduction resync is allowed to clear — every column a module-sourced step
 * freezes a Deductions figure into, and nothing else.
 *
 * An allow-list rather than a trusting pass-through, because the column name reaches a bare
 * PostgREST `update`: a typo clears nothing while reporting success, and a WRONG but real column
 * name clears money no push ever touched. Kept beside `draftPatchToDb`, whose mapping it mirrors.
 */
export const CLEARABLE_DEDUCTION_COLUMNS = [
  "fingerprint_days",
  "fingerprint_value",
  "crm",
  "unpaid_vacations",
  "resignation_crm_days",
  "manual_other_deductions",
  "p1od_crm_days",
  "p1od_crm_value",
  "p1od_vacation_days",
  "p1od_vacation_value",
  "p1od_loan_days",
  "p1od_loan_value",
  "p1od_other_days",
  "p1od_other_value",
] as const;

/**
 * The read-back select, spelled out as ONE LITERAL rather than joined from the list above.
 *
 * PostgREST's generated types parse the select STRING at compile time, so a select built with
 * `columns.join(", ")` resolves to a ParserError and the whole read loses its type (TS2352 on the
 * cast, which the box caught). A literal keeps the read narrow AND typed; the test below asserts
 * it names exactly CLEARABLE_DEDUCTION_COLUMNS, so the two cannot drift apart in silence.
 */
export const CLEARABLE_DEDUCTION_SELECT =
  "employee_hr_id, fingerprint_days, fingerprint_value, crm, unpaid_vacations, resignation_crm_days, manual_other_deductions, p1od_crm_days, p1od_crm_value, p1od_vacation_days, p1od_vacation_value, p1od_loan_days, p1od_loan_value, p1od_other_days, p1od_other_value";

/**
 * Drop the frozen deduction figures in `columns` for specific employees on a run, so the wizard
 * falls back to the live recommendation. The deduction twin of `clearDraftExpenses`, and UPDATE
 * for the same reason: an employee with no draft row has nothing frozen.
 *
 * Returns the HR ids of rows that were actually carrying a figure in at least one named column, so
 * a caller reports how many people's payroll figure really moved rather than how many were looked
 * at. That set is read BEFORE the clear: `clearDraftExpenses` gets its narrowing from a single
 * `.not(...)`, which takes one column, and this takes a set. A column outside
 * `CLEARABLE_DEDUCTION_COLUMNS` is refused rather than ignored.
 */
export async function clearDraftColumns(
  runId: string,
  hrIds: string[],
  columns: string[],
): Promise<string[]> {
  const allowed = new Set<string>(CLEARABLE_DEDUCTION_COLUMNS);
  const unknown = columns.filter((column) => !allowed.has(column));
  if (unknown.length > 0) {
    throw new Error(`Refusing to clear unknown draft column(s): ${unknown.join(", ")}`);
  }
  const compacts = Array.from(
    new Set(hrIds.map((hrId) => compactHrKey(hrId)).filter((compact): compact is string => Boolean(compact))),
  );
  if (compacts.length === 0 || columns.length === 0) return [];

  const client = getSupabaseAdmin();
  const { data: before, error: readError } = await client
    .from(DRAFT_ROWS)
    .select(CLEARABLE_DEDUCTION_SELECT)
    .eq("run_id", runId)
    .in("employee_hr_id_compact", compacts);
  if (readError) throw readError;

  const carrying = ((before ?? []) as RunRow[]).filter((row) =>
    columns.some((column) => row[column] !== null && row[column] !== undefined),
  );
  if (carrying.length === 0) return [];

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString(), ...SYSTEM_WRITE("deduction_resync") };
  for (const column of columns) patch[column] = null;

  const { error } = await client
    .from(DRAFT_ROWS)
    .update(patch)
    .eq("run_id", runId)
    .in("employee_hr_id_compact", compacts);
  if (error) throw error;

  return carrying.map((row) => String(row.employee_hr_id ?? ""));
}

/**
 * Drop the frozen expense figure for specific employees on a run, so the wizard falls back to
 * the live recommendation (a null draft value is what `pick` in recommend.ts falls through on).
 *
 * UPDATE, not upsert, on purpose: an employee with no draft row has nothing frozen, and
 * inventing a row for them would put a stranger on the sheet. `.not("expenses","is",null)`
 * narrows it further to rows that actually carry a figure, so the returned count is the number
 * of employees whose payroll figure really moved rather than the number we looked at.
 */
export async function clearDraftExpenses(runId: string, hrIds: string[]): Promise<string[]> {
  const compacts = Array.from(
    new Set(hrIds.map((hrId) => compactHrKey(hrId)).filter((compact): compact is string => Boolean(compact))),
  );
  if (compacts.length === 0) return [];
  const { data, error } = await getSupabaseAdmin()
    .from(DRAFT_ROWS)
    .update({ expenses: null, updated_at: new Date().toISOString(), ...SYSTEM_WRITE("expense_resync") })
    .eq("run_id", runId)
    .in("employee_hr_id_compact", compacts)
    .not("expenses", "is", null)
    .select("employee_hr_id");
  if (error) throw error;
  return ((data ?? []) as RunRow[]).map((row) => String(row.employee_hr_id ?? ""));
}
