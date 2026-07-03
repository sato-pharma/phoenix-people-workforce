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
  notifyDigestSent,
  notifyDisputeResolved,
  notifyDisputeSubmitted,
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
  status: "draft" | "sent" | "settled" | "auto_confirmed" | "void";
  currency: string;
};

async function loadDigest(digestId: number): Promise<WeeklyDigestRow> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_weekly_digests")
    .select("id,employee_hr_id,cycle_key,week_index,status,currency")
    .eq("id", digestId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw validationError("Digest was not found.");
  return data as WeeklyDigestRow;
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
 * Transition a digest from draft to sent: stamps sent_at / auto_confirm_at
 * (per attendance_digest_settings.auto_confirm_hours) and notifies the
 * employee on every channel — even a clean (zero-deduction) week, per the
 * confirmed spec ("all 4 weekly digests always send, even if clean").
 * TOCTOU-safe: only a digest still in 'draft' can be sent, so a re-run of the
 * scheduler never re-sends (and re-starts the clock on) an already-sent digest.
 */
export async function sendDigest(input: { digestId: number; weekLabel: string; actionUrl: string }): Promise<boolean> {
  const settings = await getDigestSettings();
  const supabase = getSupabaseAdmin();
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
  if (!updated) return false; // already sent (or not a draft) — nothing to do

  const digest = updated as { id: number; employee_hr_id: string; total_deduction_value: number; currency: string };
  const { eventId } = await notifyDigestSent({
    actionUrl: input.actionUrl,
    autoConfirmHours: settings.autoConfirmHours,
    currency: digest.currency,
    employeeHrId: digest.employee_hr_id,
    totalDeductionValue: Number(digest.total_deduction_value),
    weekLabel: input.weekLabel,
  });
  await recordDigestNotificationEvent(input.digestId, eventId);
  return true;
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
