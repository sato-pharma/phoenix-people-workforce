// Weekly attendance review: build a closed week, let the Super Admin review and release it, and
// record what each employee chooses for every flagged day.
//
// OWNER DECISION 2026-09-15 — replaces the 2026-09-08 "permanently silent" ruling.
//
//   1. BUILT, NOT SENT. The daily job builds a closed week as `awaiting_release`. It is visible
//      only on the admin review page, where a day can be removed before anybody sees it.
//   2. RELEASED BY THE SUPER ADMIN. Release opens the week and tells each employee in-app and by
//      Telegram (never email). A trial-run week (dry_run) can never be released.
//   3. SALARY OR ANNUAL BALANCE. The employee does not confirm or deny the day — they choose how
//      it is paid: from salary, or from annual vacation balance (the same number of days, only
//      when the balance covers them).
//   4. THEN A DISPUTE, IF THEY WANT ONE. After choosing, they may dispute the day; it waits for
//      the reviewer, and a rejected dispute applies the method they chose.
//   5. SILENCE MEANS SALARY. A day not answered within 2 working days of the release is settled
//      to salary by the daily job. A day the employee is on leave does not count, so the deadline
//      moves past the leave (owner, 2026-09-15 — "Pause for leave days"), and leave still waiting
//      for approval counts as leave (owner, 2026-09-16 — "Pending pauses too").
//   6. THE DECISION IS TOLD. When a reviewer accepts or rejects a dispute, the employee is told
//      in-app and by Telegram, with where a rejected day is taken from (owner, 2026-09-15).
//
// SCOPE. This module records an answer and, for balance, spends leave days. It never writes a
// deduction: the month-end Fingerprint connector stays the only author of deductions_candidates,
// and digest-bridge.ts applies the answer to the candidate once it exists. Two writers of one
// employee-day is how this database charged 19 employee-days twice in July 2026.
//
// ATOMICITY. Every settlement goes through phx_attendance_settle_digest_line, which writes the
// settlement, the balance charge, the line and the digest status in one transaction, guarded on
// the line's current action. A day paid from balance also re-checks, under the same per-employee
// lock leave approval takes, that nothing spent the balance between the read and the write.

import { writeAuditLog } from "@/lib/admin/audit";
import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { canonicalHrIdKey, hrIdForStorage, hrIdLookupKeys, hrIdsMatch } from "@/lib/hr-id.ts";
import { getFingerprintAttendanceReport } from "@/lib/attendance/fingerprint-report.ts";
import { resolveCycleWindow, type CycleWindow } from "@/lib/payroll/copilot/cycle-window.ts";
import { closedWeeksOfCurrentCycle, latestClosedSettlementWeek, tileSettlementWeeks, type SettlementWeek } from "@/lib/attendance/digest-weeks.ts";
import { buildWeekDigests, type BuiltDigest } from "@/lib/attendance/digest-generator.ts";
import { withWeekBuildLock } from "@/lib/attendance/week-build-lock.ts";
import {
  ANSWER_WINDOW_LEAVE_STATUSES,
  answerDueDate,
  balanceCoversDays,
  balanceReadIsComplete,
  canManageWeeklyReview,
  countsTowardAnswerWindow,
  deadlineApplies,
  disputeSalaryFallbackText,
  heldAnswerDueDate,
  isAnswerOverdue,
  isDeductionMethod,
  isOpenLineAction,
  parseMarkedDays,
  payrollDecisionBlocksBalance,
  reviewWeekStage,
  type DeductionMethod,
  type DigestLineAction,
  type DigestStatus,
  type ReviewWeekStage,
} from "@/lib/attendance/digest-rules.ts";
import { notifyAttendanceDisputeDecided, notifyAttendanceWeekReleased } from "@/lib/attendance/digest-notify.ts";
import { buildAttendanceCalendarContext, cairoTodayIso, getLeaveDayMap } from "@/lib/attendance/working-days.ts";
import { isAttendanceScheduledWorkingDay } from "@/lib/attendance/work-schedule.ts";
import { normalizeAttendanceHrId, resolveActiveAttendancePolicy } from "@/lib/attendance/metrics";
import { loadAttendanceFlexPolicyGroups } from "@/lib/attendance/policy-groups";
import { getEmployeeDirectoryRows, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { calculatePaymentForRequest } from "@/lib/vacation/service";
import { getVacationBalancePeriod } from "@/lib/vacation/calculations";

export type { DigestLineAction, DeductionMethod, DigestStatus, ReviewWeekStage };

export type DigestSettings = {
  disputeReviewerHrIds: string[];
  cycleAnchorDay: number;
  showEstimatedAmount: boolean;
  dryRun: boolean;
  enabled: boolean;
  answerWorkingDays: number;
};

const SETTINGS_DEFAULTS: DigestSettings = {
  disputeReviewerHrIds: [],
  cycleAnchorDay: 24,
  showEstimatedAmount: true,
  dryRun: true,
  enabled: false,
  answerWorkingDays: 2,
};

export async function getDigestSettings(): Promise<DigestSettings> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_digest_settings")
    .select("dispute_reviewer_hr_ids,cycle_anchor_day,show_estimated_amount,dry_run,enabled,answer_working_days")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return SETTINGS_DEFAULTS;
  const row = data as Record<string, unknown>;
  const answerWorkingDays = Number(row.answer_working_days);
  return {
    disputeReviewerHrIds: Array.isArray(row.dispute_reviewer_hr_ids) ? (row.dispute_reviewer_hr_ids as string[]) : [],
    cycleAnchorDay: Number(row.cycle_anchor_day) || SETTINGS_DEFAULTS.cycleAnchorDay,
    showEstimatedAmount: row.show_estimated_amount !== false,
    // Both flags FAIL SAFE: a missing or unreadable value keeps the module quiet and keeps money
    // out of it, rather than defaulting to "live".
    dryRun: row.dry_run !== false,
    enabled: row.enabled === true,
    answerWorkingDays: Number.isInteger(answerWorkingDays) && answerWorkingDays > 0 ? answerWorkingDays : SETTINGS_DEFAULTS.answerWorkingDays,
  };
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export type GenerateResult = {
  cycleKey: string;
  week: SettlementWeek | null;
  digestsCreated: number;
  linesCreated: number;
  skippedExisting: number;
  employeesClean: number;
  dryRun: boolean;
};

/**
 * Build the digests for the settlement week that has just CLOSED, waiting for release.
 *
 * Only a closed week, for the same reason the deductions collector refuses an in-progress month:
 * a day that has not ended cannot be judged. Nothing is sent here — ever. The notice goes out
 * when the Super Admin releases the week.
 */
export async function generateDigestsForCompletedWeek(input: {
  todayIso: string;
  createdBy: string;
}): Promise<GenerateResult> {
  const settings = await getDigestSettings();
  // Not simply today's cycle: on the 24th that is already the next cycle, and the week that has
  // just closed is the previous cycle's week 4. See latestClosedSettlementWeek.
  const due = latestClosedSettlementWeek(input.todayIso, settings.cycleAnchorDay);
  const cycle = due?.cycle ?? resolveCycleWindow(input.todayIso, settings.cycleAnchorDay);
  const week = due?.week ?? null;
  if (!week) {
    return {
      cycleKey: cycle.cycleKey,
      week: null,
      digestsCreated: 0,
      linesCreated: 0,
      skippedExisting: 0,
      employeesClean: 0,
      dryRun: settings.dryRun,
    };
  }
  return withWeekBuildLock(cycle.cycleKey, week.index, () => generateDigestsForWeek({ cycle, week, createdBy: input.createdBy, settings }));
}

/**
 * Build one closed week's digests, waiting for release. An employee who already has a digest for the
 * week is left alone. Used by the daily job for the week that has just closed, and by the Super Admin
 * for an earlier closed week of the current payroll month that was never built.
 *
 * If a write fails, every digest this run created is deleted again (its days go with it) and the
 * error is thrown. A half-built week looks built: Build this week refuses it for good, and an
 * employee whose digest lost its days would be released with nothing on it. Callers hold
 * withWeekBuildLock, so no other build of this week runs in this server at the same time: one that
 * did could skip the employees this run creates, and this run's undo would then leave them with no
 * digest at all. A build on another server getting there first is not a failure: the unique key
 * answers 23505, and its digest stands. A build killed mid-run (a deploy restart) is not undone.
 */
async function generateDigestsForWeek(input: {
  cycle: CycleWindow;
  week: SettlementWeek;
  createdBy: string;
  settings: DigestSettings;
}): Promise<GenerateResult> {
  const { cycle, week, settings } = input;
  const report = await getFingerprintAttendanceReport({ dateFrom: week.startIso, dateTo: week.endIso });
  const built = buildWeekDigests(report.rows);
  const employeesSeen = new Set(report.rows.map((row) => row.employeeHrId)).size;

  const supabase = getSupabaseAdmin();
  let digestsCreated = 0;
  let linesCreated = 0;
  let skippedExisting = 0;
  const createdDigestIds: number[] = [];

  try {
    for (const digest of built) {
      const { data: existing, error: existingError } = await supabase
        .from("attendance_weekly_digests")
        .select("id")
        .eq("employee_hr_id", hrIdForStorage(digest.employeeHrId))
        .eq("cycle_key", cycle.cycleKey)
        .eq("week_index", week.index)
        .maybeSingle();
      if (existingError) throw existingError;
      if (existing) {
        skippedExisting += 1;
        continue;
      }

      const { data: created, error: createError } = await supabase
        .from("attendance_weekly_digests")
        .insert({
          employee_hr_id: hrIdForStorage(digest.employeeHrId),
          cycle_key: cycle.cycleKey,
          week_index: week.index,
          week_start: week.startIso,
          week_end: week.endIso,
          status: "awaiting_release",
          total_deduction_days: digest.totalDeductionDays,
          // NULL, not 0, when any day could not be priced. See digest-generator.ts.
          total_deduction_value: digest.totalDeductionValue,
          has_unpriced_day: digest.hasUnpricedDay,
          dry_run: settings.dryRun,
        })
        .select("id")
        .single();
      if (createError) {
        // The daily job and a Build click (or two clicks) raced, and the other one created this
        // employee's digest between the check above and this insert. Theirs stands.
        if ((createError as { code?: string }).code === "23505") {
          skippedExisting += 1;
          continue;
        }
        throw createError;
      }
      const digestId = (created as { id: number }).id;
      createdDigestIds.push(digestId);
      digestsCreated += 1;

      const { error: linesError } = await supabase.from("attendance_digest_lines").insert(
        digest.lines.map((line) => ({
          digest_id: digestId,
          work_date: line.workDate,
          status: line.status,
          late_minutes: Math.round(line.lateMinutes),
          short_minutes: Math.round(line.shortMinutes),
          worked_minutes: Math.round(line.workedMinutes),
          deduction_days: line.deductionDays,
          deduction_value: line.deductionValue,
          // What was detected, kept apart from deduction_days, which the Super Admin may change before release.
          detected_days: line.deductionDays,
          detected_value: line.deductionValue,
          reason: line.reason,
          evidence: line.evidence,
        })),
      );
      if (linesError) throw linesError;
      linesCreated += digest.lines.length;
    }
  } catch (buildError) {
    await undoPartialBuild({ createdDigestIds, label: `${cycle.cycleKey} week ${week.index}`, cause: buildError });
    throw buildError;
  }

  await writeAuditLog({
    actorLoginId: input.createdBy,
    entityId: `${cycle.cycleKey}:w${week.index}`,
    entityType: "attendance_weekly_digest_run",
    newValues: { digestsCreated, linesCreated, skippedExisting, dryRun: settings.dryRun },
    summary: `Weekly attendance digests generated for ${cycle.cycleKey} week ${week.index}`,
  });

  return {
    cycleKey: cycle.cycleKey,
    week,
    digestsCreated,
    linesCreated,
    skippedExisting,
    employeesClean: Math.max(0, employeesSeen - built.length),
    dryRun: settings.dryRun,
  };
}

/**
 * Delete what a failed build created, so the week is not left half-built. Only digests this run
 * created that are still waiting for release and were never released — one a Release click reached
 * first is kept. Their days go with them (the lines cascade), and nothing is settled on a day of a
 * week nobody has released. If the undo fails too, the error names the week and how many employees
 * were left, because that week then needs a person.
 */
async function undoPartialBuild(input: { createdDigestIds: number[]; label: string; cause: unknown }): Promise<void> {
  if (!input.createdDigestIds.length) return;
  const { error } = await getSupabaseAdmin()
    .from("attendance_weekly_digests")
    .delete()
    .in("id", input.createdDigestIds)
    .eq("status", "awaiting_release")
    .is("released_at", null);
  if (!error) return;
  const cause = String((input.cause as { message?: unknown } | null)?.message ?? input.cause);
  throw new Error(
    `Building ${input.label} failed (${cause}), and undoing it failed too (${error.message}). ${input.createdDigestIds.length} employee(s) in that week are left without all their days, waiting for release. Nothing was sent.`,
  );
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type DigestLineRow = {
  id: number;
  digestId: number;
  workDate: string;
  status: string;
  lateMinutes: number;
  shortMinutes: number;
  deductionDays: number;
  /** null means the day is chargeable but could not be priced — never "free". */
  deductionValue: number | null;
  reason: string;
  evidence: Record<string, string>;
  action: DigestLineAction;
  chosenMethod: DeductionMethod | null;
  disputeReason: string | null;
  reviewNotes: string | null;
  removeReason: string | null;
  /** Ticked for deduction by the Super Admin before release. An unticked pending day is cleared on release. */
  deduct: boolean;
  /** The days the fingerprint report detected. `deductionDays` is the figure charged. */
  detectedDays: number | null;
  /** The Super Admin changed the days before release, up or down. */
  adjusted: boolean;
};

export type DigestRow = {
  id: number;
  employeeHrId: string;
  cycleKey: string;
  weekIndex: number;
  weekStart: string;
  weekEnd: string;
  status: DigestStatus;
  totalDeductionDays: number;
  /** null when any day in the week could not be priced. */
  totalDeductionValue: number | null;
  hasUnpricedDay: boolean;
  currency: string;
  dryRun: boolean;
  releasedAt: string | null;
  answerDueOn: string | null;
  notifiedAt: string | null;
  lines: DigestLineRow[];
};

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function mapLine(row: Record<string, unknown>): DigestLineRow {
  const deductionDays = Number(row.deduction_days) || 0;
  const detectedDays = numberOrNull(row.detected_days);
  return {
    id: Number(row.id),
    digestId: Number(row.digest_id),
    workDate: String(row.work_date),
    status: String(row.status),
    lateMinutes: Number(row.late_minutes) || 0,
    shortMinutes: Number(row.short_minutes) || 0,
    deductionDays,
    deductionValue: numberOrNull(row.deduction_value),
    reason: String(row.reason ?? ""),
    evidence: (row.evidence ?? {}) as Record<string, string>,
    action: String(row.action) as DigestLineAction,
    chosenMethod: isDeductionMethod(row.chosen_method) ? row.chosen_method : null,
    disputeReason: textOrNull(row.dispute_reason),
    reviewNotes: textOrNull(row.review_notes),
    removeReason: textOrNull(row.remove_reason),
    deduct: row.deduct === true,
    detectedDays,
    adjusted: detectedDays !== null && Math.abs(deductionDays - detectedDays) > 1e-9,
  };
}

const LINE_COLUMNS =
  "id,digest_id,work_date,status,late_minutes,short_minutes,deduction_days,deduction_value,reason,evidence,action,chosen_method,dispute_reason,review_notes,remove_reason,deduct,detected_days";

async function loadLines(digestIds: number[]): Promise<Map<number, DigestLineRow[]>> {
  const byDigest = new Map<number, DigestLineRow[]>();
  if (!digestIds.length) return byDigest;
  const supabase = getSupabaseAdmin();
  // Paged: PostgREST stops at 1,000 rows without saying so, and a digest missing its later days
  // would read as fully answered — and be closed, or released with the wrong day count.
  // The ids are chunked too, so a long list never outgrows the request URL.
  const PAGE = 1000;
  const ID_CHUNK = 200;
  for (let start = 0; start < digestIds.length; start += ID_CHUNK) {
    const chunk = digestIds.slice(start, start + ID_CHUNK);
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabase
        .from("attendance_digest_lines")
        .select(LINE_COLUMNS)
        .in("digest_id", chunk)
        .order("digest_id", { ascending: true })
        .order("work_date", { ascending: true })
        .order("id", { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) throw error;
      const rows = (data ?? []) as Record<string, unknown>[];
      for (const raw of rows) {
        const line = mapLine(raw);
        const list = byDigest.get(line.digestId) ?? [];
        list.push(line);
        byDigest.set(line.digestId, list);
      }
      if (rows.length < PAGE) break;
    }
  }
  return byDigest;
}

function mapDigest(row: Record<string, unknown>, lines: DigestLineRow[]): DigestRow {
  return {
    id: Number(row.id),
    employeeHrId: String(row.employee_hr_id),
    cycleKey: String(row.cycle_key),
    weekIndex: Number(row.week_index),
    weekStart: String(row.week_start),
    weekEnd: String(row.week_end),
    status: String(row.status) as DigestStatus,
    totalDeductionDays: Number(row.total_deduction_days) || 0,
    totalDeductionValue: numberOrNull(row.total_deduction_value),
    hasUnpricedDay: row.has_unpriced_day === true,
    currency: String(row.currency ?? "EGP"),
    dryRun: row.dry_run !== false,
    releasedAt: textOrNull(row.released_at),
    answerDueOn: textOrNull(row.answer_due_on),
    notifiedAt: textOrNull(row.notified_at),
    lines,
  };
}

const DIGEST_COLUMNS =
  "id,employee_hr_id,cycle_key,week_index,week_start,week_end,status,total_deduction_days,total_deduction_value,has_unpriced_day,currency,dry_run,released_at,answer_due_on,notified_at";

async function loadDigestOrThrow(digestId: number): Promise<DigestRow> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_weekly_digests")
    .select(DIGEST_COLUMNS)
    .eq("id", digestId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw notFoundError("Digest was not found.");
  const lines = await loadLines([digestId]);
  return mapDigest(data as Record<string, unknown>, lines.get(digestId) ?? []);
}

/**
 * A named reviewer never removes or rules on a day from their OWN week — that is deciding one's
 * own pay. The Super Admin is exempt: there is nobody above him to send it to.
 */
function assertNotOwnPay(employeeHrId: string, actorHrId: string, actorRole: string | null | undefined) {
  if (actorRole === "Super Admin") return;
  if (hrIdsMatch(employeeHrId, actorHrId)) {
    throw validationError("This is your own attendance. Another reviewer or the Super Admin has to decide it.", "forbidden");
  }
}

function assertOwnDigest(digest: DigestRow, actorHrId: string) {
  if (!hrIdsMatch(digest.employeeHrId, actorHrId)) {
    throw validationError("You can only act on your own attendance review.", "forbidden");
  }
}

async function loadDirectoryByKey(): Promise<Map<string, EmployeeDirectoryRow>> {
  const rows = await getEmployeeDirectoryRows({ includeInactive: true });
  const byKey = new Map<string, EmployeeDirectoryRow>();
  for (const row of rows) {
    const key = canonicalHrIdKey(row.hrId);
    if (key && !byKey.has(key)) byKey.set(key, row);
  }
  return byKey;
}

function directoryRowFor(byKey: Map<string, EmployeeDirectoryRow>, hrId: string): EmployeeDirectoryRow | null {
  const key = canonicalHrIdKey(hrId);
  return key ? byKey.get(key) ?? null : null;
}

// ---------------------------------------------------------------------------
// Annual balance
// ---------------------------------------------------------------------------

export type BalanceOption = {
  /** Can annual balance pay for this whole day right now? */
  covers: boolean;
  /** Annual balance left before this day, in days. null when it could not be worked out. */
  availableDays: number | null;
  /** Why balance is not offered, in words an employee understands. */
  unavailableReason: string | null;
};

type BalanceCheck = BalanceOption & {
  /** The machine reason behind unavailableReason; null when balance covers the day. */
  refusal: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  seenRequestDays: number | null;
  seenChargeDays: number | null;
  seenCopilotDays: number | null;
};

function unavailableReasonText(reason: string | null): string {
  switch (reason) {
    case "missing_hire_date":
      return "Your hire date is not on file, so your annual balance cannot be worked out.";
    case "first_six_months":
      return "Annual balance cannot be used during the first six months of employment.";
    case "insufficient_balance":
      return "Your annual balance does not cover this day.";
    case "payroll_decided":
      return "This day has already been decided in the month-end deductions review, so annual balance can no longer be used for it.";
    case "balance_unreadable":
      return "Your annual balance could not be fully read right now. Try again shortly.";
    default:
      return "Your annual balance cannot be used for this day.";
  }
}

async function readBalanceInputs(employeeHrId: string, periodStart: string, periodEnd: string) {
  const { data, error } = await getSupabaseAdmin().rpc("phx_attendance_balance_inputs", {
    p_employee_hr_id: employeeHrId,
    p_period_start: periodStart,
    p_period_end: periodEnd,
  });
  if (error) throw error;
  const row = (data ?? {}) as { requestDays?: unknown; chargeDays?: unknown; copilotDays?: unknown };
  return {
    requestDays: Number(row.requestDays) || 0,
    chargeDays: Number(row.chargeDays) || 0,
    copilotDays: Number(row.copilotDays) || 0,
  };
}

/**
 * The day's month-end fingerprint deduction, if the connector has built it yet. Keyed exactly as
 * the connector keys it (`${hrId}:${dateIso}`), matched case-insensitively like the settle function.
 */
async function readDayDeduction(employeeHrId: string, workDate: string): Promise<{ lockedAt: string | null; decisionStatus: string | null } | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("deductions_candidates")
    .select("id,locked_at,deductions_decisions(decision_status)")
    .eq("category", "fingerprint")
    .is("superseded_at", null)
    .ilike("source_record_id", `${employeeHrId}:${workDate}`.replace(/[\\%_]/g, (char) => `\\${char}`));
  if (error) throw error;
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  if (!rows.length) return null;
  // More than one live candidate for a day should not exist; if it does, the strictest one decides.
  let result: { lockedAt: string | null; decisionStatus: string | null } | null = null;
  for (const row of rows) {
    const nested = row.deductions_decisions as { decision_status?: string } | Array<{ decision_status?: string }> | null;
    const status = (Array.isArray(nested) ? nested[0]?.decision_status : nested?.decision_status) ?? null;
    const candidate = { lockedAt: textOrNull(row.locked_at), decisionStatus: status };
    if (!result || payrollDecisionBlocksBalance(candidate)) result = candidate;
  }
  return result;
}

/**
 * Whether annual balance can pay for one day, using the same balance arithmetic a leave request
 * is priced with (calculatePaymentForRequest) — never a second copy of it.
 *
 * The two figures a concurrent writer could change are read FIRST, so the settle function can
 * refuse the write if either moved before it commits.
 */
async function checkAnnualBalance(input: {
  employeeHrId: string;
  hireDate: string | null;
  workDate: string;
  days: number;
}): Promise<BalanceCheck> {
  const period = getVacationBalancePeriod({ employeeHrId: input.employeeHrId, hireDate: input.hireDate, referenceDate: input.workDate });
  let seen: { requestDays: number; chargeDays: number; copilotDays: number } | null = null;
  if (period) seen = await readBalanceInputs(input.employeeHrId, period.periodStart, period.periodEnd);

  const [snapshotOrFailure, dayDeduction] = await Promise.all([
    // Fail-closed: a payroll balance ledger that cannot be read refuses balance instead of counting
    // as zero days spent, in this period and in every earlier one the carried debt walks.
    calculatePaymentForRequest({
      durationDays: input.days,
      employeeHrId: input.employeeHrId,
      failClosedLedgerRead: true,
      hireDate: input.hireDate,
      startDate: input.workDate,
      vacationType: "annual",
    }).catch((error: unknown) => ({ failure: error })),
    readDayDeduction(input.employeeHrId, input.workDate),
  ]);
  const payrollDecided = payrollDecisionBlocksBalance(dayDeduction);
  if ("failure" in snapshotOrFailure) {
    const failedRefusal = payrollDecided ? "payroll_decided" : "balance_unreadable";
    return {
      covers: false,
      availableDays: null,
      unavailableReason: unavailableReasonText(failedRefusal),
      refusal: failedRefusal,
      periodStart: period?.periodStart ?? null,
      periodEnd: period?.periodEnd ?? null,
      seenRequestDays: seen?.requestDays ?? null,
      seenChargeDays: seen?.chargeDays ?? null,
      seenCopilotDays: seen?.copilotDays ?? null,
    };
  }
  const snapshot = snapshotOrFailure;
  const readComplete =
    !seen ||
    balanceReadIsComplete({
      calculatorUsedDays: snapshot.usedPaidDays,
      carriedOverDebtDays: snapshot.carriedOverDebtDays,
      requestDays: seen.requestDays,
      chargeDays: seen.chargeDays,
      copilotDays: seen.copilotDays,
    });
  const covers =
    Boolean(period) &&
    !payrollDecided &&
    readComplete &&
    snapshot.periodStart === period?.periodStart &&
    snapshot.periodEnd === period?.periodEnd &&
    balanceCoversDays({ days: input.days, paidDurationDays: snapshot.paidDurationDays, unpaidReason: snapshot.unpaidReason });

  // The calculator's own refusal (first six months, no hire date) explains itself best; the
  // incomplete-read reason is only for a balance that would otherwise have been offered.
  const refusal = payrollDecided
    ? "payroll_decided"
    : snapshot.unpaidReason
      ? snapshot.unpaidReason
      : !readComplete
        ? "balance_unreadable"
        : "insufficient_balance";
  return {
    covers,
    availableDays: period && readComplete && !snapshot.unpaidReason?.startsWith("missing") ? snapshot.balanceBeforeDays : null,
    unavailableReason: covers ? null : unavailableReasonText(refusal),
    refusal: covers ? null : refusal,
    periodStart: period?.periodStart ?? null,
    periodEnd: period?.periodEnd ?? null,
    seenRequestDays: seen?.requestDays ?? null,
    seenChargeDays: seen?.chargeDays ?? null,
    seenCopilotDays: seen?.copilotDays ?? null,
  };
}

// ---------------------------------------------------------------------------
// The settle function
// ---------------------------------------------------------------------------

type SettleAction = "salary" | "annual_balance" | "auto_salary" | "dispute_upheld" | "dispute_rejected";

function rethrowSettleError(error: { code?: string; message?: string }): never {
  const message = error.message || "The day could not be saved.";
  if (error.code === "40001") throw conflictError(message);
  if (error.code === "P0002") throw notFoundError(message);
  if (error.code === "22023") throw validationError(message);
  // The double-charge guard: the day's month-end deduction was decided or locked first.
  if (error.code === "55000") throw conflictError(message);
  if (error.code === "23505") throw conflictError("This day has already been settled.");
  throw new Error(message);
}

async function settleLine(input: {
  lineId: number;
  expected: DigestLineAction[];
  action: SettleAction;
  method: DeductionMethod | null;
  actorHrId: string | null;
  actorRole: string | null;
  reviewerHrId?: string | null;
  reason: string;
  reviewNotes?: string | null;
  balance?: BalanceCheck | null;
}) {
  const { error } = await getSupabaseAdmin().rpc("phx_attendance_settle_digest_line", {
    p_line_id: input.lineId,
    p_expected_actions: input.expected,
    p_action: input.action,
    p_method: input.method,
    p_actor_hr_id: input.actorHrId ? hrIdForStorage(input.actorHrId) : null,
    p_actor_role: input.actorRole,
    p_reviewer_hr_id: input.reviewerHrId ? hrIdForStorage(input.reviewerHrId) : null,
    p_reason: input.reason,
    p_review_notes: input.reviewNotes ?? null,
    p_period_start: input.balance?.periodStart ?? null,
    p_period_end: input.balance?.periodEnd ?? null,
    p_seen_request_days: input.balance?.seenRequestDays ?? null,
    p_seen_charge_days: input.balance?.seenChargeDays ?? null,
    p_seen_copilot_days: input.balance?.seenCopilotDays ?? null,
  });
  if (error) rethrowSettleError(error as { code?: string; message?: string });
}

// ---------------------------------------------------------------------------
// Who may do what
// ---------------------------------------------------------------------------

/**
 * Any signed-in employee may open their OWN weekly attendance review. Every surface behind this
 * is self-scoped (listMyDigests filters on the caller, answers assert ownership), and only a
 * RELEASED week is ever listed — the lock that stood here from 2026-09-08 existed because there
 * was no release step to keep an unreviewed week from an employee. There is one now.
 */
export async function canOpenDigestPortal(access: { role?: string | null; hrId?: string | null }): Promise<boolean> {
  return Boolean(access.hrId && String(access.hrId).trim());
}

// Choosing days, building a week and releasing it: the Super Admin only. The rule lives in digest-rules.ts.
export { canManageWeeklyReview };

function assertCanManageWeeklyReview(actorRole: string | null) {
  if (!canManageWeeklyReview({ role: actorRole })) {
    throw forbiddenError("Only the Super Admin can choose the days to deduct, build a week or release it.");
  }
}

/**
 * Super Admin, or anyone named in `dispute_reviewer_hr_ids`. Gates viewing the admin review page
 * and deciding disputes. Removing and releasing need canManageWeeklyReview on top.
 *
 * An empty list is a working configuration: everything lands on the Super Admin. Never falls back
 * to "anyone with attendance access", which would let a manager rule on their own team's pay.
 */
export async function canReviewDisputes(access: { role?: string | null; hrId?: string | null }): Promise<boolean> {
  if (access.role === "Super Admin") return true;
  if (!access.hrId) return false;
  const settings = await getDigestSettings();
  return settings.disputeReviewerHrIds.some((reviewer) => hrIdsMatch(reviewer, access.hrId));
}

// ---------------------------------------------------------------------------
// Admin: the review queue
// ---------------------------------------------------------------------------

export type ReviewEmployee = {
  digestId: number;
  employeeHrId: string;
  employeeName: string;
  jobTitle: string | null;
  status: DigestStatus;
  totalDeductionDays: number;
  totalDeductionValue: number | null;
  hasUnpricedDay: boolean;
  currency: string;
  answerDueOn: string | null;
  notified: boolean;
  /** Built while dry_run was on — never released, even inside a week that otherwise is. */
  dryRun: boolean;
  lines: DigestLineRow[];
};

/** One entry in the week picker. */
export type ReviewWeekOption = {
  cycleKey: string;
  weekIndex: number;
  weekStart: string;
  weekEnd: string;
  stage: ReviewWeekStage;
  employeeCount: number;
};

export type ReviewWeek = ReviewWeekOption & {
  releasedAt: string | null;
  employees: ReviewEmployee[];
};

type DigestHead = { cycleKey: string; weekIndex: number; weekStart: string; weekEnd: string; status: string; dryRun: boolean };

/** Every digest of one payroll month, or every digest still waiting for release or answers. Paged. */
async function readDigestHeads(scope: { cycleKey: string } | { unfinished: true }): Promise<DigestHead[]> {
  const supabase = getSupabaseAdmin();
  const PAGE = 1000;
  const heads: DigestHead[] = [];
  for (let from = 0; ; from += PAGE) {
    const base = supabase.from("attendance_weekly_digests").select("id,cycle_key,week_index,week_start,week_end,status,dry_run");
    const scoped = "cycleKey" in scope ? base.eq("cycle_key", scope.cycleKey) : base.in("status", ["awaiting_release", "open"]);
    const { data, error } = await scoped.order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as Record<string, unknown>[];
    for (const row of rows) {
      heads.push({
        cycleKey: String(row.cycle_key),
        weekIndex: Number(row.week_index),
        weekStart: String(row.week_start),
        weekEnd: String(row.week_end),
        status: String(row.status),
        dryRun: row.dry_run !== false,
      });
    }
    if (rows.length < PAGE) break;
  }
  return heads;
}

/**
 * The weeks the Super Admin can pick (owner, 2026-09-15 — "select the week I want"): every CLOSED
 * week of the current payroll month, built or not, plus any older week still waiting for release or
 * answers, so a week is never stranded when the month turns. Newest first.
 */
export async function listReviewWeeks(todayIso: string = cairoTodayIso()): Promise<ReviewWeekOption[]> {
  const settings = await getDigestSettings();
  const current = closedWeeksOfCurrentCycle(todayIso, settings.cycleAnchorDay);
  const currentKey = current?.cycle.cycleKey ?? null;
  const [inCycle, unfinished] = await Promise.all([
    currentKey ? readDigestHeads({ cycleKey: currentKey }) : Promise.resolve([] as DigestHead[]),
    readDigestHeads({ unfinished: true }),
  ]);

  const groups = new Map<string, { option: Omit<ReviewWeekOption, "stage" | "employeeCount">; digests: DigestHead[] }>();
  if (current) {
    for (const week of current.weeks) {
      groups.set(`${current.cycle.cycleKey}:${week.index}`, {
        option: { cycleKey: current.cycle.cycleKey, weekIndex: week.index, weekStart: week.startIso, weekEnd: week.endIso },
        digests: [],
      });
    }
  }
  for (const digest of [...inCycle, ...unfinished.filter((row) => row.cycleKey !== currentKey)]) {
    const key = `${digest.cycleKey}:${digest.weekIndex}`;
    const group = groups.get(key) ?? {
      option: { cycleKey: digest.cycleKey, weekIndex: digest.weekIndex, weekStart: digest.weekStart, weekEnd: digest.weekEnd },
      digests: [],
    };
    group.digests.push(digest);
    groups.set(key, group);
  }

  return Array.from(groups.values())
    .map(({ option, digests }) => ({ ...option, stage: reviewWeekStage(digests), employeeCount: digests.length }))
    .sort((left, right) => right.weekStart.localeCompare(left.weekStart));
}

/**
 * One week in full: every employee and every flagged day, whatever their state — cleared days
 * included, so the Super Admin can see what he did not deduct. A closed week of the current payroll
 * month that was never built comes back empty, as `not_built`; any other unknown week is null.
 */
export async function loadReviewWeek(input: { cycleKey: string; weekIndex: number; todayIso?: string }): Promise<ReviewWeek | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_weekly_digests")
    .select(DIGEST_COLUMNS)
    .eq("cycle_key", input.cycleKey)
    .eq("week_index", input.weekIndex)
    .order("id", { ascending: true })
    .limit(1000);
  if (error) throw error;
  const rows = (data ?? []) as Record<string, unknown>[];

  if (!rows.length) {
    const settings = await getDigestSettings();
    const current = closedWeeksOfCurrentCycle(input.todayIso ?? cairoTodayIso(), settings.cycleAnchorDay);
    const week = current && current.cycle.cycleKey === input.cycleKey ? current.weeks.find((candidate) => candidate.index === input.weekIndex) : undefined;
    if (!week) return null;
    return {
      cycleKey: input.cycleKey,
      weekIndex: week.index,
      weekStart: week.startIso,
      weekEnd: week.endIso,
      stage: "not_built",
      employeeCount: 0,
      releasedAt: null,
      employees: [],
    };
  }

  const lines = await loadLines(rows.map((row) => Number(row.id)));
  const directory = await loadDirectoryByKey();
  const digests = rows.map((row) => mapDigest(row, lines.get(Number(row.id)) ?? []));
  let releasedAt: string | null = null;
  const employees: ReviewEmployee[] = [];
  for (const digest of digests) {
    if (digest.releasedAt && (!releasedAt || digest.releasedAt > releasedAt)) releasedAt = digest.releasedAt;
    const person = directoryRowFor(directory, digest.employeeHrId);
    employees.push({
      digestId: digest.id,
      employeeHrId: digest.employeeHrId,
      employeeName: person?.displayName || person?.fullName || "Name not on file",
      jobTitle: person?.jobTitle ?? null,
      status: digest.status,
      totalDeductionDays: digest.totalDeductionDays,
      totalDeductionValue: digest.totalDeductionValue,
      hasUnpricedDay: digest.hasUnpricedDay,
      currency: digest.currency,
      answerDueOn: digest.answerDueOn,
      notified: Boolean(digest.notifiedAt),
      dryRun: digest.dryRun,
      lines: digest.lines,
    });
  }
  employees.sort((left, right) => left.employeeName.localeCompare(right.employeeName));
  const first = digests[0]!;
  return {
    cycleKey: first.cycleKey,
    weekIndex: first.weekIndex,
    weekStart: first.weekStart,
    weekEnd: first.weekEnd,
    stage: reviewWeekStage(digests),
    employeeCount: digests.length,
    releasedAt,
    employees,
  };
}

export type MarkResult = {
  lineId: number;
  digestId: number;
  deduct: boolean;
  deductionDays: number;
  deductionValue: number | null;
  detectedDays: number | null;
  adjusted: boolean;
  totalDeductionDays: number;
  totalDeductionValue: number | null;
  hasUnpricedDay: boolean;
};

/**
 * Tick or untick one flagged day before its week is released, and set how many days it deducts —
 * lower OR higher than detected (owner, 2026-09-15: "I want full control", "Raise too"). An unticked
 * day is cleared when the week is released and never deducted. The database function locks the
 * week's row, so a tick and a release cannot interleave, and refuses once the week has been released.
 */
export async function markDigestLine(input: {
  lineId: number;
  deduct: boolean;
  days: unknown;
  actorHrId: string;
  actorRole: string | null;
}): Promise<MarkResult> {
  assertCanManageWeeklyReview(input.actorRole);
  if (typeof input.deduct !== "boolean") throw validationError("Say whether this day is deducted.");
  let days: number | null = null;
  if (input.days !== null && input.days !== undefined) {
    const parsed = parseMarkedDays(input.days);
    if (parsed.error !== null) throw validationError(parsed.error);
    days = parsed.days;
  }

  const { data, error } = await getSupabaseAdmin().rpc("phx_attendance_mark_digest_line", {
    p_line_id: input.lineId,
    p_deduct: input.deduct,
    p_days: days,
    p_actor_hr_id: hrIdForStorage(input.actorHrId),
  });
  if (error) rethrowSettleError(error as { code?: string; message?: string });
  const row = (data ?? {}) as Record<string, unknown>;
  const result: MarkResult = {
    lineId: Number(row.lineId),
    digestId: Number(row.digestId),
    deduct: row.deduct === true,
    deductionDays: Number(row.deductionDays) || 0,
    deductionValue: numberOrNull(row.deductionValue),
    detectedDays: numberOrNull(row.detectedDays),
    adjusted: row.adjusted === true,
    totalDeductionDays: Number(row.totalDeductionDays) || 0,
    totalDeductionValue: numberOrNull(row.totalDeductionValue),
    hasUnpricedDay: row.hasUnpricedDay === true,
  };
  const workDate = String(row.workDate ?? "");

  await writeAuditLog({
    actorLoginId: input.actorHrId,
    entityId: String(input.lineId),
    entityType: "attendance_digest_line_marked",
    newValues: { digestId: result.digestId, workDate, deduct: result.deduct, deductionDays: result.deductionDays, detectedDays: result.detectedDays },
    summary: result.deduct
      ? `Attendance day ${workDate} ticked for deduction at ${result.deductionDays} day(s) before release`
      : `Attendance day ${workDate} unticked before release`,
  });
  return result;
}

/**
 * Build a closed week of the current payroll month that the daily job never built — it builds only
 * the week that has just closed. Nothing is sent: the week waits for release like any other. A week
 * with any digest at all, a trial run included, is never built again.
 */
export async function buildReviewWeek(input: {
  cycleKey: string;
  weekIndex: number;
  actorHrId: string;
  actorRole: string | null;
}): Promise<GenerateResult> {
  assertCanManageWeeklyReview(input.actorRole);
  const settings = await getDigestSettings();
  const current = closedWeeksOfCurrentCycle(cairoTodayIso(), settings.cycleAnchorDay);
  const week = current && current.cycle.cycleKey === input.cycleKey ? current.weeks.find((candidate) => candidate.index === input.weekIndex) : undefined;
  if (!current || !week) throw conflictError("Only a closed week of the current payroll month can be built.");

  // Checked inside the lock: a build of this week still running (the daily job, or another click)
  // finishes first, so this sees what it left — its digests when it succeeded, none when it failed
  // and undid itself.
  return withWeekBuildLock(current.cycle.cycleKey, week.index, async () => {
    const { data: existing, error: existingError } = await getSupabaseAdmin()
      .from("attendance_weekly_digests")
      .select("id")
      .eq("cycle_key", input.cycleKey)
      .eq("week_index", input.weekIndex)
      .limit(1);
    if (existingError) throw existingError;
    if ((existing ?? []).length) throw conflictError("This week has already been built.");

    return generateDigestsForWeek({ cycle: current.cycle, week, createdBy: input.actorHrId, settings });
  });
}

// ---------------------------------------------------------------------------
// The answer window
// ---------------------------------------------------------------------------

/**
 * How far past today the calendar and leave requests are read. A deadline only decides anything once
 * it has arrived, and every day up to today is inside this, so a leave running past it only means a
 * later run moves the stored date again.
 */
const ANSWER_HORIZON_DAYS = 45;

function addCalendarDaysIso(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

type AnswerWindowContext = {
  toIso: string;
  holidaysByDate: Map<string, string>;
  leaveByEmployee: Map<string, Set<string>>;
  directory: Map<string, EmployeeDirectoryRow>;
  flexPolicies: Awaited<ReturnType<typeof loadAttendanceFlexPolicyGroups>>;
};

/**
 * Everything a deadline needs: the public holiday calendar, leave (approved, or still waiting for a
 * decision — ANSWER_WINDOW_LEAVE_STATUSES), and each employee's job title and weekly-off pattern.
 * When the calendar or leave cannot be read, `context` is null and `unreadable` names which. Every
 * caller then refuses rather than guess: a deadline worked out without them comes too EARLY, and
 * silence after the deadline costs salary.
 */
async function loadAnswerWindow(input: {
  fromIso: string;
  toIso: string;
  employeeHrIds: string[];
}): Promise<{ context: AnswerWindowContext | null; unreadable: string | null; cause: string | null }> {
  const [calendar, leave, directory, flexPolicies] = await Promise.all([
    buildAttendanceCalendarContext({ dateFromIso: input.fromIso, dateToIso: input.toIso }),
    getLeaveDayMap({
      dateFromIso: input.fromIso,
      dateToIso: input.toIso,
      employeeHrIds: input.employeeHrIds,
      statuses: ANSWER_WINDOW_LEAVE_STATUSES,
    }).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error)))),
    loadDirectoryByKey(),
    loadAttendanceFlexPolicyGroups({ activeOnly: true }),
  ]);
  if (!calendar.holidaySourceConnected) {
    return { context: null, unreadable: "The public holiday calendar", cause: null };
  }
  // During a Google Calendar outage company and fixed-date holidays still load, so a month with one
  // (1 May, say) stays connected while both Eids, Islamic New Year, the Prophet's Birthday and Coptic
  // Easter are missing. An Eid day would then count as a day to answer in.
  if (!calendar.holidayCalendarReachable) {
    return { context: null, unreadable: "The public holiday calendar", cause: null };
  }
  if (leave instanceof Error) {
    return { context: null, unreadable: "Leave requests", cause: leave.message };
  }
  return {
    context: { toIso: input.toIso, holidaysByDate: calendar.holidaysByDate, leaveByEmployee: leave, directory, flexPolicies },
    unreadable: null,
    cause: null,
  };
}

/**
 * One employee's answer deadline: the Nth day after the release that counts — a scheduled working day
 * on THEIR weekly-off pattern that is neither a public holiday nor a day of leave, approved or still
 * waiting for approval.
 */
function answerDeadlineFor(
  context: AnswerWindowContext,
  input: { employeeHrId: string; releasedOnIso: string; workingDays: number },
): string {
  const jobTitle = directoryRowFor(context.directory, input.employeeHrId)?.jobTitle ?? null;
  // The employee's OWN weekly-off pattern, as the attendance report judges their days — a custom
  // policy (e.g. Saturday off as well) must not count Saturday as a working day to answer in.
  const policy = resolveActiveAttendancePolicy(
    { hr_id: input.employeeHrId, job_title: jobTitle },
    context.flexPolicies,
    input.releasedOnIso,
    context.toIso,
  );
  const workingWeekdays = policy?.working_weekdays ?? null;
  const leaveDays = context.leaveByEmployee.get(normalizeAttendanceHrId(input.employeeHrId) ?? "") ?? new Set<string>();
  return answerDueDate({
    releasedOnIso: input.releasedOnIso,
    workingDays: input.workingDays,
    isWorkingDay: (dateIso) =>
      countsTowardAnswerWindow({
        isScheduledWorkingDay: isAttendanceScheduledWorkingDay({ dateIso, jobTitle, workingWeekdays }),
        isPublicHoliday: context.holidaysByDate.has(dateIso),
        onLeave: leaveDays.has(dateIso),
      }),
  });
}

/**
 * The deadline each released digest holds now: worked out again from its release day with the leave
 * and holidays on record today, and never EARLIER than the date the employee was already given
 * (heldAnswerDueDate). A digest with no release stamp keeps its stored date. `deadlines` is null when
 * the calendar or leave requests cannot be read.
 */
async function heldAnswerDeadlines(input: {
  digests: Array<Pick<DigestRow, "id" | "employeeHrId" | "releasedAt" | "answerDueOn">>;
  todayIso: string;
  workingDays: number;
}): Promise<{ deadlines: Map<number, string> | null; unreadable: string | null; cause: string | null }> {
  const deadlines = new Map<number, string>();
  const released: Array<{ id: number; employeeHrId: string; releasedOnIso: string; answerDueOn: string | null }> = [];
  for (const digest of input.digests) {
    if (digest.releasedAt) {
      released.push({
        id: digest.id,
        employeeHrId: digest.employeeHrId,
        releasedOnIso: currentCairoDateOnlyIso(new Date(digest.releasedAt)),
        answerDueOn: digest.answerDueOn,
      });
    } else if (digest.answerDueOn) {
      deadlines.set(digest.id, digest.answerDueOn);
    }
  }
  if (!released.length) return { deadlines, unreadable: null, cause: null };

  // Every release day is on or before today, so starting from today finds the earliest.
  const fromIso = released.reduce((earliest, digest) => (digest.releasedOnIso < earliest ? digest.releasedOnIso : earliest), input.todayIso);
  const answerWindow = await loadAnswerWindow({
    fromIso,
    toIso: addCalendarDaysIso(input.todayIso, ANSWER_HORIZON_DAYS),
    employeeHrIds: released.map((digest) => digest.employeeHrId),
  });
  const context = answerWindow.context;
  if (!context) return { deadlines: null, unreadable: answerWindow.unreadable, cause: answerWindow.cause };
  for (const digest of released) {
    const recomputedDueOn = answerDeadlineFor(context, {
      employeeHrId: digest.employeeHrId,
      releasedOnIso: digest.releasedOnIso,
      workingDays: input.workingDays,
    });
    deadlines.set(digest.id, heldAnswerDueDate({ toldDueOn: digest.answerDueOn, recomputedDueOn }));
  }
  return { deadlines, unreadable: null, cause: null };
}

/**
 * Save an answer deadline that has moved LATER, so the employee's page, the review page and the
 * daily job all read one date. Guarded on the week still being open and its stored date still being
 * earlier, so a deadline is never brought forward and a week settled meanwhile is left alone.
 * Nothing here throws: a save that failed is named back to the caller.
 *
 * Whoever works a later date out saves it, because showing it is a promise. The window is worked out
 * from leave that may still be waiting for approval, and the daily job settles on the date that is
 * STORED — so a date only shown and never saved is a date nothing holds: reject that leave request
 * before the next run and the employee loses to salary a day they were told they still had.
 */
async function saveLaterAnswerDeadlines(
  moves: Array<{ id: number; storedDueOn: string | null; dueOn: string | null }>,
): Promise<{ moved: number; unsaved: Map<number, string> }> {
  const supabase = getSupabaseAdmin();
  let moved = 0;
  const unsaved = new Map<number, string>();
  for (const move of moves) {
    if (!move.dueOn || !move.storedDueOn || move.dueOn <= move.storedDueOn) continue;
    try {
      const { data, error } = await supabase
        .from("attendance_weekly_digests")
        .update({ answer_due_on: move.dueOn })
        .eq("id", move.id)
        .eq("status", "open")
        .lt("answer_due_on", move.dueOn)
        .select("id");
      if (error) unsaved.set(move.id, error.message);
      else if ((data ?? []).length) moved += 1;
    } catch (saveError) {
      unsaved.set(move.id, saveError instanceof Error ? saveError.message : String(saveError));
    }
  }
  return { moved, unsaved };
}

export type ReleaseResult = { released: number; notified: number; notNotified: number; skippedTrialRun: number; clearedDays: number };

/**
 * Release one week to its employees. Every day the Super Admin did not tick is cleared first — never
 * deducted — and only the ticked days are asked about. Sets each employee's answer deadline — N
 * working days after today, on THEIR weekly-off pattern, the holiday calendar and their leave,
 * approved or still waiting for approval — and tells them in-app and by Telegram. A trial-run week
 * is refused outright (owner, 2026-09-15).
 */
export async function releaseWeek(input: { cycleKey: string; weekIndex: number; actorHrId: string; actorRole: string | null }): Promise<ReleaseResult> {
  assertCanManageWeeklyReview(input.actorRole);
  // Under the same lock a build takes: a build of this week still running — the daily job, or a
  // Build this week click — finishes first, so a release can never open half of a week and leave the
  // rest of its employees in a week no later click will ever release.
  return withWeekBuildLock(input.cycleKey, input.weekIndex, () => releaseBuiltWeek(input));
}

async function releaseBuiltWeek(input: { cycleKey: string; weekIndex: number; actorHrId: string; actorRole: string | null }): Promise<ReleaseResult> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_weekly_digests")
    .select(DIGEST_COLUMNS)
    .eq("cycle_key", input.cycleKey)
    .eq("week_index", input.weekIndex)
    .eq("status", "awaiting_release");
  if (error) throw error;
  const rows = (data ?? []) as Record<string, unknown>[];
  if (!rows.length) throw conflictError("Nothing in this week is waiting for release.");

  const digests = rows.map((row) => mapDigest(row, []));
  const realDigests = digests.filter((digest) => !digest.dryRun);
  const skippedTrialRun = digests.length - realDigests.length;
  if (!realDigests.length) throw conflictError("This week was built as a trial run and can never be released.");

  const settings = await getDigestSettings();
  const todayIso = cairoTodayIso();
  // Refuse rather than guess. Without the holiday calendar a public holiday would count as one of the
  // employee's working days to answer in, and without their leave requests so would a day they are
  // away — and silence after the deadline costs them salary.
  const answerWindow = await loadAnswerWindow({
    fromIso: todayIso,
    toIso: addCalendarDaysIso(todayIso, ANSWER_HORIZON_DAYS),
    employeeHrIds: realDigests.map((digest) => digest.employeeHrId),
  });
  if (!answerWindow.context) {
    throw conflictError(
      `${answerWindow.unreadable ?? "The attendance calendar"} could not be read, so the answer deadline cannot be worked out. Nothing was released — try again shortly.`,
    );
  }
  const answerContext = answerWindow.context;

  let released = 0;
  let notified = 0;
  let notNotified = 0;
  let clearedDays = 0;
  for (const digest of realDigests) {
    const answerDueOn = answerDeadlineFor(answerContext, {
      employeeHrId: digest.employeeHrId,
      releasedOnIso: todayIso,
      workingDays: settings.answerWorkingDays,
    });
    // One transaction per employee, under the week's row lock: clear every unticked day (a `removed`
    // settlement, which the bridge turns into Do Not Take Action), then open the week — or void it
    // when nothing is left, or settle it when only days answered before the release step remain. It
    // refuses a trial-run digest and one another click already released.
    const { data: releasedRow, error: releaseError } = await supabase.rpc("phx_attendance_release_digest", {
      p_digest_id: digest.id,
      p_actor_hr_id: hrIdForStorage(input.actorHrId),
      p_answer_due_on: answerDueOn,
    });
    if (releaseError) rethrowSettleError(releaseError as { code?: string; message?: string });
    const outcome = (releasedRow ?? {}) as { released?: unknown; status?: unknown; pendingDays?: unknown; clearedDays?: unknown };
    clearedDays += Number(outcome.clearedDays) || 0;
    if (outcome.released !== true) continue;
    released += 1;

    // Only the ticked days are asked about. None pending: nobody is told.
    const dayCount = Number(outcome.pendingDays) || 0;
    if (outcome.status !== "open" || dayCount === 0) continue;
    const sent = await notifyAttendanceWeekReleased({
      digestId: digest.id,
      employeeHrId: digest.employeeHrId,
      weekStart: digest.weekStart,
      weekEnd: digest.weekEnd,
      dayCount,
      answerDueOn,
    });
    if (sent) {
      // The deadline sweep only settles digests with this stamp: a day nobody was told about is
      // never taken from salary for going unanswered. If this write fails, say so — the employee
      // was told, but their days would wait for a person instead of settling.
      const { error: stampError } = await supabase
        .from("attendance_weekly_digests")
        .update({ notified_at: new Date().toISOString() })
        .eq("id", digest.id);
      if (stampError) {
        notNotified += 1;
      } else {
        notified += 1;
      }
    } else {
      notNotified += 1;
    }
  }

  await writeAuditLog({
    actorLoginId: input.actorHrId,
    entityId: `${input.cycleKey}:w${input.weekIndex}`,
    entityType: "attendance_digest_release",
    newValues: { released, notified, notNotified, skippedTrialRun, clearedDays },
    summary: `Weekly attendance ${input.cycleKey} week ${input.weekIndex} released to ${released} employee(s), ${clearedDays} unticked day(s) cleared`,
  });
  return { released, notified, notNotified, skippedTrialRun, clearedDays };
}

// ---------------------------------------------------------------------------
// Employee: their own released weeks
// ---------------------------------------------------------------------------

export type MyDigestLine = DigestLineRow & { balance: BalanceOption | null };
export type MyDigest = Omit<DigestRow, "lines"> & { overdue: boolean; lines: MyDigestLine[] };

/**
 * One employee's RELEASED weeks. A week waiting for release is invisible to the person it
 * describes, and so is a removed day — both are still the Super Admin's to decide.
 */
export async function listMyDigests(employeeHrId: string): Promise<MyDigest[]> {
  const supabase = getSupabaseAdmin();
  // HR ids are stored mixed-case; a plain .eq under-returns. Match every spelling.
  const { data, error } = await supabase
    .from("attendance_weekly_digests")
    .select(DIGEST_COLUMNS)
    .in("employee_hr_id", hrIdLookupKeys(employeeHrId))
    .in("status", ["open", "settled"])
    .eq("dry_run", false)
    .not("released_at", "is", null)
    .order("week_start", { ascending: false })
    .limit(24);
  if (error) throw error;
  const rows = (data ?? []) as Record<string, unknown>[];
  const lines = await loadLines(rows.map((row) => Number(row.id)));
  const todayIso = cairoTodayIso();
  const digests = rows.map((row) => mapDigest(row, (lines.get(Number(row.id)) ?? []).filter((line) => line.action !== "removed")));

  const hasPending = digests.some((digest) => digest.lines.some((line) => line.action === "pending"));
  const hireDate = hasPending ? directoryRowFor(await loadDirectoryByKey(), employeeHrId)?.hireDate ?? null : null;

  // A stored deadline that has passed may have moved: days on leave, approved or still waiting for
  // approval, do not count (owner, 2026-09-15 and 2026-09-16), and leave can be filed after the
  // release. Work those out again, so the page does not say the deadline passed while the answer is
  // still accepted. If that cannot be done, the stored date stands for this page load.
  const pastStoredDate = digests.filter(
    (digest) =>
      digest.status === "open" &&
      digest.lines.some((line) => line.action === "pending") &&
      deadlineApplies({ answerDueOn: digest.answerDueOn, notifiedAt: digest.notifiedAt, todayCairoIso: todayIso }),
  );
  let held: Map<number, string> | null = null;
  if (pastStoredDate.length) {
    const settings = await getDigestSettings().catch(() => null);
    const read = settings
      ? await heldAnswerDeadlines({ digests: pastStoredDate, todayIso, workingDays: settings.answerWorkingDays }).catch(() => null)
      : null;
    const deadlines = read?.deadlines ?? null;
    held = deadlines;
    if (deadlines) {
      // Showing a later date is a promise, so it is SAVED before it is shown. The daily job settles
      // on the STORED date, and a leave request rejected before its next run would otherwise bring
      // the worked-out date back to the stored one and take the day to salary. A date that could not
      // be saved is dropped here too, and the stored one stands on this page.
      const { unsaved } = await saveLaterAnswerDeadlines(
        pastStoredDate.map((digest) => ({ id: digest.id, storedDueOn: digest.answerDueOn, dueOn: deadlines.get(digest.id) ?? null })),
      );
      for (const id of unsaved.keys()) deadlines.delete(id);
    }
  }

  const result: MyDigest[] = [];
  for (const digest of digests) {
    const answerDueOn = held?.get(digest.id) ?? digest.answerDueOn;
    const overdue = digest.status === "open" && deadlineApplies({ answerDueOn, notifiedAt: digest.notifiedAt, todayCairoIso: todayIso });
    const withBalance: MyDigestLine[] = [];
    for (const line of digest.lines) {
      let balance: BalanceOption | null = null;
      if (line.action === "pending" && !overdue) {
        const check = await checkAnnualBalance({ employeeHrId: digest.employeeHrId, hireDate, workDate: line.workDate, days: line.deductionDays }).catch(
          () => null,
        );
        balance = check
          ? { covers: check.covers, availableDays: check.availableDays, unavailableReason: check.unavailableReason }
          : { covers: false, availableDays: null, unavailableReason: "Your annual balance could not be read right now. Try again shortly." };
      }
      withBalance.push({ ...line, balance });
    }
    result.push({ ...digest, answerDueOn, overdue, lines: withBalance });
  }
  return result;
}

/**
 * The employee's answer for one day: salary or annual balance, and optionally a dispute.
 *
 * Without a dispute the day settles immediately. With one, the method is recorded and the day
 * waits for the reviewer — nothing is spent from the balance until the dispute is decided.
 */
export async function answerDigestLine(input: {
  digestId: number;
  lineId: number;
  method: DeductionMethod;
  dispute: boolean;
  disputeReason?: string | null;
  actorHrId: string;
  actorRole: string;
}): Promise<{ outcome: "salary" | "annual_balance" | "disputed" }> {
  if (!isDeductionMethod(input.method)) throw validationError("Choose salary or annual balance.");
  const digest = await loadDigestOrThrow(input.digestId);
  assertOwnDigest(digest, input.actorHrId);
  if (digest.status !== "open" || digest.dryRun) throw conflictError("This week is not open for answers.");
  const todayIso = cairoTodayIso();
  if (deadlineApplies({ answerDueOn: digest.answerDueOn, notifiedAt: digest.notifiedAt, todayCairoIso: todayIso })) {
    // The stored date has passed, but days on leave do not count (owner, 2026-09-15; leave still
    // waiting for approval too, 2026-09-16), and leave filed since the release moves the deadline.
    // Work it out again before refusing — the daily job decides on the same answer — and refuse when
    // that cannot be done.
    const dueOn = await getDigestSettings()
      .then((settings) => heldAnswerDeadlines({ digests: [digest], todayIso, workingDays: settings.answerWorkingDays }))
      .then((held) => held.deadlines?.get(digest.id) ?? null)
      .catch(() => null);
    if (!dueOn) throw conflictError("Your answer deadline could not be checked right now. Try again shortly.");
    if (isAnswerOverdue(dueOn, todayIso)) {
      throw conflictError("The deadline for this week has passed, so unanswered days are deducted from salary.");
    }
    // This answer was accepted on the later date, so the later date is saved. The daily job settles
    // the REST of this week on the stored one, and it must not take those days to salary on a
    // deadline this employee has already been let past. A failed save never blocks the answer.
    await saveLaterAnswerDeadlines([{ id: digest.id, storedDueOn: digest.answerDueOn, dueOn }]);
  }
  const line = digest.lines.find((candidate) => candidate.id === input.lineId);
  if (!line || line.action === "removed") throw notFoundError("That day was not found.");
  if (line.action !== "pending") throw conflictError("That day has already been answered — reload and look again.");

  let balance: BalanceCheck | null = null;
  if (input.method === "annual_balance") {
    const hireDate = directoryRowFor(await loadDirectoryByKey(), digest.employeeHrId)?.hireDate ?? null;
    balance = await checkAnnualBalance({ employeeHrId: digest.employeeHrId, hireDate, workDate: line.workDate, days: line.deductionDays });
    if (!balance.covers) throw conflictError(balance.unavailableReason ?? "Your annual balance does not cover this day.");
  }

  if (input.dispute) {
    const reason = String(input.disputeReason ?? "").trim();
    if (!reason) throw validationError("A dispute needs a reason.");
    const now = new Date().toISOString();
    const { data, error } = await getSupabaseAdmin()
      .from("attendance_digest_lines")
      .update({ action: "disputed", chosen_method: input.method, dispute_reason: reason, acted_at: now, updated_at: now })
      .eq("id", line.id)
      .eq("action", "pending")
      .select("id");
    if (error) throw error;
    if (!data || (data as unknown[]).length === 0) throw conflictError("That day has already been answered — reload and look again.");
    await writeAuditLog({
      actorLoginId: input.actorHrId,
      entityId: String(line.id),
      entityType: "attendance_digest_answer",
      newValues: { workDate: line.workDate, method: input.method, dispute: true, reason },
      summary: `Employee chose ${input.method === "salary" ? "salary" : "annual balance"} and disputed ${line.workDate}`,
    });
    return { outcome: "disputed" };
  }

  await settleLine({
    lineId: line.id,
    expected: ["pending"],
    action: input.method,
    method: input.method,
    actorHrId: input.actorHrId,
    actorRole: input.actorRole,
    reason: input.method === "salary" ? "Employee chose salary" : "Employee chose annual balance",
    balance,
  });
  await writeAuditLog({
    actorLoginId: input.actorHrId,
    entityId: String(line.id),
    entityType: "attendance_digest_answer",
    newValues: { workDate: line.workDate, method: input.method, dispute: false, days: line.deductionDays },
    summary: `Employee chose ${input.method === "salary" ? "salary" : "annual balance"} for ${line.workDate}`,
  });
  return { outcome: input.method };
}

// ---------------------------------------------------------------------------
// Disputes
// ---------------------------------------------------------------------------

export type PendingDispute = {
  lineId: number;
  digestId: number;
  employeeHrId: string;
  employeeName: string;
  workDate: string;
  deductionDays: number;
  deductionValue: number | null;
  chosenMethod: DeductionMethod | null;
  reason: string;
  disputeReason: string | null;
  evidence: Record<string, string>;
};

/** Every day waiting on a reviewer's decision, oldest first. */
export async function listPendingDisputes(): Promise<PendingDispute[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_digest_lines")
    .select(
      "id,digest_id,work_date,deduction_days,deduction_value,chosen_method,reason,dispute_reason,evidence,attendance_weekly_digests!inner(employee_hr_id)",
    )
    .eq("action", "disputed")
    .order("work_date", { ascending: true })
    .limit(200);
  if (error) throw error;
  const directory = await loadDirectoryByKey();
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => {
    const nested = row.attendance_weekly_digests as { employee_hr_id?: string } | Array<{ employee_hr_id?: string }> | null;
    const employeeHrId = String((Array.isArray(nested) ? nested[0]?.employee_hr_id : nested?.employee_hr_id) ?? "");
    const person = directoryRowFor(directory, employeeHrId);
    return {
      lineId: Number(row.id),
      digestId: Number(row.digest_id),
      employeeHrId,
      employeeName: person?.displayName || person?.fullName || "Name not on file",
      workDate: String(row.work_date),
      deductionDays: Number(row.deduction_days) || 0,
      deductionValue: numberOrNull(row.deduction_value),
      chosenMethod: isDeductionMethod(row.chosen_method) ? row.chosen_method : null,
      reason: String(row.reason ?? ""),
      disputeReason: textOrNull(row.dispute_reason),
      evidence: (row.evidence ?? {}) as Record<string, string>,
    };
  });
}

/**
 * Decide a disputed day. Upheld: no deduction at all. Rejected: the method the employee chose
 * applies — and if they chose annual balance but it no longer covers the day (leave approved
 * since), the day falls to salary and the settlement says why. Either way the employee is then told
 * in-app and by Telegram (owner, 2026-09-15); `notified` is false when neither channel took it.
 */
export async function reviewDispute(input: {
  lineId: number;
  uphold: boolean;
  notes?: string | null;
  reviewerHrId: string;
  reviewerRole: string;
}): Promise<{ appliedMethod: DeductionMethod | null; balanceRefusal: string | null; notified: boolean }> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_digest_lines")
    .select("id,digest_id,work_date,deduction_days,action,chosen_method")
    .eq("id", input.lineId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw notFoundError("That day was not found.");
  const line = data as { id: number; digest_id: number; work_date: string; deduction_days: unknown; action: string; chosen_method: unknown };
  if (line.action !== "disputed") throw conflictError("That day is not under dispute.");
  const digest = await loadDigestOrThrow(Number(line.digest_id));
  if (digest.dryRun) throw conflictError("This day belongs to a trial-run week, which can never be settled.");
  assertNotOwnPay(digest.employeeHrId, input.reviewerHrId, input.reviewerRole);
  const notes = input.notes?.trim() || null;

  if (input.uphold) {
    await settleLine({
      lineId: line.id,
      expected: ["disputed"],
      action: "dispute_upheld",
      method: isDeductionMethod(line.chosen_method) ? line.chosen_method : null,
      actorHrId: null,
      actorRole: input.reviewerRole,
      reviewerHrId: input.reviewerHrId,
      reason: notes ?? "Dispute upheld",
      reviewNotes: notes,
    });
    await writeAuditLog({
      actorLoginId: input.reviewerHrId,
      entityId: String(line.id),
      entityType: "attendance_digest_dispute_review",
      newValues: { uphold: true, notes },
      summary: `Attendance dispute upheld for ${line.work_date}`,
    });
    const notified = await notifyAttendanceDisputeDecided({
      digestId: digest.id,
      lineId: line.id,
      employeeHrId: digest.employeeHrId,
      workDate: line.work_date,
      upheld: true,
      appliedMethod: null,
      chosenMethod: isDeductionMethod(line.chosen_method) ? line.chosen_method : null,
      balanceRefusal: null,
      hasReviewerNote: Boolean(notes),
    });
    return { appliedMethod: null, balanceRefusal: null, notified };
  }

  let method: DeductionMethod = isDeductionMethod(line.chosen_method) ? line.chosen_method : "salary";
  let reason = notes ?? "Dispute rejected";
  let balance: BalanceCheck | null = null;
  let balanceRefusal: string | null = null;
  if (method === "annual_balance") {
    const hireDate = directoryRowFor(await loadDirectoryByKey(), digest.employeeHrId)?.hireDate ?? null;
    balance = await checkAnnualBalance({
      employeeHrId: digest.employeeHrId,
      hireDate,
      workDate: line.work_date,
      days: Number(line.deduction_days) || 0,
    });
    if (!balance.covers) {
      // A read that failed is not an answer: settling now would move the day to salary for good
      // because of a transient error. Refuse and let the reviewer try again.
      if (balance.refusal === "balance_unreadable") {
        throw conflictError("The employee's annual balance could not be fully read right now. Try again shortly.");
      }
      reason = `${reason}. ${disputeSalaryFallbackText(balance.refusal)}`;
      balanceRefusal = balance.refusal;
      method = "salary";
      balance = null;
    }
  }

  await settleLine({
    lineId: line.id,
    expected: ["disputed"],
    action: "dispute_rejected",
    method,
    actorHrId: null,
    actorRole: input.reviewerRole,
    reviewerHrId: input.reviewerHrId,
    reason,
    reviewNotes: notes,
    balance,
  });
  await writeAuditLog({
    actorLoginId: input.reviewerHrId,
    entityId: String(line.id),
    entityType: "attendance_digest_dispute_review",
    newValues: { uphold: false, notes, appliedMethod: method },
    summary: `Attendance dispute rejected for ${line.work_date}; ${method === "salary" ? "salary" : "annual balance"} applied`,
  });
  // The employee is told where the day is taken from, with the real cause when balance fell to salary.
  const notified = await notifyAttendanceDisputeDecided({
    digestId: digest.id,
    lineId: line.id,
    employeeHrId: digest.employeeHrId,
    workDate: line.work_date,
    upheld: false,
    appliedMethod: method,
    chosenMethod: isDeductionMethod(line.chosen_method) ? line.chosen_method : null,
    balanceRefusal,
    hasReviewerNote: Boolean(notes),
  });
  return { appliedMethod: method, balanceRefusal, notified };
}

// ---------------------------------------------------------------------------
// The deadline
// ---------------------------------------------------------------------------

export type SweepResult = {
  digestsChecked: number;
  daysSettledToSalary: number;
  /** Deadlines saved later, because days on leave (or holidays) since the release do not count. */
  deadlinesMoved: number;
  failures: number;
  failureMessages: string[];
};

/**
 * Settle every unanswered day whose deadline has passed to salary (owner, 2026-09-15). A disputed
 * day is left alone: the employee did answer, and the reviewer has not.
 *
 * The stored deadline only says where to look. Days on leave do not count (owner, 2026-09-15 —
 * "Pause for leave days"; leave still waiting for approval too, 2026-09-16 — "Pending pauses too"),
 * and leave can be filed after the release, so each week past its stored date has its deadline
 * worked out again first. A later date is saved and the days wait; a deadline is never brought
 * forward. When the holiday calendar or leave requests cannot be read, nothing is settled at all and
 * the run fails loudly — the next run tries again.
 */
export async function settleOverdueAnswers(input: { todayIso: string; actor: string }): Promise<SweepResult> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_weekly_digests")
    .select("id,employee_hr_id,week_start,released_at,answer_due_on,notified_at")
    .eq("status", "open")
    .eq("dry_run", false)
    // Only employees who were actually told. See deadlineApplies.
    .not("notified_at", "is", null)
    .lt("answer_due_on", input.todayIso)
    .limit(2000);
  if (error) throw error;
  const pastStoredDate = ((data ?? []) as Array<Record<string, unknown>>)
    .filter((row) =>
      deadlineApplies({ answerDueOn: textOrNull(row.answer_due_on), notifiedAt: textOrNull(row.notified_at), todayCairoIso: input.todayIso }),
    )
    .map((row) => ({
      id: Number(row.id),
      employeeHrId: String(row.employee_hr_id ?? ""),
      weekStart: String(row.week_start ?? ""),
      releasedAt: textOrNull(row.released_at),
      answerDueOn: textOrNull(row.answer_due_on),
    }));
  const lines = await loadLines(pastStoredDate.map((digest) => digest.id));
  const withPending = pastStoredDate.filter((digest) => (lines.get(digest.id) ?? []).some((line) => line.action === "pending"));

  let daysSettledToSalary = 0;
  let deadlinesMoved = 0;
  let failures = 0;
  const failureMessages: string[] = [];
  let heldDeadlines = new Map<number, string>();
  if (withPending.length) {
    const settings = await getDigestSettings();
    const held = await heldAnswerDeadlines({ digests: withPending, todayIso: input.todayIso, workingDays: settings.answerWorkingDays });
    if (!held.deadlines) {
      throw new Error(
        `${held.unreadable ?? "The attendance calendar"} could not be read${held.cause ? ` (${held.cause})` : ""}, so no overdue attendance day was settled to salary. The next run tries again.`,
      );
    }
    heldDeadlines = held.deadlines;
  }
  // Save every deadline that moved later BEFORE settling anything, so the pages and the next run
  // read one date and nothing is settled on a date this run worked out and then failed to save.
  const saved = await saveLaterAnswerDeadlines(
    withPending.map((digest) => ({ id: digest.id, storedDueOn: digest.answerDueOn, dueOn: heldDeadlines.get(digest.id) ?? digest.answerDueOn })),
  );
  deadlinesMoved = saved.moved;
  for (const digest of withPending) {
    const saveFailure = saved.unsaved.get(digest.id);
    if (saveFailure) {
      failures += 1;
      failureMessages.push(`Week of ${digest.weekStart}: the later answer deadline could not be saved (${saveFailure})`);
    }
    const dueOn = heldDeadlines.get(digest.id) ?? digest.answerDueOn;
    if (!dueOn || !isAnswerOverdue(dueOn, input.todayIso)) continue;
    // Read the stored deadline once more, right before settling this week. Minutes pass while a run
    // works through thousands of weeks, and the employee's page or an answer of theirs may have saved
    // a later date in between — the date they were shown is the date that decides. A week no longer
    // open is left alone, and a read that failed settles nothing.
    const { data: storedRow, error: storedError } = await supabase
      .from("attendance_weekly_digests")
      .select("answer_due_on")
      .eq("id", digest.id)
      .eq("status", "open")
      .maybeSingle();
    if (storedError) {
      failures += 1;
      failureMessages.push(`Week of ${digest.weekStart}: the answer deadline could not be read again before settling (${storedError.message})`);
      continue;
    }
    if (!storedRow) continue;
    const storedNow = textOrNull((storedRow as Record<string, unknown>).answer_due_on);
    if (!isAnswerOverdue(heldAnswerDueDate({ toldDueOn: storedNow, recomputedDueOn: dueOn }), input.todayIso)) continue;
    for (const line of lines.get(digest.id) ?? []) {
      if (line.action !== "pending") continue;
      try {
        await settleLine({
          lineId: line.id,
          expected: ["pending"],
          action: "auto_salary",
          method: "salary",
          actorHrId: null,
          actorRole: null,
          reason: "Not answered by the deadline after the week was released",
        });
        daysSettledToSalary += 1;
      } catch (sweepError) {
        // Somebody answered in the same instant: their answer stands, nothing to report.
        if (sweepError instanceof Error && /answered|not open/i.test(sweepError.message)) continue;
        // Anything else is a real failure. The daily job reports it (HTTP 500) so it is seen, and
        // the next run tries the day again.
        failures += 1;
        failureMessages.push(`${line.workDate}: ${sweepError instanceof Error ? sweepError.message : String(sweepError)}`);
      }
    }
  }

  if (daysSettledToSalary > 0 || deadlinesMoved > 0 || failures > 0) {
    await writeAuditLog({
      actorLoginId: input.actor,
      entityId: input.todayIso,
      entityType: "attendance_digest_auto_salary",
      newValues: { digestsChecked: pastStoredDate.length, daysSettledToSalary, deadlinesMoved, failures, failureMessages: failureMessages.slice(0, 20) },
      summary: `${daysSettledToSalary} unanswered attendance day(s) settled to salary after the deadline; ${deadlinesMoved} answer deadline(s) moved later`,
    });
  }
  return { digestsChecked: pastStoredDate.length, daysSettledToSalary, deadlinesMoved, failures, failureMessages: failureMessages.slice(0, 20) };
}

export { isOpenLineAction, tileSettlementWeeks };
export type { SettlementWeek, BuiltDigest };
