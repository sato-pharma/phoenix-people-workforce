// Weekly-digest settlement: employee confirm/dispute actions, HR/Admin dispute
// review, and the immutable attendance_settlements ledger.
//
// Scope note: missing-punch lines (deductionDays === 0) never reach this
// service's confirm/dispute flow — they carry no monetary consequence and are
// resolved separately through the A-13 -> HR -> CEO verification chain (not
// yet built; see task tracker). Only real deductible lines (late, short_hours)
// are confirmable/disputable here.
//
// Concurrency safety: every state-changing update guards on the row's CURRENT
// action/status in the WHERE clause (not just an id match) and treats "zero
// rows affected" as a conflict, not a silent no-op — the same TOCTOU-safe
// pattern already used for excuse-request decisions
// (decideExcuseRequestAsManager in src/lib/excuses/service.ts). The
// attendance_settlements table additionally has a hard unique(digest_line_id)
// constraint and is UPDATE/DELETE-blocked by a trigger, so even a bug in this
// service's guards can never produce two outcomes for the same line.

import { writeAuditLog } from "@/lib/admin/audit";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { conflictError, validationError } from "@/lib/http/api-errors";
import { normalizeAttendanceHrId } from "@/lib/attendance/metrics";
import {
  getDigestSettings,
  resolveDisputeCc,
  resolveDisputeReviewers,
} from "@/lib/attendance/digest-recipients";
import {
  notifyDigestAutoConfirmed,
  notifyDigestPendingReview,
  notifyDigestSent,
  notifyDisputeResolved,
  notifyDisputeSubmitted,
  type DigestTableLine,
} from "@/lib/attendance/digest-notify";
import { pushAttendanceSettlementToPayroll } from "@/lib/attendance/settlement-payroll";
import { recordDigestNotificationEvent } from "@/lib/attendance/digest-read-receipts";

export type DigestLineAction = "pending" | "confirmed" | "disputed" | "auto_confirmed";

export type DigestLineRow = {
  id: number;
  digest_id: number;
  work_date: string;
  status: "late" | "short_hours" | "missing_punch";
  deduction_days: number;
  deduction_value: number;
  reason: string;
  action: DigestLineAction;
  dispute_reason: string | null;
  dispute_attachment_url: string | null;
};

export type WeeklyDigestRow = {
  id: number;
  employee_hr_id: string;
  cycle_key: string;
  week_index: number;
  week_start: string;
  week_end: string;
  status: "draft" | "pending_admin_review" | "sent" | "settled" | "auto_confirmed" | "void";
  currency: string;
};

async function loadDigest(digestId: number): Promise<WeeklyDigestRow> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_weekly_digests")
    .select("id,employee_hr_id,cycle_key,week_index,week_start,week_end,status,currency")
    .eq("id", digestId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw validationError("Digest was not found.");
  return data as WeeklyDigestRow;
}

async function loadEmployeeName(employeeHrId: string): Promise<string> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("employees").select("full_name").eq("hr_id", employeeHrId).maybeSingle();
  return (data as { full_name?: string | null } | null)?.full_name?.trim() || employeeHrId;
}

export async function loadDeductibleLines(digestId: number): Promise<DigestTableLine[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_digest_lines")
    .select("work_date,deduction_days,deduction_value,reason")
    .eq("digest_id", digestId)
    .order("work_date", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as Array<{ work_date: string; deduction_days: number; deduction_value: number; reason: string }>).map((row) => ({
    deductionDays: Number(row.deduction_days),
    deductionValue: Number(row.deduction_value),
    reason: row.reason,
    workDate: row.work_date,
  }));
}

async function assertOwnsDigest(digest: WeeklyDigestRow, actorHrId: string) {
  const actor = normalizeAttendanceHrId(actorHrId);
  const owner = normalizeAttendanceHrId(digest.employee_hr_id);
  if (!actor || actor !== owner) {
    throw new Error("Forbidden: you can only act on your own attendance digest.");
  }
}

async function loadLine(digestId: number, lineId: number): Promise<DigestLineRow> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_digest_lines")
    .select("id,digest_id,work_date,status,deduction_days,deduction_value,reason,action,dispute_reason,dispute_attachment_url")
    .eq("id", lineId)
    .eq("digest_id", digestId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw validationError("Digest line was not found.");
  return data as DigestLineRow;
}

/**
 * Whether every settleable line (deduction_days > 0) in a digest has reached a
 * terminal outcome: confirmed/auto_confirmed directly, or disputed AND already
 * reviewed (an attendance_settlements row exists for it). Missing-punch lines
 * (deduction_days === 0) never block settlement — they're outside this flow.
 */
async function isDigestFullyResolved(digestId: number): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_digest_lines")
    .select("id,action,deduction_days")
    .eq("digest_id", digestId);
  if (error) throw error;

  const settleable = ((data ?? []) as Array<{ id: number; action: DigestLineAction; deduction_days: number }>)
    .filter((line) => Number(line.deduction_days) > 0);
  if (settleable.length === 0) return true;

  const resolvedDirectly = settleable.filter((line) => line.action === "confirmed" || line.action === "auto_confirmed");
  const disputed = settleable.filter((line) => line.action === "disputed");
  if (resolvedDirectly.length + disputed.length < settleable.length) return false; // still pending
  if (disputed.length === 0) return true;

  const { data: settled, error: settledError } = await supabase
    .from("attendance_settlements")
    .select("digest_line_id")
    .in("digest_line_id", disputed.map((line) => line.id));
  if (settledError) throw settledError;
  const settledIds = new Set(((settled ?? []) as Array<{ digest_line_id: number }>).map((row) => row.digest_line_id));
  return disputed.every((line) => settledIds.has(line.id));
}

async function maybeCloseDigest(digestId: number) {
  if (!(await isDigestFullyResolved(digestId))) return;
  const supabase = getSupabaseAdmin();
  await supabase
    .from("attendance_weekly_digests")
    .update({ status: "settled", updated_at: new Date().toISOString() })
    .eq("id", digestId)
    .in("status", ["sent", "draft"]);
}

async function insertSettlement(input: {
  digestLineId: number;
  employeeHrId: string;
  workDate: string;
  lineStatus: "late" | "short_hours";
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
    action: input.action,
    actor_hr_id: input.actorHrId,
    actor_role: input.actorRole,
    deduction_days: input.deductionDays,
    deduction_value: input.deductionValue,
    digest_line_id: input.digestLineId,
    employee_hr_id: input.employeeHrId,
    reason: input.reason ?? null,
    reviewer_hr_id: input.reviewerHrId ?? null,
    work_date: input.workDate,
  });
  if (error) {
    const code = (error as { code?: string }).code ?? "";
    if (code === "23505") {
      throw conflictError("This attendance day has already been settled.");
    }
    throw error;
  }

  await writeAuditLog({
    actorLoginId: input.actorHrId ?? "system",
    entityId: String(input.digestLineId),
    entityType: "attendance_settlement",
    newValues: { action: input.action, deductionDays: input.deductionDays, deductionValue: input.deductionValue },
    summary: `Attendance settlement recorded (${input.action}) for ${input.employeeHrId} on ${input.workDate}`,
  });

  // Every REAL settlement outcome (confirmed / auto_confirmed / dispute_rejected)
  // flows to payroll governance from this one centralized point — no caller can
  // forget to wire it. dispute_upheld always carries deductionDays === 0
  // (enforced by reviewDigestDispute), so the bridge's own guard is a no-op for it.
  if (input.action === "confirmed" || input.action === "auto_confirmed" || input.action === "dispute_rejected") {
    await pushAttendanceSettlementToPayroll({
      deductionDays: input.deductionDays,
      digestLineId: input.digestLineId,
      employeeHrId: input.employeeHrId,
      lineStatus: input.lineStatus,
      outcome: input.action,
      workDate: input.workDate,
    });
  }
}

/**
 * Employee confirms one or more of their own digest lines. A line with zero
 * deduction days (missing-punch) is a no-op here — nothing to confirm.
 */
export async function confirmDigestLines(input: {
  digestId: number;
  lineIds: number[];
  actorHrId: string;
}): Promise<{ confirmed: number[]; skipped: number[] }> {
  const digest = await loadDigest(input.digestId);
  await assertOwnsDigest(digest, input.actorHrId);
  if (digest.status !== "sent") {
    throw new Error(`Forbidden: digest is ${digest.status}, no further action can be taken.`);
  }

  const supabase = getSupabaseAdmin();
  const confirmed: number[] = [];
  const skipped: number[] = [];

  for (const lineId of input.lineIds) {
    const line = await loadLine(input.digestId, lineId);
    if (Number(line.deduction_days) <= 0) {
      skipped.push(lineId);
      continue;
    }

    const now = new Date().toISOString();
    const { data: updated, error } = await supabase
      .from("attendance_digest_lines")
      .update({ acted_at: now, action: "confirmed", updated_at: now })
      .eq("id", lineId)
      .eq("digest_id", input.digestId)
      .eq("action", "pending")
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!updated) {
      skipped.push(lineId);
      continue;
    }

    await insertSettlement({
      action: "confirmed",
      actorHrId: input.actorHrId,
      actorRole: "Employee",
      deductionDays: Number(line.deduction_days),
      deductionValue: Number(line.deduction_value),
      digestLineId: lineId,
      employeeHrId: digest.employee_hr_id,
      lineStatus: line.status as "late" | "short_hours",
      workDate: line.work_date,
    });
    confirmed.push(lineId);
  }

  await maybeCloseDigest(input.digestId);
  return { confirmed, skipped };
}

/** Employee disputes one digest line. Free-text reason is required. */
export async function submitDigestDispute(input: {
  digestId: number;
  lineId: number;
  actorHrId: string;
  reason: string;
  attachmentUrl: string | null;
}): Promise<DigestLineRow> {
  const reason = input.reason.trim();
  if (!reason) throw validationError("A dispute reason is required.");

  const digest = await loadDigest(input.digestId);
  await assertOwnsDigest(digest, input.actorHrId);
  if (digest.status !== "sent") {
    throw new Error(`Forbidden: digest is ${digest.status}, no further action can be taken.`);
  }

  const line = await loadLine(input.digestId, input.lineId);
  if (Number(line.deduction_days) <= 0) {
    throw validationError("This line has no deduction to dispute.");
  }

  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { data: updated, error } = await supabase
    .from("attendance_digest_lines")
    .update({
      acted_at: now,
      action: "disputed",
      dispute_attachment_url: input.attachmentUrl,
      dispute_reason: reason,
      updated_at: now,
    })
    .eq("id", input.lineId)
    .eq("digest_id", input.digestId)
    .eq("action", "pending")
    .select("id,digest_id,work_date,status,deduction_days,deduction_value,reason,action,dispute_reason,dispute_attachment_url")
    .maybeSingle();
  if (error) throw error;
  if (!updated) throw conflictError("This day has already been acted on.");

  await writeAuditLog({
    actorLoginId: input.actorHrId,
    entityId: String(input.lineId),
    entityType: "attendance_settlement",
    newValues: { attachmentUrl: input.attachmentUrl, reason },
    summary: `Attendance dispute filed for ${digest.employee_hr_id} on ${line.work_date}`,
  });

  const settings = await getDigestSettings();
  const [reviewers, cc] = await Promise.all([
    resolveDisputeReviewers(digest.employee_hr_id, settings),
    resolveDisputeCc(digest.employee_hr_id, settings),
  ]);
  await notifyDisputeSubmitted({
    actionUrl: "/admin/attendance/disputes",
    cc,
    employeeHrId: digest.employee_hr_id,
    employeeName: digest.employee_hr_id,
    reason,
    reviewers,
    workDate: line.work_date,
  });

  return updated as DigestLineRow;
}

/**
 * HR Manager or System Admin reviews a dispute. Either reviewer may act; the
 * unique(digest_line_id) constraint on attendance_settlements makes "first to
 * act wins" a hard database guarantee, not just an application-level check.
 */
export async function reviewDigestDispute(input: {
  digestId: number;
  lineId: number;
  decision: "upheld" | "rejected";
  reviewerHrId: string;
  reviewerRole: string;
  notes: string | null;
}): Promise<void> {
  const digest = await loadDigest(input.digestId);
  const line = await loadLine(input.digestId, input.lineId);
  if (line.action !== "disputed") {
    throw validationError("Only a disputed line can be reviewed.");
  }

  const settings = await getDigestSettings();
  const reviewers = await resolveDisputeReviewers(digest.employee_hr_id, settings);
  const reviewer = normalizeAttendanceHrId(input.reviewerHrId);
  if (!reviewer || !reviewers.includes(reviewer)) {
    throw new Error("Forbidden: you are not an authorized reviewer for this dispute.");
  }

  await insertSettlement({
    actorHrId: input.reviewerHrId,
    actorRole: input.reviewerRole,
    deductionDays: input.decision === "upheld" ? 0 : Number(line.deduction_days),
    deductionValue: input.decision === "upheld" ? 0 : Number(line.deduction_value),
    digestLineId: input.lineId,
    employeeHrId: digest.employee_hr_id,
    lineStatus: line.status as "late" | "short_hours",
    reason: input.notes,
    reviewerHrId: input.reviewerHrId,
    workDate: line.work_date,
    action: input.decision === "upheld" ? "dispute_upheld" : "dispute_rejected",
  });

  await maybeCloseDigest(input.digestId);
  await notifyDisputeResolved({
    employeeHrId: digest.employee_hr_id,
    notes: input.notes,
    reviewerHrId: input.reviewerHrId,
    upheld: input.decision === "upheld",
    workDate: line.work_date,
  });
}

/**
 * Transition a digest from draft onward. A CLEAN (zero-deduction) digest goes
 * straight to the employee, same as before — nothing to review. A digest with
 * a real deduction NEVER goes straight to the employee: it routes to the
 * System Administrator / HR Manager approver list for review (and optional
 * edit) first — see routeDigestForReview / approveDigestReview. Either path
 * is TOCTOU-safe: only a digest still in 'draft' transitions, so a re-run of
 * the scheduler never re-sends (or re-routes) an already-processed digest.
 */
export async function sendDigest(input: { digestId: number; weekLabel: string; actionUrl: string }): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const { data: draftRow, error: draftError } = await supabase
    .from("attendance_weekly_digests")
    .select("id,total_deduction_value")
    .eq("id", input.digestId)
    .eq("status", "draft")
    .maybeSingle();
  if (draftError) throw draftError;
  if (!draftRow) return false; // already processed — nothing to do

  const hasDeduction = Number((draftRow as { total_deduction_value: number }).total_deduction_value) > 0;
  if (hasDeduction) {
    return routeDigestForReview({ actionUrl: input.actionUrl, digestId: input.digestId, weekLabel: input.weekLabel });
  }

  const settings = await getDigestSettings();
  const now = new Date();
  const autoConfirmAt = new Date(now.getTime() + settings.autoConfirmHours * 60 * 60 * 1000);

  const { data: updated, error } = await supabase
    .from("attendance_weekly_digests")
    .update({
      auto_confirm_at: autoConfirmAt.toISOString(),
      sent_at: now.toISOString(),
      status: "sent",
      updated_at: now.toISOString(),
    })
    .eq("id", input.digestId)
    .eq("status", "draft")
    .select("id,employee_hr_id,total_deduction_value,currency")
    .maybeSingle();
  if (error) throw error;
  if (!updated) return false; // acted on between the select and here

  const digest = updated as { id: number; employee_hr_id: string; total_deduction_value: number; currency: string };
  const employeeName = await loadEmployeeName(digest.employee_hr_id);
  const { eventId } = await notifyDigestSent({
    actionUrl: input.actionUrl,
    autoConfirmHours: settings.autoConfirmHours,
    currency: digest.currency,
    employeeHrId: digest.employee_hr_id,
    employeeName,
    lines: [],
    totalDeductionValue: Number(digest.total_deduction_value),
    weekLabel: input.weekLabel,
  });
  await recordDigestNotificationEvent(input.digestId, eventId);
  return true;
}

/**
 * Route a deduction-bearing digest to the System Administrator / HR Manager
 * approver list for review before it ever reaches the employee. Only a
 * digest still in 'draft' transitions (TOCTOU-safe).
 */
async function routeDigestForReview(input: { digestId: number; weekLabel: string; actionUrl: string }): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const { data: updated, error } = await supabase
    .from("attendance_weekly_digests")
    .update({ status: "pending_admin_review", updated_at: new Date().toISOString() })
    .eq("id", input.digestId)
    .eq("status", "draft")
    .select("id,employee_hr_id,total_deduction_value,currency")
    .maybeSingle();
  if (error) throw error;
  if (!updated) return false;

  const digest = updated as { id: number; employee_hr_id: string; total_deduction_value: number; currency: string };
  const settings = await getDigestSettings();
  const [reviewers, employeeName] = await Promise.all([
    resolveDisputeReviewers(digest.employee_hr_id, settings),
    loadEmployeeName(digest.employee_hr_id),
  ]);
  await notifyDigestPendingReview({
    actionUrl: "/attendance/digest-review",
    currency: digest.currency,
    employeeHrId: digest.employee_hr_id,
    employeeName,
    reviewers,
    totalDeductionValue: Number(digest.total_deduction_value),
    weekLabel: input.weekLabel,
  });
  return true;
}

export type DigestReviewLineEdit = {
  lineId: number;
  deductionDays?: number;
  deductionValue?: number;
  reason?: string;
};

/**
 * System Administrator / HR Manager approves a pending-review digest,
 * optionally editing any line first (the system-computed value is snapshotted
 * into original_* the moment a line is actually changed). Approval transitions
 * the digest straight to 'sent' with the (possibly edited) totals and finally
 * notifies the employee — same self-exclusion + CEO-fallback reviewer pool as
 * dispute review ("if the subject is an approver, the others handle it").
 */
export async function approveDigestReview(input: {
  digestId: number;
  actorHrId: string;
  actionUrl: string;
  lineEdits?: DigestReviewLineEdit[];
}): Promise<void> {
  const digest = await loadDigest(input.digestId);
  if (digest.status !== "pending_admin_review") {
    throw new Error(`Forbidden: digest is ${digest.status}, not awaiting review.`);
  }

  const settings = await getDigestSettings();
  const reviewers = await resolveDisputeReviewers(digest.employee_hr_id, settings);
  const actor = normalizeAttendanceHrId(input.actorHrId);
  if (!actor || !reviewers.includes(actor)) {
    throw new Error("Forbidden: you are not an authorized reviewer for this digest.");
  }

  const supabase = getSupabaseAdmin();
  for (const edit of input.lineEdits ?? []) {
    const line = await loadLine(input.digestId, edit.lineId);
    const nextDays = edit.deductionDays !== undefined ? Number(edit.deductionDays) : Number(line.deduction_days);
    const nextValue = edit.deductionValue !== undefined ? Number(edit.deductionValue) : Number(line.deduction_value);
    const nextReason = edit.reason !== undefined ? edit.reason : line.reason;
    const wasEdited = nextDays !== Number(line.deduction_days) || nextValue !== Number(line.deduction_value) || nextReason !== line.reason;
    if (!wasEdited) continue;
    if (!Number.isFinite(nextDays) || nextDays < 0) throw validationError("Deduction days must be zero or a positive number.");
    if (!Number.isFinite(nextValue) || nextValue < 0) throw validationError("Deduction value must be zero or a positive number.");

    const { error: editError } = await supabase
      .from("attendance_digest_lines")
      .update({
        deduction_days: nextDays,
        deduction_value: nextValue,
        original_deduction_days: line.deduction_days,
        original_deduction_value: line.deduction_value,
        original_reason: line.reason,
        reason: nextReason,
        updated_at: new Date().toISOString(),
      })
      .eq("id", edit.lineId)
      .eq("digest_id", input.digestId);
    if (editError) throw editError;

    await writeAuditLog({
      actorLoginId: input.actorHrId,
      entityId: String(edit.lineId),
      entityType: "attendance_settlement",
      newValues: { deductionDays: nextDays, deductionValue: nextValue, reason: nextReason },
      oldValues: { deductionDays: line.deduction_days, deductionValue: line.deduction_value, reason: line.reason },
      summary: `Admin review edited digest line for ${digest.employee_hr_id} on ${line.work_date} before approval`,
    });
  }

  const lines = await loadDeductibleLines(input.digestId);
  const totalDeductionDays = lines.reduce((sum, line) => sum + line.deductionDays, 0);
  const totalDeductionValue = lines.reduce((sum, line) => sum + line.deductionValue, 0);

  const now = new Date();
  const autoConfirmAt = new Date(now.getTime() + settings.autoConfirmHours * 60 * 60 * 1000);
  const { data: updated, error } = await supabase
    .from("attendance_weekly_digests")
    .update({
      auto_confirm_at: autoConfirmAt.toISOString(),
      reviewed_at: now.toISOString(),
      reviewed_by: input.actorHrId,
      sent_at: now.toISOString(),
      status: "sent",
      total_deduction_days: totalDeductionDays,
      total_deduction_value: totalDeductionValue,
      updated_at: now.toISOString(),
    })
    .eq("id", input.digestId)
    .eq("status", "pending_admin_review")
    .select("id,employee_hr_id,currency")
    .maybeSingle();
  if (error) throw error;
  if (!updated) throw conflictError("This digest has already been acted on.");

  const updatedDigest = updated as { id: number; employee_hr_id: string; currency: string };
  const employeeName = await loadEmployeeName(updatedDigest.employee_hr_id);
  const weekLabel = `${digest.week_start} to ${digest.week_end}`;
  const { eventId } = await notifyDigestSent({
    actionUrl: input.actionUrl,
    autoConfirmHours: settings.autoConfirmHours,
    currency: updatedDigest.currency,
    employeeHrId: updatedDigest.employee_hr_id,
    employeeName,
    lines,
    totalDeductionValue,
    weekLabel,
  });
  await recordDigestNotificationEvent(input.digestId, eventId);
}

/**
 * System Administrator / HR Manager voids a pending-review digest instead of
 * approving it (e.g. the underlying data looks wrong and needs a source fix
 * before regenerating). The employee is never notified — they never knew it
 * existed.
 */
export async function voidDigestReview(input: { digestId: number; actorHrId: string; reason: string }): Promise<void> {
  const reason = input.reason.trim();
  if (!reason) throw validationError("A reason is required to void a digest under review.");

  const digest = await loadDigest(input.digestId);
  if (digest.status !== "pending_admin_review") {
    throw new Error(`Forbidden: digest is ${digest.status}, not awaiting review.`);
  }

  const settings = await getDigestSettings();
  const reviewers = await resolveDisputeReviewers(digest.employee_hr_id, settings);
  const actor = normalizeAttendanceHrId(input.actorHrId);
  if (!actor || !reviewers.includes(actor)) {
    throw new Error("Forbidden: you are not an authorized reviewer for this digest.");
  }

  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { data: updated, error } = await supabase
    .from("attendance_weekly_digests")
    .update({ reviewed_at: now, reviewed_by: input.actorHrId, status: "void", updated_at: now })
    .eq("id", input.digestId)
    .eq("status", "pending_admin_review")
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!updated) throw conflictError("This digest has already been acted on.");

  await writeAuditLog({
    actorLoginId: input.actorHrId,
    entityId: String(input.digestId),
    entityType: "attendance_settlement",
    newValues: { reason, status: "void" },
    summary: `Digest voided under admin review for ${digest.employee_hr_id}: ${reason}`,
  });
}

/**
 * Auto-confirm every still-pending settleable line in a digest whose review
 * window has expired (attendance_weekly_digests.auto_confirm_at <= now). Per
 * the confirmed spec there is no reminder before this — the 48h notice at
 * send-time is the only warning. Disputed lines are untouched here (they stay
 * with HR/Admin); only lines the employee never acted on are auto-confirmed.
 */
export async function autoConfirmDigest(digestId: number): Promise<{ autoConfirmed: number[] }> {
  const digest = await loadDigest(digestId);
  if (digest.status !== "sent") return { autoConfirmed: [] };

  const supabase = getSupabaseAdmin();
  const { data: pendingLines, error } = await supabase
    .from("attendance_digest_lines")
    .select("id,work_date,status,deduction_days,deduction_value")
    .eq("digest_id", digestId)
    .eq("action", "pending")
    .gt("deduction_days", 0);
  if (error) throw error;

  const autoConfirmed: number[] = [];
  for (const line of (pendingLines ?? []) as Array<{ id: number; work_date: string; status: "late" | "short_hours" | "missing_punch"; deduction_days: number; deduction_value: number }>) {
    const now = new Date().toISOString();
    const { data: updated, error: updateError } = await supabase
      .from("attendance_digest_lines")
      .update({ acted_at: now, action: "auto_confirmed", updated_at: now })
      .eq("id", line.id)
      .eq("digest_id", digestId)
      .eq("action", "pending")
      .select("id")
      .maybeSingle();
    if (updateError) throw updateError;
    if (!updated) continue; // acted on between the select and here — leave it

    await insertSettlement({
      action: "auto_confirmed",
      actorHrId: null,
      actorRole: "system",
      deductionDays: Number(line.deduction_days),
      deductionValue: Number(line.deduction_value),
      digestLineId: line.id,
      employeeHrId: digest.employee_hr_id,
      lineStatus: line.status as "late" | "short_hours",
      workDate: line.work_date,
    });
    autoConfirmed.push(line.id);
  }

  await maybeCloseDigest(digestId);

  if (autoConfirmed.length > 0) {
    const totalValue = (pendingLines ?? [])
      .filter((line: { id: number }) => autoConfirmed.includes(line.id))
      .reduce((sum: number, line: { deduction_value: number }) => sum + Number(line.deduction_value), 0);
    await notifyDigestAutoConfirmed({
      currency: digest.currency,
      employeeHrId: digest.employee_hr_id,
      totalDeductionValue: totalValue,
      weekLabel: `week ${digest.week_index} of cycle ${digest.cycle_key}`,
    });
  }

  return { autoConfirmed };
}
