import type { AccessContext } from "@/lib/auth/permissions";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { logError } from "@/lib/observability/log";
import { runRetentionRiskPrePayrollNotice } from "@/lib/retention-risk/notify";
import { roundCurrency } from "@/lib/payroll/money";
import { calendarDaysInMonth } from "@/lib/payroll/copilot/proration";
import {
  compareSalaryBatchRecords,
  createSalaryBatch,
  findSalaryBatchForPeriod,
  isReplaceableSalaryBatch,
  replaceSalaryBatch,
} from "@/lib/payroll/service";
import { getStatutoryConfigForPeriod } from "@/lib/payroll/statutory/config";
import { loadInsuranceWages, loadNotCompanyInsured } from "@/lib/payroll/statutory/insurance-wages.ts";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { assembleRows, computePart1Freeze, type AssembledRow } from "./assemble.ts";
import { writeAutomatedPayrollAudit, writeRequiredAutomatedPayrollAudit } from "./audit.ts";
import {
  assertCancelAllowedAfterDownloads,
  listBankFileDownloads,
  recordBankFileDownloaded,
} from "./bank-file-downloads.ts";
import { holdRun } from "./run-hold.ts";
import {
  landQueuedPayrollResyncsForPeriod,
  maybeDrainPayrollResyncOutbox,
  type ParkedPayrollResync,
  queuedPayrollResyncsForPeriod,
} from "./resync-outbox.ts";
import { recordPaidExpenseStamp } from "./expense-stamp.ts";
import { buildFinanceSheetWorkbook } from "./exports/finance-sheet.ts";
import { buildCibSheetWorkbook, cibRowsForNonEmployees, cibRowsForScope } from "./exports/cib-sheet.ts";
import { buildFabSheetWorkbook, defaultFabValueDate, fabRowsForNonEmployees, fabRowsForScope } from "./exports/fab-sheet.ts";
import { buildFullSheetWorkbook, buildPart1SheetWorkbook, type PeriodSummary } from "./exports/sheet.ts";
import { buildStepTemplateWorkbook } from "./exports/step-template.ts";
import { diffStepUpload, parseStepWorkbook } from "./imports/step-parser.ts";
import { applyDayDrivenMoney } from "./imports/day-driven-money.ts";
import {
  additionsCandidatesFromStepRows,
  assertAdditionsReasonsPresent,
} from "./additions-reason.ts";
import { assertHoldReasonsPresent, holdCandidatesFromStepRows } from "./hold-reason.ts";
import { buildHoldReview, type HoldReview } from "./hold-review.ts";
import { exclusionRefusal } from "./exclusion-guard.ts";
import {
  assertNoTransitionInProgress,
  describeTransitionRefusal,
  isRunHoldAction,
  RUN_HOLD_ACTIONS,
  TRANSITION_CLAIM_LOST,
  transitionInProgress,
} from "./transition-claim.ts";
import { assertNoNegativeStepValues } from "./negative-values.ts";
import {
  describePayrollDayCollisions,
  detectPayrollDayCollisions,
  type PayrollDayCollision,
} from "./day-collisions.ts";
import { loadConfirmedDeductions } from "./deductions-source.ts";
import { notifyPayslipAvailable } from "@/lib/payroll/notify-payslip-available";
import {
  assertMatchesPart2Confirm,
  assertPart2FileMatchesStamp,
  compareConfirmedTotals,
  compareBankDetails,
  confirmedBeforeStampExisted,
  PART2_BANK_DETAILS_KEY,
  PART2_TOTALS_KEY,
  part2BankDetails,
  part2Totals,
  readConfirmedBankDetails,
  readConfirmedTotals,
  type BankDetailsStamp,
  type ConfirmedTotals,
} from "./publish-guard.ts";
import {
  describePartSplitConflicts,
  findPartSplitConflicts,
} from "./part-split-conflict.ts";
import {
  chargedFiguresFromDrafts,
  chargeSourceKind,
  detectModuleDrift,
  describeModuleDriftBlock,
  draftColumnForField,
  mergeModuleDrift,
  MODULE_SOURCED_STEP_KEYS,
  RECOMMENDED_AT_CONFIRM_KEY,
  snapshotFromSummary,
  snapshotRecommendations,
  takeCurrentModuleFigures,
  type ModuleDriftReport,
} from "./module-drift.ts";
import { describeReopenedPart1Block, reopenedPart1DeductionSteps } from "./module-sourced-steps.ts";
import { figureGroups, untouchedFigureFields, type FigureWrite } from "./saved-figures.ts";
import {
  carryForwardForRunAssembly,
  markCarryForwardApplied,
  outstandingCarryForwardFor,
  recordOverpaidCarryForward,
  releaseCarryForwardForCancelledRun,
} from "./carry-forward.ts";
import { buildBankCoverage, describeBankCoverage, type BankCoverage } from "./exports/bank-coverage.ts";
import {
  getHeldSettlements,
  loadHeldBalances,
  monthKeyAfter,
  outstandingHeldByEmployee,
  part1CorrectionsForRun,
  enteredHeldAddedInRun,
  loadEnteredHeld,
  previousPublishedRun,
  frozenPart1ForRun,
  recordHeldReleases,
  recordPart1Corrections,
} from "./held-settlements.ts";
import { getNonEmployeePayrollRows } from "./non-employees.ts";
import { seedRunFromRecurring } from "./non-employee-recurring.ts";
import { heldDraftHrIds, readPublishedHoldRecord } from "./published-holds.ts";
import {
  auditPayrollDataQuality,
  describePayrollDataQuality,
  payAffectingIssues,
  type PayrollDataQualityReport,
} from "./data-quality.ts";
import {
  describeUnexplainedDisappearances,
  diffPopulation,
  unexplainedDisappearances,
  type PopulationDiff,
  type PreviousRosterEntry,
} from "./population-diff.ts";
import {
  claimRunTransition,
  createRun,
  findActiveRun,
  releaseRunTransition,
  findLatestRun,
  findPublishedRun,
  getRunById,
  listDraftCellHistory,
  listDraftRows,
  listLatestCellWrites,
  listStepStates,
  updateRun,
  upsertDraftRows,
  upsertStepState,
} from "./draft-store.ts";
import {
  acknowledgmentTokenAnswers,
  issueAcknowledgmentToken,
  PayrollAcknowledgmentRequiredError,
  type AcknowledgmentGate,
} from "./acknowledgment-token.ts";
import { compactHrKey } from "@/lib/payroll/copilot/feeders.ts";
import { monthLabel, notifyPart1Ready, notifyPart1SubmittedForReview, notifyPart2Ready, notifyPublished } from "./notify.ts";
import {
  actorId,
  assertAutomatedPayrollFinanceActor,
  assertAutomatedPayrollHrActor,
  assertAutomatedPayrollPublisher,
} from "./permissions.ts";
import { assertRealSessionForDecision } from "@/lib/auth/preview-session-guard";
import {
  filterExcludedMembers,
  isSettledInPart1,
  loadStepContext,
  recommendStep,
  releaseOnlyMembersFor,
  type PopulationMember,
} from "./recommend.ts";
import { lookupSource } from "@/lib/payroll/copilot/assemble.ts";
import { reconcile } from "./reconcile.ts";
import type { PayrollSalarySource } from "@/lib/payroll/salary-source.ts";
import { stepDefinition } from "./step-definitions.ts";
import type {
  DraftRow,
  DraftCellChange,
  DraftRowPatch,
  ManualRowCandidate,
  MonthlySalaryRun,
  PayrollPeriod,
  ReconciliationTotals,
  RunPhase,
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
  // The Resignations step's Days Worked. A real persisted column since
  // 2026-08-30 so every leaver tab reads ONE confirmed figure — see
  // DraftRow.daysWorked and leaver-basis.ts for what it replaced.
  "daysWorked",
  "baseForMonth",
  "ecolPaid",
  "fuelPaid",
  "fingerprintDays",
  "fingerprintValue",
  "expenses",
  "incentive",
  "bonus",
  "overtime",
  "otherAdditions",
  "heldReleaseValue",
  "payDeferralValue",
  // Part 1's Held Salary Release and Defer Pay (owner, 2026-10-26: "it should be also in part one").
  "heldReleaseP1Value",
  "payDeferralP1Value",
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
  // Defer Pay: when the deferred amount falls due ("next" | "after_next"), checked in assertPayDeferralEdits.
  payDeferralMonth: "payDeferralMonth",
  payDeferralP1Month: "payDeferralP1Month",
};

export type RunView = {
  run: MonthlySalaryRun;
  stepStates: StepState[];
  draftRows: DraftRow[];
  /**
   * Who is excluded from this run, BY NAME (audit finding 54). A draft row carries only the HR
   * code, so the panel listing exclusions printed `B-7` at the person it was asking HR to decide
   * about — against the standing rule that a screen shows names, never codes.
   */
  excludedPeople: Array<{ hrId: string; fullName: string; reason: string | null }>;
  /**
   * Deduction and expense decisions parked while the run was busy, that have NOT reached its figures
   * yet (resync-outbox.ts). Null when the queue could not be read — said on screen, never shown as
   * none. After Part 2 is confirmed they stay parked until Part 2 is reopened.
   */
  parkedResyncs: ParkedPayrollResync[] | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

/** Exported for tests/deduction-open-step-saved-figure.test.ts (the vacation columns' remap). */
export function stepEditToPatch(stepKey: StepKey, edit: StepEditInput, isLeaverEmployee = false): DraftRowPatch {
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
  // module guards against elsewhere). Remap AFTER the generic loop.
  //
  // The column NOT used is CLEARED on purpose, never just left out. Everyone on this
  // step is settled in Part 1 (p2_vacation skips them), so for them the two columns are
  // one figure in two places: a leaver's lives on unpaidVacations, anyone else's on
  // p1odVacationValue. An employee who becomes a leaver after the step was confirmed
  // (or stops being one) still carries the old column, and assemble.ts would deduct
  // both. Leaving it out used to clear it only by accident — one bulk write NULL-filled
  // every column another row named — and upsertDraftRows now writes one column set per
  // request, so it must be said (risk review, 2026-10-07).
  //
  // (The leaver CRM deduction needs no such remap: it has its own dedicated
  // p1_resignation_crm tab (owner request 2026-07-26) whose fields are keyed
  // directly to the resignationCrmDays/crm columns, so the generic loop above
  // already writes them.)
  if (stepKey === "p1_unpaid_vacation" && patch.p1odVacationValue !== undefined) {
    if (isLeaverEmployee) {
      patch.unpaidVacations = patch.p1odVacationValue;
      patch.p1odVacationValue = null;
    } else {
      patch.unpaidVacations = null;
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
  // Its OWN column, never manual_reason: one shared field would let a deduction's reason read as
  // an addition's, and nothing downstream could tell which decision the sentence describes.
  if (stepKey === "p2_additions" && edit.reason !== undefined) {
    patch.additionsReason = edit.reason;
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

/**
 * The proposal a save is judged against: the one the person's screen showed, where it sent one, else
 * the server's own. The screen's wins because a grid left open across a decision still shows the old
 * proposal, and judging its untouched figure against the new one would call it typed.
 */
function proposalShown(server: Record<string, number> | undefined, shown: unknown): Record<string, number> {
  const proposal: Record<string, number> = { ...(server ?? {}) };
  if (shown && typeof shown === "object" && !Array.isArray(shown)) {
    for (const [field, value] of Object.entries(shown as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) proposal[field] = value;
    }
  }
  return proposal;
}

/**
 * One employee's figures on a deduction step, keyed by draft field, beside what was proposed for each
 * and what the draft held — what saved-figures.ts judges a save by.
 *
 * The proposal goes through the SAME mapping as the figures (stepEditToPatch), so a leaver's vacation,
 * remapped onto `unpaid_vacations`, is compared with its own proposal rather than with nothing.
 */
function figureWriteFor(
  stepKey: StepKey,
  patch: DraftRowPatch,
  proposal: Record<string, number>,
  shownNow: Record<string, number> | undefined,
  isLeaver: boolean,
  draft: DraftRow | undefined,
): FigureWrite {
  const proposedPatch = stepEditToPatch(stepKey, { hrId: patch.employeeHrId, values: proposal }, isLeaver);
  const shownPatch = stepEditToPatch(stepKey, { hrId: patch.employeeHrId, values: shownNow ?? {} }, isLeaver);
  const figures = patch as unknown as Record<string, unknown>;
  const proposals = proposedPatch as unknown as Record<string, unknown>;
  const shownFigures = shownPatch as unknown as Record<string, unknown>;
  const held = (draft ?? {}) as unknown as Record<string, unknown>;
  const asFigure = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const write: FigureWrite = {
    compact: compactHrKey(patch.employeeHrId),
    written: {},
    proposed: {},
    before: {},
    shown: {},
  };
  for (const field of NUMERIC_FIELDS as string[]) {
    if (!(field in figures)) continue;
    write.written[field] = asFigure(figures[field]);
    const proposed = asFigure(proposals[field]);
    if (proposed !== null) write.proposed[field] = proposed;
    const shown = asFigure(shownFigures[field]);
    if (shown !== null) write.shown![field] = shown;
    write.before[field] = asFigure(held[field]);
  }
  return write;
}

/** Leave these figures exactly as the draft holds them — a save carrying nobody's change writes none. */
function stripFigures(patch: DraftRowPatch, fields: readonly string[]): void {
  const figures = patch as unknown as Record<string, unknown>;
  for (const field of fields) delete figures[field];
}

/** Whether a patch still writes any figure (the save's audit row counts these). */
function writesAFigure(patch: DraftRowPatch): boolean {
  return (NUMERIC_FIELDS as string[]).some((field) => field in (patch as unknown as Record<string, unknown>));
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

/**
 * ONE TRANSITION AT A TIME (audit finding 50).
 *
 * Every phase change read the run, checked the phase here in code, did seconds of work, then wrote the
 * new phase with no condition. Two overlapping requests both passed and the later writer won: a cancel
 * landing while Part 2 confirm was still running was overwritten back to `ready`, publishable again,
 * with the carry-forward ledger recorded against a run that had been cancelled.
 *
 * So a transition claims the run before its FIRST WRITE, in one statement that also re-checks the phase
 * (phx_claim_automated_payroll_run_transition). Its writes and its phase write run under the claim; the
 * phase write is conditioned on it and clears it; a failure part-way releases it; a claim left by a
 * request that died lapses after 15 minutes. Step saves are refused while it is held.
 *
 * The read-only gates run BEFORE the claim on purpose: a validation refusal, the common failure, never
 * holds the run, and a phase that moved underneath them is caught by the claim itself.
 */
async function claimTransition(runId: string, expected: RunPhase[], action: string): Promise<string> {
  // A short hold (a save, a resync — run-hold.ts) is waited out rather than refused: it lets go within
  // a second or two, and refusing a confirm over it would only make HR click again.
  const deadline = Date.now() + 15_000;
  for (;;) {
    const token = await claimRunTransition(runId, expected, action);
    if (token) return token;
    const current = await getRunById(runId);
    // Worth another try: a short hold, or a holder that let go between the claim and this read (the
    // refusal would otherwise read "this run is now in Part 2, not in Part 2").
    const worthRetrying = Boolean(
      current &&
        expected.includes(current.phase) &&
        (isRunHoldAction(current.transitionAction) || !transitionInProgress(current)),
    );
    if (!worthRetrying || Date.now() >= deadline) {
      throw new Error(describeTransitionRefusal(current, expected));
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Run a transition's writes under its claim, letting the claim go if they fail part-way. */
async function whileClaimed<T>(runId: string, token: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    await releaseRunTransition(runId, token).catch((releaseError: unknown) => {
      logError("Automated payroll: could not release a run transition after it failed", {
        labels: { event: "automated_payroll_transition_release_failed", runId },
        error: releaseError,
      });
    });
    throw error;
  }
}

// ---- Run lifecycle ----------------------------------------------------------

/** Start a new run for a period, or resume the active one. */
export async function startOrResumeRun(
  access: AccessContext,
  period: PayrollPeriod,
): Promise<MonthlySalaryRun> {
  assertRealSessionForDecision(access, "start or resume a payroll run");
  assertAutomatedPayrollHrActor(access);

  const existing = await findActiveRun(period.month, period.year);
  if (existing) return existing;

  // A MONTH THAT IS ALREADY PUBLISHED IS FINISHED. `findActiveRun` only sees part1/part2/ready, and
  // the database's one-run-per-month index deliberately excludes published and cancelled runs — so
  // without this, pressing Start on a paid month silently creates a SECOND run for it.
  //
  // That is not hypothetical. On 2026-09-10 a second August run was created this way on production,
  // ninety seconds after which two steps had been confirmed against it. It becomes the run every
  // finance screen answers with, so the PAID month's sheet and bank files stop being reachable;
  // confirming its Part 1 would emit a real bank transfer file for a month already paid, and
  // confirming its Part 2 would mark previous months' genuine debts recovered.
  //
  // Refused here rather than at publish, which is where the collision used to surface — a month of
  // work later, and only if someone got that far.
  const published = await findPublishedRun(period.month, period.year);
  if (published) {
    throw new Error(
      `Conflict: ${period.month}/${period.year} has already been published (run ${published.id}). ` +
        "A published month is finished — starting another run for it would create a second, shadow run " +
        "that every finance screen would answer with instead of the paid one.",
    );
  }

  // Mutual exclusion: do not start while a Payroll Copilot run is active for the
  // same period (both write the shared expense/vacation decision tables).
  //
  // FAILS CLOSED (audit finding 49). The read's error used to be discarded, so a read that failed
  // came back as "no Copilot run" and the guard passed: both engines then write the same decision
  // tables for the same month, the double-write this check exists to stop, with nothing recording
  // that the check never ran. Not being able to look is not the same as finding nothing.
  const { data: copilotRuns, error: copilotRunsError } = await getSupabaseAdmin()
    .from("payroll_copilot_runs")
    .select("id,status")
    .eq("month", period.month)
    .eq("year", period.year)
    .in("status", ["assembling", "negotiating", "drafted"])
    .limit(1);
  if (copilotRunsError) {
    logError("Automated payroll: could not check for an active Payroll Copilot run", {
      labels: { event: "automated_payroll_copilot_exclusion_read_failed", month: String(period.month), year: String(period.year) },
      error: copilotRunsError,
    });
    throw new Error(
      "Conflict: could not confirm that no Payroll Copilot run is active for this month, so nothing was started. Try again in a moment.",
    );
  }
  if (copilotRuns && copilotRuns.length > 0) {
    throw new Error(
      "Conflict: a Payroll Copilot run is active for this month. Cancel it before using Automated Payroll (they share deduction/expense decisions).",
    );
  }

  const run = await createRun({ month: period.month, year: period.year, createdBy: actorId(access) });
  await writeAutomatedPayrollAudit({ runId: run.id, actorHrId: actorId(access), action: "run_started" });

  // Copy the standing Non-Employees Payroll roster in (owner request 2026-08-30:
  // "add them to be fixed every month without me adding them manual"). These land
  // as ordinary per-run entries — from here they are edited, locked, sheeted and
  // paid by exactly the rules a hand-typed entry follows.
  //
  // Best-effort on purpose: a roster that cannot be read must never stop a
  // payroll month from opening. Seeding is idempotent per (run, roster entry) and
  // HR can re-run it from the panel, so a failure here costs a button press
  // rather than a missed payment.
  try {
    await seedRunFromRecurring({ runId: run.id, actorHrId: actorId(access), phase: run.phase });
  } catch (error) {
    logError("Automated payroll: seeding the recurring non-employee roster failed", {
      labels: { event: "automated_payroll_recurring_seed_failed", runId: run.id },
      error,
    });
  }
  return run;
}

export async function getRunView(access: AccessContext, runId: string): Promise<RunView> {
  assertAutomatedPayrollHrActor(access);
  // HR opening the run is the moment a resync parked while the run was busy should land (resync-outbox.ts).
  maybeDrainPayrollResyncOutbox();
  const run = await requireRun(runId);
  const [stepStates, draftRows, parkedResyncs] = await Promise.all([
    listStepStates(runId),
    listDraftRows(runId),
    queuedPayrollResyncsForPeriod(run.month, run.year).catch(() => null),
  ]);
  // A run that can still take them lands this month's parked decisions now, back-off ignored, so the
  // next look shows them applied rather than an hour later.
  if (parkedResyncs && parkedResyncs.length > 0 && (run.phase === "part1" || run.phase === "part2")) {
    void landParkedResyncs(run);
  }
  const excluded = draftRows.filter((row) => row.excluded);
  const names = excluded.length > 0 ? await employeeNamesByCompactKey() : new Map<string, string>();
  return {
    run,
    stepStates,
    draftRows,
    parkedResyncs,
    excludedPeople: excluded.map((row) => ({
      hrId: row.employeeHrId,
      // The code is the fallback, never the label: a person missing from `employees` still has to
      // be identifiable on screen rather than vanishing behind an empty name.
      fullName: names.get(compactHrKey(row.employeeHrId)) || row.employeeHrId,
      reason: row.excludedReason ?? null,
    })),
  };
}

/**
 * Land the month's parked payroll decisions now (resync-outbox.ts), each under the run's hold. Never
 * throws: one that fails again stays parked, and confirmPart2's own check under its claim refuses on it.
 */
async function landParkedResyncs(run: MonthlySalaryRun): Promise<void> {
  try {
    await landQueuedPayrollResyncsForPeriod(run.month, run.year);
  } catch (error) {
    logError("Automated payroll: could not land the queued payroll decisions for a run", {
      labels: { event: "automated_payroll_queued_resync_land_failed", runId: run.id },
      error,
    });
  }
}

/** "2 deduction decisions and 1 expense decision" — exported for the money-integrity test. */
export function describeParkedResyncs(parked: ParkedPayrollResync[]): string {
  const count = (kind: ParkedPayrollResync["kind"]) => parked.filter((entry) => entry.kind === kind).length;
  const phrase = (n: number, kind: string) => `${n} ${kind} decision${n === 1 ? "" : "s"}`;
  const parts = [];
  if (count("deduction") > 0) parts.push(phrase(count("deduction"), "deduction"));
  if (count("expense") > 0) parts.push(phrase(count("expense"), "expense"));
  return parts.join(" and ");
}

/**
 * The refusal while decisions for the month are still parked, or null when none is. Exported for
 * tests/automated-payroll-money-integrity.test.ts.
 */
export function describeParkedResyncRefusal(parked: ParkedPayrollResync[]): string | null {
  if (parked.length === 0) return null;
  return (
    `Conflict: ${describeParkedResyncs(parked)} made while this run was busy ${parked.length === 1 ? "has" : "have"} ` +
    "not reached it yet. Nothing was confirmed; confirm Part 2 again in a minute."
  );
}

/** The active/most-recent run for a period (or null), for the page loader. */
export async function getRunForPeriod(
  access: AccessContext,
  period: PayrollPeriod,
): Promise<MonthlySalaryRun | null> {
  assertAutomatedPayrollHrActor(access);
  return (await findActiveRun(period.month, period.year)) ?? (await findLatestRun(period.month, period.year));
}

export async function cancelRun(
  access: AccessContext,
  runId: string,
  options: {
    /**
     * Cancel even though finance has downloaded a bank file (F-PAY-016). Refused without a reason;
     * the reason is kept on the cancel's audit row. See bank-file-downloads.ts.
     */
    overrideDownloaded?: { reason?: string | null } | null;
  } = {},
): Promise<MonthlySalaryRun> {
  assertRealSessionForDecision(access, "cancel a payroll run");
  assertAutomatedPayrollHrActor(access);
  const run = await requireRun(runId);
  assertActiveRun(run);

  // One transition at a time (audit finding 50): see claimTransition.
  const transition = await claimTransition(runId, ["part1", "part2", "ready"], "Cancelling this run");
  const { ledger, updated, override } = await whileClaimed(runId, transition, async () => {
    // A file that has left for the bank is not undone by cancelling the run — refuse first, before
    // the ledger is touched, unless he says why (bank-file-downloads.ts). A read failure refuses too.
    const override = assertCancelAllowedAfterDownloads(await listBankFileDownloads(runId), options.overrideDownloaded);
    // Undo this run's effect on the carry-forward ledger BEFORE marking it
    // cancelled. A run whose Part 2 was confirmed has already marked previous
    // months' overpayments as recovered — but a cancelled run pays nobody, so
    // leaving that would silently forgive real money (the exact bug the ledger
    // exists to prevent). See releaseCarryForwardForCancelledRun.
    const released = await releaseCarryForwardForCancelledRun(runId);
    const cancelled = await updateRun(runId, { phase: "cancelled" }, { transitionToken: transition });
    return { ledger: released, updated: cancelled, override };
  });
  await writeAutomatedPayrollAudit({
    runId,
    actorHrId: actorId(access),
    action: "run_cancelled",
    detail: {
      carryForwardReleased: ledger.released,
      carryForwardDiscarded: ledger.discarded,
      ...(override.overridden ? { cancelledAfterBankFileDownload: true, overrideReason: override.reason } : {}),
    },
  });
  return updated;
}

// ---- Per-step recommend / save / confirm ------------------------------------

async function loadRunContext(period: PayrollPeriod, runId: string): Promise<{
  members: PopulationMember[];
  sources: Map<string, PayrollSalarySource>;
  draftRows: DraftRow[];
  /** Every employee record, leavers included — the Held Salary Release step pays people who left. */
  directory: Awaited<ReturnType<typeof loadStepContext>>["directory"];
  /** People outside the population on the sheet only to be paid a held salary (releaseOnlyMembersFor). */
  releaseOnlyMembers: PopulationMember[];
}> {
  const [{ members, sources, directory }, draftRows] = await Promise.all([
    loadStepContext(period),
    listDraftRows(runId),
  ]);
  // Run-scoped exclusion (excludeEmployeeFromRun): drop the employee from every
  // consumer of `members` — steps, data-quality audit, assembly/pre-flight,
  // population diff — while `draftRows` itself is returned unfiltered so the
  // wizard can still show/reverse the exclusion. See DraftRow.excluded's doc
  // comment for why this exists (a run-wide hard block over one edge-case row).
  const excludedCompacts = new Set(
    draftRows.filter((row) => row.excluded).map((row) => row.employeeHrIdCompact),
  );
  const included = filterExcludedMembers(members, excludedCompacts);
  const releaseOnlyMembers = releaseOnlyMembersFor({ members: included, directory, draftRows, sources, period });
  return { members: included, sources, draftRows, directory, releaseOnlyMembers };
}

/**
 * What the sheet releases of earlier months' held salary, row by row. Part 1's release counts wherever
 * Part 1 paid it — its bank files carried it, so it is released even if the row is held at Part 2 —
 * and Part 2's only on a row not held now (owner, 2026-10-26: "it should be also in part one").
 */
function heldReleasesOf(rows: AssembledRow[]): { hrId: string; amount: number }[] {
  return rows
    .map((entry) => ({
      hrId: entry.row.hrId,
      amount: roundCurrency(entry.heldReleasePart1Applied + (entry.onHold ? 0 : entry.heldReleaseApplied)),
    }))
    .filter((release) => release.amount > 0);
}

/** Held at Part 1 — the Part 1 bank files paid this person nothing (assemble.ts part1WithheldFor). */
function withheldAtPart1(draft: DraftRow): boolean {
  return Boolean(draft.part1Withheld ?? draft.onHold);
}

/** What a draft row releases across both instalments: what assembleRows pays, before any cap. */
function heldReleaseDueOn(draft: DraftRow): number {
  const part1 = withheldAtPart1(draft) ? 0 : Math.max(0, roundCurrency(Number(draft.heldReleaseP1Value ?? 0)));
  const part2 = draft.onHold ? 0 : Math.max(0, roundCurrency(Number(draft.heldReleaseValue ?? 0)));
  return roundCurrency(part1 + part2);
}

/** Part 1's Held Salary Release and Defer Pay: their bank files pay what Part 1 confirm froze. */
const PART1_ONLY_STEP_KEYS: ReadonlySet<StepKey> = new Set<StepKey>(["p1_held_release", "p1_pay_deferral"]);

/** The previous published month's confirmed Part 1 per person; empty when there is no such month. */
async function lastMonthPart1For(period: PayrollPeriod): Promise<Map<string, number>> {
  const previous = await previousPublishedRun(period);
  return previous ? frozenPart1ForRun(previous.id) : new Map();
}

/**
 * What the Held Salary Release step needs beyond the population: every outstanding held balance from
 * earlier published months, the employee records to pay them to, and the "Part 1 Not Paid" HR has
 * entered against the previous published month. Defer Pay needs the carry-forward debts, so its Part 2
 * column is the same figure the sheet pays. Loaded only for those steps, so no other step pays for the read.
 */
async function heldReleaseInputs(
  stepKey: StepKey,
  runId: string,
  directory: Awaited<ReturnType<typeof loadRunContext>>["directory"],
  period: PayrollPeriod,
): Promise<{
  heldBalances?: Awaited<ReturnType<typeof outstandingHeldByEmployee>>;
  directory?: typeof directory;
  part1Corrections?: Map<string, number>;
  addedInRun?: Map<string, number>;
  carryForwardByCompact?: Map<string, number>;
}> {
  if (stepKey === "p2_pay_deferral") return { carryForwardByCompact: await outstandingCarryForwardFor(runId) };
  if (stepKey !== "p2_held_release" && stepKey !== "p1_held_release") return {};
  const previous = await previousPublishedRun(period);
  // One read of what HR entered serves both the balances and the added-in-run figure, so the two can
  // never disagree inside one recommendation.
  const entered = await loadEnteredHeld();
  return {
    heldBalances: await outstandingHeldByEmployee(runId, entered),
    directory,
    part1Corrections: previous ? await part1CorrectionsForRun(previous.id) : new Map(),
    addedInRun: enteredHeldAddedInRun(entered, runId),
  };
}

/**
 * Held Salary Release's "Part 1 Not Paid" (owner, 2026-10-26): what HR says the previous published
 * month's Part 1 did NOT pay someone. It is no figure of THIS run, so it never reaches the draft row —
 * it is recorded against that month (recordPart1Corrections), where it joins what is still held. Only
 * a figure that differs from the one shown is written, so re-saving the grid records nothing new.
 * Returns whether anything was recorded, so the caller re-reads the balances it validates against.
 */
async function savePart1NotPaid(
  access: AccessContext,
  run: MonthlySalaryRun,
  edits: StepEditInput[],
  rows: StepRow[],
  candidates: ManualRowCandidate[],
): Promise<boolean> {
  const rowByHrId = new Map(rows.map((row) => [row.hrId.toLowerCase(), row]));
  const nameByHrId = new Map(candidates.map((candidate) => [candidate.hrId.toLowerCase(), candidate.fullName]));
  const entries: { hrId: string; name: string; amount: number }[] = [];
  for (const edit of edits) {
    const raw = edit.values?.part1NotPaid;
    if (raw === undefined || raw === null) continue;
    const hrId = String(edit.hrId ?? "");
    const row = rowByHrId.get(hrId.toLowerCase());
    const amount = roundCurrency(Number(raw));
    if (amount === roundCurrency(Number(row?.values?.part1NotPaid ?? 0))) continue;
    entries.push({ hrId, name: row?.fullName ?? nameByHrId.get(hrId.toLowerCase()) ?? "", amount });
  }
  if (entries.length === 0) return false;
  const previous = await previousPublishedRun({ month: run.month, year: run.year });
  if (!previous) {
    throw new Error("Validation: there is no earlier published month to record a Part 1 Not Paid against.");
  }
  await recordPart1Corrections({
    heldRunId: previous.id,
    recordedInRunId: run.id,
    actorHrId: actorId(access),
    entries,
  });
  return true;
}

/** The fields and the bounding column of one instalment's Defer Pay step. */
type PayDeferralFields = { value: "payDeferralValue" | "payDeferralP1Value"; month: string; part: "Part 1" | "Part 2" };
const PAY_DEFERRAL_FIELDS: Partial<Record<StepKey, PayDeferralFields>> = {
  p1_pay_deferral: { value: "payDeferralP1Value", month: "payDeferralP1Month", part: "Part 1" },
  p2_pay_deferral: { value: "payDeferralValue", month: "payDeferralMonth", part: "Part 2" },
};

/**
 * Defer Pay (owner, 2026-10-26): never more than the person's instalment — the figure in the step's own
 * "Part 1" or "Part 2" column, the most that instalment can move — and only to next month or the one after.
 */
function assertPayDeferralEdits(edits: StepEditInput[], rows: StepRow[], fields: PayDeferralFields): void {
  const byHrId = new Map(rows.map((row) => [row.hrId.toLowerCase(), row]));
  const problems: string[] = [];
  for (const edit of edits) {
    const month = edit.selects?.[fields.month];
    const row = byHrId.get(String(edit.hrId ?? "").toLowerCase());
    const name = row?.fullName ?? edit.hrId;
    if (month !== undefined && month !== "next" && month !== "after_next") {
      problems.push(`${name}: "${month}" is not next month or the month after`);
    }
    const value = edit.values?.[fields.value];
    if (value === undefined || value === null) continue;
    const amount = roundCurrency(Number(value));
    if (!(amount > 0)) continue;
    const instalment = roundCurrency(Number(row?.context?.[fields.part] ?? 0));
    if (amount > instalment) {
      problems.push(`${name}: ${amount.toFixed(2)} is more than this month's ${fields.part} of ${instalment.toFixed(2)}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Validation: pay can only be deferred out of this month's ${fields.part}. ${problems.slice(0, 6).join("; ")}`,
    );
  }
}

/**
 * A held salary release may be lowered, never raised past what is still owed, and only for someone
 * the step lists. Judged against the step's own Outstanding column, which is the balance read at
 * the moment of the save. Both the grid and a re-uploaded sheet come through saveStep.
 */
function assertHeldReleaseEdits(
  edits: StepEditInput[],
  rows: StepRow[],
  field: "heldReleaseValue" | "heldReleaseP1Value",
): void {
  const byHrId = new Map(rows.map((row) => [row.hrId.toLowerCase(), row]));
  const problems: string[] = [];
  for (const edit of edits) {
    const value = edit.values?.[field];
    // Zero releases nothing, so it needs no balance — a row added only to enter Part 1 Not Paid sends it.
    if (value === undefined || value === null || roundCurrency(Number(value)) === 0) continue;
    const row = byHrId.get(String(edit.hrId ?? "").toLowerCase());
    if (!row) {
      problems.push(`${edit.hrId} has no held salary to release`);
      continue;
    }
    const outstanding = roundCurrency(Number(row.context?.Outstanding ?? 0));
    if (roundCurrency(Number(value)) > outstanding) {
      problems.push(`${row.fullName}: ${roundCurrency(Number(value)).toFixed(2)} is more than the ${outstanding.toFixed(2)} still held`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Validation: a held salary release can never be more than what is still held. ${problems.slice(0, 6).join("; ")}`,
    );
  }
}

/**
 * Every held salary release saved on the run is paid in full by the rows about to be confirmed or
 * published, and is still owed. Checked at Part 2 confirm and again at publish, because a by-hand
 * settlement recorded in between lowers the balance, and a release with no employee record would
 * otherwise vanish from the sheet while the step still showed it.
 */
async function assertHeldReleasesPayable(runId: string, draftRows: DraftRow[], rows: AssembledRow[]): Promise<void> {
  // A release reaches the sheet in Part 1 unless the row was withheld at Part 1, and in Part 2 unless it
  // is held now (assemble.ts). What does not reach it stays owed, so it is not checked against the sheet
  // here and not recorded by recordHeldReleases. Both instalments are checked as ONE figure against the
  // balance, which leaves out this run's own reservation, so Part 1's release cannot be offered twice.
  const releases = draftRows.filter((draft) => !draft.excluded && heldReleaseDueOn(draft) > 0);
  if (releases.length === 0) return;
  const balances = await outstandingHeldByEmployee(runId);
  const paidByCompact = new Map(
    rows.map((entry) => [entry.compact, roundCurrency(entry.heldReleaseApplied + entry.heldReleasePart1Applied)]),
  );
  const problems: string[] = [];
  for (const draft of releases) {
    const compact = compactHrKey(draft.employeeHrIdCompact);
    const owed = balances.get(compact) ?? [];
    const name = owed[0]?.name || draft.employeeHrId;
    const amount = heldReleaseDueOn(draft);
    const outstanding = roundCurrency(owed.reduce((sum, balance) => sum + balance.outstanding, 0));
    if (amount > outstanding) {
      problems.push(`${name}: release ${amount.toFixed(2)} is more than the ${outstanding.toFixed(2)} still held`);
    } else if (roundCurrency(paidByCompact.get(compact) ?? 0) !== amount) {
      problems.push(`${name}: release ${amount.toFixed(2)} is not on the sheet (no employee record to pay it to)`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Validation: re-open Held Salary Release and correct it. ${problems.slice(0, 6).join("; ")}`,
    );
  }
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
  directory: Map<string, EmployeeDirectoryRow>,
  lastMonthPart1: Map<string, number> = new Map(),
): ManualRowCandidate[] {
  if (!stepDefinition(stepKey).allowsManualRows) return [];
  const listed = new Set(rows.map((row) => compactHrKey(row.hrId)).filter(Boolean));
  // Held Salary Release pays people who have LEFT (owner, 2026-11-09: "every employee even if resigned …
  // I want Ahmed Helal"), so its picker is every employee record, not this month's population.
  if (stepKey === "p1_held_release" || stepKey === "p2_held_release") {
    const seen = new Set<string>();
    const everyone: ManualRowCandidate[] = [];
    for (const [compact, employee] of directory) {
      if (!compact || listed.has(compact) || seen.has(compact) || !employee.fullName?.trim()) continue;
      seen.add(compact);
      everyone.push({
        hrId: employee.hrId,
        fullName: employee.fullName,
        jobTitle: employee.jobTitle ?? null,
        line: employee.lineName ?? null,
        status: employee.employmentStatus ?? null,
        lastMonthPart1: lastMonthPart1.get(compact) ?? 0,
      });
    }
    return everyone.sort((left, right) => left.fullName.localeCompare(right.fullName));
  }
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

/**
 * A module-sourced step's rows with each STALE figure swapped for the module's current one.
 *
 * Used by both the step view and its confirm, so what HR sees is what the confirm stores. A figure
 * that differs from the last confirm is somebody's decision and is left alone; a step never
 * confirmed has no snapshot and is returned as it is. See takeCurrentModuleFigures.
 */
function withCurrentModuleFigures(
  stepKey: StepKey,
  rows: StepRow[],
  state: StepState | null,
  draftRows: DraftRow[],
): StepRow[] {
  if (!MODULE_SOURCED_STEP_KEYS.includes(stepKey) || !state) return rows;
  return takeCurrentModuleFigures({
    stepKey,
    rows,
    snapshot: snapshotFromSummary(state.summary),
    chargedByCompact: chargedFiguresFromDrafts(draftRows),
  });
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
  const { run, rows, state, candidates } = await loadStepView(access, runId, stepKey);
  return { run, rows, state, candidates };
}

/** The step as getStepRecommendation shows it, plus the draft rows it was built from (for saveStep). */
async function loadStepView(
  access: AccessContext,
  runId: string,
  stepKey: StepKey,
): Promise<{
  run: MonthlySalaryRun;
  rows: StepRow[];
  state: StepState | null;
  candidates: ManualRowCandidate[];
  draftRows: DraftRow[];
}> {
  assertAutomatedPayrollHrActor(access);
  const run = await requireRun(runId);
  const period: PayrollPeriod = { month: run.month, year: run.year };
  const { members, sources, draftRows, directory } = await loadRunContext(period, runId);
  // Needed only by the four-figure summary each card shows (owner 2026-08-30):
  // a previous run's overpayment being recovered is a real deduction, so
  // leaving it out would overstate take-home for exactly the people whose pay
  // has already gone wrong once. One indexed lookup, on the read path only.
  const carryForwardByCompact = await outstandingCarryForwardFor(runId);
  const releaseInputs = await heldReleaseInputs(stepKey, runId, directory, period);
  const [recommended, states] = await Promise.all([
    recommendStep({
      access,
      period,
      stepKey,
      members,
      sources,
      draftRows,
      carryForwardByCompact,
      ...releaseInputs,
    }),
    listStepStates(runId),
  ]);
  const state = states.find((candidate) => candidate.stepKey === stepKey) ?? null;
  // The step shows the figure its confirm will store — see withCurrentModuleFigures.
  const rows = withCurrentModuleFigures(stepKey, recommended, state, draftRows);
  return {
    run,
    rows,
    state,
    candidates: manualRowCandidates(
      stepKey,
      members,
      rows,
      directory,
      // Who last month's Part 1 actually paid — "Part 1 Not Paid" is offered only for them (owner, 2026-11-09).
      stepKey === "p1_held_release" || stepKey === "p2_held_release"
        ? await lastMonthPart1For({ month: run.month, year: run.year })
        : new Map(),
    ),
    draftRows,
  };
}

function assertStepPhaseAllowed(run: MonthlySalaryRun, stepKey: StepKey): void {
  assertActiveRun(run);

  // ONCE PART 2 IS CONFIRMED THE SHEET IS THE PAYABLE TRUTH, AND FINANCE MAY ALREADY HOLD IT.
  //
  // `ready` means Part 2 is confirmed: the finance sheet and both bank files are downloadable and
  // are, in practice, downloaded and executed from that moment. Every step stayed writable anyway —
  // the lock HR sees is a browser-side property, never a server rule — so a stale tab, a retry or a
  // direct call could still change a figure after the money had left, and publish would then write
  // the CHANGED row to the payslip. The employee's payslip and their bank transfer would disagree,
  // with nothing anywhere recording that they ever differed.
  //
  // Reopening Part 2 is the way back, and it is deliberate rather than accidental: it undoes this
  // run's effect on the carry-forward ledger and puts the run back where the gates run again.
  if (run.phase === "ready") {
    throw new Error(
      "Conflict: Part 2 is confirmed for this run, and finance may already have executed its bank " +
        "files. Reopen Part 2 before changing any step — editing now would publish a payslip that " +
        "disagrees with the transfer that was already sent.",
    );
  }

  const phase = stepPhase(stepKey);
  if (phase === "part2" && run.phase === "part1") {
    throw new Error("Conflict: confirm Part 1 before editing Part 2 steps.");
  }
  // Part 1's release and deferral are what its bank files paid, so they are fixed once Part 1 is
  // confirmed. A change after that goes on Part 2's own Held Salary Release or Defer Pay.
  if (PART1_ONLY_STEP_KEYS.has(stepKey) && run.phase !== "part1") {
    throw new Error(
      "Conflict: Part 1 is confirmed, and its bank files pay these figures. Use Part 2's Held Salary " +
        "Release or Defer Pay, or reopen Part 1 to change them.",
    );
  }

  // Nor while a confirm, reopen, cancel or publish holds the run (audit finding 50).
  assertNoTransitionInProgress(run);
}

/**
 * Every phase a write to this step may land in — the same answer assertStepPhaseAllowed gives, handed
 * to the run hold so the phase is checked again at the moment of the write, not only when it was read.
 */
function stepWritablePhases(stepKey: StepKey): RunPhase[] {
  if (PART1_ONLY_STEP_KEYS.has(stepKey)) return ["part1"];
  return stepPhase(stepKey) === "part2" ? ["part2"] : ["part1", "part2"];
}

/** Save inline/xlsx edits for a step (marks the step edited, not confirmed). */
export async function saveStep(
  access: AccessContext,
  runId: string,
  stepKey: StepKey,
  edits: StepEditInput[],
  inputMode: StepInputMode,
  /**
   * Server-internal only; the step route never supplies it. `recalculateMoney` names, per lower-cased
   * HR id, the money fields a re-uploaded sheet left stale beside a corrected day count. They are
   * cleared so the settlement rule re-derives them (see applyDayDrivenMoney).
   */
  options?: { recalculateMoney?: Map<string, string[]> },
): Promise<void> {
  assertRealSessionForDecision(access, "save a payroll run step");
  assertAutomatedPayrollHrActor(access);
  const run = await requireRun(runId);
  assertStepPhaseAllowed(run, stepKey);

  // Notice-period rows are display-only (see confirmStep). Drop any that reach
  // here — including via a re-uploaded xlsx, which bypasses the UI entirely.
  const view = await loadStepView(access, runId, stepKey);
  const { candidates, draftRows } = view;
  let currentRows = view.rows;
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
  const applicable = edits
    .filter((edit) => !readOnlyHrIds.has(String(edit.hrId ?? "").toLowerCase()))
    .filter((edit) => !populationHrIds || populationHrIds.has(String(edit.hrId ?? "").toLowerCase()));

  // Nothing on a step may be negative (audit finding 42): a negative addition is a deduction no
  // deduction check can see. Here because both the inline grid and a re-uploaded xlsx come through.
  assertNoNegativeStepValues(stepDefinition(stepKey), applicable, currentRows);
  // Part 1 Not Paid raises what is owed, so it is recorded first and the release is judged against the
  // balance it produced — entering it and releasing it in one save works.
  const releaseStep = stepKey === "p1_held_release" || stepKey === "p2_held_release";
  if (releaseStep && (await savePart1NotPaid(access, run, applicable, currentRows, candidates))) {
    currentRows = (await loadStepView(access, runId, stepKey)).rows;
  }
  if (releaseStep) {
    assertHeldReleaseEdits(applicable, currentRows, stepKey === "p1_held_release" ? "heldReleaseP1Value" : "heldReleaseValue");
  }
  const deferralFields = PAY_DEFERRAL_FIELDS[stepKey];
  if (deferralFields) assertPayDeferralEdits(applicable, currentRows, deferralFields);

  // A hold may not be saved without a reason.
  //
  // This is the boundary that matters: `recommendHolds` reads `onHold` straight
  // off the stored draft row, so a hold can only ever ENTER the run through here
  // — from the inline grid or from a re-uploaded xlsx, both of which land in
  // saveStep. Enforcing in the service rather than in the grid is what makes the
  // xlsx path and any future caller obey it too; "Validation:" is what jsonError
  // turns into a 400.
  //
  // Judged on the state the save RESULTS in, not on the edit: an edit that only
  // flips the switch passes when a reason is already stored, and an edit that
  // blanks the reason of an already-held row fails. A field the edit omits keeps
  // whatever is on the current row — including a reason carried forward from
  // last month, which is why a continuing hold needs no retyping.
  if (stepDefinition(stepKey).isHoldStep) {
    const currentByHr = new Map(currentRows.map((row) => [row.hrId.toLowerCase(), row]));
    assertHoldReasonsPresent(
      applicable.map((edit) => {
        const current = currentByHr.get(String(edit.hrId ?? "").toLowerCase());
        return {
          hrId: String(edit.hrId ?? ""),
          fullName: current?.fullName ?? null,
          onHold: edit.onHold !== undefined ? edit.onHold : current?.onHold ?? false,
          reason: edit.reason !== undefined ? edit.reason : current?.reason ?? null,
        };
      }),
    );
  }

  // On a step fed by the Deductions module, a figure nobody changed stays exactly as the draft holds it
  // (judged per day-and-money group, so typing one pair never stamps the row's other pair). The grid sends every row it shows, and writing them all made every untouched 0.00 a
  // "person saved it" entry in the cell history — the entry deduction-resync.ts keeps out of every
  // later approval (saved-figures.ts has the September 2026 account).
  const moduleSourced = MODULE_SOURCED_STEP_KEYS.includes(stepKey);
  const currentByHrId = new Map(currentRows.map((row) => [row.hrId.toLowerCase(), row]));
  const draftByCompact = new Map(draftRows.map((draft) => [draft.employeeHrIdCompact, draft]));
  const patches = applicable.map((edit) => {
    const hrIdKey = String(edit.hrId ?? "").toLowerCase();
    const isLeaver = leaverHrIds.has(hrIdKey);
    const patch = stepEditToPatch(stepKey, edit, isLeaver);
    // Money the settlement rule must re-derive from a corrected day count is CLEARED rather than left
    // at the sheet's stale figure (audit finding 32). Only stored money columns, and only what the
    // server itself asked for.
    for (const key of options?.recalculateMoney?.get(hrIdKey) ?? []) {
      if ((NUMERIC_FIELDS as string[]).includes(key)) (patch as unknown as Record<string, number | null>)[key] = null;
    }
    if (moduleSourced) {
      const current = currentByHrId.get(hrIdKey);
      const write = figureWriteFor(
        stepKey,
        patch,
        proposalShown(current?.recommended, edit.recommended),
        current?.values,
        isLeaver,
        draftByCompact.get(compactHrKey(edit.hrId)),
      );
      stripFigures(patch, untouchedFigureFields(write, figureGroups(stepKey, Object.keys(write.written))));
    }
    patch.source = inputMode;
    patch.editedBy = actorId(access);
    patch.writeReason = "step_saved";
    patch.writeStepKey = stepKey;
    return patch;
  });
  // Written under the run's hold (audit 2026-10-23, F-08a): a confirm that started after the checks
  // above cannot be overtaken by this save, and a run that moved on is refused rather than written.
  await holdRun({ runId, expected: stepWritablePhases(stepKey), action: RUN_HOLD_ACTIONS.saveStep }, async () => {
    await upsertDraftRows(runId, patches);
    await upsertStepState({ runId, stepKey, status: "pending", inputMode });
  });
  await writeAutomatedPayrollAudit({
    runId,
    actorHrId: actorId(access),
    action: "step_saved",
    stepKey,
    // `edited` counts the rows the save carried; `figuresWritten` the ones that still wrote a figure
    // after the untouched groups were left out — the cell history is the full record.
    detail: { edited: patches.length, figuresWritten: patches.filter(writesAFigure).length, inputMode },
  });
}

/** Confirm a step: persist the currently-shown values (accepted recommendations + edits) and lock it. */
export async function confirmStep(
  access: AccessContext,
  runId: string,
  stepKey: StepKey,
): Promise<StepState> {
  assertRealSessionForDecision(access, "confirm a payroll run step");
  assertAutomatedPayrollHrActor(access);
  const run = await requireRun(runId);
  assertStepPhaseAllowed(run, stepKey);

  const period: PayrollPeriod = { month: run.month, year: run.year };
  const [{ members, sources, draftRows, directory }, states] = await Promise.all([
    loadRunContext(period, runId),
    listStepStates(runId),
  ]);
  const recommended = await recommendStep({
    access,
    period,
    stepKey,
    members,
    sources,
    draftRows,
    ...(await heldReleaseInputs(stepKey, runId, directory, period)),
  });
  // RE-CONFIRMING TAKES THE MODULE'S CURRENT FIGURE for every line nobody overrode — the remedy the
  // drift block names. Without this the saved figure won and the re-confirm stored it again.
  const rows = withCurrentModuleFigures(
    stepKey,
    recommended,
    states.find((state) => state.stepKey === stepKey) ?? null,
    draftRows,
  );

  // A hold may not be CONFIRMED without a reason either.
  //
  // saveStep guards the two paths a hold is EDITED by (the inline grid and the
  // xlsx re-upload). Confirming is the third way one is written: it persists
  // every row the step is showing, and `stepRowToPatch` carries `onHold` and
  // `reason` straight onto the draft row, so a hold nobody touched this session
  // is re-saved with an empty reason and the step locks — the save rule never
  // running because nothing was "edited". That is the click this rule most needs
  // to cover: it is the last one before publish drops the held rows, and once
  // published the reason is unrecoverable because no salary_record is written.
  //
  // Rows carrying a reason inherited from last month pass without retyping —
  // recommendHolds has already resolved carry-forward into `row.reason` by here.
  if (stepDefinition(stepKey).isHoldStep) {
    assertHoldReasonsPresent(holdCandidatesFromStepRows(rows));
  }

  // MONEY ADDED TO A PAYSLIP SAYS WHY. Additions is the only step that adds money and the only one
  // with no feeder behind it, so the reason is the only thing that will ever explain the figure.
  // Enforced here rather than at save because confirming is what locks the step, and Part 2 confirm
  // refuses unless every step is confirmed — so no published addition bypasses this.
  if (stepKey === "p2_additions") {
    assertAdditionsReasonsPresent(additionsCandidatesFromStepRows(rows));
  }

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
      patch.writeReason = "step_confirmed";
      patch.writeStepKey = stepKey;
      return patch;
    });
  const summary = summarizeStep(stepKey, rows);
  // WHAT THE MODULE WAS PROPOSING AT THIS MOMENT, for the steps it feeds.
  //
  // Confirming copies the module's figure onto the run's own row, and the engine reads that row
  // from here on. Without a record of what was proposed at the time, a later check cannot tell a
  // figure somebody deliberately overrode from one the module has since changed — see
  // module-drift.ts. Stored in the step state's existing jsonb summary, so it costs no schema.
  if (MODULE_SOURCED_STEP_KEYS.includes(stepKey)) {
    summary[RECOMMENDED_AT_CONFIRM_KEY] = snapshotRecommendations(stepKey, rows);
  }

  // CONFIRMING p2_vacation TOUCHES NO LEAVE BALANCE, AND READS NO CRM LEAVE TO DECIDE ONE.
  //
  // It used to do both: it computed every member's CRM-only leave here — refusing the confirm
  // outright if the CRM feed or the Egypt holiday calendar could not be read — and then wrote a
  // row per employee into payroll_copilot_vacation_settlements to draw those days off the balance.
  // That write never once succeeded (a foreign key onto the wrong runs table) while its unscoped
  // supersede destroyed live rows it could not replace. The full account, and why it must not be
  // rebuilt, is on the note where it lived in recommend.ts.
  //
  // CRM leave now reaches a balance by one path only (owner's decision, 2026-10-01):
  // scripts/import-crm-vacation-backfill.ts, which creates a real Phoenix request through the same
  // balance engine the admin UI uses, behind three guards this step never had — hire-date
  // attribution (CRM accounts are seats the vendor renames), national-holiday adjacency, and
  // overlap containment against an existing request. So the owner's holiday protection of
  // 2026-09-16 sits in front of the write that actually happens, not in front of one that cannot.
  //
  // The read is therefore gone from here rather than left in: with nothing downstream consuming
  // it, an unreachable holiday calendar would have refused a payroll confirm for no benefit at all.
  // The step's own figure comes from the Deductions module via recommendVacation, untouched.
  // The rows and the step's confirmed state are written together under the run's hold (F-08a), so a
  // Part confirm running at the same moment either sees both or neither.
  const state = await holdRun({ runId, expected: stepWritablePhases(stepKey), action: RUN_HOLD_ACTIONS.confirmStep }, async () => {
    await upsertDraftRows(runId, patches);
    return upsertStepState({
      runId,
      stepKey,
      status: "confirmed",
      summary,
      confirmedAt: nowIso(),
      confirmedBy: actorId(access),
    });
  });

  await writeAutomatedPayrollAudit({
    runId,
    actorHrId: actorId(access),
    action: "step_confirmed",
    stepKey,
    detail: summary,
  });
  return state;
}

/**
 * Which confirmed figures the Deductions module no longer agrees with.
 *
 * Recomputes only the steps the module feeds, and only the ones already confirmed — an unconfirmed
 * step is still showing live figures, so there is nothing for it to have drifted from.
 */
export async function getModuleDrift(access: AccessContext, runId: string): Promise<ModuleDriftReport> {
  assertAutomatedPayrollHrActor(access);
  const run = await requireRun(runId);
  const period: PayrollPeriod = { month: run.month, year: run.year };
  const [{ members, sources, draftRows }, states] = await Promise.all([
    loadRunContext(period, runId),
    listStepStates(runId),
  ]);
  const confirmed = new Map(
    states.filter((state) => state.status === "confirmed").map((state) => [state.stepKey, state]),
  );

  // What each row is really FROZEN at, straight off the draft. A step field's key IS its DraftRow
  // key (see step-definitions.ts — the generic persist loop relies on that), so no mapping table is
  // needed. It matters only for an employee the step never persisted: `row.values` would then show
  // the live recommendation, and a 0.00 the sheet is about to pay would be reported as an override
  // somebody chose.
  const chargedByCompact = chargedFiguresFromDrafts(draftRows);

  const reports: ModuleDriftReport[] = [];
  for (const stepKey of MODULE_SOURCED_STEP_KEYS) {
    const state = confirmed.get(stepKey);
    if (!state) continue;
    const snapshot = snapshotFromSummary(state.summary);
    if (!snapshot) continue;
    const rows = await recommendStep({ access, period, stepKey, members, sources, draftRows });
    reports.push(
      detectModuleDrift({ stepKey, rows, snapshot, chargedByCompact, part1Confirmed: run.part1ConfirmedAt != null }),
    );
  }
  const merged = mergeModuleDrift(reports);
  return attachChargeSources(runId, merged);
}

/**
 * Who set each figure that differs from its confirm, from the cell history — so the report says
 * "typed" only when a person did. Wording only: whether a row blocks is decided by detectModuleDrift
 * and is unchanged by this.
 */
async function attachChargeSources(runId: string, report: ModuleDriftReport): Promise<ModuleDriftReport> {
  const differing = report.rows.filter((row) => row.overridden);
  if (differing.length === 0) return report;
  const compacts = [...new Set(differing.map((row) => compactHrKey(row.hrId)).filter(Boolean))];
  const columns = [...new Set(differing.map((row) => draftColumnForField(row.field)))];
  const [latest, names] = await Promise.all([
    listLatestCellWrites(runId, compacts, columns),
    employeeNamesByCompactKey(),
  ]);
  return {
    ...report,
    rows: report.rows.map((row) => {
      if (!row.overridden) return row;
      const write = latest.get(`${compactHrKey(row.hrId)}|${draftColumnForField(row.field)}`);
      if (!write) return { ...row, chargeSource: { kind: "unknown", name: null, stepKey: null, at: null } };
      const kind = chargeSourceKind(write.writeReason);
      return {
        ...row,
        chargeSource: {
          kind,
          name:
            kind === "typed" && write.changedBy && write.changedBy !== "system"
              ? names.get(compactHrKey(write.changedBy)) || null
              : null,
          stepKey: write.stepKey,
          at: write.changedAt || null,
        },
      };
    }),
  };
}

/**
 * Employee-days this run would charge twice.
 *
 * Surfaced from the moment the run opens so the Part 2 gate below is never the first anybody hears
 * of it — a block at the last step, on a month somebody has already worked through, is the shape
 * of check that gets resented rather than read.
 */
export async function getPayrollDayCollisions(
  access: AccessContext,
  runId: string,
): Promise<PayrollDayCollision[]> {
  assertAutomatedPayrollHrActor(access);
  const run = await requireRun(runId);
  const period: PayrollPeriod = { month: run.month, year: run.year };
  const [{ members }, deductions] = await Promise.all([
    loadRunContext(period, runId),
    loadConfirmedDeductions(period),
  ]);
  return detectPayrollDayCollisions({ members, deductions });
}

/**
 * What the audit row records about a confirmed step.
 *
 * IT USED TO TOTAL ONE FIELD — the first one it found — and silently ignored every other. On the
 * Additions step that first field is Incentive, so bonus and overtime left no trace in any audit
 * entry at all: the August run's audit recorded an incentive total of 5,442 across 120 employees
 * while the same rows carried 2,258.00 of bonus and 1,000.00 of overtime that nothing mentioned.
 * The step that adds money to a payslip was the least auditable one in the wizard.
 *
 * Every numeric field is now totalled and named. `primaryField` and `total` are kept exactly as
 * they were so nothing reading an older audit row has to change its mind about what they mean.
 */
export function summarizeStep(stepKey: StepKey, allRows: StepRow[]): Record<string, unknown> {
  // A read-only row is shown, never written: a notice-period leaver, or expenses for someone outside the
  // run (audit finding 45). The record of what a confirm wrote does not count it.
  const rows = allRows.filter((row) => !row.readOnly);
  if (stepKey === "p1_holds" || stepKey === "p2_holds") {
    return { employees: rows.length, held: rows.filter((row) => row.onHold).length };
  }
  const fieldTotals: Record<string, number> = {};
  for (const row of rows) {
    for (const [field, value] of Object.entries(row.values ?? {})) {
      const amount = Number(value ?? 0);
      if (!Number.isFinite(amount)) continue;
      fieldTotals[field] = (fieldTotals[field] ?? 0) + amount;
    }
  }
  for (const field of Object.keys(fieldTotals)) {
    fieldTotals[field] = Math.round((fieldTotals[field] ?? 0) * 100) / 100;
  }
  const primaryField = Object.keys(rows[0]?.values ?? {})[0];
  return {
    employees: rows.length,
    primaryField: primaryField ?? null,
    total: primaryField ? (fieldTotals[primaryField] ?? 0) : 0,
    // Every field this step writes, so no figure that reaches a payslip is absent from the record
    // of the click that put it there.
    fieldTotals,
  };
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
export async function confirmPart1(
  access: AccessContext,
  runId: string,
  options: { acknowledgeDataIssuesToken?: string | null } = {},
): Promise<MonthlySalaryRun> {
  assertRealSessionForDecision(access, "confirm Part 1 of a payroll run");
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

  // Confirming Part 1 FREEZES real money. An employee with no hire date, no
  // salary or no payment mode is about to have a default decide their first
  // installment, permanently — so HR sees exactly who, and accepts it on the
  // record, before the freeze rather than after.
  await assertPayrollDataAcknowledged({
    access,
    run,
    members,
    sources,
    draftRows,
    acknowledgmentToken: options.acknowledgeDataIssuesToken,
  });

  // THE SAME HARD VALIDATION PART 2 WILL RUN, run here, BEFORE money is frozen.
  //
  // Part 1's data-quality gate above is acknowledgeable by design: a missing hire date or payment
  // mode is a judgement call HR can accept on the record. But the pre-flight validator at Part 2
  // confirm is NOT acknowledgeable, and it refuses some of the same people — an employee with no
  // salary at all fails `missing_gross_salary` there with no flag to get past it.
  //
  // So Part 1 was waving through exactly what Part 2 would later refuse. Walked end to end on
  // staging 2026-09-10: three employees with no salary were acknowledged at Part 1, frozen into the
  // first instalment at 0.00, and then Part 2 refused outright over those same three. The month was
  // stuck, and the only ways out both damaged a Part 1 that had already been confirmed as money —
  // change their salary (moving the basis of a frozen instalment) or exclude them (erasing people
  // whose Part 1 was already executed).
  //
  // Running it here makes the Part 1 acknowledgement honest: what it lets through, Part 2 accepts.
  const { rows: preflightRows } = await assembleForRun(run);
  const { preflightValidate: preflightAtPart1 } = await import("./validate.ts");
  const part1Preflight = preflightAtPart1(preflightRows);
  if (!part1Preflight.ok) {
    const sample = part1Preflight.issues.slice(0, 6).map((issue) => `${issue.hrId ?? "?"}: ${issue.message}`);
    throw new Error(
      `Validation: fix ${part1Preflight.errorCount} issue(s) before confirming Part 1. ${sample.join("; ")} ` +
        "(These cannot be acknowledged past: Part 2 refuses them outright, so confirming Part 1 now would " +
        "freeze money for people the month can never be completed with.)",
    );
  }

  // Part 1's release must still be owed, and paid in full by the First Part about to be frozen.
  await assertHeldReleasesPayable(runId, draftRows, preflightRows);

  // One deduction, one instalment — refused before the freeze takes both columns (audit 2026-11-07).
  const part1SplitConflicts = findPartSplitConflicts(draftRows);
  if (part1SplitConflicts.length > 0) {
    throw new Error(`Conflict: ${describePartSplitConflicts(part1SplitConflicts)}`);
  }

  // One-instalment rows repay old overpayments from Part 1 (part1CarryForward).
  const carryForwardByCompact = await outstandingCarryForwardFor(runId);
  const frozen = computePart1Freeze({ members, sources, draftRows, period, carryForwardByCompact });

  // THE PART 1 / PART 2 DEDUCTION ROUTING IS FROZEN HERE TOO, in the same write.
  //
  // `isSettledInPart1` reads the employee's payment mode and lifecycle live, and both move: a mode
  // gets corrected, somebody resigns mid-month. The columns it routes money into do not move. So a
  // correction between the two confirms left a loan in the Part 1 column from before AND offered it
  // again on the Part 2 step — charged twice — while the mirror correction took it out of both and
  // never charged it at all. Nothing detected either, because the double-deduction warning is off on
  // every Part 1 deduction step.
  //
  // Freezing it at the same moment as the money is what makes the two populations stay disjoint for
  // the rest of the run. Before this line the live rule still answers, which is correct: nothing has
  // been routed anywhere yet.
  const patches: DraftRowPatch[] = members.map((member) => ({
    employeeHrId: member.employee.hrId,
    firstPartFrozen: frozen.get(member.compact)?.firstPart ?? 0,
    settledInPart1: isSettledInPart1(member, lookupSource(sources, member.employee.hrId)),
    // Held now means the Part 1 bank files leave them out: their first instalment is NOT paid, and
    // stays owed even if Part 2 releases the hold (owner, 2026-10-26). Set under the claim below.
    part1Withheld: false,
    editedBy: actorId(access),
    writeReason: "part1_confirmed",
  }));
  // The freeze and the phase write happen under one claim (audit finding 50): see claimTransition.
  const transition = await claimTransition(runId, ["part1"], "Confirming Part 1");
  const updated = await whileClaimed(runId, transition, async () => {
    // WHAT IS FROZEN IS WHAT THE RUN SAYS NOW (audit 2026-10-23, F-08a). Everything above read the run
    // before the claim, and a save or a resync that finished in between would be frozen over. Under
    // the claim nothing else can write, so recomputing here and refusing on any difference means the
    // freeze is never built from figures the run no longer holds.
    const fresh = await loadRunContext(period, runId);
    const refrozen = computePart1Freeze({
      members: fresh.members,
      sources: fresh.sources,
      draftRows: fresh.draftRows,
      period,
      carryForwardByCompact,
    });
    const movedWhileConfirming = frozenFirstPartsDiffer(
      firstPartsOf(frozen),
      firstPartsOf(refrozen),
      members,
      fresh.members,
    );
    if (movedWhileConfirming) {
      throw new Error(
        "Conflict: this run changed while Part 1 was being confirmed (a step was saved or a deduction " +
          `decision reached it — ${movedWhileConfirming}). Nothing was confirmed; confirm Part 1 again.`,
      );
    }
    // The hold as it stands under the claim — a hold saved after the first read is the one the bank
    // files will act on.
    const heldNow = new Set(fresh.draftRows.filter((row) => row.onHold).map((row) => row.employeeHrIdCompact));
    for (const patch of patches) patch.part1Withheld = heldNow.has(compactHrKey(patch.employeeHrId));
    const part1Releases: { hrId: string; amount: number }[] = [];
    const freshDrafts = new Map(fresh.draftRows.map((row) => [row.employeeHrIdCompact, row]));
    for (const member of fresh.members) {
      const freeze = refrozen.get(member.compact);
      if (!freeze) continue;
      if (freeze.heldReleaseApplied > 0) {
        part1Releases.push({ hrId: member.employee.hrId, amount: freeze.heldReleaseApplied });
      }
      // Part 1's Defer Pay is stored as it was applied — capped at the First Part — so the bank file
      // and the figure owed later are the same one.
      const typed = roundCurrency(Number(freshDrafts.get(member.compact)?.payDeferralP1Value ?? 0));
      const patch = patches.find((candidate) => compactHrKey(candidate.employeeHrId) === member.compact);
      if (patch && !patch.part1Withheld && typed > freeze.payDeferralApplied) {
        patch.payDeferralP1Value = freeze.payDeferralApplied;
      }
    }
    // Someone on the sheet only for a held salary (releaseOnlyMembersFor): Part 1 pays their Part 1
    // release unless they are held now, and that answer is frozen like everyone else's.
    for (const member of fresh.releaseOnlyMembers) {
      const draft = freshDrafts.get(member.compact);
      const release = Math.max(0, roundCurrency(Number(draft?.heldReleaseP1Value ?? 0)));
      if (!draft || !(release > 0)) continue;
      const withheld = heldNow.has(member.compact);
      patches.push({
        employeeHrId: member.employee.hrId,
        part1Withheld: withheld,
        editedBy: actorId(access),
        writeReason: "part1_confirmed",
      });
      if (!withheld) part1Releases.push({ hrId: member.employee.hrId, amount: release });
    }
    await upsertDraftRows(runId, patches);
    // RESERVE THE HELD SALARY PART 1 RELEASES, before the run moves on: from here the Part 1 bank files
    // can pay it. Always written, so a re-confirm after a reopen replaces what the first confirm recorded.
    await recordHeldReleases({
      runId,
      actorHrId: actorId(access),
      stage: "part1_confirmed",
      releases: part1Releases,
    });
    return updateRun(
      runId,
      { phase: "part2", part1ConfirmedAt: nowIso(), part1ConfirmedBy: actorId(access) },
      { transitionToken: transition },
    );
  });
  await writeAutomatedPayrollAudit({
    runId,
    actorHrId: actorId(access),
    action: "part1_confirmed",
    detail: { frozenEmployees: patches.length },
  });
  await notifyPart1Ready(updated);
  await notifyPart1SubmittedForReview(updated);
  // The "take care, HR" notice, at the last moment before money moves. Owner instruction
  // 2026-09-06: he was offered a scheduled notice on the 25th OR one at this point, and chose
  // BOTH — the 25th leaves time to investigate, this one is the final check. `reason` is part of
  // the idempotency key, so the two never suppress each other.
  //
  // CAUGHT, NEVER AWAITED INTO THE RESULT. Part 1 confirmation has already frozen real money and
  // written its audit row by this line; a notification outage must not throw back through a
  // completed financial transition and present it to HR as having failed.
  await runRetentionRiskPrePayrollNotice("part1_confirmed", monthLabel(run.month, run.year)).catch((error) => {
    logError("Pre-payroll retention-risk notice failed after Part 1 confirmation", {
      labels: { event: "retention_risk_pre_payroll_failed", runId },
      error,
    });
  });
  return updated;
}

function firstPartsOf(freeze: ReturnType<typeof computePart1Freeze>): Map<string, number> {
  return new Map([...freeze].map(([compact, part1]) => [compact, part1.firstPart]));
}

/**
 * The first difference between two freezes of the same run, in words, or null when they agree. Who is
 * in the population counts as much as the figure: a person added or dropped changes what is frozen.
 */
function frozenFirstPartsDiffer(
  before: Map<string, number>,
  after: Map<string, number>,
  membersBefore: PopulationMember[],
  membersAfter: PopulationMember[],
): string | null {
  const keysBefore = new Set(membersBefore.map((member) => member.compact));
  const keysAfter = new Set(membersAfter.map((member) => member.compact));
  if (keysBefore.size !== keysAfter.size || [...keysBefore].some((key) => !keysAfter.has(key))) {
    return "the people on the run changed";
  }
  for (const member of membersAfter) {
    const was = roundCurrency(before.get(member.compact) ?? 0);
    const now = roundCurrency(after.get(member.compact) ?? 0);
    if (Math.abs(was - now) > 0.005) {
      return `${member.employee.fullName}'s first instalment moved from ${was.toLocaleString()} to ${now.toLocaleString()}`;
    }
  }
  return null;
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
  assertRealSessionForDecision(access, "reopen Part 1 of a payroll run");
  assertAutomatedPayrollHrActor(access);
  const run = await requireRun(runId);
  assertActiveRun(run);
  if (run.phase !== "part2") {
    throw new Error("Conflict: Part 1 is not currently confirmed.");
  }

  const draftRows = await listDraftRows(runId);

  // EVERYTHING CONFIRMING PART 1 STAMPED IS CLEARED, not only the frozen figure.
  //
  // Reopening exists for exactly one purpose: a wrong base salary was found and the first
  // instalment has to be refrozen off the corrected record. But confirming the Joiners and
  // Resignations steps also STAMPS each of those people's Base, allowance, fuel and days worked
  // onto their draft row — and `buildEffective` treats a stored figure as an OVERRIDE that beats
  // the employee record. So the frozen number was cleared while the numbers it is derived FROM
  // survived, and re-confirming refroze the identical wrong answer. A rep hired on 10 August at
  // 5,000 instead of 8,000 stayed on the 5,000 after the record was fixed, the run reported
  // success, and the sheet showed the corrected salary beside an instalment computed from the old.
  //
  // Clearing is safe in the way finding 19's near-miss was not: `effectiveSalary` reads these
  // through `overrideBase != null`, so an absent figure RECOMPUTES. It does not read as zero.
  //
  // A figure HR typed by hand on those steps is cleared too, and that is the intended behaviour
  // rather than a cost worth avoiding: the reopen is a request to re-derive from the record, and a
  // typed value silently outliving it is the defect. The audit row names how many were cleared.
  const stampedCleared = draftRows.filter(
    (row) =>
      row.baseForMonth != null || row.ecolPaid != null || row.fuelPaid != null || row.daysWorked != null,
  ).length;

  const patches: DraftRowPatch[] = draftRows.map((row) => ({
    employeeHrId: row.employeeHrId,
    firstPartFrozen: null,
    // Cleared with the money it was frozen beside. Reopening exists so HR can correct the very
    // source data this decision was read from, and re-confirming freezes both again from current
    // truth. A stamp surviving the reopen would pin the run to the answer HR just corrected.
    settledInPart1: null,
    part1Withheld: null,
    // The joiner / leaver basis, re-derived on the next confirm.
    baseForMonth: null,
    ecolPaid: null,
    fuelPaid: null,
    daysWorked: null,
    editedBy: actorId(access),
    writeReason: "part1_reopened",
  }));
  // Under one claim with the phase write (audit finding 50): see claimTransition.
  const transition = await claimTransition(runId, ["part2"], "Reopening Part 1");
  const updated = await whileClaimed(runId, transition, async () => {
    await upsertDraftRows(runId, patches);
    // What confirming Part 1 (and any Part 2 confirm since) reserved of earlier months' held salary is
    // withdrawn with the freeze: re-confirming records it again from the figures as they then stand.
    await recordHeldReleases({ runId, actorHrId: actorId(access), stage: "part1_reopened", releases: [] });
    return updateRun(
      runId,
      { phase: "part1", part1ConfirmedAt: null, part1ConfirmedBy: null },
      { transitionToken: transition },
    );
  });
  await writeAutomatedPayrollAudit({
    runId,
    actorHrId: actorId(access),
    action: "part1_unconfirmed",
    detail: { unfrozenEmployees: patches.length, stampedBasisCleared: stampedCleared },
  });
  return updated;
}

/**
 * Reopen a Part-2-confirmed run back to Part 2 — THE WAY BACK, without which refusing step writes
 * in `ready` would trap the month.
 *
 * `ready` is the state in which the finance sheet and both bank files are downloadable, so the
 * honest assumption is that finance has them. Every step is refused in that state; this is the one
 * deliberate action that reopens it, and unlike a stale browser tab it says so on the record.
 *
 * IT UNDOES THIS RUN'S EFFECT ON THE CARRY-FORWARD LEDGER, for the same reason cancelling does.
 * Confirming Part 2 records this run's overpayments and consumes previous months' balances; a run
 * that is no longer confirmed has collected nothing, so leaving those marks would forgive real
 * money. Re-confirming records them again — `recordOverpaidCarryForward` is idempotent per run and
 * employee — and only UNAPPLIED balances are touched, so a later run's genuine recovery stands.
 *
 * Part 2 step confirmations are left intact, exactly as `unconfirmPart1` leaves Part 1's: they
 * recompute from current data on the next confirm, and HR should not have to click through every
 * tab again to correct one figure.
 */
export async function unconfirmPart2(access: AccessContext, runId: string): Promise<MonthlySalaryRun> {
  assertRealSessionForDecision(access, "reopen Part 2 of a payroll run");
  assertAutomatedPayrollHrActor(access);
  const run = await requireRun(runId);
  assertActiveRun(run);
  if (run.phase !== "ready") {
    throw new Error(
      "Conflict: Part 2 is not currently confirmed, so there is nothing to reopen.",
    );
  }

  // Under one claim with the phase write (audit finding 50): see claimTransition.
  const transition = await claimTransition(runId, ["ready"], "Reopening Part 2");
  const { ledger, updated } = await whileClaimed(runId, transition, async () => {
    const released = await releaseCarryForwardForCancelledRun(runId);
    const reopened = await updateRun(
      runId,
      { phase: "part2", part2ConfirmedAt: null, part2ConfirmedBy: null },
      { transitionToken: transition },
    );
    return { ledger: released, updated: reopened };
  });
  await writeAutomatedPayrollAudit({
    runId,
    actorHrId: actorId(access),
    action: "part2_unconfirmed",
    detail: { carryForwardReleased: ledger.released, carryForwardDiscarded: ledger.discarded },
  });
  // A decision parked after Part 2 was confirmed was waiting for exactly this (resync-outbox.ts).
  await landParkedResyncs(updated);
  return updated;
}

/** The audit action of the stamp row a Part 2 confirm writes inside its claim. */
const PART2_TOTALS_STAMP_ACTION = "part2_totals_stamped";

/**
 * The money totals stamped by the most recent Part 2 confirm on this run.
 *
 * FAILS CLOSED. A read error here is not "nothing to compare against" — it is not knowing whether
 * the month moved, and carrying on would silently disable the one check that catches it. A run
 * with no stamp returns null, and since 2026-10-23 every caller REFUSES on null rather than letting
 * it through (assertMatchesPart2Confirm): re-confirming Part 2 writes the stamp.
 */
async function readPart2ConfirmedTotals(runId: string): Promise<ConfirmedTotals | null> {
  return (await readPart2ConfirmedStamp(runId)).totals;
}

/**
 * The whole stamp: the totals, and since 2026-10-23 each person's bank fingerprint (null on a stamp
 * written before that — the month is then held to its totals alone). Fails closed like the totals.
 */
async function readPart2ConfirmedStamp(
  runId: string,
): Promise<{ totals: ConfirmedTotals | null; bankDetails: BankDetailsStamp | null }> {
  // The stamp row written inside the confirm's claim, and the older `part2_confirmed` row that
  // carried it before 2026-10-23. Both hold the same totals for the same confirm; the newest wins.
  const { data, error } = await getSupabaseAdmin()
    .from("automated_payroll_audit")
    .select("detail,created_at")
    .eq("run_id", runId)
    .in("action", [PART2_TOTALS_STAMP_ACTION, "part2_confirmed"])
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) {
    throw new Error(
      "Could not read what this run confirmed at Part 2, so publishing cannot prove it is writing " +
        `the same month finance was given. Nothing was published. (${error.message})`,
    );
  }
  const newest = (data ?? [])[0] as { detail?: unknown } | undefined;
  if (!newest) return { totals: null, bankDetails: null };
  return { totals: readConfirmedTotals(newest.detail), bankDetails: readConfirmedBankDetails(newest.detail) };
}

/** Confirm Part 2: assemble the full sheet, run the pre-flight gate, notify. */
export async function confirmPart2(
  access: AccessContext,
  runId: string,
  options: {
    acknowledgeOverpaidToken?: string | null;
    acknowledgeDataIssuesToken?: string | null;
    acknowledgePopulationDiffToken?: string | null;
  } = {},
): Promise<MonthlySalaryRun> {
  assertRealSessionForDecision(access, "confirm Part 2 of a payroll run");
  assertAutomatedPayrollHrActor(access);
  const run = await requireRun(runId);
  assertActiveRun(run);
  if (run.phase !== "part2") {
    throw new Error("Conflict: confirm Part 1 before Part 2 (or Part 2 is already confirmed).");
  }

  // NO DECISION LEFT BEHIND (risk review, 26 Oct). A deduction or expense resync that could not take
  // the run's hold is parked and retried on a back-off of up to an hour, so it can still be waiting
  // when HR confirms. Land this month's parked ones NOW, before any gate reads the steps: one that
  // re-opens a step is then refused by the step check below like any other re-opened step, and one
  // still parked after this is refused under the claim.
  await landParkedResyncs(run);

  const states = await listStepStates(runId);
  assertAllStepsConfirmed(states, PART2_STEP_KEYS);
  // A Part 1 deduction step a decision re-opened since Part 1 was confirmed has had its figure cleared,
  // and confirming now would pay the month without it (owner decision 2026-10-07, module-sourced-steps.ts).
  const reopenedPart1 = reopenedPart1DeductionSteps(states);
  if (reopenedPart1.length > 0) {
    throw new Error(`Conflict: ${describeReopenedPart1Block(reopenedPart1)}`);
  }

  // Same gate as Part 1, checked again here: the population can change between
  // the two confirms (someone hired, someone's record edited), so an employee
  // with missing data can appear after Part 1 was already accepted.
  {
    const period: PayrollPeriod = { month: run.month, year: run.year };
    const context = await loadRunContext(period, runId);
    await assertPayrollDataAcknowledged({
      access,
      run,
      members: context.members,
      sources: context.sources,
      draftRows: context.draftRows,
      acknowledgmentToken: options.acknowledgeDataIssuesToken,
    });
    await assertPopulationDiffAcknowledged({
      access,
      run,
      members: context.members,
      draftRows: context.draftRows,
      acknowledgmentToken: options.acknowledgePopulationDiffToken,
    });
  }

  const { rows, members: assembledMembers, draftRows: assembledDraftRows } = await assembleForRun(run);
  const { preflightValidate } = await import("./validate.ts");
  const preflight = preflightValidate(rows);
  if (!preflight.ok) {
    const sample = preflight.issues.slice(0, 6).map((issue) => `${issue.hrId ?? "?"}: ${issue.message}`);
    throw new Error(`Validation: fix ${preflight.errorCount} issue(s) before confirming Part 2. ${sample.join("; ")}`);
  }
  await assertHeldReleasesPayable(runId, assembledDraftRows, rows);

  // ONE ABSENCE DAY, CHARGED ONCE.
  //
  // The Deductions module refuses to publish a month where two detectors claim the same
  // employee-day, and payroll reads that module's approved candidates without ever running its
  // publish step — so for the money that reaches a payslip the rule was never enforced. Enforced
  // here, at the same strength the module uses and at the same moment as the other accuracy nets.
  //
  // NOT acknowledgeable, deliberately. Waving this through means charging somebody twice for one
  // day, and the module already treats it as something a human must clear rather than accept.
  // Which of the two claims is wrong is a judgement about what the person was doing that day, so
  // payroll cannot decide it — see day-collisions.ts.
  const dayCollisions = detectPayrollDayCollisions({
    members: assembledMembers,
    deductions: await loadConfirmedDeductions({ month: run.month, year: run.year }),
  });
  if (dayCollisions.length > 0) {
    throw new Error(`Conflict: ${describePayrollDayCollisions(dayCollisions)}`);
  }

  // THE RUN MUST PAY WHAT THE DEDUCTIONS MODULE SAYS TODAY, NOT WHAT IT SAID AT CONFIRM.
  //
  // Owner decision, 2026-10-06: a stale deduction BLOCKS this confirm rather than only warning on
  // the wizard. Confirming a module-sourced step copies the module's figure onto the run's own row
  // and `assembleRows` reads that copy, so under the push gate a figure goes stale by the ORDINARY
  // order of work — Part 1 confirmed, the lines pushed days later, the run still carrying the zero
  // it froze. The September 2026 run was exactly that: all ten Part 1 steps confirmed 2026-09-24,
  // every push on 2026-10-06, 3,333.32 EGP of fingerprint deductions listed in the step's own
  // breakdown and charged nowhere. `deduction-resync.ts` prevents the state from here on; this is
  // the gate for a run that reached Part 2 already in it.
  //
  // Only `staleCharges` blocks — a figure somebody typed by hand is their decision, still wins, and
  // is reported beside the refusal without causing one. Not acknowledgeable: the remedy is to
  // re-confirm the named step, which is an ordinary action (a Part 1 step stays confirmable while
  // the run is in Part 2), not a judgement call to wave through.
  const moduleDrift = await getModuleDrift(access, runId);
  if (moduleDrift.staleCharges > 0) {
    throw new Error(`Conflict: ${describeModuleDriftBlock(moduleDrift)}`);
  }

  // ONE DEDUCTION, IN ONE INSTALMENT.
  //
  // `isSettledInPart1` keeps the Part 1 and Part 2 deduction populations disjoint, and from
  // `confirmPart1` onward its answer is stamped on the row rather than re-read. That closes the way
  // this state was created: a payment mode corrected between the two confirms used to leave a loan
  // in the Part 1 column from before and offer it again on the Part 2 step.
  //
  // This is the backstop for rows that predate the stamp, and for whatever other route into the
  // same state nobody has found yet. Not acknowledgeable: which instalment should keep the charge
  // is a decision about this employee, not something a payroll run may pick.
  const partSplitConflicts = findPartSplitConflicts(await listDraftRows(runId));
  if (partSplitConflicts.length > 0) {
    throw new Error(`Conflict: ${describePartSplitConflicts(partSplitConflicts)}`);
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
  if (totals.overpaid.length > 0) {
    const totalResidual = roundCurrency(totals.overpaid.reduce((sum, row) => sum + row.residual, 0));
    const sample = totals.overpaid.slice(0, 5).map((row) => `${row.hrId}: ${row.residual}`);
    requireAcknowledgment({
      runId: run.id,
      gate: "overpaid",
      marker: OVERPAID_ACK_REQUIRED,
      actorHrId: actorId(access),
      warning:
        `${totals.overpaid.length} employee(s) were overpaid in Part 1 by a ` +
        `total of ${totalResidual} (Part 2 deductions exceeded their already-paid first installment). ` +
        `Acknowledge to confirm and carry these balances forward to next month. ${sample.join("; ")}`,
      token: options.acknowledgeOverpaidToken,
    });
  }

  // ---- carry-forward ledger settlement (owner decision 2026-07-25) ----------
  // Order matters. First close out what this run RECOVERED (those balances were
  // already deducted in `rows` above, so they are genuinely settled), then
  // record what this run newly OVERPAID. Doing it in this order means a run
  // that both recovers an old debt and creates a new one leaves the ledger in
  // the right state instead of immediately re-consuming its own fresh entry.
  //
  // Derive what was recovered from the ASSEMBLED ROWS, not from the ledger map.
  //
  // carryForwardByCompact is the list of outstanding debts — it is scoped only by
  // "unapplied, not from this run", with no population filter. The money is only actually
  // charged inside assembleRows, which iterates the run's members; loadRunContext has
  // already stripped excluded employees, and a departed employee is no longer in the
  // population at all. So marking every key in that map as applied settled debts for people
  // this run never deducted from — the balance was written off, silently, which is precisely
  // the loss the carry-forward ledger exists to prevent.
  //
  // Held rows are the worse case: they DO assemble (so the deduction appears on the sheet)
  // but publishToPayslips drops them (`rows.filter((entry) => !entry.onHold)`), so no salary
  // record is ever written while the debt already reads as settled.
  //
  // AssembledRow.carriedForwardApplied is set by assembleRows for exactly this purpose.
  //
  // NOTHING IS SETTLED HERE ANY MORE (2026-09-10). A balance is marked recovered at PUBLISH, from
  // the rows actually published — see carry-forward.ts for the full account. Settling at confirm
  // marked a debt collected against money that had not been written yet, and the finance sheet,
  // the FAB file and the CIB file each re-assembled without the ledger, so none of the three
  // artifacts finance executes carried the deduction. This count is reported so the audit still
  // says what the run intends to recover; it is a statement of intent, not of settlement.
  const carryForwardPendingRecovery = rows.filter(
    (entry) => entry.carriedForwardApplied > 0 && !entry.onHold && Boolean(entry.compact),
  ).length;
  // Recorded and confirmed under one claim (audit finding 50): see claimTransition.
  const transition = await claimTransition(runId, ["part2"], "Confirming Part 2");
  const confirmedTotals = part2Totals(rows.length, totals);
  const confirmedBankDetails = part2BankDetails(runId, rows);
  const { carryForwardRecorded, updated } = await whileClaimed(runId, transition, async () => {
    // Under the claim nothing can land or be parked against this run's hold, so this is the last word: a
    // decision still parked (it failed again, or arrived after the landing above) has NOT reached these
    // figures, and confirming would pay the old ones. A queue that cannot be read refuses too.
    let parked: ParkedPayrollResync[];
    try {
      parked = await queuedPayrollResyncsForPeriod(run.month, run.year);
    } catch {
      throw new Error(
        "Conflict: could not check whether a deduction or expense decision is still waiting to reach this run. " +
          "Nothing was confirmed; confirm Part 2 again in a minute.",
      );
    }
    const parkedRefusal = describeParkedResyncRefusal(parked);
    if (parkedRefusal) throw new Error(parkedRefusal);

    // THE STAMP IS THE SHEET THE RUN HOLDS NOW (audit 2026-10-23, F-08a). The gates above read the run
    // before the claim; a step save or a Deductions resync that finished in between would leave the
    // stamp describing a month the run no longer holds. Under the claim nothing else can write, so one
    // more assembly settles it: a difference refuses, and nothing has been written yet.
    const { rows: rowsUnderClaim } = await assembleForRun(run);
    const movedWhileConfirming = compareConfirmedTotals(
      confirmedTotals,
      part2Totals(rowsUnderClaim.length, reconcile(rowsUnderClaim)),
    );
    const bankMovedWhileConfirming = compareBankDetails(
      confirmedBankDetails,
      part2BankDetails(runId, rowsUnderClaim),
    );
    if (movedWhileConfirming.length > 0 || bankMovedWhileConfirming.length > 0) {
      throw new Error(
        "Conflict: this run changed while Part 2 was being confirmed (a step was saved or a deduction or " +
          "expense decision reached it). Nothing was confirmed; confirm Part 2 again.",
      );
    }
    // THE STAMP IS WRITTEN FIRST, AND IT MUST LAND (audit 2026-10-23, S-PAY-08). It used to ride on the
    // best-effort audit row written after the claim, so a lost insert left a `ready` run with no stamp —
    // and publish then skipped the comparison. Publish and every Part 2 bank file now refuse without it,
    // so it is required here, inside the claim, and before the ledger: a stamp that cannot be written
    // leaves no overpayment recorded as a debt for another run to collect.
    await writeRequiredAutomatedPayrollAudit({
      runId,
      actorHrId: actorId(access),
      action: PART2_TOTALS_STAMP_ACTION,
      detail: { [PART2_TOTALS_KEY]: confirmedTotals, [PART2_BANK_DETAILS_KEY]: confirmedBankDetails },
    });
    const recorded = await recordOverpaidCarryForward({ runId, rows, actorHrId: actorId(access) });
    // RESERVE THE HELD SALARY THIS MONTH RELEASES, before the run is ready: from here the Part 2 bank
    // files can pay it, so another run or the held-salary sheet must no longer see it as owed.
    await recordHeldReleases({
      runId,
      actorHrId: actorId(access),
      stage: "part2_confirmed",
      releases: heldReleasesOf(rowsUnderClaim),
    });
    const confirmed = await updateRun(
      runId,
      { phase: "ready", part2ConfirmedAt: nowIso(), part2ConfirmedBy: actorId(access) },
      { transitionToken: transition },
    );
    return { carryForwardRecorded: recorded, updated: confirmed };
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
      // Intent, not settlement — the ledger is marked at publish now.
      carryForwardPendingRecovery,
      carryForwardRecorded,
      // THE SHEET FINANCE IS ABOUT TO EXECUTE, recorded so publish can prove it is writing the
      // same month. Publish re-assembles from CURRENT data rather than from anything stored, so
      // without a stamp there is nothing for it to disagree with. See publishToPayslips.
      [PART2_TOTALS_KEY]: confirmedTotals,
      // Carried here too: readPart2ConfirmedStamp takes the NEWEST of the two rows, and this one is
      // written after the stamp row, so without the fingerprints it would switch the bank check off.
      [PART2_BANK_DETAILS_KEY]: confirmedBankDetails,
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
  draftRows: DraftRow[];
}> {
  const period: PayrollPeriod = { month: run.month, year: run.year };
  const [{ members, sources, draftRows, releaseOnlyMembers }, carryForwardByCompact, statutoryConfig, insuranceWages] =
    await Promise.all([
      loadRunContext(period, run.id),
      // Overpayments from PREVIOUS runs that this run recovers (owner rule
      // 2026-07-25). Loaded on every assemble so the figure HR reviews, the
      // figure on the sheet, and the figure that gets published are the same one.
      //
      // `carryForwardForRunAssembly`, not `outstandingCarryForwardFor`: a published run has to
      // assemble against the balances it ITSELF applied, or a sheet re-downloaded after publish
      // quietly loses a deduction that the real payslip carries.
      carryForwardForRunAssembly(run.id),
      // The rates and caps as they stood in the month being run, not as they stand today — the
      // ceiling is revised most years and a re-assembled old month must file at its own.
      getStatutoryConfigForPeriod(period),
      loadInsuranceWages(),
    ]);
  const rows = assembleRows({
    members,
    sources,
    draftRows,
    period,
    carryForwardByCompact,
    statutory: { config: statutoryConfig, insuranceWages },
    // Once Part 1 is executed money, an employee with no frozen first part
    // joined the run after the freeze — they must not have one recomputed for
    // them, because that silently moves a total finance already paid.
    part1Confirmed: run.part1ConfirmedAt != null,
    // Leavers paid only an earlier month's held salary (Held Salary Release, 2026-10-26).
    releaseOnlyMembers,
  });
  return { rows, members, carryForwardByCompact, draftRows };
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
  const { data: leavers, error: leaversError } = await getSupabaseAdmin()
    .from("employee_resignations")
    .select("employee_hr_id")
    .lte("last_working_date", end);
  // A failed read used to leave this set empty, which turned every legitimate leaver into
  // "disappeared" (audit finding 46). A refusal beats a panel of false alarms.
  if (leaversError) throw leaversError;
  const leaverCompacts = new Set(
    ((leavers ?? []) as Array<{ employee_hr_id: string | null }>)
      .map((row) => compactHrKey(row.employee_hr_id ?? ""))
      .filter(Boolean),
  );

  const roster = ((data ?? []) as Array<{ hr_id: string | null; full_name: string | null }>)
    .map((row) => {
      const hrId = row.hr_id ?? "";
      const compact = compactHrKey(hrId);
      return { hrId, compact, fullName: row.full_name ?? hrId, wasLeaver: leaverCompacts.has(compact) };
    })
    .filter((entry) => entry.compact);

  // LAST MONTH'S HELD PEOPLE BELONG IN THE BASELINE (audit finding 46). A held row is dropped at publish,
  // so salary_records never lists them, and someone held last month read as "joined" this month beside
  // the real new hires. Named from publish's own record where it kept one, and from the run's draft rows
  // where it kept only a count (July and August 2026).
  const onRoster = new Set(roster.map((entry) => entry.compact));
  const holdRecord = await readPublishedHoldRecord(prevRun.id);
  const heldPeople = holdRecord.held
    ? holdRecord.held.map((person) => ({ hrId: person.hrId, fullName: person.name }))
    : await heldPeopleFromDrafts(prevRun.id);
  for (const person of heldPeople) {
    const compact = compactHrKey(person.hrId);
    if (!compact || onRoster.has(compact)) continue;
    onRoster.add(compact);
    roster.push({ hrId: person.hrId, compact, fullName: person.fullName, wasLeaver: leaverCompacts.has(compact) });
  }
  return roster;
}

/** A run's held HR ids from its draft rows, named from the employee directory (compact-keyed: HR ids are mixed case). */
/**
 * Every employee's name, keyed the one way HR ids compare safely here — lower-cased with the
 * punctuation stripped, because the ids are stored in mixed case and a raw `.eq` under-returns.
 */
async function employeeNamesByCompactKey(): Promise<Map<string, string>> {
  // The whole master, page by page: a name cut off by a response ceiling would read as a blank in a
  // payroll note about a held person.
  const data = await fetchAllRows<{ hr_id: string | null; full_name: string | null }>(
    () => getSupabaseAdmin().from("employees").select("hr_id,full_name"),
    "hr_id",
  );
  return new Map(
    data.map((row) => [
      compactHrKey(row.hr_id ?? ""),
      row.full_name ?? "",
    ]),
  );
}

/**
 * Every recorded change to one employee's cells on a run, each naming who made it — a person's name,
 * or "system" for a resync after a Deductions push or an expense change. Read-only.
 */
export async function getDraftCellHistory(
  access: AccessContext,
  runId: string,
  hrId: string,
): Promise<DraftCellChange[]> {
  assertAutomatedPayrollHrActor(access);
  await requireRun(runId);
  const changes = await listDraftCellHistory(runId, hrId);
  if (changes.length === 0) return changes;
  const names = await employeeNamesByCompactKey();
  return changes.map((change) => ({
    ...change,
    changedByName:
      change.changedBy && change.changedBy !== "system"
        ? names.get(compactHrKey(change.changedBy)) || null
        : null,
  }));
}

async function heldPeopleFromDrafts(runId: string): Promise<Array<{ hrId: string; fullName: string }>> {
  const hrIds = await heldDraftHrIds(runId);
  if (hrIds.length === 0) return [];
  const names = await employeeNamesByCompactKey();
  return hrIds.map((hrId) => ({ hrId, fullName: names.get(compactHrKey(hrId)) || hrId }));
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
/**
 * Who this run is NOT paying, and why — the pre-publish held-employee review.
 *
 * Reads the hold step through `recommendStep`, the same call `confirmStep` makes,
 * so the panel shows exactly the reasons the confirm gate will judge. Deriving
 * them separately from the draft columns would be cheaper and would reintroduce
 * the drift that `hold-reason.ts` exists to prevent.
 *
 * `p2_holds` rather than `p1_holds`: both hold steps read and write the one
 * `on_hold` / `hold_reason` pair on the draft row, so either returns identical
 * hold data, and Part 2 is the one a reviewer is standing in before publishing.
 */
export async function getHoldReview(access: AccessContext, runId: string): Promise<HoldReview> {
  assertAutomatedPayrollHrActor(access);
  const run = await requireRun(runId);
  const period: PayrollPeriod = { month: run.month, year: run.year };
  const { members, sources, draftRows } = await loadRunContext(period, runId);
  const rows = await recommendStep({ access, period, stepKey: "p2_holds", members, sources, draftRows });
  return buildHoldReview({ period, rows });
}

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

/**
 * Employees whose pay-determining data is missing or ambiguous on this run
 * (owner-reported 2026-08-04 — see data-quality.ts for the four defects and the
 * live evidence behind each). Read-only; the acknowledgement gate lives on the
 * two confirm paths.
 */
export async function getPayrollDataQuality(
  access: AccessContext,
  runId: string,
): Promise<PayrollDataQualityReport> {
  assertAutomatedPayrollHrActor(access);
  const run = await requireRun(runId);
  const period: PayrollPeriod = { month: run.month, year: run.year };
  const [{ members, sources, draftRows }, insuranceWages, notCompanyInsured] = await Promise.all([
    loadRunContext(period, runId),
    loadInsuranceWages(),
    loadNotCompanyInsured(),
  ]);
  return auditPayrollDataQuality({
    members,
    sources,
    draftRows,
    part1Confirmed: run.part1ConfirmedAt != null,
    insuranceWages,
    notCompanyInsured,
  });
}

/**
 * Drop one employee from THIS run's population entirely (every step, the
 * data-quality audit, and assembly/pre-flight) — never their master employee
 * record, never another run. Exists for the one case the data-quality
 * acknowledgement gate can't cover: a row whose derived Gross Salary is <= 0
 * hard-blocks Part 2 confirmation for the whole run via preflightValidate, with
 * no acknowledge-and-proceed option (owner-reported 2026-08-08, a same-day
 * hire/termination whose master record carries only allowances, no base).
 *
 * A reason is required so the decision is on the record, same convention as
 * `manualReason`/`holdReason`.
 *
 * Refused once Part 1 has frozen a first instalment above zero for this person
 * (audit finding 39): that money is already being paid, and excluding them would
 * erase it from every output of the month. See `exclusionRefusal`.
 */
export async function excludeEmployeeFromRun(
  access: AccessContext,
  runId: string,
  hrId: string,
  reason: string,
): Promise<void> {
  assertRealSessionForDecision(access, "exclude an employee from a payroll run");
  assertAutomatedPayrollHrActor(access);
  const run = await requireRun(runId);
  assertActiveRun(run);
  assertNoTransitionInProgress(run);
  const compact = compactHrKey(hrId);
  if (!compact) throw new Error("Validation: a valid HR ID is required.");
  const trimmedReason = reason.trim();
  if (!trimmedReason) throw new Error("Validation: a reason is required to exclude an employee from this run.");

  if (run.part1ConfirmedAt) {
    const draft = (await listDraftRows(runId)).find((row) => row.employeeHrIdCompact === compact);
    const refusal = exclusionRefusal({ part1ConfirmedAt: run.part1ConfirmedAt, firstPartFrozen: draft?.firstPartFrozen });
    if (refusal) throw new Error(refusal);
  }

  await holdRun({ runId, expected: [run.phase], action: RUN_HOLD_ACTIONS.exclude }, () =>
    upsertDraftRows(runId, [
      {
        employeeHrId: hrId,
        excluded: true,
        excludedReason: trimmedReason,
        editedBy: actorId(access),
        writeReason: "employee_excluded",
      },
    ]),
  );
  await writeAutomatedPayrollAudit({
    runId,
    actorHrId: actorId(access),
    action: "employee_excluded_from_run",
    detail: { hrId, reason: trimmedReason },
  });
}

/** Reverse excludeEmployeeFromRun — the employee re-enters the run's population. */
export async function includeEmployeeInRun(access: AccessContext, runId: string, hrId: string): Promise<void> {
  assertRealSessionForDecision(access, "put an employee back into a payroll run");
  assertAutomatedPayrollHrActor(access);
  const run = await requireRun(runId);
  assertActiveRun(run);
  assertNoTransitionInProgress(run);
  const compact = compactHrKey(hrId);
  if (!compact) throw new Error("Validation: a valid HR ID is required.");

  await holdRun({ runId, expected: [run.phase], action: RUN_HOLD_ACTIONS.include }, () =>
    upsertDraftRows(runId, [
      {
        employeeHrId: hrId,
        excluded: false,
        excludedReason: null,
        editedBy: actorId(access),
        writeReason: "employee_included",
      },
    ]),
  );
  await writeAutomatedPayrollAudit({
    runId,
    actorHrId: actorId(access),
    action: "employee_included_in_run",
    detail: { hrId },
  });
}

// ---- Publish (separate, Super-Admin-only) -----------------------------------

/**
 * Move the batch to `approved`, and PROVE it happened.
 *
 * The `.eq("status", "uploaded")` is a real concurrency guard and stays. What was missing is that a
 * zero-row match returns no error: if anything moved the batch between the create and this update —
 * a second publisher, the old payroll module's workflow — the update quietly changed nothing and
 * publish went on to mark the run published anyway. Payslips are only visible for an approved
 * batch, so the month would then exist with no payslips, and re-publishing returns early forever
 * because the run already reads as published. The month becomes permanently unpublishable.
 *
 * Returns the batch's status as it now stands, so the caller can refuse rather than assume.
 */
async function finalizeApproved(batchId: string, actorHrId: string): Promise<string | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("salary_batches")
    .update({ status: "approved", approved_at: nowIso(), approved_by: actorHrId })
    .eq("id", batchId)
    .eq("status", "uploaded")
    .select("status");
  if (error) throw error;
  if ((data ?? []).length > 0) return "approved";

  // Nothing matched. Read what the batch actually is now — it may already be approved (a retry of
  // an interrupted publish, which is fine) or something else entirely (which is not).
  const { data: current, error: readError } = await getSupabaseAdmin()
    .from("salary_batches")
    .select("status")
    .eq("id", batchId)
    .maybeSingle();
  if (readError) throw readError;
  return (current as { status?: string } | null)?.status ?? null;
}

/** Refuse to call a run published over a batch that is not approved. */
function assertBatchApproved(status: string | null, batchId: string): void {
  if (status === "approved" || status === "locked") return;
  throw new Error(
    `Conflict: the salary batch ${batchId} is "${status ?? "missing"}", not approved, so no payslip would be ` +
      "visible. Publishing was stopped rather than marking the run published over it — a run that reads " +
      "as published can never be published again.",
  );
}

export type PublishResult = {
  run: MonthlySalaryRun;
  batchId: string;
  publishedCount: number;
  heldExcluded: number;
};

/**
 * What a publishing month pays LATER, for the published audit row (owner, 2026-10-26). Pure.
 *
 * - part1Unpaid: paid this month's Part 2 but NOT its Part 1 — held when Part 1 was confirmed, released
 *   by Part 2. Owed to them, and the next month's Held Salary Release offers it.
 * - deferred: pay moved off this month's Part 1 or Part 2 by Defer Pay, owed again in the month HR
 *   chose for it. Part 1's is owed even on a row held at Part 2: Part 1 was paid without it either way.
 *
 * Otherwise a row still on hold is in the held record instead, never in either list.
 */
function owedLaterRecords(
  rows: AssembledRow[],
  draftRows: DraftRow[],
  period: { month: number; year: number },
): {
  part1Unpaid: { hrId: string; name: string; amount: number }[];
  deferred: { hrId: string; name: string; amount: number; releaseIn: string }[];
} {
  const part1Unpaid = rows
    .filter((entry) => !entry.onHold && entry.part1Withheld === true && entry.row.firstPart > 0)
    .map((entry) => ({ hrId: entry.row.hrId, name: entry.row.fullName, amount: roundCurrency(entry.row.firstPart) }));
  const draftByCompact = new Map(draftRows.map((draft) => [draft.employeeHrIdCompact, draft]));
  const releaseIn = (month: string | null | undefined) =>
    monthKeyAfter(period.month, period.year, month === "after_next" ? 2 : 1);
  const deferredPart1 = rows
    .filter((entry) => entry.payDeferralPart1Applied > 0)
    .map((entry) => ({
      hrId: entry.row.hrId,
      name: entry.row.fullName,
      amount: roundCurrency(entry.payDeferralPart1Applied),
      releaseIn: releaseIn(draftByCompact.get(entry.compact)?.payDeferralP1Month),
    }));
  const deferredPart2 = rows
    .filter((entry) => !entry.onHold && entry.payDeferralApplied > 0)
    .map((entry) => ({
      hrId: entry.row.hrId,
      name: entry.row.fullName,
      amount: roundCurrency(entry.payDeferralApplied),
      releaseIn: releaseIn(draftByCompact.get(entry.compact)?.payDeferralMonth),
    }));
  return { part1Unpaid, deferred: [...deferredPart1, ...deferredPart2] };
}

/**
 * Publish the confirmed run to payslips. Deliberate, Super-Admin-only. Held
 * employees are excluded (no payslip until released). Guards against a foreign
 * batch already claiming the month; idempotent if this run already published.
 */
export async function publishToPayslips(access: AccessContext, runId: string): Promise<PublishResult> {
  assertRealSessionForDecision(access, "publish a payroll run to payslips");
  assertAutomatedPayrollPublisher(access);
  const run = await requireRun(runId);

  if (run.phase === "published" && run.publishedBatchId) {
    return { run, batchId: run.publishedBatchId, publishedCount: 0, heldExcluded: 0 };
  }
  if (run.phase !== "ready") {
    throw new Error("Conflict: confirm Part 2 before publishing to payslips.");
  }

  const { rows, draftRows: publishDraftRows } = await assembleForRun(run);
  const heldRows = rows.filter((entry) => entry.onHold);
  const heldExcluded = heldRows.length;
  const publishRows = rows.filter((entry) => !entry.onHold).map((entry) => entry.row);
  if (publishRows.length === 0) {
    throw new Error("Conflict: no publishable employees (all rows are held or empty).");
  }

  // THE GATES RUN AGAIN, HERE, AGAINST THE ROWS ABOUT TO BE WRITTEN.
  //
  // Publish re-assembles every row live from current employee, deduction and expense data, and
  // until now checked nothing but the run's phase. So anything that moved between Part 2 confirm
  // and this click — a corrected salary, a new deduction, an expense approved this morning — was
  // written to the payslip while finance had already executed bank files built from the older
  // figures. The employee's payslip and their transfer disagreed, and nothing recorded it.
  const { preflightValidate: preflightAtPublish } = await import("./validate.ts");
  const publishPreflight = preflightAtPublish(rows);
  if (!publishPreflight.ok) {
    const sample = publishPreflight.issues
      .slice(0, 6)
      .map((issue) => `${issue.hrId ?? "?"}: ${issue.message}`);
    throw new Error(
      `Validation: ${publishPreflight.errorCount} issue(s) in the rows about to be published. ` +
        `${sample.join("; ")} (These passed at Part 2 confirm, so something has changed since.)`,
    );
  }
  await assertHeldReleasesPayable(runId, publishDraftRows, rows);

  const publishTotals = reconcile(rows);
  if (publishTotals.splitMismatches.length > 0) {
    const sample = publishTotals.splitMismatches
      .slice(0, 5)
      .map((one) => `${one.hrId}: ${one.firstPart} + ${one.secondPart} != ${one.monthSalary}`);
    throw new Error(
      `Conflict: the split does not reconcile for ${publishTotals.splitMismatches.length} row(s) ` +
        `about to be published. ${sample.join("; ")}`,
    );
  }

  // Refuses when the month moved since Part 2 confirm AND when there is no stamp at all (audit
  // 2026-10-23, S-PAY-08): "could not compare" used to publish, recording only that it had not checked.
  // The one exception is a run confirmed before the stamp existed (2026-09-11), which never had one.
  const confirmedStamp = await readPart2ConfirmedTotals(runId);
  const predatesStamp = !confirmedStamp && confirmedBeforeStampExisted(run.part2ConfirmedAt);
  if (!predatesStamp) {
    assertMatchesPart2Confirm(confirmedStamp, part2Totals(rows.length, publishTotals), "publish");
  }

  // WHAT EACH HELD PERSON WAS OWED, recorded permanently at the moment they are dropped.
  //
  // Publishing filters held rows out, so no salary_record is written for them and the payslip
  // screens show nothing. Until now the only trace was a COUNT in this run's audit row plus a
  // free-text reason on a staging row that the next run overwrites — so a month later there was
  // no way to answer "who was held in August, for how much, and why". Production carried 20 such
  // people in August holding EGP 260,904 of already-paid first instalment, 18 of them with a hold
  // reason of a single dash.
  //
  // This is the whole roster, with money, captured from the same assembled rows publish itself
  // used — so it can never disagree with what was published. It is a record of a decision, not a
  // payment: nothing here pays anybody, and a held person is still settled outside the system.
  const heldRecord = heldRows
    .map((entry) => ({
      hrId: entry.row.hrId,
      name: entry.row.fullName,
      // assembleRows already puts a held row's hold reason in payrollComment, falling back to an
      // explicit "no reason given" marker — so this is the same string the sheet shows.
      reason: (entry.row.payrollComment ?? "").trim() || null,
      // The first instalment has ALREADY left the company — unless they were held at Part 1 confirm,
      // when the Part 1 bank files left them out and it is still owed (owner, 2026-10-26). A run
      // confirmed before that was recorded keeps the old reading, "already paid". The second is what
      // this publish would have paid and did not. All are needed to settle the person by hand.
      firstPartAlreadyPaid: entry.part1Withheld === true ? 0 : roundCurrency(entry.row.firstPart),
      firstPartWithheld: entry.part1Withheld === true ? roundCurrency(entry.row.firstPart) : 0,
      // A held row releases no earlier held salary in Part 2 (assemble.ts); a Part 1 release paid before
      // the hold is inside firstPartAlreadyPaid. So the Part 2 figure is this month's own.
      secondPartWithheld: roundCurrency(entry.row.secondPart),
      monthTotal: roundCurrency(entry.row.monthSalary),
      // The filing figures too (audit finding 43): a held person has no salary record, so the statutory
      // summary can only name what they would have filed if publish writes it down here.
      socialInsurance: roundCurrency(entry.row.socialInsurance),
      employmentIncomeTax: roundCurrency(entry.row.employmentIncomeTax),
    }))
    .sort((a, b) => b.secondPartWithheld - a.secondPartWithheld);
  const heldSecondPartTotal = roundCurrency(
    heldRecord.reduce((sum, entry) => sum + entry.secondPartWithheld, 0),
  );
  const heldFirstPartTotal = roundCurrency(
    heldRecord.reduce((sum, entry) => sum + entry.firstPartAlreadyPaid, 0),
  );
  // Counted, not corrected. A reason of "-" satisfies every existing check and answers nothing;
  // production carried 18 of them in one month. Naming the count here makes it visible without
  // this publish inventing a policy about what a good reason looks like.
  const heldWithoutMeaningfulReason = heldRecord.filter(
    (entry) => !entry.reason || /^[\s\-–—.]*$/.test(entry.reason),
  ).length;
  const { part1Unpaid, deferred } = owedLaterRecords(rows, publishDraftRows, run);

  // Who the bank files carry and who they do not, for both instalments, captured at the one
  // moment the month becomes final. See exports/bank-coverage.ts.
  const nonEmployeesForCoverage = await getNonEmployeePayrollRows(run.id);
  const bankCoverage = (["part1", "part2"] as const).map((scope) =>
    buildBankCoverage({ rows, nonEmployees: nonEmployeesForCoverage, scope }),
  );

  // From the batch to the phase, under one claim (audit finding 50): see claimTransition. A cancel racing
  // publish used to write `cancelled` over `published` and un-mark the debts it had just recovered.
  const transition = await claimTransition(runId, ["ready"], "Publishing to payslips");
  // What already landed, so a lost claim can say what exists instead of "nothing was written". Publish is
  // the one transition that writes REAL MONEY before its phase write: by the time the run is marked, the
  // salary records exist, the batch is approved and the carry-forward ledger is settled.
  let batchAlreadyWritten: string | null = null;
  // What happened to the batch on the way, for the publish audit row: a leftover batch replaced because
  // its records were not this run's, or a create whose own follow-up threw after the batch was written.
  const batchNotes: Record<string, unknown> = {};
  const published = await whileClaimed(runId, transition, async () => {
    const ownFileName = `automated-payroll:${runId}`;
    let existing = await findSalaryBatchForPeriod(run.month, run.year);

    if (!existing) {
      // A CREATE THAT THROWS MAY STILL HAVE WRITTEN THE BATCH (audit 2026-10-23, F-18). The batch and
      // its records are committed by one database call; the record check and the required audit row
      // come after it and can throw. Reporting that as "publish failed" left a batch behind and sent
      // the next click down the leftover-batch path below. So look: if our batch exists, carry on and
      // prove its records the same way a retry does; if it does not, the create really failed.
      try {
        await createSalaryBatch({
          records: publishRows,
          month: run.month,
          year: run.year,
          fileName: ownFileName,
          uploadedBy: actorId(access),
          validationWarnings: [],
        });
      } catch (createError) {
        const written = await findSalaryBatchForPeriod(run.month, run.year);
        if (!written || written.fileName !== ownFileName) throw createError;
        batchNotes.createFollowUpError = createError instanceof Error ? createError.message : String(createError);
        logError("Automated payroll: the salary batch was written but its create reported an error", {
          labels: { event: "automated_payroll_batch_create_follow_up_failed", runId, batchId: written.id },
          error: createError,
        });
      }
      existing = await findSalaryBatchForPeriod(run.month, run.year);
      if (!existing) {
        throw new Error("Conflict: the salary batch could not be read back after it was created. Nothing was published.");
      }
    }

    if (existing.fileName !== ownFileName) {
      throw new Error(
        `Conflict: a payroll batch already exists for ${run.month}/${run.year} ("${existing.fileName}"). Resolve it in the existing payroll tools before publishing here.`,
      );
    }
    const batchId = existing.id;
    batchAlreadyWritten = batchId;

    // OUR OWN BATCH IS FINALISED ONLY WHEN ITS RECORDS ARE THIS RUN'S (audit 2026-10-23, S-PAY-09).
    // A batch left by an earlier, interrupted publish was approved as it stood, so a partial batch, or
    // one written before the month moved, became the month's payslips. Every record is compared with
    // the rows this publish would write: every column, every person, and nobody extra.
    const { all: mismatches, money: moneyMismatches } = await compareSalaryBatchRecords(batchId, publishRows);
    const alreadyLive = existing.status === "approved" || existing.status === "locked";
    if (alreadyLive && moneyMismatches.length > 0) {
      throw new Error(
        `Conflict: salary batch ${batchId} for this run is already "${existing.status}" (its payslips are live) and ` +
          `what it pays differs from the confirmed month (${moneyMismatches.slice(0, 5).join("; ")}). Nothing was ` +
          "published. Do not publish this run again: the batch has to be reconciled by hand first.",
      );
    }
    if (alreadyLive && mismatches.length > 0) {
      // Payslips already live and every figure and person matches; only a name, title, area, line, hire
      // date or comment moved in the directory between the two attempts. Not a reason to strand the month
      // half-published — finish it, and write down what differs.
      batchNotes.liveBatchDescriptiveDifferences = { differences: mismatches.length, sample: mismatches.slice(0, 10) };
    } else if (mismatches.length > 0) {
      if (!isReplaceableSalaryBatch(existing)) {
        throw new Error(
          `Conflict: salary batch ${batchId} for this run is "${existing.status}" and its records differ ` +
            `from the confirmed month (${mismatches.slice(0, 5).join("; ")}). Nothing was published. Do not ` +
            "publish this run again: the batch has to be reconciled by hand first.",
        );
      }
      // Still editable: rewrite it with this run's rows, then prove the rewrite before finalising it.
      try {
        await replaceSalaryBatch(batchId, {
          records: publishRows,
          fileName: ownFileName,
          uploadedBy: actorId(access),
          validationWarnings: [],
        });
      } catch (replaceError) {
        // Same shape as the create: the rewrite commits first and checks after, so the comparison below
        // is the answer, not this error.
        batchNotes.replaceFollowUpError = replaceError instanceof Error ? replaceError.message : String(replaceError);
      }
      const { all: stillDifferent } = await compareSalaryBatchRecords(batchId, publishRows);
      if (stillDifferent.length > 0) {
        throw new Error(
          `Conflict: salary batch ${batchId} could not be brought in line with this run ` +
            `(${stillDifferent.slice(0, 5).join("; ")}). Nothing was published.`,
        );
      }
      batchNotes.replacedLeftoverBatch = {
        batchId,
        status: existing.status,
        differences: mismatches.length,
        sample: mismatches.slice(0, 10),
      };
    }

    // Any non-approved leftover is finalised, not just an "uploaded" one, and the result is checked.
    // Skipping this for every other status is what let a run be marked published over a batch nobody
    // could see.
    const status =
      existing.status === "approved" || existing.status === "locked"
        ? existing.status
        : await finalizeApproved(batchId, actorId(access));
    assertBatchApproved(status, batchId);

    // SETTLE THE CARRY-FORWARD LEDGER HERE, from the rows that were actually published. Held rows
    // are excluded because no salary record was written for them, so their debt was collected from
    // nobody. This used to happen at Part-2 confirm, which marked balances recovered against money
    // that had not been written yet — see carry-forward.ts.
    const carryForwardRecovered = await markCarryForwardApplied({
      runId,
      appliedCompacts: rows
        .filter((entry) => entry.carriedForwardApplied > 0 && !entry.onHold)
        .map((entry) => entry.compact)
        .filter((compact): compact is string => Boolean(compact)),
    });

    // RECORD WHAT THIS RUN RELEASED OF AN EARLIER MONTH'S HELD SALARY, from the rows actually published
    // — the same rule as the carry-forward above. It REPLACES what Part 2 confirm reserved, so a retried
    // publish writes the same record again rather than a second one.
    const heldReleased = await recordHeldReleases({
      runId,
      actorHrId: actorId(access),
      stage: "published",
      releases: heldReleasesOf(rows),
    });

    const updated = await updateRun(
      runId,
      { phase: "published", publishedBatchId: batchId, publishedAt: nowIso(), publishedBy: actorId(access) },
      { transitionToken: transition },
    );
    return { batchId, carryForwardRecovered, heldReleased, updated };
  }).catch((publishError: unknown) => {
    // A lost claim HERE is not "nothing happened": the payslips are live and the run is not marked.
    // Saying otherwise invites the two moves that make it worse — re-publishing, or reopening Part 2 and
    // releasing a carry-forward that was genuinely collected.
    const message = publishError instanceof Error ? publishError.message : String(publishError);
    if (message.includes(TRANSITION_CLAIM_LOST) && batchAlreadyWritten) {
      throw new Error(
        `Conflict: the payslips for this run WERE written — salary batch ${batchAlreadyWritten} is approved and ` +
          "live, and the carry-forward ledger is settled — but the run could not be marked published because " +
          "another action took it. Do NOT publish, reopen or cancel this run again: it and its batch now " +
          "disagree, and someone has to reconcile them by hand.",
      );
    }
    throw publishError;
  });
  const { batchId, carryForwardRecovered, heldReleased, updated } = published;

  // Mark the outstation trips this month paid (owner ruling 2026-09-12). Never throws: expense-stamp.ts.
  const expenseStamp = await recordPaidExpenseStamp({
    actorHrId: actorId(access),
    batchId,
    entries: rows,
    month: run.month,
    runId,
    year: run.year,
  });

  // TELL THE EMPLOYEES. This is the notification the whole company receives, and this path never
  // sent it: it was a helper private to the OLD payroll module's route file, and Automated Payroll
  // approves its batch with a direct database write. Production's count says it plainly — 123
  // records, all dated 13 July 2026, the last time the old module approved a batch, and none since,
  // while the two automated publishes covered 205 people between them.
  //
  // After the run is marked published on purpose. Money and payslips already exist by here, so a
  // notification outage must not throw back through a completed payroll and present it as failed.
  // It cannot throw, and it reports what happened so a month that told nobody reads as one.
  const payslipNotice = await notifyPayslipAvailable({ batchId });

  await writeAutomatedPayrollAudit({
    runId,
    actorHrId: actorId(access),
    action: "published",
    detail: {
      batchId,
      publishedCount: publishRows.length,
      heldExcluded,
      // Who was actually told. `payslipNoticeFailed` above zero, or an error, means people hold a
      // payslip nobody announced — recoverable, but only if it is visible.
      payslipNoticeSent: payslipNotice.notified,
      payslipNoticeFailed: payslipNotice.failed,
      payslipNoticeError: payslipNotice.error,
      carryForwardRecovered,
      // Earlier months' held salary this month paid, by person and held month.
      heldReleased,
      // Which outstation trips this month paid, or why marking them failed.
      expenseStamp,
      // False only for a run confirmed before the stamp existed; anything else without one is refused (S-PAY-08).
      totalsComparedToConfirm: !predatesStamp,
      // A leftover batch replaced, or a create or rewrite that wrote the batch and then threw (S-PAY-09, F-18).
      ...batchNotes,
      // The permanent answer to "who was held this month, for how much, and why".
      held: heldRecord,
      heldFirstPartTotal,
      heldSecondPartTotal,
      heldWithoutMeaningfulReason,
      // The other money this month withheld and still owes (held-settlements.ts reads all three lists).
      part1Unpaid,
      deferred,
      // The permanent answer to "did the bank files carry everybody".
      bankCoverage: bankCoverage.map((entry) => ({
        scope: entry.scope,
        covered: entry.covered,
        fabRows: entry.fab.rows,
        fabTotal: entry.fab.total,
        cibRows: entry.cib.rows,
        cibTotal: entry.cib.total,
        unroutable: entry.unroutable,
        unroutableTotal: entry.unroutableTotal,
        summary: describeBankCoverage(entry),
      })),
    },
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

/**
 * Marker for the missing-payroll-data gate (owner rule 2026-08-04: flag loudly,
 * let HR acknowledge and proceed — do not block the run). Same contract as
 * OVERPAID_ACK_REQUIRED: the route turns it into a 409 the client can prompt on,
 * rather than a red dead-end.
 */
export const DATA_QUALITY_ACK_REQUIRED = "[data-quality-acknowledgment-required]";

/**
 * ONE PLACE DECIDES WHETHER A WARNING HAS BEEN ANSWERED (audit finding 53).
 *
 * Every acknowledgeable gate ends here: it has computed a warning, and the only question left is
 * whether the person confirming has been shown THAT warning and accepted it. A boolean in the
 * request body could not answer that — it said "somebody typed yes", never "somebody was told".
 * A token can, because only this server mints one, and only from inside a gate that fired.
 *
 * Refusing re-throws with a FRESH token, so the client always leaves a refusal holding the thing
 * it needs to come back with. There is no state to reconcile and nothing to expire by hand.
 */
function requireAcknowledgment(input: {
  runId: string;
  gate: AcknowledgmentGate;
  marker: string;
  actorHrId: string;
  warning: string;
  token: string | null | undefined;
}): void {
  if (
    acknowledgmentTokenAnswers({
      token: input.token,
      runId: input.runId,
      gate: input.gate,
      actorHrId: input.actorHrId,
      warning: input.warning,
    })
  ) {
    return;
  }
  throw new PayrollAcknowledgmentRequiredError({
    marker: input.marker,
    gate: input.gate,
    warning: input.warning,
    token: issueAcknowledgmentToken({
      runId: input.runId,
      gate: input.gate,
      actorHrId: input.actorHrId,
      warning: input.warning,
    }),
  });
}

/**
 * Shared by both confirms. Throws the acknowledgeable conflict when the run
 * carries employees with missing pay-determining data and HR has not yet
 * accepted it; records the acceptance in the audit log when they have, so a
 * knowingly-confirmed gap is answerable later.
 */
async function assertPayrollDataAcknowledged(input: {
  access: AccessContext;
  run: MonthlySalaryRun;
  members: PopulationMember[];
  sources: Map<string, PayrollSalarySource>;
  draftRows: DraftRow[];
  acknowledgmentToken: string | null | undefined;
}): Promise<void> {
  // The gate deliberately asks only for the issues that change what somebody is PAID — see
  // PAYROLL_DATA_ISSUE_AFFECTS_PAY. The wizard banner shows the full report, filing gaps included.
  const report = payAffectingIssues(
    auditPayrollDataQuality({
      members: input.members,
      sources: input.sources,
      draftRows: input.draftRows,
      part1Confirmed: input.run.part1ConfirmedAt != null,
    }),
  );
  if (report.total === 0) return;
  requireAcknowledgment({
    runId: input.run.id,
    gate: "data-quality",
    marker: DATA_QUALITY_ACK_REQUIRED,
    actorHrId: actorId(input.access),
    warning: describePayrollDataQuality(report),
    token: input.acknowledgmentToken,
  });
  await writeAutomatedPayrollAudit({
    runId: input.run.id,
    actorHrId: actorId(input.access),
    action: "payroll_data_issues_acknowledged",
    detail: { employees: report.total, rows: report.rows },
  });
}

/**
 * Marker for the population gate at Part 2 confirm (audit finding 46). Same contract as the two above:
 * the route turns it into a 409 the wizard prompts on.
 */
export const POPULATION_DIFF_ACK_REQUIRED = "[population-diff-acknowledgment-required]";

/**
 * THE POPULATION COMPARISON STOPS PART 2 UNTIL SOMEONE HAS LOOKED (audit finding 46).
 *
 * It was a banner and nothing more: a run that had silently dropped someone paid last month confirmed
 * and published with the warning on screen. That is the shape of the 2026-07-25 notice-period bug, which
 * surfaced only because the owner asked about one person by name.
 *
 * Acknowledgeable, never a hard block: a real departure with no resignation on file happens, and HR can
 * accept it on the record. Someone HR excluded from this run, with a reason, is already explained and
 * never asks. With no previous published month there is no baseline, and nothing asks.
 */
async function assertPopulationDiffAcknowledged(input: {
  access: AccessContext;
  run: MonthlySalaryRun;
  members: PopulationMember[];
  draftRows: DraftRow[];
  acknowledgmentToken: string | null | undefined;
}): Promise<void> {
  const previous = await previousMonthRoster({ month: input.run.month, year: input.run.year });
  const unexplained = unexplainedDisappearances(diffPopulation({ current: input.members, previous }), input.draftRows);
  if (unexplained.length === 0) return;
  requireAcknowledgment({
    runId: input.run.id,
    gate: "population-diff",
    marker: POPULATION_DIFF_ACK_REQUIRED,
    actorHrId: actorId(input.access),
    warning: describeUnexplainedDisappearances(unexplained),
    token: input.acknowledgmentToken,
  });
  await writeAutomatedPayrollAudit({
    runId: input.run.id,
    actorHrId: actorId(input.access),
    action: "population_diff_acknowledged",
    detail: { unexplained },
  });
}

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
  const recordsValue = Math.round(rows.reduce((sum, row) => sum + Number(row[valueField] ?? 0), 0) * 100) / 100;

  // THE SAME POPULATION AS THIS MONTH'S FIGURE (audit finding 52). This month counts every assembled row,
  // held people included, plus the non-employees paid in this scope; salary_records holds neither last
  // month's held people nor any non-employee, so both are added back from what that run recorded.
  const holdRecord = await readPublishedHoldRecord(prevRun.id);
  const heldCount = holdRecord.held?.length ?? holdRecord.heldExcluded ?? 0;
  const heldValue = holdRecord.held
    ? holdRecord.held.reduce(
        (sum, person) =>
          sum +
          (valueField === "first_part" ? person.firstPartAlreadyPaid + person.firstPartWithheld : person.monthTotal),
        0,
      )
    : 0;
  const nonEmployees = await getNonEmployeePayrollRows(prevRun.id, valueField === "first_part" ? "first" : undefined);
  const nonEmployeeValue = nonEmployees.reduce((sum, entry) => sum + entry.totalSalary, 0);

  return {
    headcount: rows.length + heldCount,
    totalValue: roundCurrency(recordsValue + heldValue + nonEmployeeValue),
    // A publish that recorded only HOW MANY were held cannot supply their pay. Said beside the figure,
    // so the gap is not read as a month-on-month movement.
    basis:
      !holdRecord.held && heldCount > 0
        ? `Last month counts ${heldCount} held employees, but its value leaves out their pay: that month was published before held amounts were recorded.`
        : undefined,
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
  // The Held tab needs both halves: what was settled by hand against THIS run, and what is still
  // outstanding from earlier months. The second is what stops the same held amount being worked up
  // and paid a second time next month (owner rule 2026-09-10).
  const [heldSettlements, priorHeld] = await Promise.all([
    getHeldSettlements(runId),
    loadHeldBalances({ excludeRunId: runId }),
  ]);
  const priorHeldBalances = priorHeld.filter((balance) => balance.outstanding > 0);
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
          heldSettlements,
          priorHeldBalances,
        })
      : await buildFullSheetWorkbook({
          run,
          rows,
          previousSummary: await previousMonthSummary(period, "month_salary"),
          // BOTH parts: the full sheet is the month's complete picture, and
          // their amount lands under Month Salary either way.
          nonEmployees: await getNonEmployeePayrollRows(runId),
          heldSettlements,
          priorHeldBalances,
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

  const { edits: parsed, invalidHrIds } = await parseStepWorkbook({ file, stepKey });
  // A corrected day count moves the money it drives, as it does on screen (audit finding 32). Priced
  // against the rows as they stand BEFORE the upload, so the preview and the commit move the same money.
  const { rows: before } = await getStepRecommendation(access, runId, stepKey);
  const { edits, recalculated } = applyDayDrivenMoney({
    stepKey,
    edits: parsed,
    current: before,
    monthDays: calendarDaysInMonth({ month: run.month, year: run.year }),
  });

  if (!commit) {
    return diffStepUpload({ stepKey, edits, current: before, invalidHrIds, recalculated });
  }

  await saveStep(access, runId, stepKey, edits, "xlsx", { recalculateMoney: recalculated });
  const { rows: current } = await getStepRecommendation(access, runId, stepKey);
  const preview = diffStepUpload({ stepKey, edits, current, invalidHrIds });
  return { mode: "commit", applied: edits.length, invalid: preview.invalid, diffs: preview.diffs };
}

// ---- Finance download (finance actor) ---------------------------------------

/**
 * A FILE THAT PAYS PART 2 CARRIES THE MONTH PART 2 CONFIRMED (audit 2026-10-23, F-08b).
 *
 * The finance sheet and both bank files are rebuilt from live data at the moment of download. Only
 * publish compared that against the totals Part 2 confirm stamped, so anything that moved between
 * the confirm and the click — a corrected salary, a deduction decision, an expense approved that
 * morning — went to the bank in a file nobody had confirmed. The same check publish runs, here.
 *
 * Part 1 files are not checked against it: the first instalment is frozen at Part 1 confirm, and the
 * stamp does not exist until Part 2.
 *
 * Since 2026-10-23 the destination is held too, not only the amount: a bank or account changed on the
 * employee record after the confirm refuses the file (owner, "block it"), naming whose changed.
 */
async function assertFileMatchesPart2Confirm(
  run: MonthlySalaryRun,
  rows: AssembledRow[],
  draftRows: DraftRow[],
): Promise<void> {
  // The rule is assertPart2FileMatchesStamp's; the phase test here only saves a read for a month that
  // is not held to the stamp.
  if (run.phase !== "ready") return;
  // A held salary this file would pay must still be owed — a by-hand transfer recorded after the
  // confirm would otherwise be paid a second time by the bank.
  await assertHeldReleasesPayable(run.id, draftRows, rows);
  const stamp = await readPart2ConfirmedStamp(run.id);
  const names = new Map(rows.map((entry) => [entry.compact, entry.row.fullName]));
  assertPart2FileMatchesStamp(run, stamp.totals, part2Totals(rows.length, reconcile(rows)), {
    confirmed: stamp.bankDetails,
    current: part2BankDetails(run.id, rows),
    // Someone on the confirmed sheet who has since left the population has no row today; the
    // confirmed month still knew them, so the refusal says so rather than printing an id.
    nameOf: (compact) => names.get(compact) ?? "a person no longer on this month's sheet",
  });
}

/**
 * The run a finance download is built from: the one in progress, else the PUBLISHED one, else the
 * newest. A month cancelled and started again could otherwise hand finance a cancelled run's bank
 * file — a run that pays nobody — because "newest" alone does not ask (audit 2026-11-07).
 */
async function findFinanceRun(period: PayrollPeriod): Promise<MonthlySalaryRun> {
  const run =
    (await findActiveRun(period.month, period.year)) ??
    (await findPublishedRun(period.month, period.year)) ??
    (await findLatestRun(period.month, period.year));
  if (!run) throw new Error("Not found: no Automated Payroll run for this period.");
  if (run.phase === "cancelled") {
    throw new Error("Conflict: this month's run was cancelled — it pays nobody, so there is no file to download.");
  }
  return run;
}

/** Finance locked sheet for a period (CEO / Financial Advisor / Finance Manager / Super Admin). */
export async function buildFinanceSheet(
  access: AccessContext,
  period: PayrollPeriod,
  scope: "part1" | "full",
): Promise<{ buffer: Buffer; coverage: BankCoverage[]; fileName: string }> {
  assertAutomatedPayrollFinanceActor(access);
  const run = await findFinanceRun(period);

  if (scope === "part1" && !run.part1ConfirmedAt) {
    throw new Error("Conflict: Part 1 has not been confirmed yet for this period.");
  }
  if (scope === "full" && !run.part2ConfirmedAt) {
    throw new Error("Conflict: the full sheet is not ready — Part 2 has not been confirmed yet.");
  }

  // ONE assembly path — see buildFabSheet. The finance sheet is the document the month is executed
  // from, and it used to re-assemble without the carry-forward ledger.
  const { rows, draftRows } = await assembleForRun(run);
  if (scope === "full") await assertFileMatchesPart2Confirm(run, rows, draftRows);
  const buffer = await buildFinanceSheetWorkbook({
    run,
    rows,
    scope,
    // Mirrors buildRunSheet exactly: the Part 1 scope pays first-installment
    // entries, the full scope shows the month's whole picture.
    nonEmployees: await getNonEmployeePayrollRows(run.id, scope === "part1" ? "first" : undefined),
  });
  // Coverage is per instalment, because the bank files are. The Part 1 scope answers for Part 1
  // only; the full sheet answers for both, so a Part 2 gap cannot hide behind a covered Part 1.
  const allNonEmployees = await getNonEmployeePayrollRows(run.id);
  const coverage =
    scope === "part1"
      ? [buildBankCoverage({ rows, nonEmployees: allNonEmployees, scope: "part1" })]
      : [
          buildBankCoverage({ rows, nonEmployees: allNonEmployees, scope: "part1" }),
          buildBankCoverage({ rows, nonEmployees: allNonEmployees, scope: "part2" }),
        ];
  const label = monthLabel(run.month, run.year).replace(/\s+/g, "-");
  const fileName = `Automated-Payroll-${label}-${scope}-finance.xlsx`;
  // Recorded before it is handed out, or not handed out at all (F-PAY-016, bank-file-downloads.ts).
  await recordBankFileDownloaded({ runId: run.id, actorHrId: actorId(access), file: "finance", scope, fileName });
  return { buffer, coverage, fileName };
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
  const run = await findFinanceRun(period);
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
): Promise<{ buffer: Buffer; coverage: BankCoverage; fileName: string }> {
  assertAutomatedPayrollFinanceActor(access);
  const run = await findFinanceRun(period);

  if (scope === "part1" && !run.part1ConfirmedAt) {
    throw new Error("Conflict: Part 1 has not been confirmed yet for this period.");
  }
  if (scope === "part2" && !run.part2ConfirmedAt) {
    throw new Error("Conflict: the Part 2 sheet is not ready — Part 2 has not been confirmed yet.");
  }

  const period2: PayrollPeriod = { month: run.month, year: run.year };
  // ONE assembly path — the same call publish makes. This used to re-assemble by hand WITHOUT the
  // carry-forward ledger, so a recovery that the payslip carried reached neither bank file.
  const { rows, draftRows } = await assembleForRun(run);
  if (scope === "part2") await assertFileMatchesPart2Confirm(run, rows, draftRows);
  const nonEmployees = await getNonEmployeePayrollRows(run.id);
  // Non-Employees Payroll (people paid a monthly salary with no HR_ID record)
  // is a separate data source from AssembledRow — fabRowsForScope never sees
  // them, so they'd silently be missing from the real bank file without this
  // (owner-reported 2026-07-26). Which scope carries an entry is its own `part`
  // (owner request 2026-08-03) — fabRowsForNonEmployees does that filtering.
  const fabRows = [...fabRowsForScope(rows, scope), ...fabRowsForNonEmployees(nonEmployees, scope)];
  // Who this file does NOT carry. The only check here used to be "is it completely empty", so a
  // file missing a fifth of the payable population downloaded clean and said nothing.
  const coverage = buildBankCoverage({ rows, nonEmployees, scope });
  if (fabRows.length === 0) {
    throw new Error("Conflict: no FAB-bank employees with a payable amount for this part.");
  }

  const valueDate = valueDateIso ? new Date(`${valueDateIso}T00:00:00Z`) : defaultFabValueDate(period2);
  const buffer = await buildFabSheetWorkbook({
    rows: fabRows,
    valueDate,
    salaryColumnLabel: scope === "part2" ? "Expense" : "Salary",
  });
  const label = monthLabel(run.month, run.year).replace(/\s+/g, "-");
  const fileName = `FAB-Salary-Transfer-${label}-${scope}.xlsx`;
  // Recorded before it is handed out, or not handed out at all (F-PAY-016, bank-file-downloads.ts).
  await recordBankFileDownloaded({ runId: run.id, actorHrId: actorId(access), file: "fab", scope, fileName });
  return { buffer, coverage, fileName };
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
): Promise<{ buffer: Buffer; coverage: BankCoverage; fileName: string }> {
  assertAutomatedPayrollFinanceActor(access);
  const run = await findFinanceRun(period);

  if (scope === "part1" && !run.part1ConfirmedAt) {
    throw new Error("Conflict: Part 1 has not been confirmed yet for this period.");
  }
  if (scope === "part2" && !run.part2ConfirmedAt) {
    throw new Error("Conflict: the Part 2 sheet is not ready — Part 2 has not been confirmed yet.");
  }

  // ONE assembly path — see buildFabSheet. Carry-forward recoveries reached neither bank file.
  const { rows, draftRows } = await assembleForRun(run);
  if (scope === "part2") await assertFileMatchesPart2Confirm(run, rows, draftRows);
  const nonEmployees = await getNonEmployeePayrollRows(run.id);
  // See buildFabSheet's own comment: Non-Employees Payroll is a separate data
  // source that cibRowsForScope never sees on its own.
  const cibRows = [...cibRowsForScope(rows, scope), ...cibRowsForNonEmployees(nonEmployees, scope)];
  const coverage = buildBankCoverage({ rows, nonEmployees, scope });
  if (cibRows.length === 0) {
    throw new Error("Conflict: no CIB-bank employees with a payable amount for this part.");
  }

  const buffer = await buildCibSheetWorkbook({ rows: cibRows });
  const label = monthLabel(run.month, run.year).replace(/\s+/g, "-");
  const fileName = `CIB-Salary-Transfer-${label}-${scope}.xlsx`;
  // Recorded before it is handed out, or not handed out at all (F-PAY-016, bank-file-downloads.ts).
  await recordBankFileDownloaded({ runId: run.id, actorHrId: actorId(access), file: "cib", scope, fileName });
  return { buffer, coverage, fileName };
}
