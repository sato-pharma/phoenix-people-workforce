import {
  assertPermission,
  normalizeHrId,
  resolveEmployeeIdentityId,
  type AccessContext,
} from "@/lib/auth/permissions";
import { writeAuditLog } from "@/lib/admin/audit";
import { notFoundError } from "@/lib/http/api-errors";
import { notifyConversationMessage } from "@/lib/conversations/notify";
import { canonicalHrIdKey, hrIdForStorage, hrIdLookupKeys } from "@/lib/hr-id";
import type { PrivateCalendarDataDispute } from "@/lib/private-calendar/disputes";
import { resolveSuperAdminRecipients } from "@/lib/private-calendar/notify-admin";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// The conversation under one Private Calendar review request.
//
// A review request used to be one shot each way — the employee's claim, then the Super Admin's
// decision note — with nowhere to ask "which manager confirmed it?" before deciding. Both sides can
// now reply, and either side's reply is delivered on the same channels every other Phoenix
// conversation uses (email to the person the thread belongs to, cc the sender, plus in-app, Telegram
// and push) through the one shared addressing rule in lib/conversations/notify.ts.
//
// The request's own `claim_text` is NOT copied in here: it is rendered as the first message of the
// thread by whoever displays it, so there is exactly one stored copy of what the employee wrote.

export type PrivateCalendarDisputeMessage = {
  authorHrId: string;
  authorIsAdmin: boolean;
  authorName: string | null;
  body: string;
  createdAt: string;
  id: string;
};

type MessageRow = {
  author_hr_id: string;
  author_is_admin: boolean;
  body: string;
  created_at: string;
  dispute_id: string;
  id: string;
};

const MESSAGE_COLUMNS = "id,dispute_id,author_hr_id,author_is_admin,body,created_at";

export const PRIVATE_CALENDAR_DISPUTE_MESSAGE_MAX_LENGTH = 2000;

function mapMessageRow(row: MessageRow, authorName: string | null): PrivateCalendarDisputeMessage {
  return {
    authorHrId: row.author_hr_id,
    authorIsAdmin: row.author_is_admin,
    authorName,
    body: row.body,
    createdAt: row.created_at,
    id: row.id,
  };
}

/**
 * Full names for a set of HR ids, keyed by canonical key.
 *
 * `hrIdLookupKeys` on every id rather than one normalized form, for the reason spelled out in
 * conversations/notify.ts: `employees.hr_id` is stored UPPER-case in all but one row, so an `.in()`
 * over lower-case comparison keys matches nothing and silently returns a thread of blank names.
 * Best-effort — an unresolved id leaves the name null and the line still renders.
 */
async function resolveAuthorNames(hrIds: string[]): Promise<Map<string, string>> {
  const nameByKey = new Map<string, string>();
  const ids = Array.from(new Set(hrIds.filter(Boolean)));
  if (ids.length === 0) return nameByKey;
  const lookups = Array.from(new Set(ids.flatMap((id) => hrIdLookupKeys(id))));
  const { data, error } = await getSupabaseAdmin().from("employees").select("hr_id,full_name").in("hr_id", lookups);
  if (error) return nameByKey;
  for (const row of (data ?? []) as Array<{ full_name?: string | null; hr_id?: string | null }>) {
    const key = canonicalHrIdKey(row.hr_id);
    const name = String(row.full_name ?? "").trim();
    if (key && name) nameByKey.set(key, name);
  }
  return nameByKey;
}

/**
 * Who may read and write this thread: the employee who raised the request, or a Super Admin.
 *
 * Deliberately the same narrow gate as the decision itself (`assertDisputeDecisionActor` in
 * disputes.ts) rather than the `attendance` permission matrix — a manager with attendance:read must
 * not be able to join a conversation about somebody else's pay-affecting day. Exported and pure so a
 * test can assert the gate without a database.
 */
export function resolveDisputeThreadActor(input: {
  employeeHrId: string;
  hrId: string | null;
  role: string;
}): { hrId: string; isAdmin: boolean } {
  const isAdmin = input.role === "Super Admin";
  const viewerKey = canonicalHrIdKey(input.hrId);
  const ownerKey = canonicalHrIdKey(input.employeeHrId);
  const isOwner = Boolean(viewerKey && ownerKey && viewerKey === ownerKey);
  if (!isAdmin && !isOwner) {
    throw new Error("Forbidden: only the employee who raised this review request, or a Super Admin, can read or reply to it.");
  }
  if (!input.hrId) throw new Error("Your employee profile is not linked. Contact HR.");
  return { hrId: input.hrId, isAdmin };
}

function viewerHrIdFor(access: AccessContext): string | null {
  return resolveEmployeeIdentityId(access) ?? normalizeHrId(access.hrId) ?? normalizeHrId(access.loginId) ?? null;
}

async function loadDispute(disputeId: string) {
  const { data, error } = await getSupabaseAdmin()
    .from("private_calendar_data_disputes")
    .select("id,employee_hr_id,employee_name,dispute_date,status")
    .eq("id", disputeId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw notFoundError("That review request no longer exists.");
  return data as {
    dispute_date: string;
    employee_hr_id: string;
    employee_name: string | null;
    id: string;
    status: string;
  };
}

/**
 * Replies for many requests at once, keyed by request id, oldest first — the order a conversation
 * reads in.
 *
 * One query rather than one per request: the private calendar renders a whole month and the Approvals
 * Hub renders the whole pending queue, so a per-request read would be a loop of round trips for a
 * thread most days do not have at all. Not permission-gated itself — every caller has already
 * resolved which requests the viewer may see.
 */
export async function listMessagesForDisputes(
  disputeIds: string[],
): Promise<Map<string, PrivateCalendarDisputeMessage[]>> {
  const byDispute = new Map<string, PrivateCalendarDisputeMessage[]>();
  const ids = Array.from(new Set(disputeIds.filter(Boolean)));
  if (ids.length === 0) return byDispute;
  const { data, error } = await getSupabaseAdmin()
    .from("private_calendar_dispute_messages")
    .select(MESSAGE_COLUMNS)
    .in("dispute_id", ids)
    .order("created_at", { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as MessageRow[];
  const nameByKey = await resolveAuthorNames(rows.map((row) => row.author_hr_id));
  for (const row of rows) {
    const key = canonicalHrIdKey(row.author_hr_id);
    const list = byDispute.get(row.dispute_id) ?? [];
    list.push(mapMessageRow(row, (key && nameByKey.get(key)) || null));
    byDispute.set(row.dispute_id, list);
  }
  return byDispute;
}

/**
 * A request with its own thread attached — what a reviewer's queue needs in one object.
 *
 * Deliberately a wrapper rather than a field on `PrivateCalendarDataDispute`: the calendar's overlay
 * code reads that type for a dozen reasons that have nothing to do with the conversation, and widening
 * it would make every one of those reads carry the thread.
 */
export type PrivateCalendarDisputeThread = PrivateCalendarDataDispute & {
  messages: PrivateCalendarDisputeMessage[];
};

export async function attachDisputeMessages(
  disputes: PrivateCalendarDataDispute[],
): Promise<PrivateCalendarDisputeThread[]> {
  const byDispute = await listMessagesForDisputes(disputes.map((dispute) => dispute.id)).catch(
    () => new Map<string, PrivateCalendarDisputeMessage[]>(),
  );
  return disputes.map((dispute) => ({ ...dispute, messages: byDispute.get(dispute.id) ?? [] }));
}

/** Every reply on one request, for the viewer who is allowed to read that one. */
export async function listPrivateCalendarDisputeMessages(
  access: AccessContext,
  disputeId: string,
): Promise<PrivateCalendarDisputeMessage[]> {
  await assertPermission(access, "attendance", "read");
  const dispute = await loadDispute(disputeId);
  resolveDisputeThreadActor({
    employeeHrId: dispute.employee_hr_id,
    hrId: viewerHrIdFor(access),
    role: access.role,
  });
  const byDispute = await listMessagesForDisputes([disputeId]);
  return byDispute.get(disputeId) ?? [];
}

/**
 * Post one reply and tell the other side.
 *
 * The notification goes through `notifyConversationMessage`, which is the system's single addressing
 * rule for every comment thread: the email is addressed To the person the thread belongs to — the
 * employee who raised the request — and CCs the sender and the rest of the thread, while in-app,
 * Telegram and push reach everyone except the author. So the Super Admin is told on Telegram when an
 * employee replies, and the employee is emailed when he does, without this module deciding any of it.
 */
export async function addPrivateCalendarDisputeMessage(
  access: AccessContext,
  input: { body: string; disputeId: string },
): Promise<PrivateCalendarDisputeMessage> {
  await assertPermission(access, "attendance", "read");
  const body = input.body.trim();
  if (!body) throw new Error("Write something before sending.");
  if (body.length > PRIVATE_CALENDAR_DISPUTE_MESSAGE_MAX_LENGTH) {
    throw new Error(`Keep a reply under ${PRIVATE_CALENDAR_DISPUTE_MESSAGE_MAX_LENGTH} characters.`);
  }

  const dispute = await loadDispute(input.disputeId);
  const actor = resolveDisputeThreadActor({
    employeeHrId: dispute.employee_hr_id,
    hrId: viewerHrIdFor(access),
    role: access.role,
  });

  const { data, error } = await getSupabaseAdmin()
    .from("private_calendar_dispute_messages")
    .insert({
      author_hr_id: hrIdForStorage(actor.hrId) ?? actor.hrId,
      author_is_admin: actor.isAdmin,
      body,
      dispute_id: dispute.id,
    })
    .select(MESSAGE_COLUMNS)
    .single();
  if (error) throw error;

  const nameByKey = await resolveAuthorNames([actor.hrId]);
  const authorName = nameByKey.get(canonicalHrIdKey(actor.hrId) ?? "") ?? null;
  const message = mapMessageRow(data as MessageRow, authorName);

  await writeAuditLog({
    actorLoginId: access.loginId ?? actor.hrId,
    entityId: dispute.id,
    entityType: "private_calendar_data_dispute",
    newValues: { messageId: message.id, replyFrom: actor.isAdmin ? "admin" : "employee" },
    summary: `Reply posted on the private calendar review request for ${dispute.dispute_date}`,
  });

  // Super Admins are in the thread because they are the side that reviews it; the employee owns it.
  const admins = await resolveSuperAdminRecipients().catch(() => []);
  await notifyConversationMessage({
    // The employee's landing page. The Super Admin's is the hub, resolved per role at read time by
    // notificationHrefForViewerRole from `roleHrefs` below, so one notification serves both sides.
    actionUrl: "/employee-portals/private-calendar",
    authorHrId: actor.hrId,
    authorName,
    body,
    eventType: "private_calendar_dispute_message",
    messageKey: message.id,
    metadata: {
      disputeDate: dispute.dispute_date,
      disputeId: dispute.id,
      roleHrefs: { "Super Admin": "/admin/approvals-hub?tab=disputes" },
    },
    module: "private_calendar",
    participantHrIds: [dispute.employee_hr_id, ...admins.map((admin) => admin.hrId)],
    recordId: dispute.id,
    subjectLabel: `review request for ${dispute.dispute_date}`,
    submitterHrId: dispute.employee_hr_id,
    threadLabel: "calendar",
  });

  return message;
}
