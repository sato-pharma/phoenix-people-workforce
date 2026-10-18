import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission, type AccessContext } from "@/lib/auth/permissions";
import { conflictError, notFoundError } from "@/lib/http/api-errors";
import { canonicalHrIdKey } from "@/lib/hr-id";
import type { PrivateCalendarDataDispute } from "@/lib/private-calendar/disputes";
import { listMessagesForDisputes, type PrivateCalendarDisputeMessage } from "@/lib/private-calendar/dispute-messages";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { listDisputeCenterAttachments } from "./attachment-store.ts";
import { loadDayFacts, loadEmployeeProfileFacts } from "./day-evidence.ts";
import { listCaseEvents, nameFor, recordCaseEvent, resolvePeopleNames } from "./events.ts";
import { notifyDisputeCase, reviewerHrIdsFor } from "./notify.ts";
import { resolveCaseParticipant, viewerHrIdOf } from "./participants.ts";
import { compareCasesForReviewer, deriveDisputeCaseState, lastActivityAt, reopenedSince } from "./state.ts";
import { dayLabel, tidyDisputeText } from "./text.ts";
import type { DisputeCase, DisputeCaseEvent, DisputeMessage } from "./types.ts";

// CALENDAR DISPUTES in the Dispute Center's shape.
//
// The module's own record is unchanged: an employee flags that what the calendar shows for a day is
// wrong, and the Super Admin Accepts (the overlay is applied) or Rejects. What this file adds is
// everything the owner asked for on 2026-10-09 that the module did not have — the case never
// disappearing once decided, a reopen the EMPLOYEE asks for and the REVIEWER grants, the day's own
// record as facts beside the claim, and the history of every decision rather than only the latest.
//
// The reopen writes the module's own row back to pending_review and clears its decision fields, so
// every existing surface (the calendar overlay, the pending queue, the portal) treats it as open
// again with no change to them. Nothing is lost: the decision that was in force is copied into the
// `reopened` event first, and `dispute_case_events` is append-only in the database.

const DISPUTE_COLUMNS =
  "id,employee_hr_id,employee_name,dispute_date,item_source,item_source_record_id,displayed_summary,claim_text,claim_source_text,status,admin_hr_id,admin_decision_note,decided_at,created_at";

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
  status: "pending_review" | "accepted" | "rejected";
};

function mapRow(row: DisputeRow): PrivateCalendarDataDispute {
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
    itemSource: (row.item_source as PrivateCalendarDataDispute["itemSource"]) ?? null,
    itemSourceRecordId: row.item_source_record_id,
    status: row.status,
  };
}

async function loadDisputeOrThrow(disputeId: string): Promise<PrivateCalendarDataDispute> {
  const { data, error } = await getSupabaseAdmin()
    .from("private_calendar_data_disputes")
    .select(DISPUTE_COLUMNS)
    .eq("id", disputeId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw notFoundError("That dispute no longer exists.");
  return mapRow(data as DisputeRow);
}

/** The claim, as the first message of the thread — the stored text, never a second copy of it. */
function openingMessage(dispute: PrivateCalendarDataDispute, pictures: DisputeMessage["attachments"]): DisputeMessage {
  return {
    attachments: pictures,
    authorHrId: dispute.employeeHrId,
    authorName: dispute.employeeName,
    body: [dispute.claimText, dispute.claimSourceText ? `Where to verify: ${dispute.claimSourceText}` : ""]
      .filter(Boolean)
      .join("\n\n"),
    createdAt: dispute.createdAt,
    id: `calendar-opening-${dispute.id}`,
    side: "employee",
  };
}

function decisionLabel(status: PrivateCalendarDataDispute["status"]): string {
  if (status === "accepted") return "Accepted — the calendar shows the verified correction";
  if (status === "rejected") return "Rejected — the calendar stands as it was";
  return "";
}

/**
 * One calendar dispute as a case. `facts` are the day's own record, read only when asked for: the
 * evidence read gathers seven sources, which is right for one open case and far too much for a list.
 */
export async function buildCalendarCase(input: {
  dispute: PrivateCalendarDataDispute;
  events: DisputeCaseEvent[];
  messages: DisputeMessage[];
  openingAttachments: DisputeMessage["attachments"];
  viewer: { isOwner: boolean; isReviewer: boolean };
  decidedByName: string | null;
  withFacts: boolean;
}): Promise<DisputeCase> {
  const { dispute } = input;
  const decided = dispute.status !== "pending_review" && !reopenedSince(input.events, dispute.decidedAt);
  const opening = openingMessage(dispute, input.openingAttachments);
  let facts: DisputeCase["facts"] = [];
  let factsIncomplete = false;
  if (input.withFacts) {
    const [profile, day] = await Promise.all([
      loadEmployeeProfileFacts(dispute.employeeHrId),
      loadDayFacts(dispute.employeeHrId, [dispute.disputeDate]),
    ]);
    facts = [
      ...profile,
      { label: "What the calendar showed", value: dispute.displayedSummary || "(nothing was shown for this day)" },
      ...day.facts,
    ];
    factsIncomplete = day.incomplete;
  }
  return {
    canReply: input.viewer.isReviewer || !decided,
    decision: decided
      ? {
          decidedAt: dispute.decidedAt,
          decidedByName: input.decidedByName,
          favoursEmployee: dispute.status === "accepted",
          label: decisionLabel(dispute.status),
          note: dispute.adminDecisionNote,
        }
      : null,
    employeeHrId: dispute.employeeHrId,
    employeeName: dispute.employeeName ?? dispute.employeeHrId,
    events: input.events,
    facts,
    factsIncomplete,
    kind: "calendar",
    lastActivityAt: lastActivityAt({
      decidedAt: dispute.decidedAt,
      events: input.events,
      messages: input.messages,
      openedAt: dispute.createdAt,
    }),
    messages: input.messages,
    opening,
    openedAt: dispute.createdAt,
    ref: dispute.id,
    refunds: [],
    state: deriveDisputeCaseState({
      decided,
      events: input.events,
      messages: input.messages,
      openedAt: dispute.createdAt,
    }),
    title: `Calendar — ${dayLabel(dispute.disputeDate)}`,
    viewer: input.viewer,
  };
}

/**
 * Every calendar dispute the viewer may see — EVERY status, not only pending (owner, 2026-10-09:
 * "dispute closed dispute open but never disappeared from me or the employee side"). A reviewer sees
 * the company's; anyone else sees their own.
 */
export async function listCalendarCases(access: AccessContext): Promise<DisputeCase[]> {
  // The registry row for every dispute-center route declares attendance:read with a
  // domain-helper guard, so the helper is where it has to be enforced. Measured on production
  // 2026-10-09: without this an UNAUTHENTICATED GET of /api/dispute-center/cases answered 200
  // with an empty list, where the private-calendar sibling answers 403. No row leaked — each
  // list self-scopes and an anonymous caller has no hr id — but an empty 200 is not a refusal,
  // and "the list came back empty" must never be what stands in for access control.
  await assertPermission(access, "attendance", "read");
  const viewerHrId = viewerHrIdOf(access);
  const isReviewer = access.role === "Super Admin";
  if (!isReviewer && !viewerHrId) return [];

  let query = getSupabaseAdmin()
    .from("private_calendar_data_disputes")
    .select(DISPUTE_COLUMNS)
    .order("created_at", { ascending: false });
  if (!isReviewer) query = query.eq("employee_hr_id", viewerHrId as string);
  const { data, error } = await query;
  if (error) throw error;
  const disputes = ((data ?? []) as DisputeRow[]).map(mapRow);
  if (disputes.length === 0) return [];

  const ids = disputes.map((dispute) => dispute.id);
  const [messagesByDispute, eventsByRef, pictures, names] = await Promise.all([
    listMessagesForDisputes(ids).catch(() => new Map<string, PrivateCalendarDisputeMessage[]>()),
    listCaseEvents("calendar", ids),
    listDisputeCenterAttachments("calendar", ids),
    resolvePeopleNames(disputes.map((dispute) => dispute.adminHrId)),
  ]);

  const cases = await Promise.all(
    disputes.map((dispute) =>
      buildCalendarCase({
        decidedByName: nameFor(names, dispute.adminHrId),
        dispute,
        events: eventsByRef.get(dispute.id) ?? [],
        messages: (messagesByDispute.get(dispute.id) ?? []).map((message) => ({
          attachments: message.attachments ?? [],
          authorHrId: message.authorHrId,
          authorName: message.authorName,
          body: message.body,
          createdAt: message.createdAt,
          id: message.id,
          side: message.authorIsAdmin ? ("reviewer" as const) : ("employee" as const),
        })),
        openingAttachments: pictures.opening.get(dispute.id) ?? [],
        viewer: {
          isOwner: canonicalHrIdKey(viewerHrId) === canonicalHrIdKey(dispute.employeeHrId),
          isReviewer,
        },
        withFacts: false,
      }),
    ),
  );
  return cases.sort(compareCasesForReviewer);
}

/** One calendar case in full, with the day's own record attached. */
export async function loadCalendarCase(access: AccessContext, disputeId: string): Promise<DisputeCase> {
  const participant = await resolveCaseParticipant(access, "calendar", disputeId);
  const dispute = await loadDisputeOrThrow(disputeId);
  const [messagesByDispute, eventsByRef, pictures, names] = await Promise.all([
    listMessagesForDisputes([disputeId]).catch(() => new Map<string, PrivateCalendarDisputeMessage[]>()),
    listCaseEvents("calendar", [disputeId]),
    listDisputeCenterAttachments("calendar", [disputeId]),
    resolvePeopleNames([dispute.adminHrId]),
  ]);
  return buildCalendarCase({
    decidedByName: nameFor(names, dispute.adminHrId),
    dispute,
    events: eventsByRef.get(disputeId) ?? [],
    messages: (messagesByDispute.get(disputeId) ?? []).map((message) => ({
      attachments: message.attachments ?? [],
      authorHrId: message.authorHrId,
      authorName: message.authorName,
      body: message.body,
      createdAt: message.createdAt,
      id: message.id,
      side: message.authorIsAdmin ? ("reviewer" as const) : ("employee" as const),
    })),
    openingAttachments: pictures.opening.get(disputeId) ?? [],
    viewer: { isOwner: participant.isOwner, isReviewer: participant.isReviewer },
    withFacts: true,
  });
}

/** Record that a calendar decision was taken, so a later reopen still shows what it was. */
export async function recordCalendarDecisionEvent(input: {
  access: Pick<AccessContext, "role" | "hrId" | "loginId">;
  dispute: PrivateCalendarDataDispute;
}): Promise<void> {
  await recordCaseEvent({
    actorHrId: viewerHrIdOf(input.access),
    actorRole: input.access.role,
    details: {
      decision: input.dispute.status,
      disputeDate: input.dispute.disputeDate,
      note: input.dispute.adminDecisionNote,
    },
    eventType: "decided",
    kind: "calendar",
    note: input.dispute.adminDecisionNote,
    ref: input.dispute.id,
  });
}

/**
 * The employee asks for a decided calendar dispute to be looked at again (owner, 2026-10-09:
 * "Employee asks, reviewer reopens"). It does not reopen anything — it flags the case and tells the
 * reviewers. Asking twice is refused, so a case cannot carry two open requests.
 */
export async function requestCalendarReopen(access: AccessContext, input: { disputeId: string; reason: string }): Promise<void> {
  const participant = await resolveCaseParticipant(access, "calendar", input.disputeId);
  if (!participant.isOwner) throw new Error("Forbidden: only the employee this dispute belongs to can ask for it to be looked at again.");
  const dispute = await loadDisputeOrThrow(input.disputeId);
  if (dispute.status === "pending_review") throw conflictError("This dispute is already open — reply in the conversation instead.");
  const reason = tidyDisputeText(input.reason);
  if (!reason) throw new Error("Validation: say why it should be looked at again.");

  const events = (await listCaseEvents("calendar", [input.disputeId])).get(input.disputeId) ?? [];
  const pending = events.filter((event) => ["reopen_requested", "reopened", "reopen_declined"].includes(event.eventType)).at(-1);
  if (pending?.eventType === "reopen_requested") {
    throw conflictError("You have already asked for this to be looked at again. It is with the reviewer.");
  }

  await recordCaseEvent({
    actorHrId: participant.viewerHrId,
    actorRole: access.role,
    details: { decisionAtRequest: dispute.status },
    eventType: "reopen_requested",
    kind: "calendar",
    note: reason,
    ref: input.disputeId,
  });
  await notifyDisputeCase({
    actorHrId: participant.viewerHrId,
    audience: "reviewer",
    employeeHrId: dispute.employeeHrId,
    eventKey: `reopen_requested:${new Date().toISOString()}`,
    kind: "calendar",
    message: `${dispute.employeeName ?? "An employee"} asked you to look again at ${dayLabel(dispute.disputeDate)}: "${reason}"`,
    recipientHrIds: await reviewerHrIdsFor("calendar", dispute.employeeHrId),
    ref: input.disputeId,
    title: `Reopen asked — calendar ${dayLabel(dispute.disputeDate)}`,
  });
}

/**
 * The reviewer reopens a decided calendar dispute, or declines the request.
 *
 * Reopening copies the decision in force into the `reopened` event FIRST, then writes the row back
 * to pending_review — so the module's own screens see an open request again and nothing about the
 * earlier ruling is lost. The row update is guarded on the status it read, so two reviewers cannot
 * both reopen it; the pending unique index can refuse it when the employee has since raised a fresh
 * dispute for the same day, and that is reported in those words.
 */
export async function decideCalendarReopen(
  access: AccessContext,
  input: { disputeId: string; grant: boolean; note: string },
): Promise<void> {
  const participant = await resolveCaseParticipant(access, "calendar", input.disputeId);
  if (!participant.isReviewer) throw new Error("Forbidden: only the Super Admin can reopen a calendar dispute.");
  const dispute = await loadDisputeOrThrow(input.disputeId);
  const note = tidyDisputeText(input.note);

  if (!input.grant) {
    // The note is OPTIONAL (owner, 2026-10-18).
    await recordCaseEvent({
      actorHrId: participant.viewerHrId,
      actorRole: access.role,
      details: { decision: dispute.status },
      eventType: "reopen_declined",
      kind: "calendar",
      note,
      ref: input.disputeId,
    });
    await notifyDisputeCase({
      actorHrId: participant.viewerHrId,
      audience: "employee",
      employeeHrId: dispute.employeeHrId,
      eventKey: `reopen_declined:${new Date().toISOString()}`,
      kind: "calendar",
      message: `The decision on ${dayLabel(dispute.disputeDate)} stands. ${note}`.trim(),
      recipientHrIds: [dispute.employeeHrId],
      ref: input.disputeId,
      title: `Decision stands — calendar ${dayLabel(dispute.disputeDate)}`,
    });
    return;
  }

  if (dispute.status === "pending_review") throw conflictError("This dispute is already open.");

  // The ruling being set aside is recorded before it is cleared.
  await recordCaseEvent({
    actorHrId: participant.viewerHrId,
    actorRole: access.role,
    details: {
      previousDecidedAt: dispute.decidedAt,
      previousDecidedByHrId: dispute.adminHrId,
      previousDecision: dispute.status,
      previousNote: dispute.adminDecisionNote,
    },
    eventType: "reopened",
    kind: "calendar",
    note: note || null,
    ref: input.disputeId,
  });

  const now = new Date().toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from("private_calendar_data_disputes")
    .update({ admin_decision_note: null, admin_hr_id: null, decided_at: null, status: "pending_review", updated_at: now })
    .eq("id", input.disputeId)
    .eq("status", dispute.status)
    .select("id")
    .maybeSingle();
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      throw conflictError(
        `${dispute.employeeName ?? "The employee"} has since raised a new dispute for ${dayLabel(dispute.disputeDate)}, and only one can be open at a time. Decide that one instead.`,
      );
    }
    throw error;
  }
  if (!data) throw conflictError("Somebody else changed this dispute while you were looking at it. Reload and try again.");

  await writeAuditLog({
    actorLoginId: access.loginId ?? participant.viewerHrId ?? "unknown",
    entityId: input.disputeId,
    entityType: "private_calendar_data_dispute",
    newValues: { reopenedAt: now, reopenedFrom: dispute.status, status: "pending_review" },
    summary: `Private calendar dispute for ${dispute.disputeDate} reopened by the reviewer`,
  });
  await notifyDisputeCase({
    actorHrId: participant.viewerHrId,
    audience: "employee",
    employeeHrId: dispute.employeeHrId,
    eventKey: `reopened:${now}`,
    kind: "calendar",
    message: note
      ? `${dayLabel(dispute.disputeDate)} is being looked at again. ${note}`
      : `${dayLabel(dispute.disputeDate)} is being looked at again.`,
    recipientHrIds: [dispute.employeeHrId],
    ref: input.disputeId,
    title: `Reopened — calendar ${dayLabel(dispute.disputeDate)}`,
  });
}
