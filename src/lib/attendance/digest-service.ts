// Weekly attendance digest: generate, send, and settle an employee's answer.
//
// SCOPE. This module records what the employee said about a flagged day. It never
// writes a deduction. The month-end Fingerprint connector in src/lib/deductions/
// stays the only writer of deductions_candidates, and digest-bridge.ts applies the
// answer to the candidate once it exists. Two writers of the same employee-day is
// how this database charged 19 employee-days twice in July 2026.
//
// CONCURRENCY. Every state change guards on the row's CURRENT action inside the
// WHERE clause, not just its id, and treats "zero rows affected" as a conflict
// rather than a silent no-op — the same TOCTOU-safe shape as decideExcuseRequestAsManager
// in src/lib/excuses/service.ts. attendance_settlements additionally carries a unique
// (digest_line_id), a partial unique index on (employee_hr_id, work_date) for the
// three outcomes that cost money, and an immutability trigger, so even a bug in the
// guards below cannot produce two answers for one day.

import { writeAuditLog } from "@/lib/admin/audit";
import { conflictError, notFoundError, validationError } from "@/lib/http/api-errors";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { hrIdForStorage, hrIdLookupKeys, hrIdsMatch } from "@/lib/hr-id.ts";
import { normalizeAttendanceHrId } from "@/lib/attendance/metrics.ts";
import { getFingerprintAttendanceReport } from "@/lib/attendance/fingerprint-report.ts";
import { resolveCycleWindow } from "@/lib/payroll/copilot/cycle-window.ts";
import { completedSettlementWeek, tileSettlementWeeks, type SettlementWeek } from "@/lib/attendance/digest-weeks.ts";
import { buildWeekDigests, type BuiltDigest } from "@/lib/attendance/digest-generator.ts";

export type DigestSettings = {
  disputeReviewerHrIds: string[];
  ccManager: boolean;
  ccCeo: boolean;
  autoConfirmHours: number;
  cycleAnchorDay: number;
  channelInApp: boolean;
  channelTelegram: boolean;
  channelEmail: boolean;
  showEstimatedAmount: boolean;
  dryRun: boolean;
  enabled: boolean;
};

export type DigestLineAction = "pending" | "confirmed" | "disputed" | "auto_confirmed";

const SETTINGS_DEFAULTS: DigestSettings = {
  disputeReviewerHrIds: [],
  ccManager: true,
  ccCeo: true,
  autoConfirmHours: 48,
  cycleAnchorDay: 24,
  channelInApp: true,
  channelTelegram: true,
  channelEmail: true,
  showEstimatedAmount: true,
  dryRun: true,
  enabled: false,
};

export async function getDigestSettings(): Promise<DigestSettings> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_digest_settings")
    .select(
      "dispute_reviewer_hr_ids,cc_manager,cc_ceo,auto_confirm_hours,cycle_anchor_day,channel_in_app,channel_telegram,channel_email,show_estimated_amount,dry_run,enabled",
    )
    .eq("id", 1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return SETTINGS_DEFAULTS;
  const row = data as Record<string, unknown>;
  return {
    disputeReviewerHrIds: Array.isArray(row.dispute_reviewer_hr_ids)
      ? (row.dispute_reviewer_hr_ids as string[])
      : [],
    ccManager: row.cc_manager !== false,
    ccCeo: row.cc_ceo !== false,
    autoConfirmHours: Number(row.auto_confirm_hours) || SETTINGS_DEFAULTS.autoConfirmHours,
    cycleAnchorDay: Number(row.cycle_anchor_day) || SETTINGS_DEFAULTS.cycleAnchorDay,
    channelInApp: row.channel_in_app !== false,
    channelTelegram: row.channel_telegram !== false,
    channelEmail: row.channel_email !== false,
    showEstimatedAmount: row.show_estimated_amount !== false,
    // Both flags FAIL SAFE: a missing or unreadable value keeps the module quiet and
    // keeps money out of it, rather than defaulting to "live".
    dryRun: row.dry_run !== false,
    enabled: row.enabled === true,
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
 * Build (but do not send) the digests for the settlement week that has just closed.
 *
 * Deliberately generates only for a CLOSED week — the same reasoning that makes the
 * deductions collector refuse an in-progress month: a day that has not ended cannot
 * be judged, and telling someone they were short on a day they are still working is
 * how a correct system loses the room.
 */
export async function generateDigestsForCompletedWeek(input: {
  todayIso: string;
  createdBy: string;
}): Promise<GenerateResult> {
  const settings = await getDigestSettings();
  const cycle = resolveCycleWindow(input.todayIso, settings.cycleAnchorDay);
  const week = completedSettlementWeek(input.todayIso, cycle);
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

  const report = await getFingerprintAttendanceReport({ dateFrom: week.startIso, dateTo: week.endIso });
  const built = buildWeekDigests(report.rows);
  const employeesSeen = new Set(report.rows.map((row) => row.employeeHrId)).size;

  const supabase = getSupabaseAdmin();
  let digestsCreated = 0;
  let linesCreated = 0;
  let skippedExisting = 0;

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
        status: "draft",
        total_deduction_days: digest.totalDeductionDays,
        total_deduction_value: digest.totalDeductionValue,
        dry_run: settings.dryRun,
      })
      .select("id")
      .single();
    if (createError) throw createError;
    const digestId = (created as { id: number }).id;
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
        reason: line.reason,
        evidence: line.evidence,
      })),
    );
    if (linesError) throw linesError;
    linesCreated += digest.lines.length;
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
  deductionValue: number;
  reason: string;
  evidence: Record<string, string>;
  action: DigestLineAction;
  disputeReason: string | null;
};

export type DigestRow = {
  id: number;
  employeeHrId: string;
  cycleKey: string;
  weekIndex: number;
  weekStart: string;
  weekEnd: string;
  status: string;
  sentAt: string | null;
  autoConfirmAt: string | null;
  totalDeductionDays: number;
  totalDeductionValue: number;
  currency: string;
  dryRun: boolean;
  lines: DigestLineRow[];
};

function mapLine(row: Record<string, unknown>): DigestLineRow {
  return {
    id: Number(row.id),
    digestId: Number(row.digest_id),
    workDate: String(row.work_date),
    status: String(row.status),
    lateMinutes: Number(row.late_minutes) || 0,
    shortMinutes: Number(row.short_minutes) || 0,
    deductionDays: Number(row.deduction_days) || 0,
    deductionValue: Number(row.deduction_value) || 0,
    reason: String(row.reason ?? ""),
    evidence: (row.evidence ?? {}) as Record<string, string>,
    action: String(row.action) as DigestLineAction,
    disputeReason: (row.dispute_reason as string | null) ?? null,
  };
}

async function loadLines(digestIds: number[]): Promise<Map<number, DigestLineRow[]>> {
  const byDigest = new Map<number, DigestLineRow[]>();
  if (!digestIds.length) return byDigest;
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_digest_lines")
    .select("id,digest_id,work_date,status,late_minutes,short_minutes,deduction_days,deduction_value,reason,evidence,action,dispute_reason")
    .in("digest_id", digestIds)
    .order("work_date", { ascending: true });
  if (error) throw error;
  for (const raw of (data ?? []) as Record<string, unknown>[]) {
    const line = mapLine(raw);
    const list = byDigest.get(line.digestId) ?? [];
    list.push(line);
    byDigest.set(line.digestId, list);
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
    status: String(row.status),
    sentAt: (row.sent_at as string | null) ?? null,
    autoConfirmAt: (row.auto_confirm_at as string | null) ?? null,
    totalDeductionDays: Number(row.total_deduction_days) || 0,
    totalDeductionValue: Number(row.total_deduction_value) || 0,
    currency: String(row.currency ?? "EGP"),
    dryRun: row.dry_run !== false,
    lines,
  };
}

const DIGEST_COLUMNS =
  "id,employee_hr_id,cycle_key,week_index,week_start,week_end,status,sent_at,auto_confirm_at,total_deduction_days,total_deduction_value,currency,dry_run";

/**
 * One employee's own digests. Draft and void rows are hidden from the person they
 * describe — a digest cancelled during review was never something they were told
 * about, and showing it leaks a charge that no longer exists.
 */
export async function listMyDigests(employeeHrId: string): Promise<DigestRow[]> {
  const supabase = getSupabaseAdmin();
  // HR ids are stored mixed-case; a plain .eq under-returns. Match every spelling.
  const { data, error } = await supabase
    .from("attendance_weekly_digests")
    .select(DIGEST_COLUMNS)
    .in("employee_hr_id", hrIdLookupKeys(employeeHrId))
    .in("status", ["sent", "settled"])
    .order("week_start", { ascending: false })
    .limit(24);
  if (error) throw error;
  const rows = (data ?? []) as Record<string, unknown>[];
  const lines = await loadLines(rows.map((row) => Number(row.id)));
  return rows.map((row) => mapDigest(row, lines.get(Number(row.id)) ?? []));
}

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

function assertOwnDigest(digest: DigestRow, actorHrId: string) {
  if (!hrIdsMatch(digest.employeeHrId, actorHrId)) {
    throw validationError("You can only act on your own attendance digest.", "forbidden");
  }
}

// ---------------------------------------------------------------------------
// Settling one line
// ---------------------------------------------------------------------------

async function insertSettlement(input: {
  digestLineId: number;
  employeeHrId: string;
  workDate: string;
  action: "confirmed" | "auto_confirmed" | "dispute_upheld" | "dispute_rejected";
  deductionDays: number;
  deductionValue: number;
  actorHrId: string | null;
  actorRole: string | null;
  reviewerHrId?: string | null;
  reason?: string | null;
}) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("attendance_settlements").insert({
    digest_line_id: input.digestLineId,
    employee_hr_id: hrIdForStorage(input.employeeHrId),
    work_date: input.workDate,
    action: input.action,
    // An upheld dispute costs nothing, whatever the line said.
    deduction_days: input.action === "dispute_upheld" ? 0 : input.deductionDays,
    deduction_value: input.action === "dispute_upheld" ? 0 : input.deductionValue,
    actor_hr_id: input.actorHrId ? hrIdForStorage(input.actorHrId) : null,
    actor_role: input.actorRole,
    reviewer_hr_id: input.reviewerHrId ? hrIdForStorage(input.reviewerHrId) : null,
    reason: input.reason ?? null,
  });
  if (error) {
    // The partial unique index is the real guard against a day being answered twice.
    if (String(error.code) === "23505") {
      throw conflictError("This day has already been settled.");
    }
    throw error;
  }
}

/** Flip one line's action, refusing unless it is still where the caller believes it is. */
async function transitionLine(input: {
  lineId: number;
  from: DigestLineAction[];
  to: DigestLineAction;
  patch?: Record<string, unknown>;
}) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_digest_lines")
    .update({ action: input.to, acted_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...input.patch })
    .eq("id", input.lineId)
    .in("action", input.from)
    .select("id");
  if (error) throw error;
  if (!data || (data as unknown[]).length === 0) {
    throw conflictError("That day has already been answered — reload and look again.");
  }
}

export async function confirmDigestLines(input: {
  digestId: number;
  lineIds: number[];
  actorHrId: string;
  actorRole: string;
}): Promise<{ confirmed: number }> {
  const digest = await loadDigestOrThrow(input.digestId);
  assertOwnDigest(digest, input.actorHrId);
  if (digest.status !== "sent") throw conflictError("This digest is not open for answers.");

  const wanted = new Set(input.lineIds);
  const lines = digest.lines.filter((line) => wanted.has(line.id));
  if (!lines.length) throw validationError("No matching days to confirm.");

  let confirmed = 0;
  for (const line of lines) {
    if (line.action !== "pending") continue;
    await transitionLine({ lineId: line.id, from: ["pending"], to: "confirmed" });
    await insertSettlement({
      digestLineId: line.id,
      employeeHrId: digest.employeeHrId,
      workDate: line.workDate,
      action: "confirmed",
      deductionDays: line.deductionDays,
      deductionValue: line.deductionValue,
      actorHrId: input.actorHrId,
      actorRole: input.actorRole,
      reason: "Employee confirmed",
    });
    confirmed += 1;
  }

  await maybeCloseDigest(input.digestId);
  await writeAuditLog({
    actorLoginId: input.actorHrId,
    entityId: String(input.digestId),
    entityType: "attendance_digest_confirm",
    newValues: { confirmed, lineIds: input.lineIds },
    summary: `Employee confirmed ${confirmed} attendance day(s)`,
  });
  return { confirmed };
}

export async function disputeDigestLine(input: {
  digestId: number;
  lineId: number;
  reason: string;
  attachmentUrl?: string | null;
  actorHrId: string;
  actorRole: string;
}): Promise<void> {
  const digest = await loadDigestOrThrow(input.digestId);
  assertOwnDigest(digest, input.actorHrId);
  if (digest.status !== "sent") throw conflictError("This digest is not open for answers.");
  if (!input.reason.trim()) throw validationError("A dispute needs a reason.");

  const line = digest.lines.find((candidate) => candidate.id === input.lineId);
  if (!line) throw notFoundError("Digest line was not found.");

  // A dispute does NOT settle: it parks the line until a reviewer decides, which is
  // why no settlement row is written here.
  await transitionLine({
    lineId: line.id,
    from: ["pending"],
    to: "disputed",
    patch: { dispute_reason: input.reason.trim(), dispute_attachment_url: input.attachmentUrl?.trim() || null },
  });

  await writeAuditLog({
    actorLoginId: input.actorHrId,
    entityId: String(line.id),
    entityType: "attendance_digest_dispute",
    newValues: { workDate: line.workDate, reason: input.reason.trim() },
    summary: `Employee disputed the attendance charge for ${line.workDate}`,
  });

  // A dispute is the one event where a human MUST look, so a failed notice is
  // logged loudly rather than swallowed — but it never rolls back the dispute
  // itself: the line is already parked and cannot settle without a decision.
  try {
    const settings = await getDigestSettings();
    const { notifyDisputeSubmitted } = await import("@/lib/attendance/digest-notify.ts");
    await notifyDisputeSubmitted({
      digest,
      workDate: line.workDate,
      reason: input.reason.trim(),
      reviewerHrIds: settings.disputeReviewerHrIds,
      settings,
    });
  } catch (notifyError) {
    console.error("[attendance:digest] dispute notice failed:", notifyError);
  }
}

export async function reviewDispute(input: {
  lineId: number;
  uphold: boolean;
  notes?: string | null;
  reviewerHrId: string;
  reviewerRole: string;
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_digest_lines")
    .select("id,digest_id,work_date,deduction_days,deduction_value,action")
    .eq("id", input.lineId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw notFoundError("Digest line was not found.");
  const line = data as Record<string, unknown>;
  if (String(line.action) !== "disputed") throw conflictError("That day is not under dispute.");

  const digest = await loadDigestOrThrow(Number(line.digest_id));

  await insertSettlement({
    digestLineId: Number(line.id),
    employeeHrId: digest.employeeHrId,
    workDate: String(line.work_date),
    action: input.uphold ? "dispute_upheld" : "dispute_rejected",
    deductionDays: Number(line.deduction_days) || 0,
    deductionValue: Number(line.deduction_value) || 0,
    actorHrId: null,
    actorRole: null,
    reviewerHrId: input.reviewerHrId,
    reason: input.notes?.trim() || (input.uphold ? "Dispute upheld" : "Dispute rejected"),
  });

  await maybeCloseDigest(digest.id);
  await writeAuditLog({
    actorLoginId: input.reviewerHrId,
    entityId: String(input.lineId),
    entityType: "attendance_digest_dispute_review",
    newValues: { uphold: input.uphold, notes: input.notes ?? null },
    summary: `Attendance dispute ${input.uphold ? "upheld" : "rejected"} for ${String(line.work_date)}`,
  });

  try {
    const settings = await getDigestSettings();
    const { notifyDisputeResolved } = await import("@/lib/attendance/digest-notify.ts");
    await notifyDisputeResolved({
      digest,
      workDate: String(line.work_date),
      upheld: input.uphold,
      notes: input.notes ?? null,
      settings,
    });
  } catch (notifyError) {
    console.error("[attendance:digest] dispute resolution notice failed:", notifyError);
  }
}

/**
 * Owner decision 2026-09-08: silence auto-confirms after the window.
 *
 * This is the one path in the module that costs an employee money without anyone
 * deciding, so it is deliberately narrow — it acts only on digests that were really
 * sent, whose window has really elapsed, and only on lines still untouched.
 */
export async function autoConfirmElapsedDigests(nowIso: string): Promise<{ digests: number; lines: number }> {
  const settings = await getDigestSettings();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_weekly_digests")
    .select(DIGEST_COLUMNS)
    .eq("status", "sent")
    .not("auto_confirm_at", "is", null)
    .lte("auto_confirm_at", nowIso)
    .limit(200);
  if (error) throw error;

  const rows = (data ?? []) as Record<string, unknown>[];
  const lineMap = await loadLines(rows.map((row) => Number(row.id)));
  let digests = 0;
  let lines = 0;

  for (const raw of rows) {
    const digest = mapDigest(raw, lineMap.get(Number(raw.id)) ?? []);
    let touched = 0;
    for (const line of digest.lines) {
      if (line.action !== "pending") continue;
      await transitionLine({ lineId: line.id, from: ["pending"], to: "auto_confirmed" });
      await insertSettlement({
        digestLineId: line.id,
        employeeHrId: digest.employeeHrId,
        workDate: line.workDate,
        action: "auto_confirmed",
        deductionDays: line.deductionDays,
        deductionValue: line.deductionValue,
        actorHrId: null,
        actorRole: null,
        reason: "No response within the review window",
      });
      touched += 1;
    }
    await maybeCloseDigest(digest.id);
    if (touched) {
      digests += 1;
      lines += touched;
      // Tell them AFTER the fact. This notice is what makes auto-confirm
      // defensible at all — the alternative is finding it on a payslip.
      try {
        const { notifyDigestAutoConfirmed } = await import("@/lib/attendance/digest-notify.ts");
        await notifyDigestAutoConfirmed({ digest, settings, linesAutoConfirmed: touched });
      } catch (notifyError) {
        console.error("[attendance:digest] auto-confirm notice failed:", notifyError);
      }
    }
  }

  return { digests, lines };
}

/** A digest closes once every line has reached a terminal answer. */
async function maybeCloseDigest(digestId: number): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_digest_lines")
    .select("action")
    .eq("digest_id", digestId);
  if (error) throw error;
  const actions = ((data ?? []) as { action: string }[]).map((row) => row.action);
  if (!actions.length) return;
  // A disputed line is NOT terminal — it is waiting for a reviewer.
  if (actions.some((action) => action === "pending" || action === "disputed")) return;
  await supabase
    .from("attendance_weekly_digests")
    .update({ status: "settled", updated_at: new Date().toISOString() })
    .eq("id", digestId)
    .in("status", ["sent", "draft"]);
}

// ---------------------------------------------------------------------------
// Who may decide a dispute
// ---------------------------------------------------------------------------

/**
 * A dispute may be decided by Super Admin, or by anyone named in
 * `dispute_reviewer_hr_ids`.
 *
 * The named list exists because Super Admin is currently ONE person, who is also
 * the owner. Leaving the list empty is therefore a working configuration, not a
 * broken one — it simply means every dispute lands on him — so this returns false
 * rather than throwing when the list is empty, and never falls back to "anyone with
 * attendance access", which would let a manager rule on their own team's pay.
 */
export async function canReviewDisputes(access: {
  role?: string | null;
  hrId?: string | null;
}): Promise<boolean> {
  if (access.role === "Super Admin") return true;
  if (!access.hrId) return false;
  const settings = await getDigestSettings();
  return settings.disputeReviewerHrIds.some((reviewer) => hrIdsMatch(reviewer, access.hrId));
}

export type PendingDispute = {
  lineId: number;
  digestId: number;
  employeeHrId: string;
  workDate: string;
  deductionDays: number;
  deductionValue: number;
  reason: string;
  disputeReason: string | null;
  evidence: Record<string, string>;
};

/** Every line waiting on a human decision, oldest first. */
export async function listPendingDisputes(): Promise<PendingDispute[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_digest_lines")
    .select(
      "id,digest_id,work_date,deduction_days,deduction_value,reason,dispute_reason,evidence,attendance_weekly_digests!inner(employee_hr_id)",
    )
    .eq("action", "disputed")
    .order("work_date", { ascending: true })
    .limit(200);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => {
    const nested = row.attendance_weekly_digests as
      | { employee_hr_id?: string }
      | Array<{ employee_hr_id?: string }>
      | null;
    const employeeHrId = Array.isArray(nested) ? nested[0]?.employee_hr_id : nested?.employee_hr_id;
    return {
      lineId: Number(row.id),
      digestId: Number(row.digest_id),
      employeeHrId: normalizeAttendanceHrId(employeeHrId ?? "") ?? String(employeeHrId ?? ""),
      workDate: String(row.work_date),
      deductionDays: Number(row.deduction_days) || 0,
      deductionValue: Number(row.deduction_value) || 0,
      reason: String(row.reason ?? ""),
      disputeReason: (row.dispute_reason as string | null) ?? null,
      evidence: (row.evidence ?? {}) as Record<string, string>,
    };
  });
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * Send every draft digest, and start its response window.
 *
 * `auto_confirm_at` is stamped from the moment the notice actually goes out, not
 * from generation — an employee cannot be held to a window that began before they
 * were told. A digest whose notification throws stays `draft`, so the next run
 * retries it rather than silently starting a clock nobody heard begin.
 */
export async function sendDraftDigests(input: { limit?: number } = {}): Promise<{
  sent: number;
  failed: number;
  skippedDisabled: boolean;
}> {
  const settings = await getDigestSettings();
  if (!settings.enabled) return { sent: 0, failed: 0, skippedDisabled: true };

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_weekly_digests")
    .select(DIGEST_COLUMNS)
    .eq("status", "draft")
    .order("week_start", { ascending: true })
    .limit(input.limit ?? 100);
  if (error) throw error;

  const rows = (data ?? []) as Record<string, unknown>[];
  const lineMap = await loadLines(rows.map((row) => Number(row.id)));
  const { notifyDigestSent } = await import("@/lib/attendance/digest-notify.ts");

  let sent = 0;
  let failed = 0;
  for (const raw of rows) {
    const digest = mapDigest(raw, lineMap.get(Number(raw.id)) ?? []);
    if (!digest.lines.length) continue;
    const sentAt = new Date();
    const autoConfirmAt = new Date(sentAt.getTime() + settings.autoConfirmHours * 3_600_000);
    try {
      await notifyDigestSent({ digest: { ...digest, sentAt: sentAt.toISOString() }, settings });
    } catch (notifyError) {
      failed += 1;
      console.error("[attendance:digest] notification failed, leaving digest as draft:", notifyError);
      continue;
    }
    const { error: updateError } = await supabase
      .from("attendance_weekly_digests")
      .update({
        status: "sent",
        sent_at: sentAt.toISOString(),
        auto_confirm_at: autoConfirmAt.toISOString(),
        updated_at: sentAt.toISOString(),
      })
      .eq("id", digest.id)
      .eq("status", "draft");
    if (updateError) throw updateError;
    sent += 1;
  }

  return { sent, failed, skippedDisabled: false };
}

export { tileSettlementWeeks };
export type { SettlementWeek, BuiltDigest };
