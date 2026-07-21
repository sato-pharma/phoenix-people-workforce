import type { AccessContext } from "@/lib/auth/permissions";
import {
  createSalaryBatch,
  findSalaryBatchForPeriod,
} from "@/lib/payroll/service";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { assembleRows, computeFrozenFirstParts, type AssembledRow } from "./assemble.ts";
import { writeAutomatedPayrollAudit } from "./audit.ts";
import { buildFinanceSheetWorkbook } from "./exports/finance-sheet.ts";
import { buildFullSheetWorkbook, buildPart1SheetWorkbook } from "./exports/sheet.ts";
import { buildStepTemplateWorkbook } from "./exports/step-template.ts";
import { diffStepUpload, parseStepWorkbook } from "./imports/step-parser.ts";
import {
  createRun,
  findActiveRun,
  findLatestRun,
  getRunById,
  listDraftRows,
  listStepStates,
  updateRun,
  upsertDraftRows,
  upsertStepState,
} from "./draft-store.ts";
import { monthLabel, notifyPart1Ready, notifyPart2Ready, notifyPublished } from "./notify.ts";
import {
  actorId,
  assertAutomatedPayrollFinanceActor,
  assertAutomatedPayrollHrActor,
  assertAutomatedPayrollPublisher,
} from "./permissions.ts";
import {
  computeVacationDeductionTotals,
  loadStepContext,
  recommendStep,
  settleCrmLeaveBalanceForPeriod,
  type PopulationMember,
} from "./recommend.ts";
import { reconcile } from "./reconcile.ts";
import type { PayrollSalarySource } from "@/lib/payroll/salary-source.ts";
import type {
  DraftRow,
  DraftRowPatch,
  MonthlySalaryRun,
  PayrollPeriod,
  ReconciliationTotals,
  StepEditInput,
  StepImportCommit,
  StepImportPreview,
  StepInputMode,
  StepKey,
  StepRow,
  StepState,
} from "./types.ts";
import { PART1_STEP_KEYS, PART2_STEP_KEYS, stepPhase } from "./types.ts";

export type { StepEditInput } from "./types.ts";

/**
 * Orchestrates the Automated Payroll run lifecycle: start/resume, per-step
 * recommend/save/confirm, Part 1 freeze + Part 2 assemble, and the separate
 * Super-Admin publish to payslips. Every mutation re-checks the caller.
 */

const NUMERIC_FIELDS: (keyof DraftRowPatch)[] = [
  "baseForMonth",
  "ecolPaid",
  "fuelPaid",
  "fingerprintDays",
  "fingerprintValue",
  "expenses",
  "incentive",
  "bonus",
  "overtime",
  "unpaidVacations",
  "crm",
  "manualOtherDeductions",
];

export type RunView = {
  run: MonthlySalaryRun;
  stepStates: StepState[];
  draftRows: DraftRow[];
};

function nowIso(): string {
  return new Date().toISOString();
}

function stepEditToPatch(stepKey: StepKey, edit: StepEditInput): DraftRowPatch {
  const patch: DraftRowPatch = { employeeHrId: edit.hrId };
  const values = edit.values ?? {};
  for (const field of NUMERIC_FIELDS) {
    const value = values[field as string];
    if (value !== undefined && Number.isFinite(Number(value))) {
      (patch as unknown as Record<string, number>)[field as string] = Number(value);
    }
  }
  if (stepKey === "p1_holds" || stepKey === "p2_holds") {
    if (edit.onHold !== undefined) patch.onHold = edit.onHold;
    if (edit.reason !== undefined) patch.holdReason = edit.reason;
  }
  if (stepKey === "p2_manual_deductions" && edit.reason !== undefined) {
    patch.manualReason = edit.reason;
  }
  return patch;
}

function stepRowToPatch(stepKey: StepKey, row: StepRow): DraftRowPatch {
  return stepEditToPatch(stepKey, {
    hrId: row.hrId,
    values: row.values,
    reason: row.reason,
    onHold: row.onHold,
  });
}

async function requireRun(runId: string): Promise<MonthlySalaryRun> {
  const run = await getRunById(runId);
  if (!run) throw new Error("Not found: payroll run does not exist.");
  return run;
}

function assertActiveRun(run: MonthlySalaryRun): void {
  if (run.phase === "published") throw new Error("Conflict: this run is already published.");
  if (run.phase === "cancelled") throw new Error("Conflict: this run was cancelled.");
}

// ---- Run lifecycle ----------------------------------------------------------

/** Start a new run for a period, or resume the active one. */
export async function startOrResumeRun(
  access: AccessContext,
  period: PayrollPeriod,
): Promise<MonthlySalaryRun> {
  assertAutomatedPayrollHrActor(access);

  const existing = await findActiveRun(period.month, period.year);
  if (existing) return existing;

  // Mutual exclusion: do not start while a Payroll Copilot run is active for the
  // same period (both write the shared expense/vacation decision tables).
  const { data: copilotRuns } = await getSupabaseAdmin()
    .from("payroll_copilot_runs")
    .select("id,status")
    .eq("month", period.month)
    .eq("year", period.year)
    .in("status", ["assembling", "negotiating", "drafted"])
    .limit(1);
  if (copilotRuns && copilotRuns.length > 0) {
    throw new Error(
      "Conflict: a Payroll Copilot run is active for this month. Cancel it before using Automated Payroll (they share deduction/expense decisions).",
    );
  }

  const run = await createRun({ month: period.month, year: period.year, createdBy: actorId(access) });
  await writeAutomatedPayrollAudit({ runId: run.id, actorHrId: actorId(access), action: "run_started" });
  return run;
}

export async function getRunView(access: AccessContext, runId: string): Promise<RunView> {
  assertAutomatedPayrollHrActor(access);
  const run = await requireRun(runId);
  const [stepStates, draftRows] = await Promise.all([listStepStates(runId), listDraftRows(runId)]);
  return { run, stepStates, draftRows };
}

/** The active/most-recent run for a period (or null), for the page loader. */
export async function getRunForPeriod(
  access: AccessContext,
  period: PayrollPeriod,
): Promise<MonthlySalaryRun | null> {
  assertAutomatedPayrollHrActor(access);
  return (await findActiveRun(period.month, period.year)) ?? (await findLatestRun(period.month, period.year));
}

export async function cancelRun(access: AccessContext, runId: string): Promise<MonthlySalaryRun> {
  assertAutomatedPayrollHrActor(access);
  const run = await requireRun(runId);
  assertActiveRun(run);
  const updated = await updateRun(runId, { phase: "cancelled" });
  await writeAutomatedPayrollAudit({ runId, actorHrId: actorId(access), action: "run_cancelled" });
  return updated;
}

// ---- Per-step recommend / save / confirm ------------------------------------

async function loadRunContext(period: PayrollPeriod, runId: string): Promise<{
  members: PopulationMember[];
  sources: Map<string, PayrollSalarySource>;
  draftRows: DraftRow[];
}> {
  const [{ members, sources }, draftRows] = await Promise.all([
    loadStepContext(period),
    listDraftRows(runId),
  ]);
  return { members, sources, draftRows };
}

export async function getStepRecommendation(
  access: AccessContext,
  runId: string,
  stepKey: StepKey,
): Promise<{ run: MonthlySalaryRun; rows: StepRow[]; state: StepState | null }> {
  assertAutomatedPayrollHrActor(access);
  const run = await requireRun(runId);
  const period: PayrollPeriod = { month: run.month, year: run.year };
  const { members, sources, draftRows } = await loadRunContext(period, runId);
  const rows = await recommendStep({ access, period, stepKey, members, sources, draftRows });
  const states = await listStepStates(runId);
  return { run, rows, state: states.find((state) => state.stepKey === stepKey) ?? null };
}

function assertStepPhaseAllowed(run: MonthlySalaryRun, stepKey: StepKey): void {
  assertActiveRun(run);
  const phase = stepPhase(stepKey);
  if (phase === "part2" && run.phase === "part1") {
    throw new Error("Conflict: confirm Part 1 before editing Part 2 steps.");
  }
}

/** Save inline/xlsx edits for a step (marks the step edited, not confirmed). */
export async function saveStep(
  access: AccessContext,
  runId: string,
  stepKey: StepKey,
  edits: StepEditInput[],
  inputMode: StepInputMode,
): Promise<void> {
  assertAutomatedPayrollHrActor(access);
  const run = await requireRun(runId);
  assertStepPhaseAllowed(run, stepKey);

  const patches = edits.map((edit) => {
    const patch = stepEditToPatch(stepKey, edit);
    patch.source = inputMode;
    patch.editedBy = actorId(access);
    return patch;
  });
  await upsertDraftRows(runId, patches);
  await upsertStepState({ runId, stepKey, status: "pending", inputMode });
  await writeAutomatedPayrollAudit({
    runId,
    actorHrId: actorId(access),
    action: "step_saved",
    stepKey,
    detail: { edited: patches.length, inputMode },
  });
}

/** Confirm a step: persist the currently-shown values (accepted recommendations + edits) and lock it. */
export async function confirmStep(
  access: AccessContext,
  runId: string,
  stepKey: StepKey,
): Promise<StepState> {
  assertAutomatedPayrollHrActor(access);
  const run = await requireRun(runId);
  assertStepPhaseAllowed(run, stepKey);

  const period: PayrollPeriod = { month: run.month, year: run.year };
  const { members, sources, draftRows } = await loadRunContext(period, runId);
  const rows = await recommendStep({ access, period, stepKey, members, sources, draftRows });

  const patches = rows.map((row) => {
    const patch = stepRowToPatch(stepKey, row);
    patch.editedBy = actorId(access);
    return patch;
  });
  await upsertDraftRows(runId, patches);

  const summary = summarizeStep(stepKey, rows);
  const state = await upsertStepState({
    runId,
    stepKey,
    status: "confirmed",
    summary,
    confirmedAt: nowIso(),
    confirmedBy: actorId(access),
  });

  // Owner rule (2026-07-21): a vacation day — CRM-sourced or a formal Phoenix request —
  // must durably subtract from balance first, salary only for what balance doesn't cover.
  // Confirming this step is the one moment CRM-only leave (no v2_vacation_requests row)
  // becomes real: settle it into the same ledger a formal request settlement uses, so future
  // balance checks see it consumed, not just this month's payroll-sheet number.
  if (stepKey === "p2_vacation") {
    const { crmLeaveSettlements } = await computeVacationDeductionTotals(members, sources, period);
    const { settled } = await settleCrmLeaveBalanceForPeriod({
      actorHrId: actorId(access),
      crmLeaveSettlements,
      runId,
    });
    if (settled > 0) summary.crmLeaveBalanceSettled = settled;
  }

  await writeAutomatedPayrollAudit({
    runId,
    actorHrId: actorId(access),
    action: "step_confirmed",
    stepKey,
    detail: summary,
  });
  return state;
}

function summarizeStep(stepKey: StepKey, rows: StepRow[]): Record<string, unknown> {
  if (stepKey === "p1_holds" || stepKey === "p2_holds") {
    return { employees: rows.length, held: rows.filter((row) => row.onHold).length };
  }
  const primaryField = Object.keys(rows[0]?.values ?? {})[0];
  const total = primaryField
    ? Math.round(rows.reduce((sum, row) => sum + (row.values[primaryField] ?? 0), 0) * 100) / 100
    : 0;
  return { employees: rows.length, primaryField: primaryField ?? null, total };
}

// ---- Part confirmations -----------------------------------------------------

function assertAllStepsConfirmed(states: StepState[], keys: readonly StepKey[]): void {
  const confirmed = new Set(states.filter((state) => state.status === "confirmed").map((state) => state.stepKey));
  const missing = keys.filter((key) => !confirmed.has(key));
  if (missing.length > 0) {
    throw new Error(`Conflict: confirm all steps first (pending: ${missing.join(", ")}).`);
  }
}

/** Confirm Part 1: freeze the First Part per employee, notify the finance roles. */
export async function confirmPart1(access: AccessContext, runId: string): Promise<MonthlySalaryRun> {
  assertAutomatedPayrollHrActor(access);
  const run = await requireRun(runId);
  assertActiveRun(run);
  if (run.phase !== "part1") {
    throw new Error("Conflict: Part 1 has already been confirmed.");
  }

  const states = await listStepStates(runId);
  assertAllStepsConfirmed(states, PART1_STEP_KEYS);

  const period: PayrollPeriod = { month: run.month, year: run.year };
  const { members, sources, draftRows } = await loadRunContext(period, runId);
  const frozen = computeFrozenFirstParts({ members, sources, draftRows, period });

  const patches: DraftRowPatch[] = members.map((member) => ({
    employeeHrId: member.employee.hrId,
    firstPartFrozen: frozen.get(member.compact) ?? 0,
    editedBy: actorId(access),
  }));
  await upsertDraftRows(runId, patches);

  const updated = await updateRun(runId, {
    phase: "part2",
    part1ConfirmedAt: nowIso(),
    part1ConfirmedBy: actorId(access),
  });
  await writeAutomatedPayrollAudit({
    runId,
    actorHrId: actorId(access),
    action: "part1_confirmed",
    detail: { frozenEmployees: patches.length },
  });
  await notifyPart1Ready(updated);
  return updated;
}

/** Confirm Part 2: assemble the full sheet, run the pre-flight gate, notify. */
export async function confirmPart2(access: AccessContext, runId: string): Promise<MonthlySalaryRun> {
  assertAutomatedPayrollHrActor(access);
  const run = await requireRun(runId);
  assertActiveRun(run);
  if (run.phase !== "part2") {
    throw new Error("Conflict: confirm Part 1 before Part 2 (or Part 2 is already confirmed).");
  }

  const states = await listStepStates(runId);
  assertAllStepsConfirmed(states, PART2_STEP_KEYS);

  const { rows } = await assembleForRun(run);
  const { preflightValidate } = await import("./validate.ts");
  const preflight = preflightValidate(rows);
  if (!preflight.ok) {
    const sample = preflight.issues.slice(0, 6).map((issue) => `${issue.hrId ?? "?"}: ${issue.message}`);
    throw new Error(`Validation: fix ${preflight.errorCount} issue(s) before confirming Part 2. ${sample.join("; ")}`);
  }

  const updated = await updateRun(runId, {
    phase: "ready",
    part2ConfirmedAt: nowIso(),
    part2ConfirmedBy: actorId(access),
  });
  await writeAutomatedPayrollAudit({
    runId,
    actorHrId: actorId(access),
    action: "part2_confirmed",
    detail: { employees: rows.length },
  });
  await notifyPart2Ready(updated);
  return updated;
}

// ---- Assembly / reconciliation ----------------------------------------------

async function assembleForRun(run: MonthlySalaryRun): Promise<{
  rows: AssembledRow[];
  members: PopulationMember[];
}> {
  const period: PayrollPeriod = { month: run.month, year: run.year };
  const { members, sources, draftRows } = await loadRunContext(period, run.id);
  const rows = assembleRows({ members, sources, draftRows, period });
  return { rows, members };
}

export async function getReconciliation(
  access: AccessContext,
  runId: string,
): Promise<ReconciliationTotals> {
  assertAutomatedPayrollHrActor(access);
  const run = await requireRun(runId);
  const { rows } = await assembleForRun(run);
  return reconcile(rows);
}

// ---- Publish (separate, Super-Admin-only) -----------------------------------

async function finalizeApproved(batchId: string, actorHrId: string): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from("salary_batches")
    .update({ status: "approved", approved_at: nowIso(), approved_by: actorHrId })
    .eq("id", batchId)
    .eq("status", "uploaded");
  if (error) throw error;
}

export type PublishResult = {
  run: MonthlySalaryRun;
  batchId: string;
  publishedCount: number;
  heldExcluded: number;
};

/**
 * Publish the confirmed run to payslips. Deliberate, Super-Admin-only. Held
 * employees are excluded (no payslip until released). Guards against a foreign
 * batch already claiming the month; idempotent if this run already published.
 */
export async function publishToPayslips(access: AccessContext, runId: string): Promise<PublishResult> {
  assertAutomatedPayrollPublisher(access);
  const run = await requireRun(runId);

  if (run.phase === "published" && run.publishedBatchId) {
    return { run, batchId: run.publishedBatchId, publishedCount: 0, heldExcluded: 0 };
  }
  if (run.phase !== "ready") {
    throw new Error("Conflict: confirm Part 2 before publishing to payslips.");
  }

  const { rows } = await assembleForRun(run);
  const heldExcluded = rows.filter((entry) => entry.onHold).length;
  const publishRows = rows.filter((entry) => !entry.onHold).map((entry) => entry.row);
  if (publishRows.length === 0) {
    throw new Error("Conflict: no publishable employees (all rows are held or empty).");
  }

  const ownFileName = `automated-payroll:${runId}`;
  const existing = await findSalaryBatchForPeriod(run.month, run.year);
  let batchId: string;

  if (existing) {
    if (existing.fileName !== ownFileName) {
      throw new Error(
        `Conflict: a payroll batch already exists for ${run.month}/${run.year} ("${existing.fileName}"). Resolve it in the existing payroll tools before publishing here.`,
      );
    }
    // Our own batch from a previous partial publish — finalize it.
    batchId = existing.id;
    if (existing.status === "uploaded") await finalizeApproved(batchId, actorId(access));
  } else {
    const created = await createSalaryBatch({
      records: publishRows,
      month: run.month,
      year: run.year,
      fileName: ownFileName,
      uploadedBy: actorId(access),
      validationWarnings: [],
    });
    batchId = created.batch.id;
    await finalizeApproved(batchId, actorId(access));
  }

  const updated = await updateRun(runId, {
    phase: "published",
    publishedBatchId: batchId,
    publishedAt: nowIso(),
    publishedBy: actorId(access),
  });
  await writeAutomatedPayrollAudit({
    runId,
    actorHrId: actorId(access),
    action: "published",
    detail: { batchId, publishedCount: publishRows.length, heldExcluded },
  });
  await notifyPublished(updated);

  return { run: updated, batchId, publishedCount: publishRows.length, heldExcluded };
}

// ---- Exports / per-step round-trip ------------------------------------------

/** Full or Part-1 branded sheet for the HR wizard (xlsx buffer). */
export async function buildRunSheet(
  access: AccessContext,
  runId: string,
  variant: "part1" | "full",
): Promise<{ buffer: Buffer; fileName: string }> {
  assertAutomatedPayrollHrActor(access);
  const run = await requireRun(runId);
  const { rows } = await assembleForRun(run);
  const buffer =
    variant === "part1"
      ? await buildPart1SheetWorkbook({ run, rows })
      : await buildFullSheetWorkbook({ run, rows });
  const label = monthLabel(run.month, run.year).replace(/\s+/g, "-");
  return { buffer, fileName: `Automated-Payroll-${label}-${variant}.xlsx` };
}

/** Pre-populated per-step template (xlsx buffer). */
export async function buildStepTemplate(
  access: AccessContext,
  runId: string,
  stepKey: StepKey,
): Promise<{ buffer: Buffer; fileName: string }> {
  const { run, rows } = await getStepRecommendation(access, runId, stepKey);
  const buffer = await buildStepTemplateWorkbook({ run, stepKey, rows });
  return { buffer, fileName: `Automated-Payroll-${stepKey}.xlsx` };
}

/** Re-upload a step's edited xlsx: dry-run preview (commit=false) or apply (commit=true). */
export async function importStepUpload(
  access: AccessContext,
  runId: string,
  stepKey: StepKey,
  file: File,
  commit: boolean,
): Promise<StepImportPreview | StepImportCommit> {
  assertAutomatedPayrollHrActor(access);
  const run = await requireRun(runId);
  assertStepPhaseAllowed(run, stepKey);

  const { edits, invalidHrIds } = await parseStepWorkbook({ file, stepKey });

  if (!commit) {
    const { rows: current } = await getStepRecommendation(access, runId, stepKey);
    return diffStepUpload({ stepKey, edits, current, invalidHrIds });
  }

  await saveStep(access, runId, stepKey, edits, "xlsx");
  const { rows: current } = await getStepRecommendation(access, runId, stepKey);
  const preview = diffStepUpload({ stepKey, edits, current, invalidHrIds });
  return { mode: "commit", applied: edits.length, invalid: preview.invalid, diffs: preview.diffs };
}

// ---- Finance download (finance actor) ---------------------------------------

/** Finance locked sheet for a period (CEO / Financial Advisor / Finance Manager / Super Admin). */
export async function buildFinanceSheet(
  access: AccessContext,
  period: PayrollPeriod,
  scope: "part1" | "full",
): Promise<{ buffer: Buffer; fileName: string }> {
  assertAutomatedPayrollFinanceActor(access);
  const run = (await findActiveRun(period.month, period.year)) ?? (await findLatestRun(period.month, period.year));
  if (!run) throw new Error("Not found: no Automated Payroll run for this period.");

  if (scope === "part1" && !run.part1ConfirmedAt) {
    throw new Error("Conflict: Part 1 has not been confirmed yet for this period.");
  }
  if (scope === "full" && !run.part2ConfirmedAt) {
    throw new Error("Conflict: the full sheet is not ready — Part 2 has not been confirmed yet.");
  }

  const period2: PayrollPeriod = { month: run.month, year: run.year };
  const { members, sources, draftRows } = await loadRunContext(period2, run.id);
  const rows = assembleRows({ members, sources, draftRows, period: period2 });
  const buffer = await buildFinanceSheetWorkbook({ run, rows, scope });
  const label = monthLabel(run.month, run.year).replace(/\s+/g, "-");
  return { buffer, fileName: `Automated-Payroll-${label}-${scope}-finance.xlsx` };
}

/** Which finance scopes are available for a period (drives the finance dropdown). */
export async function getFinanceAvailability(
  access: AccessContext,
  period: PayrollPeriod,
): Promise<{ hasRun: boolean; part1: boolean; full: boolean; published: boolean }> {
  assertAutomatedPayrollFinanceActor(access);
  const run = (await findActiveRun(period.month, period.year)) ?? (await findLatestRun(period.month, period.year));
  return {
    hasRun: Boolean(run),
    part1: Boolean(run?.part1ConfirmedAt),
    full: Boolean(run?.part2ConfirmedAt),
    published: Boolean(run?.publishedAt),
  };
}
