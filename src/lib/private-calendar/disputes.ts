import { randomUUID } from "node:crypto";

import {
  assertPermission,
  normalizeHrId,
  resolveEmployeeIdentityId,
  type AccessContext,
} from "@/lib/auth/permissions";
import { writeAuditLog } from "@/lib/admin/audit";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { conflictError, validationError } from "@/lib/http/api-errors";
import { afterResponse } from "@/lib/http/after-response";
import { createSystemNotification } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import type { CheckedDisputeImage } from "@/lib/dispute-center/attachment-rules.ts";
import { storeDisputeCenterAttachments } from "@/lib/dispute-center/attachment-store.ts";
import { recordCaseEvent } from "@/lib/dispute-center/events.ts";
import { tidyDisputeText } from "@/lib/dispute-center/text.ts";
import {
  explainDatesPhrase,
  explainDayLabel,
  explainReason,
  explanationSummary,
  explanationVerifySource,
  type DisputeExplanation,
} from "@/lib/dispute-center/explain-reasons.ts";
import {
  assertDaysNotExplainedElsewhere,
  assertDaysStillExplainable,
  checkExplanation,
  insertDisputeExplanations,
  loadExplanationsByCase,
  notifyExplanationConfirmer,
  resolveExplanationConfirmer,
} from "@/lib/dispute-center/explanations.ts";
import { cairoTodayIso } from "@/lib/attendance/working-days";
import { resolveSuperAdminRecipients } from "@/lib/private-calendar/notify-admin";
import { privateCalendarHrIdPattern, type PrivateCalendarSource } from "@/lib/private-calendar/logic";
import { currentVerificationSourceText } from "@/lib/private-calendar/verification-sources";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// Private Calendar review requests. Since 2026-11-16 an employee no longer
// flags the calendar as "wrong" in free text: he EXPLAINS a day with no record
// from the reason list (dispute-center/explain-reasons.ts) and names who can
// confirm it; the confirmer answers first, then the Super Admin decides. Older
// requests (before that day) were free text and may target one item. Super
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
  /** The structured explanation (reason, confirmer, answer). Null on a request filed before 2026-11-16. */
  explanation?: DisputeExplanation | null;
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
    // A request filed before 15 Nov 2026 names the retired iReports360 option; it reads as Phoenix CRM now.
    claimSourceText: currentVerificationSourceText(row.claim_source_text),
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

/**
 * Each request with its explanation beside it (null for a request filed before 2026-11-16).
 * Best-effort: an unreadable explanation table leaves `explanation` unset and the request still shows
 * with its stored words — a failed side read must never hide a waiting decision.
 */
async function withExplanations(disputes: PrivateCalendarDataDispute[]): Promise<PrivateCalendarDataDispute[]> {
  if (disputes.length === 0) return disputes;
  try {
    const byRef = await loadExplanationsByCase("calendar", disputes.map((dispute) => dispute.id));
    return disputes.map((dispute) => ({ ...dispute, explanation: byRef.get(dispute.id) ?? null }));
  } catch (error) {
    logError("Calendar request explanations unreadable", { error, labels: { event: "calendar_explanations_read_failed" } });
    return disputes;
  }
}

// Decisions are Super Admin only, per owner instruction — a narrower gate
// than the generic `deductions`/`attendance` permission matrix, so it is
// enforced explicitly here rather than through assertPermission.
function assertDisputeDecisionActor(access: Pick<AccessContext, "role">) {
  if (access.role !== "Super Admin") {
    throw new Error("Forbidden: only Super Admin can review private calendar data disputes.");
  }
}

/**
 * The employee EXPLAINS one or more of his own days (owner, 2026-11-16) — a reason from the list, the
 * person who can confirm it, and his words for "Something else". One request row per day, written in
 * one insert and sharing one explanation group, so a training week is one action for him, one answer
 * for his manager and one decision for the Super Admin.
 *
 * Refused, with a sentence he can act on: a day already asked about (waiting → wait; decided → "ask
 * for another look" on it), a day already explained on a deduction dispute, and a day whose payroll
 * month is already confirmed (owner: "Until payroll closes").
 */
export async function submitPrivateCalendarDataDispute(
  access: AccessContext,
  input: {
    confirmerHrId?: unknown;
    dates: unknown;
    detailText?: unknown;
    /** What the calendar showed on each day, keyed by date — kept with the request for the record. */
    displayedSummaries?: Record<string, string> | null;
    /** Ignored: the sender's name comes from their own employee record, never from the request body. */
    employeeName?: string | null;
    /** Pictures the employee attached to the request itself (owner, 2026-10-09). Kept on the first day. */
    images?: CheckedDisputeImage[];
    reasonCode: unknown;
  },
): Promise<PrivateCalendarDataDispute[]> {
  await assertPermission(access, "attendance", "read");
  const employeeHrId = resolveEmployeeIdentityId(access);
  if (!employeeHrId) throw new Error("Your employee profile is not linked. Contact HR.");
  // Named from the sender's own record: a name in the request body could put anyone's name on the confirmer's card.
  // The DISPLAY name (nickname-aware, `resolveEmployeeDisplayName`) is what the calendar and the old client value
  // carried, so a nickname holder reads the same on the confirmer's card and the Super Admin's notice. A failed
  // read stops the request — a retry is free — instead of storing a request with no name on it.
  const { data: ownRecord, error: ownRecordError } = await getSupabaseAdmin()
    .from("employees")
    .select("full_name, nickname, hr_id")
    .ilike("hr_id", privateCalendarHrIdPattern(employeeHrId))
    .limit(1);
  if (ownRecordError) throw ownRecordError;
  const own = (ownRecord as Array<{ full_name: string | null; nickname: string | null; hr_id: string | null }> | null)?.[0];
  const employeeName = own?.full_name ? tidyDisputeText(resolveEmployeeDisplayName(own.full_name, own.nickname, own.hr_id)) || null : null;

  const explanation = checkExplanation(
    { confirmerHrId: input.confirmerHrId, dates: input.dates, detailText: input.detailText, reasonCode: input.reasonCode },
    cairoTodayIso(),
  );
  const confirmer = await resolveExplanationConfirmer(employeeHrId, explanation);
  const dates = explanation.dates;

  // A day already asked about is never asked twice: one waiting is waited on, one decided is reopened.
  const { data: existing, error: existingError } = await getSupabaseAdmin()
    .from("private_calendar_data_disputes")
    .select("dispute_date,status")
    .ilike("employee_hr_id", privateCalendarHrIdPattern(employeeHrId))
    .is("item_source", null)
    .in("dispute_date", dates);
  if (existingError) throw existingError;
  const taken = ((existing ?? []) as Array<{ dispute_date: string; status: PrivateCalendarDisputeStatus }>)
    .sort((left, right) => left.dispute_date.localeCompare(right.dispute_date));
  const waiting = taken.find((row) => row.status === "pending_review");
  if (waiting) {
    throw conflictError(`${explainDayLabel(waiting.dispute_date)} is already waiting for a decision. Untick it, or wait for the answer.`);
  }
  const decided = taken[0];
  if (decided) {
    throw conflictError(
      `${decided.dispute_date} was already ${decided.status === "accepted" ? "accepted" : "decided"}. Open it in your Disputes and ask for another look instead.`,
    );
  }
  await assertDaysNotExplainedElsewhere({ dates, employeeHrId, otherKinds: ["deduction", "daily"] });
  await assertDaysStillExplainable(employeeHrId, dates);

  const claimText = tidyDisputeText(
    explanationSummary({ confirmerName: confirmer?.name ?? null, detailText: explanation.detailText, reasonCode: explanation.reasonCode }),
  );
  const claimSourceText = explanationVerifySource({ confirmerName: confirmer?.name ?? null, reasonCode: explanation.reasonCode });

  const { data, error } = await getSupabaseAdmin()
    .from("private_calendar_data_disputes")
    .insert(
      dates.map((date) => ({
        claim_source_text: claimSourceText,
        claim_text: claimText,
        displayed_summary: input.displayedSummaries?.[date]?.trim() || "(nothing was shown for this day)",
        dispute_date: date,
        employee_hr_id: employeeHrId,
        employee_name: employeeName,
        item_source: null,
        item_source_record_id: null,
        status: "pending_review",
      })),
    )
    .select(DISPUTE_COLUMNS);

  if (error) {
    if ((error as { code?: string }).code === "23505") {
      throw conflictError("One of these days is already waiting for a decision. Refresh the calendar and try again.");
    }
    throw error;
  }

  const disputes = ((data ?? []) as DisputeRow[])
    .map(mapDisputeRow)
    .sort((left, right) => left.disputeDate.localeCompare(right.disputeDate));
  // A clean-up that fails would leave pending requests with no reason behind them, refusing the employee's
  // next try for those days ("already waiting for a decision"). So it is checked, tried once more, and a
  // second failure is logged with the request ids for the Super Admin's error board — never silent.
  const removeAll = async () => {
    const ids = disputes.map((dispute) => dispute.id);
    let removeError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { error } = await getSupabaseAdmin().from("private_calendar_data_disputes").delete().in("id", ids);
      removeError = error;
      if (!error) return;
    }
    logError("Calendar review requests could not be removed after a failed save", {
      error: removeError,
      labels: { dispute_ids: ids.join(","), event: "private_calendar_request_cleanup_failed" },
    });
  };

  // The explanation rows hang off the request ids. If they cannot be written the requests go too:
  // nobody reviews, or is notified of, half a claim.
  const groupId = randomUUID();
  let explanations: DisputeExplanation[] = [];
  try {
    explanations = await insertDisputeExplanations({
      caseKind: "calendar",
      cases: disputes.map((dispute) => ({ dates: [dispute.disputeDate], ref: dispute.id })),
      confirmer,
      employeeHrId,
      employeeName,
      explanation,
      groupId,
    });
  } catch (explainError) {
    await removeAll();
    throw explainError;
  }
  const explanationByRef = new Map(explanations.map((row) => [row.caseRef, row]));
  for (const dispute of disputes) dispute.explanation = explanationByRef.get(dispute.id) ?? null;

  let pictureCount = 0;
  if ((input.images?.length ?? 0) > 0 && disputes[0]) {
    try {
      const stored = await storeDisputeCenterAttachments({
        images: input.images ?? [],
        kind: "calendar",
        messageId: null,
        ref: disputes[0].id,
        uploadedByHrId: employeeHrId,
      });
      pictureCount = stored.length;
    } catch (storeError) {
      const { error: explanationsError } = await getSupabaseAdmin().from("dispute_explanations").delete().eq("group_id", groupId);
      if (explanationsError) {
        logError("Calendar explanation rows could not be removed after a failed save", {
          error: explanationsError,
          labels: { event: "private_calendar_explanation_cleanup_failed", group_id: groupId },
        });
      }
      await removeAll();
      throw storeError;
    }
  }

  await writeAuditLog({
    actorLoginId: access.loginId ?? employeeHrId,
    entityId: groupId,
    entityType: "private_calendar_data_dispute",
    newValues: {
      confirmerHrId: confirmer?.hrId ?? null,
      dates,
      disputeIds: disputes.map((dispute) => dispute.id),
      pictureCount,
      reasonCode: explanation.reasonCode,
      status: "pending_review",
    },
    summary: `Private calendar ${dates.length === 1 ? "day" : `${dates.length} days`} explained: ${explainReason(explanation.reasonCode).label}`,
  });

  const who = employeeName ?? employeeHrId;
  // The days as a person reads them, gaps kept ("2–3 Nov and 9 Nov"), never one run from first to last.
  const span = dates.length === 1 ? explainDayLabel(dates[0]) : `${explainDatesPhrase(dates)} (${dates.length} days)`;

  // Manager first, then the Super Admin (owner, 2026-11-16): a reason with a confirmer goes to that
  // person, and the Super Admin hears once it is answered (explanations.ts answerExplanationGroup).
  // Only "Something else", which nobody confirms, reaches the Super Admin now.
  if (confirmer) {
    await notifyExplanationConfirmer({
      caseKind: "calendar",
      confirmer,
      dates,
      employeeHrId,
      employeeName,
      groupId,
      reasonCode: explanation.reasonCode,
    });
  } else {
    // After the reply (afterResponse): the requests are saved and audited. A failed notice is logged,
    // never thrown.
    await afterResponse("private_calendar_notice:dispute_submitted", async () => {
      const recipients = await resolveSuperAdminRecipients();
      await Promise.all(recipients.map((recipient) => createSystemNotification({
        actionUrl: "/admin/private-calendar-disputes",
        actorId: employeeHrId,
        channels: ["email", "in_app", "push"],
        eventType: "private_calendar_dispute_submitted",
        message: `${who} explained a missing record on ${span}: "${claimText}"`,
        metadata: { disputeId: disputes[0]?.id ?? null, employeeHrId, groupId, idempotencyKey: `private-calendar-dispute:${groupId}:submitted` },
        module: "private_calendar",
        priority: "normal",
        recipientHrId: recipient.hrId,
        subjectHrId: employeeHrId,
        title: `Missing record explained — ${span}`,
      })));
    });
  }

  return disputes;
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
  return withExplanations(((data ?? []) as DisputeRow[]).map(mapDisputeRow));
}

/**
 * Every request waiting for the Super Admin. `withExplanation` adds each one's reason and confirmer —
 * the inbox asks for it; the badge counts, polled every 30 s, do not.
 */
export async function listPendingPrivateCalendarDataDisputes(
  access: AccessContext,
  options: { withExplanation?: boolean } = {},
): Promise<PrivateCalendarDataDispute[]> {
  assertDisputeDecisionActor(access);
  const { data, error } = await getSupabaseAdmin()
    .from("private_calendar_data_disputes")
    .select(DISPUTE_COLUMNS)
    .eq("status", "pending_review")
    .order("created_at", { ascending: true });
  if (error) throw error;
  const disputes = ((data ?? []) as DisputeRow[]).map(mapDisputeRow);
  return options.withExplanation ? withExplanations(disputes) : disputes;
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
  return withExplanations(((data ?? []) as DisputeRow[]).map(mapDisputeRow));
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
        ? `Your explanation for ${dispute.disputeDate} was accepted. The calendar now shows it.`
        : `Your explanation for ${dispute.disputeDate} was reviewed and rejected.`) + (note ? ` Note: ${note}` : ""),
      metadata: { disputeId: dispute.id, employeeHrId: dispute.employeeHrId, idempotencyKey: `private-calendar-dispute:${dispute.id}:decided:${now}` },
      module: "private_calendar",
      priority: "normal",
      recipientHrId: dispute.employeeHrId,
      subjectHrId: dispute.employeeHrId,
      title: `Explanation ${nextStatus} — ${dispute.disputeDate}`,
    });
  });

  return dispute;
}

/**
 * One decision over several requests at once — the inbox's "Accept all" on a reason group (owner,
 * 2026-11-16: a training week from eleven people was 37 separate clicks). Each request is decided
 * exactly as {@link decidePrivateCalendarDataDispute} decides one (pending only, the same row, audit
 * and case-history entry); the employee gets ONE notice listing his days, not one per day.
 */
export async function decidePrivateCalendarDataDisputes(
  access: AccessContext,
  input: { decision: "accept" | "reject"; disputeIds: string[]; note: string },
): Promise<{ decided: PrivateCalendarDataDispute[] }> {
  assertDisputeDecisionActor(access);
  const ids = Array.from(new Set((input.disputeIds ?? []).map((id) => String(id ?? "").trim()).filter(Boolean)));
  if (ids.length === 0) throw validationError("Choose at least one request.");
  if (ids.length > 200) throw validationError("Decide at most 200 requests at once.");
  const note = input.note.trim();
  const adminHrId = normalizeHrId(access.hrId) ?? normalizeHrId(access.loginId) ?? "system";
  const now = new Date().toISOString();
  const nextStatus: PrivateCalendarDisputeStatus = input.decision === "accept" ? "accepted" : "rejected";

  // Accepting together is for requests the person named has CONFIRMED (owner, 2026-11-16: "manager
  // first then me"). "Something else", a request filed before the reason list, and anything still
  // waiting or declined are decided one by one — the inbox offers no button for them, and this is
  // the gate behind it.
  if (input.decision === "accept") {
    const explained = await loadExplanationsByCase("calendar", ids);
    const unconfirmed = ids.filter((id) => explained.get(id)?.confirmationStatus !== "confirmed");
    if (unconfirmed.length > 0) {
      throw validationError(
        `${unconfirmed.length} of these ${ids.length} requests ${unconfirmed.length === 1 ? "was" : "were"} not confirmed by the person named. Decide ${unconfirmed.length === 1 ? "it" : "them"} one by one.`,
      );
    }
  }

  const { data, error } = await getSupabaseAdmin()
    .from("private_calendar_data_disputes")
    .update({
      admin_decision_note: note || null,
      admin_hr_id: adminHrId,
      decided_at: now,
      status: nextStatus,
      updated_at: now,
    })
    .in("id", ids)
    .eq("status", "pending_review")
    .select(DISPUTE_COLUMNS);
  if (error) throw error;
  const decided = ((data ?? []) as DisputeRow[]).map(mapDisputeRow);
  if (decided.length === 0) throw conflictError("These requests have already been decided.");

  await writeAuditLog({
    actorLoginId: access.loginId ?? adminHrId,
    entityId: decided[0].id,
    entityType: "private_calendar_data_dispute",
    newValues: { adminDecisionNote: note, decidedAt: now, disputeIds: decided.map((dispute) => dispute.id), status: nextStatus },
    summary: `${decided.length} private calendar review requests ${nextStatus} together by Super Admin`,
  });

  await Promise.all(
    decided.map((dispute) =>
      recordCaseEvent({
        actorHrId: adminHrId,
        actorRole: access.role,
        details: { decision: nextStatus, disputeDate: dispute.disputeDate, together: decided.length },
        eventType: "decided",
        kind: "calendar",
        note,
        ref: dispute.id,
      }).catch(() => undefined),
    ),
  );

  // After the reply: one notice per employee, naming every day decided for him.
  await afterResponse("private_calendar_notice:disputes_decided_together", async () => {
    const byEmployee = new Map<string, PrivateCalendarDataDispute[]>();
    for (const dispute of decided) {
      const list = byEmployee.get(dispute.employeeHrId) ?? [];
      list.push(dispute);
      byEmployee.set(dispute.employeeHrId, list);
    }
    await Promise.all(
      Array.from(byEmployee.entries()).map(([employeeHrId, list]) => {
        const days = list.map((dispute) => dispute.disputeDate).sort();
        const span = days.length === 1 ? explainDayLabel(days[0]) : `${explainDatesPhrase(days)} (${days.length} days)`;
        return createSystemNotification({
          actorId: adminHrId,
          channels: ["email", "in_app", "push"],
          eventType: "private_calendar_dispute_decided",
          message:
            (nextStatus === "accepted"
              ? `Your explanation for ${span} was accepted. The calendar now shows it.`
              : `Your explanation for ${span} was reviewed and rejected.`) + (note ? ` Note: ${note}` : ""),
          metadata: {
            disputeIds: list.map((dispute) => dispute.id),
            employeeHrId,
            idempotencyKey: `private-calendar-dispute:${list[0].id}:decided-together:${now}`,
          },
          module: "private_calendar",
          priority: "normal",
          recipientHrId: employeeHrId,
          subjectHrId: employeeHrId,
          title: `Explanation ${nextStatus} — ${days.length === 1 ? explainDayLabel(days[0]) : explainDatesPhrase(days)}`,
        });
      }),
    );
  });

  return { decided };
}
