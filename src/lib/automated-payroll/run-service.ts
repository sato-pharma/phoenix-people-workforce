import type { AccessContext } from "@/lib/auth/permissions";
import { roundCurrency } from "@/lib/payroll/money";
import {
  createSalaryBatch,
  findSalaryBatchForPeriod,
} from "@/lib/payroll/service";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { assembleRows, computeFrozenFirstParts, type AssembledRow } from "./assemble.ts";
import { writeAutomatedPayrollAudit } from "./audit.ts";
import { buildFinanceSheetWorkbook } from "./exports/finance-sheet.ts";
import { buildCibSheetWorkbook, cibRowsForNonEmployees, cibRowsForScope } from "./exports/cib-sheet.ts";
import { buildFabSheetWorkbook, defaultFabValueDate, fabRowsForNonEmployees, fabRowsForScope } from "./exports/fab-sheet.ts";
import { buildFullSheetWorkbook, buildPart1SheetWorkbook, type PeriodSummary } from "./exports/sheet.ts";
import { buildStepTemplateWorkbook } from "./exports/step-template.ts";
import { diffStepUpload, parseStepWorkbook } from "./imports/step-parser.ts";
import {
  markCarryForwardApplied,
  outstandingCarryForwardFor,
  recordOverpaidCarryForward,
  releaseCarryForwardForCancelledRun,
} from "./carry-forward.ts";
import { getNonEmployeePayrollRows } from "./non-employees.ts";
import {
  diffPopulation,
  type PopulationDiff,
  type PreviousRosterEntry,
} from "./population-diff.ts";
import {
  createRun,
  findActiveRun,
  findLatestRun,
  findPublishedRun,
  getRunById,
  listDraftRows,
  listStepStates,
  updateRun,
  upsertDraftRows,
  upsertStepState,
} from "./draft-store.ts";
import { compactHrKey } from "@/lib/payroll/copilot/feeders.ts";
import { monthLabel, notifyPart1Ready, notifyPart1SubmittedForReview, notifyPart2Ready, notifyPublished } from "./notify.ts";
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
import { stepDefinition } from "./step-definitions.ts";
import type {
  DraftRow,
  DraftRowPatch,
  ManualRowCandidate,
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
  "resignationCrmDays",
  "crm",
  "manualOtherDeductions",
  "p1odCrmDays",
  "p1odCrmValue",
  "p1odVacationDays",
  "p1odVacationValue",
  "p1odNoRecordDays",
  "p1odNoRecordValue",
  "p1odLoanDays",
  "p1odLoanValue",
  "p1odOtherDays",
  "p1odOtherValue",
  "specialDeductionDays",
  "specialDeductionValue",
  "specialAdditionDays",
  "specialAdditionValue",
];

/** Maps a "text"-kind step field key to the DraftRowPatch text column it persists to. */
const TEXT_FIELDS: Record<string, keyof DraftRowPatch> = {
  p1odCrmReason: "p1odCrmReason",
  // Resignations CRM tab reuses the p1od_crm_reason column (its employees —
  // leavers — never overlap with the p1_crm tab's continuing employees), under
  // a distinct field key so each tab still owns a unique set of field keys.
  resigCrmReason: "p1odCrmReason",
  p1odVacationReason: "p1odVacationReason",
  p1odNoRecordReason: "p1odNoRecordReason",
  p1odLoanReason: "p1odLoanReason",
  p1odOtherReason: "p1odOtherReason",
  // Part 2 — the outstation expenses step's "why" column (owner request
  // 2026-08-03), the only record behind a manually added employee's amount.
  expensesNote: "expensesNote",
};

/** Maps a "select"-kind field key to its DraftRowPatch field (currently just Special Situations). */
const SELECT_FIELDS: Record<string, keyof DraftRowPatch> = {
  specialSituationPart: "specialSituationPart",
};

export type RunView = {
  run: MonthlySalaryRun;
  stepStates: StepState[];
  draftRows: DraftRow[];
};

function nowIso(): string {
  return new Date().toISOString();
}

function stepEditToPatch(stepKey: StepKey, edit: StepEditInput, isLeaverEmployee = false): DraftRowPatch {
  const patch: DraftRowPatch = { employeeHrId: edit.hrId };
  const values = edit.values ?? {};
  for (const field of NUMERIC_FIELDS) {
    const value = values[field as string];
    if (value !== undefined && Number.isFinite(Number(value))) {
      (patch as unknown as Record<string, number>)[field as string] = Number(value);
    }
  }

  // Owner request 2026-07-25: a leaver's unpaid-vacation deduction, edited in the
  // p1_unpaid_vacation tab, must land on the SAME unpaidVacations draft column the
  // Resignations step used to write — never ALSO on p1odVacationValue, which would
  // double-count via otherPart1DeductionsTotal (the exact double-deduction bug this
  // module guards against elsewhere). Remap AFTER the generic loop, deleting the
  // p1od* key so it is never persisted for a leaver.
  //
  // (The leaver CRM deduction needs no such remap: it has its own dedicated
  // p1_resignation_crm tab (owner request 2026-07-26) whose fields are keyed
  // directly to the resignationCrmDays/crm columns, so the generic loop above
  // already writes them.)
  if (isLeaverEmployee && stepKey === "p1_unpaid_vacation") {
    const generic = patch as unknown as Record<string, number | undefined>;
    if (generic.p1odVacationValue !== undefined) {
      patch.unpaidVacations = generic.p1odVacationValue;
      delete generic.p1odVacationValue;
    }
    // p1odVacationDays intentionally left as p1od* metadata for a leaver — see
    // step-definitions.ts: their real deduction is a balance-aware composite,
    // not a flat day rate, so a day count must never drive the money here.
  }

  if (stepKey === "p1_holds" || stepKey === "p2_holds") {
    if (edit.onHold !== undefined) patch.onHold = edit.onHold;
    if (edit.reason !== undefined) patch.holdReason = edit.reason;
  }
  if (stepKey === "p2_manual_deductions" && edit.reason !== undefined) {
    patch.manualReason = edit.reason;
  }
  if (edit.reasons) {
    for (const [key, field] of Object.entries(TEXT_FIELDS)) {
      const value = edit.reasons[key];
      if (value !== undefined) (patch as unknown as Record<string, string>)[field as string] = value;
    }
  }
  if (edit.selects) {
    for (const [key, field] of Object.entries(SELECT_FIELDS)) {
      const value = edit.selects[key];
      if (value !== undefined) (patch as unknown as Record<string, string>)[field as string] = value;
    }
  }
  return patch;
}

function stepRowToPatch(stepKey: StepKey, row: StepRow): DraftRowPatch {
  return stepEditToPatch(
    stepKey,
    {
      hrId: row.hrId,
      values: row.values,
      reasons: row.reasons,
      selects: row.selects,
      reason: row.reason,
      onHold: row.onHold,
    },
    row.lifecycle === "leaver",
  );
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

  // Undo this run's effect on the carry-forward ledger BEFORE marking it
  // cancelled. A run whose Part 2 was confirmed has already marked previous
  // months' overpayments as recovered — but a cancelled run pays nobody, so
  // leaving that would silently forgive real money (the exact bug the ledger
  // exists to prevent). See releaseCarryForwardForCancelledRun.
  const ledger = await releaseCarryForwardForCancelledRun(runId);

  const updated = await updateRun(runId, { phase: "cancelled" });
  await writeAutomatedPayrollAudit({
    runId,
    actorHrId: actorId(access),
    action: "run_cancelled",
    detail: { carryForwardReleased: ledger.released, carryForwardDiscarded: ledger.discarded },
  });
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

/**
 * Employees HR may still add by hand to a step: this run's payroll population
 * minus whoever the step already lists. Empty for every step that doesn't
 * declare `allowsManualRows`, so no other step can be handed a picker it has no
 * business having.
 *
 * Drawn from the SAME `members` list every step is built from, which is what
 * keeps a manually added employee a real payroll employee — never a free-text
 * name. Someone with no employee record belongs in Non-Employees Payroll.
 */
function manualRowCandidates(
  stepKey: StepKey,
  members: PopulationMember[],
  rows: StepRow[],
): ManualRowCandidate[] {
  if (!stepDefinition(stepKey).allowsManualRows) return [];
  const listed = new Set(rows.map((row) => compactHrKey(row.hrId)).filter(Boolean));
  return members
    .filter((member) => !listed.has(member.compact))
    .map((member) => ({
      hrId: member.employee.hrId,
      fullName: member.employee.fullName,
      jobTitle: member.employee.jobTitle,
      line: member.employee.lineName,
    }))
    .sort((left, right) => left.fullName.localeCompare(right.fullName));
}

export async function getStepRecommendation(
  access: AccessContext,
  runId: string,
  stepKey: StepKey,
): Promise<{
  run: MonthlySalaryRun;
  rows: StepRow[];
  state: StepState | null;
  candidates: ManualRowCandidate[];
}> {
  assertAutomatedPayrollHrActor(access);
  const run = await requireRun(runId);
  const period: PayrollPeriod = { month: run.month, year: run.year };
  const { members, sources, draftRows } = await loadRunContext(period, runId);
  const rows = await recommendStep({ access, period, stepKey, members, sources, draftRows });
  const states = await listStepStates(runId);
  return {
    run,
    rows,
    state: states.find((state) => state.stepKey === stepKey) ?? null,
    candidates: manualRowCandidates(stepKey, members, rows),
  };
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

  // Notice-period rows are display-only (see confirmStep). Drop any that reach
  // here — including via a re-uploaded xlsx, which bypasses the UI entirely.
  const { rows: currentRows, candidates } = await getStepRecommendation(access, runId, stepKey);
  const readOnlyHrIds = new Set(
    currentRows.filter((row) => row.readOnly).map((row) => row.hrId.toLowerCase()),
  );
  // For the leaver draft-column remap in stepEditToPatch — see its doc comment.
  const leaverHrIds = new Set(
    currentRows.filter((row) => row.lifecycle === "leaver").map((row) => row.hrId.toLowerCase()),
  );
  // A step that allows manual rows accepts HR_IDs it has never displayed, so
  // there is no row to validate an incoming edit against. Bound it to this run's
  // payroll population (its own rows + everyone still addable) — otherwise a
  // typo'd or invented id quietly creates a draft row for someone not on
  // payroll. Deliberately scoped to manual-row steps: every other step's write
  // set is unchanged, including the xlsx re-upload path.
  const populationHrIds = stepDefinition(stepKey).allowsManualRows
    ? new Set(
        [...currentRows.map((row) => row.hrId), ...candidates.map((candidate) => candidate.hrId)].map((hrId) =>
          hrId.toLowerCase(),
        ),
      )
    : null;
  const patches = edits
    .filter((edit) => !readOnlyHrIds.has(String(edit.hrId ?? "").toLowerCase()))
    .filter((edit) => !populationHrIds || populationHrIds.has(String(edit.hrId ?? "").toLowerCase()))
    .map((edit) => {
      const isLeaver = leaverHrIds.has(String(edit.hrId ?? "").toLowerCase());
      const patch = stepEditToPatch(stepKey, edit, isLeaver);
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

  // Informational rows never persist. A notice-period employee is shown on the
  // Resignations step so HR can see the resignation, but their settlement
  // belongs to the month they actually leave — writing anything here risks
  // stamping this month's figures onto them. Enforced server-side because the
  // client filter is a convenience, not a boundary.
  const patches = rows
    .filter((row) => !row.readOnly)
    .map((row) => {
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
  await notifyPart1SubmittedForReview(updated);
  return updated;
}

/**
 * Reopen a Part-1-confirmed run back to Part 1, so HR can correct upstream
 * data (e.g. an employee's base salary) and re-freeze accurate First Part
 * values. Clears every draft row's frozen First Part alongside the run's
 * confirmation stamp — a stale frozen value from before the correction must
 * not survive to Part 2. Step confirmations (PART1_STEP_KEYS) are left
 * intact: re-confirming recomputes straight from current source data, and
 * HR does not need to re-click through every tab to get there.
 */
export async function unconfirmPart1(access: AccessContext, runId: string): Promise<MonthlySalaryRun> {
  assertAutomatedPayrollHrActor(access);
  const run = await requireRun(runId);
  assertActiveRun(run);
  if (run.phase !== "part2") {
    throw new Error("Conflict: Part 1 is not currently confirmed.");
  }

  const draftRows = await listDraftRows(runId);
  const patches: DraftRowPatch[] = draftRows.map((row) => ({
    employeeHrId: row.employeeHrId,
    firstPartFrozen: null,
    editedBy: actorId(access),
  }));
  await upsertDraftRows(runId, patches);

  const updated = await updateRun(runId, {
    phase: "part1",
    part1ConfirmedAt: null,
    part1ConfirmedBy: null,
  });
  await writeAutomatedPayrollAudit({
    runId,
    actorHrId: actorId(access),
    action: "part1_unconfirmed",
    detail: { unfrozenEmployees: patches.length },
  });
  return updated;
}

/** Confirm Part 2: assemble the full sheet, run the pre-flight gate, notify. */
export async function confirmPart2(
  access: AccessContext,
  runId: string,
  options: { acknowledgeOverpaid?: boolean } = {},
): Promise<MonthlySalaryRun> {
  const acknowledgeOverpaid = options.acknowledgeOverpaid === true;
  assertAutomatedPayrollHrActor(access);
  const run = await requireRun(runId);
  assertActiveRun(run);
  if (run.phase !== "part2") {
    throw new Error("Conflict: confirm Part 1 before Part 2 (or Part 2 is already confirmed).");
  }

  const states = await listStepStates(runId);
  assertAllStepsConfirmed(states, PART2_STEP_KEYS);

  const { rows, carryForwardByCompact } = await assembleForRun(run);
  const { preflightValidate } = await import("./validate.ts");
  const preflight = preflightValidate(rows);
  if (!preflight.ok) {
    const sample = preflight.issues.slice(0, 6).map((issue) => `${issue.hrId ?? "?"}: ${issue.message}`);
    throw new Error(`Validation: fix ${preflight.errorCount} issue(s) before confirming Part 2. ${sample.join("; ")}`);
  }

  // The accuracy nets ENFORCE here — before this they were advisory, computed by
  // reconcile() and shown only if HR happened to click the Reconcile button
  // (audit finding 2026-07-25). Part 2 confirm is the last gate before the sheet
  // becomes the payable truth, so both checks run unconditionally.
  const totals = reconcile(rows);

  // A split mismatch can ONLY mean a code bug (reconcile's own doc comment says
  // this list "must always be empty"). Never acknowledgeable — hard block.
  if (totals.splitMismatches.length > 0) {
    const sample = totals.splitMismatches
      .slice(0, 5)
      .map((row) => `${row.hrId}: ${row.firstPart} + ${row.secondPart} != ${row.monthSalary}`);
    throw new Error(
      `Conflict: ${totals.splitMismatches.length} row(s) have First Part + Second Part != Month Salary. ` +
        `This indicates a calculation bug, not a data-entry problem — do not confirm; report it. ${sample.join("; ")}`,
    );
  }

  // Overpaid rows are real money the company paid out in Part 1 that this
  // month's total can no longer absorb. HR must consciously accept them rather
  // than discover them later in a report.
  if (totals.overpaid.length > 0 && !acknowledgeOverpaid) {
    const totalResidual = roundCurrency(totals.overpaid.reduce((sum, row) => sum + row.residual, 0));
    const sample = totals.overpaid.slice(0, 5).map((row) => `${row.hrId}: ${row.residual}`);
    throw new Error(
      `Conflict: ${OVERPAID_ACK_REQUIRED} ${totals.overpaid.length} employee(s) were overpaid in Part 1 by a ` +
        `total of ${totalResidual} (Part 2 deductions exceeded their already-paid first installment). ` +
        `Acknowledge to confirm and carry these balances forward to next month. ${sample.join("; ")}`,
    );
  }

  // ---- carry-forward ledger settlement (owner decision 2026-07-25) ----------
  // Order matters. First close out what this run RECOVERED (those balances were
  // already deducted in `rows` above, so they are genuinely settled), then
  // record what this run newly OVERPAID. Doing it in this order means a run
  // that both recovers an old debt and creates a new one leaves the ledger in
  // the right state instead of immediately re-consuming its own fresh entry.
  const recoveredCompacts = Array.from(carryForwardByCompact.keys()).filter(
    (compact) => (carryForwardByCompact.get(compact) ?? 0) > 0,
  );
  const carryForwardRecovered = await markCarryForwardApplied({ runId, appliedCompacts: recoveredCompacts });
  const carryForwardRecorded = await recordOverpaidCarryForward({
    runId,
    rows,
    actorHrId: actorId(access),
  });

  const updated = await updateRun(runId, {
    phase: "ready",
    part2ConfirmedAt: nowIso(),
    part2ConfirmedBy: actorId(access),
  });
  await writeAutomatedPayrollAudit({
    runId,
    actorHrId: actorId(access),
    action: "part2_confirmed",
    detail: {
      employees: rows.length,
      // Record WHAT was accepted, not just that someone clicked twice — an
      // overpayment acknowledgment is a money decision and must be auditable.
      overpaidAcknowledged: totals.overpaid.length,
      overpaidTotal: roundCurrency(totals.overpaid.reduce((sum, row) => sum + row.residual, 0)),
      carryForwardRecovered,
      carryForwardRecorded,
    },
  });
  await notifyPart2Ready(updated);
  return updated;
}

// ---- Assembly / reconciliation ----------------------------------------------

async function assembleForRun(run: MonthlySalaryRun): Promise<{
  rows: AssembledRow[];
  members: PopulationMember[];
  carryForwardByCompact: Map<string, number>;
}> {
  const period: PayrollPeriod = { month: run.month, year: run.year };
  const [{ members, sources, draftRows }, carryForwardByCompact] = await Promise.all([
    loadRunContext(period, run.id),
    // Overpayments from PREVIOUS runs that this run recovers (owner rule
    // 2026-07-25). Loaded on every assemble so the figure HR reviews, the
    // figure on the sheet, and the figure that gets published are the same one.
    outstandingCarryForwardFor(run.id),
  ]);
  const rows = assembleRows({ members, sources, draftRows, period, carryForwardByCompact });
  return { rows, members, carryForwardByCompact };
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

/**
 * Last month's roster, for the population diff. Read from the previous month's
 * PUBLISHED salary records (the durable truth about who actually got paid)
 * rather than re-deriving the population, so the comparison can't be skewed by
 * the very population bug it exists to detect.
 */
async function previousMonthRoster(period: PayrollPeriod): Promise<PreviousRosterEntry[]> {
  if (isAtOrBeforeLaunch(period)) return [];
  const prev = previousPeriod(period);
  const prevRun = await findPublishedRun(prev.month, prev.year);
  if (!prevRun?.publishedBatchId) return [];
  const { data, error } = await getSupabaseAdmin()
    .from("salary_records")
    .select("hr_id,full_name")
    .eq("batch_id", prevRun.publishedBatchId);
  if (error) throw error;

  // Anyone whose resignation had already taken effect by the end of last month
  // is legitimately absent now — that is "left", not "disappeared".
  const { end } = periodBoundsFor(prev);
  const { data: leavers } = await getSupabaseAdmin()
    .from("employee_resignations")
    .select("employee_hr_id")
    .lte("last_working_date", end);
  const leaverCompacts = new Set(
    ((leavers ?? []) as Array<{ employee_hr_id: string | null }>)
      .map((row) => compactHrKey(row.employee_hr_id ?? ""))
      .filter(Boolean),
  );

  return ((data ?? []) as Array<{ hr_id: string | null; full_name: string | null }>)
    .map((row) => {
      const hrId = row.hr_id ?? "";
      const compact = compactHrKey(hrId);
      return { hrId, compact, fullName: row.full_name ?? hrId, wasLeaver: leaverCompacts.has(compact) };
    })
    .filter((entry) => entry.compact);
}

function periodBoundsFor(period: PayrollPeriod): { start: string; end: string } {
  const pad = (value: number) => String(value).padStart(2, "0");
  const lastDay = new Date(Date.UTC(period.year, period.month, 0)).getUTCDate();
  return {
    start: `${period.year}-${pad(period.month)}-01`,
    end: `${period.year}-${pad(period.month)}-${pad(lastDay)}`,
  };
}

/**
 * Who joined, left, or unexpectedly vanished vs. last month. `disappeared`
 * should always be empty — anything in it means someone silently fell out of
 * payroll (see population-diff.ts for the real incident this guards).
 */
export async function getPopulationDiff(access: AccessContext, runId: string): Promise<PopulationDiff> {
  assertAutomatedPayrollHrActor(access);
  const run = await requireRun(runId);
  const period: PayrollPeriod = { month: run.month, year: run.year };
  const [{ members }, previous] = await Promise.all([
    assembleForRun(run),
    previousMonthRoster(period),
  ]);
  return diffPopulation({ current: members, previous });
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

/** Previous calendar month for a period (handles the January → December/year-1 rollover). */
function previousPeriod(period: PayrollPeriod): PayrollPeriod {
  return period.month === 1 ? { month: 12, year: period.year - 1 } : { month: period.month - 1, year: period.year };
}

/**
 * Automated Payroll's first live month (owner rule 2026-07-25: "treat july as
 * a fresh [start], starting from august compare"). No month-over-month
 * comparison — Executive Summary or the per-employee Salary Changes tab — is
 * ever shown for this period or earlier, regardless of whether some prior
 * published run happens to exist (e.g. leftover test/legacy data): this is an
 * explicit design boundary, not an incidental side effect of missing data.
 */
/**
 * Stable marker embedded in the Part-2 overpayment-gate error so the API route
 * can tell "HR must acknowledge this" apart from any other Conflict, without
 * fragile matching on the human-readable sentence around it.
 */
export const OVERPAID_ACK_REQUIRED = "[overpaid-acknowledgment-required]";

export const AUTOMATED_PAYROLL_LAUNCH_PERIOD: PayrollPeriod = { month: 7, year: 2026 };

export function isAtOrBeforeLaunch(period: PayrollPeriod): boolean {
  return (
    period.year < AUTOMATED_PAYROLL_LAUNCH_PERIOD.year ||
    (period.year === AUTOMATED_PAYROLL_LAUNCH_PERIOD.year && period.month <= AUTOMATED_PAYROLL_LAUNCH_PERIOD.month)
  );
}

/**
 * Headcount + total payout for the previous month's published run — the
 * Executive Summary Dashboard's comparison baseline (owner request 2026-07-25:
 * "must have comparison between the last month in number of employees and
 * value of money"). Null if the prior month was never published (first-ever
 * run) or if `period` is at/before the launch month. `valueField` picks which
 * money column to sum: First Part for the Part 1 sheet, Month Salary for the
 * full sheet — matching whichever figure that sheet variant actually pays out.
 */
async function previousMonthSummary(
  period: PayrollPeriod,
  valueField: "first_part" | "month_salary",
): Promise<PeriodSummary | null> {
  if (isAtOrBeforeLaunch(period)) return null;
  const prevRun = await findPublishedRun(previousPeriod(period).month, previousPeriod(period).year);
  if (!prevRun?.publishedBatchId) return null;
  const { data, error } = await getSupabaseAdmin()
    .from("salary_records")
    .select(valueField)
    .eq("batch_id", prevRun.publishedBatchId);
  if (error) throw error;
  const rows = (data ?? []) as Array<Record<string, number | null>>;
  return {
    headcount: rows.length,
    totalValue: Math.round(rows.reduce((sum, row) => sum + Number(row[valueField] ?? 0), 0) * 100) / 100,
  };
}

/** Net Salary per employee (keyed by compact HR id) from the previous month's published run, for the Salary Changes tab. Empty map if none, or if `period` is at/before the launch month. */
async function previousMonthNetSalaryByHrIdCompact(period: PayrollPeriod): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (isAtOrBeforeLaunch(period)) return map;
  const prevRun = await findPublishedRun(previousPeriod(period).month, previousPeriod(period).year);
  if (!prevRun?.publishedBatchId) return map;
  const { data, error } = await getSupabaseAdmin()
    .from("salary_records")
    .select("hr_id,net_salary")
    .eq("batch_id", prevRun.publishedBatchId);
  if (error) throw error;
  for (const row of (data ?? []) as Array<{ hr_id: string | null; net_salary: number | null }>) {
    const compact = compactHrKey(row.hr_id ?? "");
    if (!compact) continue;
    map.set(compact, Number(row.net_salary ?? 0));
  }
  return map;
}

/** Full or Part-1 branded sheet for the HR wizard (xlsx buffer). */
export async function buildRunSheet(
  access: AccessContext,
  runId: string,
  variant: "part1" | "full",
): Promise<{ buffer: Buffer; fileName: string }> {
  assertAutomatedPayrollHrActor(access);
  const run = await requireRun(runId);
  const { rows } = await assembleForRun(run);
  const period: PayrollPeriod = { month: run.month, year: run.year };
  const buffer =
    variant === "part1"
      ? await buildPart1SheetWorkbook({
          run,
          rows,
          previousNetByHrIdCompact: await previousMonthNetSalaryByHrIdCompact(period),
          // First-installment entries only: the Part 1 sheet is what finance
          // executes for Part 1, and a Part 2 non-employee is not paid then.
          nonEmployees: await getNonEmployeePayrollRows(runId, "first"),
          previousSummary: await previousMonthSummary(period, "first_part"),
        })
      : await buildFullSheetWorkbook({
          run,
          rows,
          previousSummary: await previousMonthSummary(period, "month_salary"),
          // BOTH parts: the full sheet is the month's complete picture, and
          // their amount lands under Month Salary either way.
          nonEmployees: await getNonEmployeePayrollRows(runId),
        });
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
  const buffer = await buildFinanceSheetWorkbook({
    run,
    rows,
    scope,
    // Mirrors buildRunSheet exactly: the Part 1 scope pays first-installment
    // entries, the full scope shows the month's whole picture.
    nonEmployees: await getNonEmployeePayrollRows(run.id, scope === "part1" ? "first" : undefined),
  });
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

/**
 * Live-computed rows for a period's active/latest run — for preview/review
 * tooling only. Unlike buildFabSheet/buildFinanceSheet, this does NOT gate on
 * part1ConfirmedAt/part2ConfirmedAt, so it reflects whatever the run's
 * figures are RIGHT NOW, which can still change before the real confirm.
 */
export async function previewAssembledRowsForPeriod(
  access: AccessContext,
  period: PayrollPeriod,
): Promise<AssembledRow[]> {
  assertAutomatedPayrollFinanceActor(access);
  const run = (await findActiveRun(period.month, period.year)) ?? (await findLatestRun(period.month, period.year));
  if (!run) throw new Error("Not found: no Automated Payroll run for this period.");
  const { rows } = await assembleForRun(run);
  return rows;
}

/**
 * FAB (First Abu Dhabi Bank) bulk salary-transfer file — the literal bank-
 * execution format (see exports/fab-sheet.ts doc comment), scoped to the
 * FAB-bank employees actually owed money in that part. Gated the same way as
 * the finance sheet: Part 1 requires Part 1 confirmed, Part 2 requires Part 2
 * confirmed. `valueDateIso` overrides the default (the 25th of the run's
 * month); validated by the API route before reaching here.
 */
export async function buildFabSheet(
  access: AccessContext,
  period: PayrollPeriod,
  scope: "part1" | "part2",
  valueDateIso?: string,
): Promise<{ buffer: Buffer; fileName: string }> {
  assertAutomatedPayrollFinanceActor(access);
  const run = (await findActiveRun(period.month, period.year)) ?? (await findLatestRun(period.month, period.year));
  if (!run) throw new Error("Not found: no Automated Payroll run for this period.");

  if (scope === "part1" && !run.part1ConfirmedAt) {
    throw new Error("Conflict: Part 1 has not been confirmed yet for this period.");
  }
  if (scope === "part2" && !run.part2ConfirmedAt) {
    throw new Error("Conflict: the Part 2 sheet is not ready — Part 2 has not been confirmed yet.");
  }

  const period2: PayrollPeriod = { month: run.month, year: run.year };
  const { members, sources, draftRows } = await loadRunContext(period2, run.id);
  const rows = assembleRows({ members, sources, draftRows, period: period2 });
  // Non-Employees Payroll (people paid a monthly salary with no HR_ID record)
  // is a separate data source from AssembledRow — fabRowsForScope never sees
  // them, so they'd silently be missing from the real bank file without this
  // (owner-reported 2026-07-26). Which scope carries an entry is its own `part`
  // (owner request 2026-08-03) — fabRowsForNonEmployees does that filtering.
  const fabRows = [
    ...fabRowsForScope(rows, scope),
    ...fabRowsForNonEmployees(await getNonEmployeePayrollRows(run.id), scope),
  ];
  if (fabRows.length === 0) {
    throw new Error("Conflict: no FAB-bank employees with a payable amount for this part.");
  }

  const valueDate = valueDateIso ? new Date(`${valueDateIso}T00:00:00Z`) : defaultFabValueDate(period2);
  const buffer = await buildFabSheetWorkbook({ rows: fabRows, valueDate });
  const label = monthLabel(run.month, run.year).replace(/\s+/g, "-");
  return { buffer, fileName: `FAB-Salary-Transfer-${label}-${scope}.xlsx` };
}

/**
 * CIB (Commercial International Bank) bulk-credit file — the literal bank-
 * execution format (see exports/cib-sheet.ts doc comment), scoped to the
 * CIB-bank employees actually owed money in that part. Same gating as
 * buildFabSheet: Part 1 requires Part 1 confirmed, Part 2 requires Part 2
 * confirmed.
 */
export async function buildCibSheet(
  access: AccessContext,
  period: PayrollPeriod,
  scope: "part1" | "part2",
): Promise<{ buffer: Buffer; fileName: string }> {
  assertAutomatedPayrollFinanceActor(access);
  const run = (await findActiveRun(period.month, period.year)) ?? (await findLatestRun(period.month, period.year));
  if (!run) throw new Error("Not found: no Automated Payroll run for this period.");

  if (scope === "part1" && !run.part1ConfirmedAt) {
    throw new Error("Conflict: Part 1 has not been confirmed yet for this period.");
  }
  if (scope === "part2" && !run.part2ConfirmedAt) {
    throw new Error("Conflict: the Part 2 sheet is not ready — Part 2 has not been confirmed yet.");
  }

  const period2: PayrollPeriod = { month: run.month, year: run.year };
  const { members, sources, draftRows } = await loadRunContext(period2, run.id);
  const rows = assembleRows({ members, sources, draftRows, period: period2 });
  // See buildFabSheet's own comment: Non-Employees Payroll is a separate data
  // source that cibRowsForScope never sees on its own.
  const cibRows = [
    ...cibRowsForScope(rows, scope),
    ...cibRowsForNonEmployees(await getNonEmployeePayrollRows(run.id), scope),
  ];
  if (cibRows.length === 0) {
    throw new Error("Conflict: no CIB-bank employees with a payable amount for this part.");
  }

  const buffer = await buildCibSheetWorkbook({ rows: cibRows });
  const label = monthLabel(run.month, run.year).replace(/\s+/g, "-");
  return { buffer, fileName: `CIB-Salary-Transfer-${label}-${scope}.xlsx` };
}
