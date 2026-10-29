import {
  assertPermission,
  normalizeHrId,
  resolveEmployeeIdentityId,
  type AccessContext,
} from "@/lib/auth/permissions";
import { writeAuditLog } from "@/lib/admin/audit";
import { conflictError } from "@/lib/http/api-errors";
import { afterResponse } from "@/lib/http/after-response";
import { createSystemNotification } from "@/lib/notifications/system";
import type { CheckedDisputeImage } from "@/lib/dispute-center/attachment-rules.ts";
import { storeDisputeCenterAttachments } from "@/lib/dispute-center/attachment-store.ts";
import { recordCaseEvent } from "@/lib/dispute-center/events.ts";
import { tidyDisputeText } from "@/lib/dispute-center/text.ts";
import { resolveSuperAdminRecipients } from "@/lib/private-calendar/notify-admin";
import { privateCalendarHrIdPattern, type PrivateCalendarSource } from "@/lib/private-calendar/logic";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// Private Calendar data-accuracy disputes. An employee flags that what the
// calendar shows for a day (or one specific item on that day) is wrong, must
// state what actually happened and where a Super Admin can verify it. Super
// Admin Accepts (the calendar overlays the verified correction on top of the
// original item — the underlying synced source record, e.g. a CRM visit row
// or a fingerprint punch, is NEVER mutated here; Phoenix does not own that
// upstream data) or Rejects (nothing changes, employee is told why).

export type PrivateCalendarDisputeStatus = "pending_review" | "accepted" | "rejected";

export type PrivateCalendarDataDispute = {
  adminDecisionNote: string | null;
  adminHrId: string | null;
  claimSourceText: string;
  claimText: string;
  createdAt: string;
  decidedAt: string | null;
  disputeDate: string;
  displayedSummary: string;
  employeeHrId: string;
  employeeName: string | null;
  id: string;
  itemSource: PrivateCalendarSource | null;
  itemSourceRecordId: string | null;
  status: PrivateCalendarDisputeStatus;
};

type DisputeRow = {
  admin_decision_note: string | null;
  admin_hr_id: string | null;
  claim_source_text: string;
  claim_text: string;
  created_at: string;
  decided_at: string | null;
  dispute_date: string;
  displayed_summary: string;
  employee_hr_id: string;
  employee_name: string | null;
  id: string;
  item_source: string | null;
  item_source_record_id: string | null;
  status: PrivateCalendarDisputeStatus;
};

const DISPUTE_COLUMNS = "id,employee_hr_id,employee_name,dispute_date,item_source,item_source_record_id,displayed_summary,claim_text,claim_source_text,status,admin_hr_id,admin_decision_note,decided_at,created_at";

function mapDisputeRow(row: DisputeRow): PrivateCalendarDataDispute {
  return {
    adminDecisionNote: row.admin_decision_note,
    adminHrId: row.admin_hr_id,
    claimSourceText: row.claim_source_text,
    claimText: row.claim_text,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    disputeDate: row.dispute_date,
    displayedSummary: row.displayed_summary,
    employeeHrId: row.employee_hr_id,
    employeeName: row.employee_name,
    id: row.id,
    itemSource: (row.item_source as PrivateCalendarSource | null) ?? null,
    itemSourceRecordId: row.item_source_record_id,
    status: row.status,
  };
}

// Decisions are Super Admin only, per owner instruction — a narrower gate
// than the generic `deductions`/`attendance` permission matrix, so it is
// enforced explicitly here rather than through assertPermission.
function assertDisputeDecisionActor(access: Pick<AccessContext, "role">) {
  if (access.role !== "Super Admin") {
    throw new Error("Forbidden: only Super Admin can review private calendar data disputes.");
  }
}

export async function submitPrivateCalendarDataDispute(
  access: AccessContext,
  input: {
    claimSourceText: string;
    claimText: string;
    disputeDate: string;
    displayedSummary: string;
    employeeName?: string | null;
    /** Pictures the employee attached to the request itself (owner, 2026-10-09). */
    images?: CheckedDisputeImage[];
    itemSource?: PrivateCalendarSource | null;
    itemSourceRecordId?: string | null;
  },
): Promise<PrivateCalendarDataDispute> {
  await assertPermission(access, "attendance", "read");
  const employeeHrId = resolveEmployeeIdentityId(access);
  if (!employeeHrId) throw new Error("Your employee profile is not linked. Contact HR.");

  // Line breaks kept: a claim is often a list of times and places.
  const claimText = tidyDisputeText(input.claimText);
  const claimSourceText = tidyDisputeText(input.claimSourceText);
  if (!claimText) throw new Error("Tell us what actually happened on this day.");
  if (!claimSourceText) throw new Error("Tell us where an admin can verify this.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.disputeDate)) throw new Error("Invalid date.");

  const { data, error } = await getSupabaseAdmin()
    .from("private_calendar_data_disputes")
    .insert({
      claim_source_text: claimSourceText,
      claim_text: claimText,
      displayed_summary: input.displayedSummary.trim() || "(nothing was shown for this day)",
      dispute_date: input.disputeDate,
      employee_hr_id: employeeHrId,
      employee_name: input.employeeName ?? null,
      item_source: input.itemSource ?? null,
      item_source_record_id: input.itemSourceRecordId ?? null,
      status: "pending_review",
    })
    .select(DISPUTE_COLUMNS)
    .single();

  if (error) {
    if ((error as { code?: string }).code === "23505") {
      throw conflictError("You already have a pending dispute for this day. Wait for it to be reviewed before submitting another.");
    }
    throw error;
  }

  const dispute = mapDisputeRow(data as DisputeRow);

  // The pictures hang off the request's id, so they are stored after it exists. If they cannot be
  // stored the request is removed again: nobody reviews, or is notified of, half a claim.
  let pictureCount = 0;
  if ((input.images?.length ?? 0) > 0) {
    try {
      const stored = await storeDisputeCenterAttachments({
        images: input.images ?? [],
        kind: "calendar",
        messageId: null,
        ref: dispute.id,
        uploadedByHrId: employeeHrId,
      });
      pictureCount = stored.length;
    } catch (storeError) {
      await getSupabaseAdmin().from("private_calendar_data_disputes").delete().eq("id", dispute.id);
      throw storeError;
    }
  }

  await writeAuditLog({
    actorLoginId: access.loginId ?? employeeHrId,
    entityId: dispute.id,
    entityType: "private_calendar_data_dispute",
    newValues: { claimSourceText, claimText, disputeDate: dispute.disputeDate, pictureCount, status: dispute.status },
    summary: `Private calendar data dispute submitted for ${dispute.disputeDate}`,
  });

  // After the reply (afterResponse): the dispute is saved and audited, and the recipient lookup and the
  // fan-out used to be awaited before the answer left. A failed notice is logged, never thrown.
  await afterResponse("private_calendar_notice:dispute_submitted", async () => {
    const recipients = await resolveSuperAdminRecipients();
    await Promise.all(recipients.map((recipient) => createSystemNotification({
      actionUrl: "/admin/private-calendar-disputes",
      actorId: employeeHrId,
      channels: ["email", "in_app", "push"],
      eventType: "private_calendar_dispute_submitted",
      message: `${input.employeeName ?? employeeHrId} flagged ${dispute.disputeDate} as inaccurate: "${claimText}"`,
      metadata: { disputeId: dispute.id, employeeHrId, idempotencyKey: `private-calendar-dispute:${dispute.id}:submitted` },
      module: "private_calendar",
      priority: "normal",
      recipientHrId: recipient.hrId,
      subjectHrId: employeeHrId,
      title: `Calendar data dispute — ${dispute.disputeDate}`,
    })));
  });

  return dispute;
}

export async function listMyPrivateCalendarDataDisputes(access: AccessContext): Promise<PrivateCalendarDataDispute[]> {
  await assertPermission(access, "attendance", "read");
  const employeeHrId = resolveEmployeeIdentityId(access);
  if (!employeeHrId) return [];
  const { data, error } = await getSupabaseAdmin()
    .from("private_calendar_data_disputes")
    .select(DISPUTE_COLUMNS)
    .ilike("employee_hr_id", privateCalendarHrIdPattern(employeeHrId))
    .order("created_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as DisputeRow[]).map(mapDisputeRow);
}

export async function listPendingPrivateCalendarDataDisputes(access: AccessContext): Promise<PrivateCalendarDataDispute[]> {
  assertDisputeDecisionActor(access);
  const { data, error } = await getSupabaseAdmin()
    .from("private_calendar_data_disputes")
    .select(DISPUTE_COLUMNS)
    .eq("status", "pending_review")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as DisputeRow[]).map(mapDisputeRow);
}

/**
 * All private-calendar disputes in [start, end] for one employee, any
 * status — used by the calendar display to overlay a visible status badge on
 * the affected day (pending / accepted-with-correction / rejected-with-note),
 * keyed by dispute_date (+ item_source when the dispute targeted one specific
 * item rather than the whole day). Never touches the original item's own
 * fields — see appendDisputeStatusExceptions / applyAcceptedDisputeOverlays
 * in service.ts for how each status renders.
 */
export async function listDisputesForEmployee(input: {
  employeeHrId: string;
  end: string;
  start: string;
}): Promise<PrivateCalendarDataDispute[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("private_calendar_data_disputes")
    .select(DISPUTE_COLUMNS)
    .ilike("employee_hr_id", privateCalendarHrIdPattern(input.employeeHrId))
    .gte("dispute_date", input.start)
    .lte("dispute_date", input.end);
  if (error) throw error;
  return ((data ?? []) as DisputeRow[]).map(mapDisputeRow);
}

export async function decidePrivateCalendarDataDispute(
  access: AccessContext,
  input: { decision: "accept" | "reject"; disputeId: string; note: string },
): Promise<PrivateCalendarDataDispute> {
  assertDisputeDecisionActor(access);
  // The note is OPTIONAL (owner, 2026-10-18): accept or reject with or without words.
  const note = input.note.trim();

  const adminHrId = normalizeHrId(access.hrId) ?? normalizeHrId(access.loginId) ?? "system";
  const now = new Date().toISOString();
  const nextStatus: PrivateCalendarDisputeStatus = input.decision === "accept" ? "accepted" : "rejected";

  const { data, error } = await getSupabaseAdmin()
    .from("private_calendar_data_disputes")
    .update({
      admin_decision_note: note || null,
      admin_hr_id: adminHrId,
      decided_at: now,
      status: nextStatus,
      updated_at: now,
    })
    .eq("id", input.disputeId)
    .eq("status", "pending_review")
    .select(DISPUTE_COLUMNS)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw conflictError("This dispute has already been decided.");

  const dispute = mapDisputeRow(data as DisputeRow);

  await writeAuditLog({
    actorLoginId: access.loginId ?? adminHrId,
    entityId: dispute.id,
    entityType: "private_calendar_data_dispute",
    newValues: { adminDecisionNote: note, decidedAt: now, status: nextStatus },
    summary: `Private calendar data dispute ${nextStatus} by Super Admin`,
  });

  // Every decision is kept in the case history, so a reopened dispute still shows what was ruled
  // before (the module's own row is overwritten by the next decision; this row never is).
  await recordCaseEvent({
    actorHrId: adminHrId,
    actorRole: access.role,
    details: { decision: nextStatus, disputeDate: dispute.disputeDate },
    eventType: "decided",
    kind: "calendar",
    note,
    ref: dispute.id,
  }).catch(() => undefined);

  // After the reply (afterResponse): the decision is saved, audited and in the case history, and the
  // notice used to be awaited before the answer left. A failed notice is logged, never thrown (it used
  // to turn a saved decision into a false 500).
  await afterResponse("private_calendar_notice:dispute_decided", async () => {
    await createSystemNotification({
      actorId: adminHrId,
      channels: ["email", "in_app", "push"],
      eventType: "private_calendar_dispute_decided",
      message: (nextStatus === "accepted"
        ? `Your dispute for ${dispute.disputeDate} was accepted. The calendar now shows the verified correction.`
        : `Your dispute for ${dispute.disputeDate} was reviewed and rejected.`) + (note ? ` Note: ${note}` : ""),
      metadata: { disputeId: dispute.id, employeeHrId: dispute.employeeHrId, idempotencyKey: `private-calendar-dispute:${dispute.id}:decided:${now}` },
      module: "private_calendar",
      priority: "normal",
      recipientHrId: dispute.employeeHrId,
      subjectHrId: dispute.employeeHrId,
      title: `Dispute ${nextStatus} — ${dispute.disputeDate}`,
    });
  });

  return dispute;
}
