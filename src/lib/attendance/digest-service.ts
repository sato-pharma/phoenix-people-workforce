// Weekly attendance review: keep each week's flagged days up to date, let the Super Admin review and
// release them, and record what each employee chooses for every flagged day.
//
// OWNER DECISION 2026-09-15 — replaces the 2026-09-08 "permanently silent" ruling — and 2026-09-17.
//
//   1. LIVE, NOT SENT. A week is on the admin review page from its first day and holds the days up to
//      yesterday (owner, 2026-09-17 — "Show live, release any time"). The daily job brings every week
//      of the review month up to date from the fingerprint report: new flagged days are added unticked,
//      a waiting day's figures follow the report, and a waiting day the report has since cleared is
//      removed. Nothing reaches an employee from here. The weeks follow the calendar month
//      (digest-weeks.ts).
//   2. RELEASED BY THE SUPER ADMIN, AS OFTEN AS HE LIKES. Release opens the days waiting now and tells
//      each employee by email, Telegram and in-app (owner, 2026-09-17). Days that arrive after a release wait for a
//      second release of the same week. A trial-run week (dry_run) can never be released.
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
//      by email, Telegram and in-app, with where a rejected day is taken from (owner, 2026-09-15).
//
// SCOPE. This module records an answer and, for balance, spends leave days. It never writes a
// deduction: the month-end Fingerprint connector stays the only author of deductions_candidates,
// and digest-bridge.ts applies the answer to the candidate once it exists. Two writers of one
// employee-day is how this database charged 19 employee-days twice in July 2026.
//
// ATOMICITY. Every settlement goes through phx_attendance_settle_digest_line, which writes the
// settlement, the balance charge, the line and the digest status in one transaction, guarded on
// the line's current action. A day paid from balance also re-checks, under the same per-employee
// lock leave approval takes, that nothing spent the balance between the read and the write. Bringing a
// week up to date goes through phx_attendance_sync_digest_days, one transaction per employee under the
// week's row lock, so a tick, a release and an update never interleave.

import { writeAuditLog } from "@/lib/admin/audit";
import { isSalaryBlindRole } from "@/lib/auth/hr-functions";
import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { canonicalHrIdKey, hrIdForStorage, hrIdLookupKeys, hrIdsMatch } from "@/lib/hr-id.ts";
import { getFingerprintAttendanceReport } from "@/lib/attendance/fingerprint-report.ts";
import {
  currentReviewMonth,
  previousMonthKey,
  refreshableReviewWeek,
  reviewWeekOf,
  reviewWeeksToSync,
  reviewWeekWindow,
  startedReviewWeeks,
  type ReviewWeekWindow,
  type SettlementWeek,
} from "@/lib/attendance/digest-weeks.ts";
import { planWeekSync, type BuiltDigest } from "@/lib/attendance/digest-generator.ts";
import { withWeekBuildLock } from "@/lib/attendance/week-build-lock.ts";
import {
  ANSWER_WINDOW_LEAVE_STATUSES,
  answerDueDate,
  balanceCoversDays,
  balanceReadIsComplete,
  canManageWeeklyReview,
  countsTowardAnswerWindow,
  deadlineApplies,
  deductionCategoryForDigestLine,
  disputeSalaryFallbackText,
  heldAnswerDueDate,
  isAnswerOverdue,
  isDeductionMethod,
  isOpenLineAction,
  parseMarkedDays,
  parseReleaseDigestId,
  parseSeenReleaseLines,
  payrollDecisionBlocksBalance,
  releaseNoticeRange,
  releaseScope,
  reviewWeekStage,
  staleReleaseLines,
  type DeductionMethod,
  type DigestLineAction,
  type DigestStatus,
  type ReviewWeekStage,
  type SeenReleaseLine,
} from "@/lib/attendance/digest-rules.ts";
import {
  notifyAttendanceDisputeDecided,
  notifyAttendanceDisputeFiled,
  notifyAttendanceWeekReleased,
} from "@/lib/attendance/digest-notify.ts";
import { resolveSuperAdminRecipients } from "@/lib/private-calendar/notify-admin";
import { buildAttendanceCalendarContext, cairoTodayIso, getLeaveDayMap } from "@/lib/attendance/working-days.ts";
import { isAttendanceScheduledWorkingDay } from "@/lib/attendance/work-schedule.ts";
import { normalizeAttendanceHrId, resolveActiveAttendancePolicy } from "@/lib/attendance/metrics";
import { loadAttendanceFlexPolicyGroups } from "@/lib/attendance/policy-groups";
import { getEmployeeDirectoryRows, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { calculatePaymentForRequest } from "@/lib/vacation/service";
import { getVacationBalancePeriod } from "@/lib/vacation/calculations";

export type { DigestLineAction, DeductionMethod, DigestStatus, ReviewWeekStage, SeenReleaseLine };

export type DigestSettings = {
  disputeReviewerHrIds: string[];
  showEstimatedAmount: boolean;
  dryRun: boolean;
  enabled: boolean;
  answerWorkingDays: number;
};

const SETTINGS_DEFAULTS: DigestSettings = {
  disputeReviewerHrIds: [],
  showEstimatedAmount: true,
  dryRun: true,
  enabled: false,
  answerWorkingDays: 2,
};

export async function getDigestSettings(): Promise<DigestSettings> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_digest_settings")
    .select("dispute_reviewer_hr_ids,show_estimated_amount,dry_run,enabled,answer_working_days")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return SETTINGS_DEFAULTS;
  const row = data as Record<string, unknown>;
  const answerWorkingDays = Number(row.answer_working_days);
  return {
    disputeReviewerHrIds: Array.isArray(row.dispute_reviewer_hr_ids) ? (row.dispute_reviewer_hr_ids as string[]) : [],
    showEstimatedAmount: row.show_estimated_amount !== false,
    // Both flags FAIL SAFE: a missing or unreadable value keeps the module quiet and keeps money
    // out of it, rather than defaulting to "live".
    dryRun: row.dry_run !== false,
    enabled: row.enabled === true,
    answerWorkingDays: Number.isInteger(answerWorkingDays) && answerWorkingDays > 0 ? answerWorkingDays : SETTINGS_DEFAULTS.answerWorkingDays,
  };
}

// ---------------------------------------------------------------------------
// Keeping a week up to date
// ---------------------------------------------------------------------------

export type WeekSyncResult = {
  monthKey: string;
  weekIndex: number;
  weekStart: string;
  weekEnd: string;
  /** The last day read from the fingerprint report: the week end, or yesterday while the week runs. */
  throughIso: string;
  running: boolean;
  /** Employees with a flagged day, or a waiting day to check, in this week. */
  employeesChecked: number;
  digestsCreated: number;
  daysAdded: number;
  daysUpdated: number;
  daysCleared: number;
  digestsRemoved: number;
  /** Flagged days already in an earlier release of the week, left with it. */
  daysAlreadyReleased: number;
  /** Employees whose update failed, by name. Every other employee in the week was still brought up to date. */
  failures: string[];
  dryRun: boolean;
};

export type SyncRunResult = { todayIso: string; weeks: WeekSyncResult[]; failures: string[]; dryRun: boolean };

/** What one call of phx_attendance_sync_digest_days did for one employee. */
type EmployeeSyncOutcome = {
  created: boolean;
  added: number;
  updated: number;
  cleared: number;
  alreadyElsewhere: number;
  removedDigest: boolean;
};

/**
 * The daily job: bring every started week of the current review month up to date — and, for the first
 * three days of a month, the previous month's last week — waiting for release. Nothing is sent here —
 * ever. The notice goes out when the Super Admin releases a week.
 *
 * The report runs ONCE, over every week's days together, and each week takes its own days from it: one
 * report per week would multiply the run's time by the number of weeks. Each week is then brought up to
 * date under its build lock, and a week that fails does not stop the others: its failure is returned,
 * so the scheduler sees a 500 rather than a quiet zero.
 */
export async function syncOpenReviewWeeks(input: { todayIso: string; createdBy: string }): Promise<SyncRunResult> {
  const settings = await getDigestSettings();
  const windows = reviewWeeksToSync(input.todayIso);
  const weeks: WeekSyncResult[] = [];
  const failures: string[] = [];
  if (!windows.length) return { todayIso: input.todayIso, weeks, failures, dryRun: settings.dryRun };
  const dateFrom = windows.reduce((earliest, window) => (window.startIso < earliest ? window.startIso : earliest), windows[0]!.startIso);
  const dateTo = windows.reduce((latest, window) => (window.throughIso > latest ? window.throughIso : latest), windows[0]!.throughIso);
  const report = await getFingerprintAttendanceReport({ dateFrom, dateTo });
  for (const window of windows) {
    try {
      const result = await withWeekBuildLock(window.monthKey, window.index, () =>
        syncReviewWeekDays({ window, createdBy: input.createdBy, settings, rows: report.rows }),
      );
      weeks.push(result);
      for (const failure of result.failures) failures.push(`${window.monthKey} week ${window.index}: ${failure}`);
    } catch (error) {
      failures.push(`${window.monthKey} week ${window.index}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { todayIso: input.todayIso, weeks, failures, dryRun: settings.dryRun };
}

/**
 * Bring one week up to date from the fingerprint report, over its days up to `throughIso`. Callers hold
 * withWeekBuildLock for the week.
 *
 * `rows` is a report already read over these days (the daily job reads one for all its weeks); without
 * it the report runs for this week. An employee is sent to the database function when they have a
 * flagged day, or a day waiting for release that the report now clears. The function adds, refreshes
 * and removes only days still waiting — a released, answered or cleared day is never touched — and a day
 * the report does not return at all is left alone: a missing row is not proof the day is clean.
 */
async function syncReviewWeekDays(input: {
  window: ReviewWeekWindow;
  createdBy: string;
  settings: DigestSettings;
  rows?: Awaited<ReturnType<typeof getFingerprintAttendanceReport>>["rows"];
}): Promise<WeekSyncResult> {
  const { window, settings } = input;
  const rows = input.rows ?? (await getFingerprintAttendanceReport({ dateFrom: window.startIso, dateTo: window.throughIso })).rows;
  // planWeekSync keeps only this week's days, so a report read over several weeks is safe to pass.
  const plan = planWeekSync(rows, window);

  // A cleared day matters only to an employee with days waiting in this week; everyone else with
  // nothing flagged is left out, so a clean employee never reaches the database at all.
  const { data: waiting, error: waitingError } = await getSupabaseAdmin()
    .from("attendance_weekly_digests")
    .select("employee_hr_id")
    .eq("cycle_key", window.monthKey)
    .eq("week_index", window.index)
    .eq("status", "awaiting_release")
    .eq("dry_run", settings.dryRun);
  if (waitingError) throw waitingError;
  const waitingKeys = new Set(
    ((waiting ?? []) as Array<{ employee_hr_id: string }>).map((row) => canonicalHrIdKey(row.employee_hr_id)).filter(Boolean),
  );
  const targets = [...plan.entries()]
    .filter(([key, entry]) => entry.lines.length > 0 || waitingKeys.has(key))
    .map(([, entry]) => entry);

  const result: WeekSyncResult = {
    monthKey: window.monthKey,
    weekIndex: window.index,
    weekStart: window.startIso,
    weekEnd: window.endIso,
    throughIso: window.throughIso,
    running: window.running,
    employeesChecked: targets.length,
    digestsCreated: 0,
    daysAdded: 0,
    daysUpdated: 0,
    daysCleared: 0,
    digestsRemoved: 0,
    daysAlreadyReleased: 0,
    failures: [],
    dryRun: settings.dryRun,
  };
  const failedHrIds: Array<{ hrId: string; message: string }> = [];

  for (const target of targets) {
    const days = target.lines.map((line) => ({
      work_date: line.workDate,
      status: line.status,
      late_minutes: Math.round(line.lateMinutes),
      short_minutes: Math.round(line.shortMinutes),
      worked_minutes: Math.round(line.workedMinutes),
      // What was detected. The function keeps the Super Admin's own figure on a day he changed.
      deduction_days: line.deductionDays,
      // NULL, not 0, when the day could not be priced. See digest-generator.ts.
      deduction_value: line.deductionValue,
      reason: line.reason,
      evidence: line.evidence,
    }));
    const { data, error } = await getSupabaseAdmin().rpc("phx_attendance_sync_digest_days", {
      p_employee_hr_id: hrIdForStorage(target.employeeHrId),
      p_cycle_key: window.monthKey,
      p_week_index: window.index,
      p_week_start: window.startIso,
      p_week_end: window.endIso,
      p_dry_run: settings.dryRun,
      p_days: days,
      // Only a day with nothing waiting is ever taken off: the function leaves released days alone.
      p_cleared_dates: waitingKeys.has(canonicalHrIdKey(target.employeeHrId)) ? target.clearedDates : [],
    });
    if (error) {
      failedHrIds.push({ hrId: target.employeeHrId, message: (error as { message?: string }).message ?? "unknown error" });
      continue;
    }
    const outcome = (data ?? {}) as Partial<EmployeeSyncOutcome>;
    if (outcome.created === true) result.digestsCreated += 1;
    if (outcome.removedDigest === true) result.digestsRemoved += 1;
    result.daysAdded += Number(outcome.added) || 0;
    result.daysUpdated += Number(outcome.updated) || 0;
    result.daysCleared += Number(outcome.cleared) || 0;
    result.daysAlreadyReleased += Number(outcome.alreadyElsewhere) || 0;
  }

  if (failedHrIds.length) {
    const directory = await loadDirectoryByKey().catch(() => null);
    result.failures = failedHrIds.map((failure) => {
      const person = directory ? directoryRowFor(directory, failure.hrId) : null;
      return `${person?.displayName || person?.fullName || "An employee whose name is not on file"} (${failure.message})`;
    });
  }

  if (result.digestsCreated || result.daysAdded || result.daysUpdated || result.daysCleared || result.digestsRemoved) {
    await writeAuditLog({
      actorLoginId: input.createdBy,
      entityId: `${window.monthKey}:w${window.index}`,
      entityType: "attendance_weekly_digest_run",
      newValues: {
        throughIso: window.throughIso,
        digestsCreated: result.digestsCreated,
        daysAdded: result.daysAdded,
        daysUpdated: result.daysUpdated,
        daysCleared: result.daysCleared,
        digestsRemoved: result.digestsRemoved,
        failures: result.failures.length,
        dryRun: settings.dryRun,
      },
      summary: `Weekly attendance review ${window.monthKey} week ${window.index} brought up to date through ${window.throughIso}`,
    });
  }

  return result;
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
  /** 1 for a week's first release; 2 and up for days that arrived after an earlier release of the week. */
  releaseRound: number;
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
    releaseRound: Number(row.release_round) || 1,
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
  "id,employee_hr_id,cycle_key,week_index,release_round,week_start,week_end,status,total_deduction_days,total_deduction_value,has_unpriced_day,currency,dry_run,released_at,answer_due_on,notified_at";

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
 * A field day decided in the HR operations report reads its own `field_review` deduction instead
 * (deductionCategoryForDigestLine); every other day reads `fingerprint`, as before.
 */
async function readDayDeduction(
  employeeHrId: string,
  workDate: string,
  category: "fingerprint" | "field_review" = "fingerprint",
): Promise<{ lockedAt: string | null; decisionStatus: string | null } | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("deductions_candidates")
    .select("id,locked_at,deductions_decisions(decision_status)")
    .eq("category", category)
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
  /** The day's own month-end deduction category — `fingerprint` unless the day is a reviewed field day. */
  category?: "fingerprint" | "field_review";
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
    readDayDeduction(input.employeeHrId, input.workDate, input.category ?? "fingerprint"),
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
 * Who answers a dispute, by HR id: every active Super Admin plus the named reviewers, never the
 * employee whose own week it is (a named reviewer does not rule on their own pay; the Super Admin is
 * exempt, since nobody is above him). Best-effort: a failed read returns the Super Admins alone.
 */
export async function resolveDisputeReviewerHrIds(employeeHrId: string): Promise<string[]> {
  const admins = await resolveSuperAdminRecipients().catch(() => []);
  const ids = admins.map((admin) => admin.hrId);
  const settings = await getDigestSettings().catch(() => null);
  for (const reviewer of settings?.disputeReviewerHrIds ?? []) {
    if (reviewer && !hrIdsMatch(reviewer, employeeHrId)) ids.push(reviewer);
  }
  const seen = new Set<string>();
  return ids.filter((id) => {
    const key = String(id ?? "").trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Super Admin, or anyone named in `dispute_reviewer_hr_ids`. Gates viewing the admin review page
 * and deciding disputes. Removing and releasing need canManageWeeklyReview on top.
 *
 * An empty list is a working configuration: everything lands on the Super Admin. Never falls back
 * to "anyone with attendance access", which would let a manager rule on their own team's pay.
 *
 * A salary-blind seat (isSalaryBlindRole — the HR Operations Specialist) is never a reviewer, even
 * if somebody adds her HR id to the list: the queue and the weekly review show every day priced in
 * EGP, and she never sees pay (technical audit, 2026-10-23, P7-07).
 */
export async function canReviewDisputes(access: { role?: string | null; hrId?: string | null }): Promise<boolean> {
  if (access.role === "Super Admin") return true;
  if (isSalaryBlindRole(access.role)) return false;
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
  /** 1 for the week's first release; 2 and up for days that arrived after an earlier release. */
  releaseRound: number;
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
  /** The week has not ended: days keep arriving until it does. */
  running: boolean;
  /** The last day the week holds so far: yesterday while it runs, else its last day. */
  throughIso: string;
  /** The Super Admin may bring this week up to date now: a started week of this month or last month. */
  canRefresh: boolean;
};

export type ReviewWeek = ReviewWeekOption & {
  releasedAt: string | null;
  employees: ReviewEmployee[];
};

type DigestHead = {
  employeeHrId: string;
  cycleKey: string;
  weekIndex: number;
  weekStart: string;
  weekEnd: string;
  status: string;
  dryRun: boolean;
};

/** Every digest of the given review months, or every digest still waiting for release or answers. Paged. */
async function readDigestHeads(scope: { cycleKeys: string[] } | { unfinished: true }): Promise<DigestHead[]> {
  const supabase = getSupabaseAdmin();
  const PAGE = 1000;
  const heads: DigestHead[] = [];
  for (let from = 0; ; from += PAGE) {
    const base = supabase.from("attendance_weekly_digests").select("id,employee_hr_id,cycle_key,week_index,week_start,week_end,status,dry_run");
    const scoped = "cycleKeys" in scope ? base.in("cycle_key", scope.cycleKeys) : base.in("status", ["awaiting_release", "open"]);
    const { data, error } = await scoped.order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as Record<string, unknown>[];
    for (const row of rows) {
      heads.push({
        employeeHrId: String(row.employee_hr_id),
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

/** Employees, not digests: an employee released twice in one week is still one person. */
function distinctEmployees(digests: ReadonlyArray<{ employeeHrId: string }>): number {
  return new Set(digests.map((digest) => canonicalHrIdKey(digest.employeeHrId) ?? digest.employeeHrId)).size;
}

/**
 * How a week reads on `todayIso`. A week of the review calendar gets its own dates, whether it is still
 * running, and whether it may be refreshed; a week from before August 2026 (the old payroll cycle)
 * keeps the dates stored on its digests and is never refreshed.
 */
function weekTiming(
  cycleKey: string,
  weekIndex: number,
  stored: { weekStart: string; weekEnd: string } | null,
  todayIso: string,
): { weekStart: string; weekEnd: string; running: boolean; throughIso: string; canRefresh: boolean } | null {
  const week = reviewWeekOf(cycleKey, weekIndex);
  const window = week ? reviewWeekWindow(cycleKey, week, todayIso) : null;
  if (week && window) {
    return {
      weekStart: week.startIso,
      weekEnd: week.endIso,
      running: window.running,
      throughIso: window.throughIso,
      canRefresh: refreshableReviewWeek(cycleKey, weekIndex, todayIso) !== null,
    };
  }
  if (!stored) return null;
  return { weekStart: stored.weekStart, weekEnd: stored.weekEnd, running: false, throughIso: stored.weekEnd, canRefresh: false };
}

/**
 * The weeks the Super Admin can pick (owner, 2026-09-15 — "select the week I want"; 2026-09-17 — "Show
 * live, release any time"): every week of the current review month that has started, running or not,
 * with or without flagged days; every week of the month before it that has any; and any older week still
 * waiting for release or answers, so a week is never stranded when the month turns. Newest first.
 */
export async function listReviewWeeks(todayIso: string = cairoTodayIso()): Promise<ReviewWeekOption[]> {
  const currentKey = currentReviewMonth(todayIso);
  const previousKey = previousMonthKey(currentKey);
  const [recent, unfinished] = await Promise.all([
    readDigestHeads({ cycleKeys: [currentKey, previousKey] }),
    readDigestHeads({ unfinished: true }),
  ]);

  type Group = { cycleKey: string; weekIndex: number; stored: { weekStart: string; weekEnd: string } | null; digests: DigestHead[] };
  const groups = new Map<string, Group>();
  for (const week of startedReviewWeeks(currentKey, todayIso)) {
    groups.set(`${currentKey}:${week.index}`, { cycleKey: currentKey, weekIndex: week.index, stored: null, digests: [] });
  }
  const recentKeys = new Set([currentKey, previousKey]);
  for (const digest of [...recent, ...unfinished.filter((row) => !recentKeys.has(row.cycleKey))]) {
    const key = `${digest.cycleKey}:${digest.weekIndex}`;
    const group: Group = groups.get(key) ?? { cycleKey: digest.cycleKey, weekIndex: digest.weekIndex, stored: null, digests: [] };
    group.stored ??= { weekStart: digest.weekStart, weekEnd: digest.weekEnd };
    group.digests.push(digest);
    groups.set(key, group);
  }

  const options: ReviewWeekOption[] = [];
  for (const group of groups.values()) {
    const timing = weekTiming(group.cycleKey, group.weekIndex, group.stored, todayIso);
    if (!timing) continue;
    options.push({
      cycleKey: group.cycleKey,
      weekIndex: group.weekIndex,
      ...timing,
      stage: reviewWeekStage(group.digests),
      employeeCount: distinctEmployees(group.digests),
    });
  }
  return options.sort((left, right) => right.weekStart.localeCompare(left.weekStart));
}

/**
 * One week in full: every employee and every flagged day, whatever their state — cleared days
 * included, so the Super Admin can see what he did not deduct — across every release of the week. A
 * started week with no flagged day yet comes back empty, as `not_built`; any other unknown week is null.
 */
export async function loadReviewWeek(input: { cycleKey: string; weekIndex: number; todayIso?: string }): Promise<ReviewWeek | null> {
  const todayIso = input.todayIso ?? cairoTodayIso();
  const supabase = getSupabaseAdmin();
  // Paged: a week holds one digest per employee per release, and PostgREST stops at 1,000 rows without saying so.
  const rows = await fetchAllRows<Record<string, unknown>>(
    () =>
      supabase
        .from("attendance_weekly_digests")
        .select(DIGEST_COLUMNS)
        .eq("cycle_key", input.cycleKey)
        .eq("week_index", input.weekIndex)
        .order("release_round", { ascending: true }),
    "id",
  );

  if (!rows.length) {
    const timing = weekTiming(input.cycleKey, input.weekIndex, null, todayIso);
    if (!timing) return null;
    return {
      cycleKey: input.cycleKey,
      weekIndex: input.weekIndex,
      ...timing,
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
      releaseRound: digest.releaseRound,
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
  employees.sort((left, right) => left.employeeName.localeCompare(right.employeeName) || left.releaseRound - right.releaseRound);
  const first = digests[0]!;
  const timing = weekTiming(first.cycleKey, first.weekIndex, { weekStart: first.weekStart, weekEnd: first.weekEnd }, todayIso)!;
  return {
    cycleKey: first.cycleKey,
    weekIndex: first.weekIndex,
    ...timing,
    stage: reviewWeekStage(digests),
    employeeCount: distinctEmployees(digests),
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
 * Bring one week up to date now, from the review page — the daily job does the same for this month's
 * weeks every morning and afternoon, but punches, excuses and leave keep arriving between runs. Any
 * started week of this review month or the month before may be refreshed. Nothing is sent: new days wait
 * for release like any other, unticked, and a day already released is never touched.
 */
export async function buildReviewWeek(input: {
  cycleKey: string;
  weekIndex: number;
  actorHrId: string;
  actorRole: string | null;
}): Promise<WeekSyncResult> {
  assertCanManageWeeklyReview(input.actorRole);
  const window = refreshableReviewWeek(input.cycleKey, input.weekIndex, cairoTodayIso());
  if (!window) throw conflictError("Only a week of this month or last month that has started can be brought up to date.");
  const settings = await getDigestSettings();
  // Under the week's lock: the daily job refreshing the same week, a second click, or a release of it
  // finishes first.
  return withWeekBuildLock(window.monthKey, window.index, () =>
    syncReviewWeekDays({ window, createdBy: input.actorHrId, settings }),
  );
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
 * Release the days of one week waiting now (owner, 2026-09-17 — "Show live, release any time"). A week
 * may be released while it is still running; days that arrive afterwards wait for a second release of
 * the same week. Every day the Super Admin did not tick is cleared first — never deducted — and only the
 * ticked days are asked about. Sets each employee's answer deadline — N working days after today, on
 * THEIR weekly-off pattern, the holiday calendar and their leave, approved or still waiting for approval
 * — and tells them by email, Telegram and in-app. Their deadline runs only when a real channel told
 * them and they still work here (releaseNoticeReached). A trial-run week is refused outright (owner,
 * 2026-09-15).
 *
 * `seenLines` is every day waiting for release as the page showed it. When a day was added or changed
 * after the page loaded, nothing at all is released: the Super Admin reloads and looks again.
 *
 * `digestId` releases one employee only (owner, 2026-09-17 — "every row has a release beside it … so I
 * can release one employee and after release another"). Every other employee keeps waiting, days and
 * ticks untouched. Absent, the whole week is released.
 */
export async function releaseWeek(input: {
  cycleKey: string;
  weekIndex: number;
  seenLines: unknown;
  digestId?: unknown;
  actorHrId: string;
  actorRole: string | null;
}): Promise<ReleaseResult> {
  assertCanManageWeeklyReview(input.actorRole);
  const seen = parseSeenReleaseLines(input.seenLines);
  if (seen.error !== null) throw validationError(seen.error);
  const seenLines = seen.lines;
  const scope = parseReleaseDigestId(input.digestId);
  if (scope.error !== null) throw validationError(scope.error);
  // Under the same lock the daily job and Refresh take to bring the week up to date: one still running
  // finishes first, so the days checked below are the days that are released.
  return withWeekBuildLock(input.cycleKey, input.weekIndex, () => releaseWaitingDays({ ...input, seenLines }));
}

async function releaseWaitingDays(input: {
  cycleKey: string;
  weekIndex: number;
  seenLines: SeenReleaseLine[];
  digestId?: unknown;
  actorHrId: string;
  actorRole: string | null;
}): Promise<ReleaseResult> {
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

  // One employee's release touches that employee only: the others are not checked, cleared or told.
  const scope = parseReleaseDigestId(input.digestId);
  if (scope.error !== null) throw validationError(scope.error);
  const digestId = scope.digestId;
  const digests = releaseScope(rows.map((row) => mapDigest(row, [])), digestId);
  if (!digests.length) throw conflictError("This employee is no longer waiting for release. Reload the page.");
  const realDigests = digests.filter((digest) => !digest.dryRun);
  const skippedTrialRun = digests.length - realDigests.length;
  if (!realDigests.length) throw conflictError("This week was built as a trial run and can never be released.");

  // Every employee is checked before anyone is released, so a stale page releases nobody rather than
  // some. The database function checks each employee again under the week's row lock.
  const waitingLines = await loadLines(realDigests.map((digest) => digest.id));
  const pending = realDigests.flatMap((digest) => (waitingLines.get(digest.id) ?? []).filter((line) => line.action === "pending"));
  if (staleReleaseLines(pending, input.seenLines).length) {
    throw conflictError("New or changed days arrived in this week after the page was loaded. Reload the page, check the days, then release again.");
  }
  const seenIds = input.seenLines.map((line) => line.id);
  const seenDays = input.seenLines.map((line) => line.days);

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
    // One transaction per employee, under the week's row lock: refuse when a waiting day is not one the
    // page showed, clear every unticked day (a `removed` settlement, which the bridge turns into Do Not
    // Take Action), then open the week — or void it when nothing is left, or settle it when only days
    // answered before the release step remain. It refuses a trial-run digest and one another click
    // already released.
    const { data: releasedRow, error: releaseError } = await supabase.rpc("phx_attendance_release_digest", {
      p_digest_id: digest.id,
      p_actor_hr_id: hrIdForStorage(input.actorHrId),
      p_answer_due_on: answerDueOn,
      p_seen_line_ids: seenIds,
      p_seen_days: seenDays,
    });
    if (releaseError) rethrowSettleError(releaseError as { code?: string; message?: string });
    const outcome = (releasedRow ?? {}) as { released?: unknown; status?: unknown; pendingDays?: unknown; clearedDays?: unknown };
    clearedDays += Number(outcome.clearedDays) || 0;
    if (outcome.released !== true) continue;
    released += 1;

    // Only the ticked days are asked about. None pending: nobody is told.
    const dayCount = Number(outcome.pendingDays) || 0;
    if (outcome.status !== "open" || dayCount === 0) continue;
    // The notice names the days asked about, not the whole week: a second release of a week holds
    // only the days that arrived after the first.
    const asked = (waitingLines.get(digest.id) ?? []).filter((line) => line.action === "pending" && line.deduct);
    const range = releaseNoticeRange(asked, digest);
    const sent = await notifyAttendanceWeekReleased({
      digestId: digest.id,
      employeeHrId: digest.employeeHrId,
      weekStart: range.weekStart,
      weekEnd: range.weekEnd,
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
    newValues: {
      released,
      notified,
      notNotified,
      skippedTrialRun,
      clearedDays,
      daysSeen: input.seenLines.length,
      scope: digestId === null ? "week" : "employee",
      digestId,
      employeeHrId: digestId === null ? null : (realDigests[0]?.employeeHrId ?? null),
    },
    summary:
      digestId === null
        ? `Weekly attendance ${input.cycleKey} week ${input.weekIndex} released to ${released} employee(s), ${clearedDays} unticked day(s) cleared`
        : `Weekly attendance ${input.cycleKey} week ${input.weekIndex} released for one employee only, ${clearedDays} unticked day(s) cleared; the others keep waiting`,
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
        const check = await checkAnnualBalance({
          employeeHrId: digest.employeeHrId,
          hireDate,
          workDate: line.workDate,
          days: line.deductionDays,
          category: deductionCategoryForDigestLine(line.status),
        }).catch(() => null);
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
    balance = await checkAnnualBalance({
      employeeHrId: digest.employeeHrId,
      hireDate,
      workDate: line.workDate,
      days: line.deductionDays,
      category: deductionCategoryForDigestLine(line.status),
    });
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
    // The reviewers are told now (owner, 2026-10-09). Nothing was sent before: a dispute waited for
    // somebody to open the review page and spot it. Best-effort — the dispute is already saved.
    const person = directoryRowFor(await loadDirectoryByKey().catch(() => new Map()), digest.employeeHrId);
    await notifyAttendanceDisputeFiled({
      digestId: digest.id,
      employeeHrId: digest.employeeHrId,
      employeeName: person?.displayName || person?.fullName || null,
      lineId: line.id,
      reason,
      reviewerHrIds: await resolveDisputeReviewerHrIds(digest.employeeHrId),
      workDate: line.workDate,
    }).catch(() => undefined);
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
  // Paged: a fixed cap here would hide the newest disputed days from the only person who can decide them.
  const data = await fetchAllRows<Record<string, unknown>>(
    () =>
      supabase
        .from("attendance_digest_lines")
        .select(
          "id,digest_id,work_date,deduction_days,deduction_value,chosen_method,reason,dispute_reason,evidence,attendance_weekly_digests!inner(employee_hr_id)",
        )
        .eq("action", "disputed")
        .order("work_date", { ascending: true }),
    "id",
  );
  const directory = await loadDirectoryByKey();
  return data.map((row) => {
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
 * by email, Telegram and in-app; `notified` is false when no real channel reached them
 * (noticeReachedEmployee).
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
    .select("id,digest_id,work_date,status,deduction_days,action,chosen_method")
    .eq("id", input.lineId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw notFoundError("That day was not found.");
  const line = data as {
    id: number;
    digest_id: number;
    work_date: string;
    status: string | null;
    deduction_days: unknown;
    action: string;
    chosen_method: unknown;
  };
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
      category: deductionCategoryForDigestLine(line.status),
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
  // Paged: a fixed cap would leave the weeks past it unsettled, run after run, without a word.
  const data = await fetchAllRows<Record<string, unknown>>(
    () =>
      supabase
        .from("attendance_weekly_digests")
        .select("id,employee_hr_id,week_start,released_at,answer_due_on,notified_at")
        .eq("status", "open")
        .eq("dry_run", false)
        // Only employees who were actually told. See deadlineApplies.
        .not("notified_at", "is", null)
        .lt("answer_due_on", input.todayIso),
    "id",
  );
  const pastStoredDate = data
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

export { isOpenLineAction };
export type { SettlementWeek, BuiltDigest };
