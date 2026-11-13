// Unified Deductions module: comment thread on a published candidate (Phase 4).
// Mirrors deductions-governance/service.ts's listDeductionComments/addDeductionComment
// 1:1 — same self-only authorship rule, same "only after publication" gate,
// same audit-log call — just pointed at this module's own deductions_comments/
// deductions_candidates/deductions_publication_lines tables instead of the
// legacy singular-named ones.

import { writeAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { compactDeductionsHrId } from "./candidate-key.ts";
import { assertDeductionsDecisionActor, isDeductionsDecisionActor } from "./permissions.ts";
import { deductionOpenForDispute } from "./dispute-open.ts";
import type { CheckedDisputeImage } from "./comment-attachment-rules.ts";
import { attachCommentAttachments, discardDisputeComment, storeDisputeAttachments } from "./comment-attachments.ts";
import { loadTelegramReach, resolveDisputeAudience } from "./dispute-audience.ts";
import { picturesNotice, picturesOnlyBody, tidyDisputeText } from "@/lib/dispute-center/text.ts";
import type { DeductionDisputeDelivery, DeductionsComment } from "./types.ts";
import { namesByHrId } from "@/lib/employees/names-by-hr-id";
import { canonicalHrIdKey, hrIdForStorage } from "@/lib/hr-id";
import { notifyConversationMessage, notifyHrConversationMessage } from "@/lib/conversations/notify";
import { logError } from "@/lib/observability/log";

type CommentRow = {
  id: string;
  candidate_id: string;
  author_login_id: string;
  author_hr_id: string | null;
  author_role: string | null;
  body: string;
  created_at: string;
};

function mapCommentRow(row: CommentRow): DeductionsComment {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    authorLoginId: row.author_login_id,
    authorHrId: row.author_hr_id,
    authorRole: row.author_role,
    authorName: null,
    body: row.body,
    createdAt: row.created_at,
  };
}

/**
 * Fill in each comment's authorName from the employees table. A deduction dispute is now a two-way
 * conversation — the employee on one side, the HR person who replies on the other — so every line
 * has to say who wrote it, by display name (owner, 2026-11-03) and never by HR id (the owner's
 * standing rule). Best-effort: an unresolved id leaves authorName null and the row still renders.
 */
async function attachAuthorNames(comments: DeductionsComment[]): Promise<DeductionsComment[]> {
  const ids = Array.from(new Set(comments.map((comment) => comment.authorHrId).filter((id): id is string => Boolean(id))));
  if (ids.length === 0) return comments;
  const names = await namesByHrId(ids);
  return comments.map((comment) => ({ ...comment, authorName: names.get(comment.authorHrId) }));
}

export async function listDeductionsComments(input: {
  candidateIds: string[];
}): Promise<DeductionsComment[]> {
  if (input.candidateIds.length === 0) return [];
  const rows: CommentRow[] = [];
  for (let i = 0; i < input.candidateIds.length; i += 100) {
    const batch = input.candidateIds.slice(i, i + 100);
    const { data, error } = await getSupabaseAdmin()
      .from("deductions_comments")
      .select("id, candidate_id, author_login_id, author_hr_id, author_role, body, created_at")
      .in("candidate_id", batch)
      .order("created_at", { ascending: false });
    if (error) throw error;
    rows.push(...((data ?? []) as CommentRow[]));
  }
  rows.sort((left, right) => String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")));
  return attachCommentAttachments(await attachAuthorNames(rows.map(mapCommentRow)));
}

/**
 * Every deduction comment in the system, newest first, for the admin dispute inbox.
 *
 * Self-only authorship (assertEmployeeCanCommentOnCandidate) means every row here was
 * written by the employee it belongs to — this is the company-wide read of those, and the
 * route that calls it is gated on assertDeductionsReadActor, so it is never reached by a
 * self-only viewer. With no `limit` this is the WHOLE history, read page by page (a single read is
 * cut at 1,000 rows by the API, and the oldest comments would disappear without a word); a caller
 * that passes a `limit` asks for just the newest that many.
 */
export async function listRecentDeductionsComments(input?: {
  limit?: number;
}): Promise<DeductionsComment[]> {
  const columns = "id, candidate_id, author_login_id, author_hr_id, author_role, body, created_at";
  const requested = input?.limit;
  let rows: CommentRow[];
  if (requested === undefined || !Number.isFinite(requested)) {
    rows = await fetchAllRows<CommentRow>(
      () =>
        getSupabaseAdmin()
          .from("deductions_comments")
          .select(columns)
          .order("created_at", { ascending: false }),
      "id",
    );
  } else {
    const limit = Math.max(Math.trunc(requested), 1);
    const { data, error } = await getSupabaseAdmin()
      .from("deductions_comments")
      .select(columns)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    rows = (data ?? []) as CommentRow[];
  }
  return attachCommentAttachments(await attachAuthorNames(rows.map(mapCommentRow)));
}

/** Returns the candidate's employee_hr_id_compact, or throws if this candidateId
 * doesn't belong to this module at all (the caller falls back to the legacy path). */
export async function findDeductionsCandidateOwner(candidateId: string): Promise<string | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("deductions_candidates")
    .select("employee_hr_id_compact")
    .eq("id", candidateId)
    .maybeSingle();
  if (error) throw error;
  return (data as { employee_hr_id_compact: string } | null)?.employee_hr_id_compact ?? null;
}

/**
 * A comment — from either side — is allowed on any deduction the employee can see, EXCEPT one already
 * cleared (owner, 2026-11-13: "make the employee able to dispute in the deduction module"). Until then
 * only a line pushed to the payslip could be argued with, so a deduction approved but not yet pushed —
 * which payroll charges all the same — and one still waiting for HR could not be disputed at all.
 * A published line always keeps its conversation, whatever its decision says now
 * (`deductionOpenForDispute`, dispute-open.ts).
 */
async function assertCandidateOpenForDispute(candidateId: string) {
  const supabase = getSupabaseAdmin();
  const [lineResult, candidateResult, decisionResult] = await Promise.all([
    supabase
      .from("deductions_publication_lines")
      .select("id, publication_id, deductions_publications!inner(status)")
      .eq("candidate_id", candidateId)
      .eq("deductions_publications.status", "published")
      .limit(1),
    supabase.from("deductions_candidates").select("id, superseded_at").eq("id", candidateId).maybeSingle(),
    supabase.from("deductions_decisions").select("decision_status").eq("candidate_id", candidateId).maybeSingle(),
  ]);
  if (lineResult.error) throw lineResult.error;
  if (candidateResult.error) throw candidateResult.error;
  if (decisionResult.error) throw decisionResult.error;
  const hasPublishedLine = Array.isArray(lineResult.data) && lineResult.data.length > 0;
  const candidate = candidateResult.data as { id: string; superseded_at: string | null } | null;
  if (!hasPublishedLine && (!candidate || candidate.superseded_at)) {
    throw new Error("This deduction was replaced by a newer one, so it cannot be disputed. Dispute the current one.");
  }
  const decisionStatus = (decisionResult.data as { decision_status: string | null } | null)?.decision_status ?? null;
  if (!deductionOpenForDispute({ decisionStatus, hasPublishedLine })) {
    throw new Error("Nothing is deducted for this one, so there is nothing to dispute.");
  }
}

async function assertEmployeeCanCommentOnCandidate(access: AccessContext, candidateId: string) {
  const ownerCompactHrId = await findDeductionsCandidateOwner(candidateId);
  if (!ownerCompactHrId) throw new Error("Deduction candidate not found.");
  const actorHr = compactDeductionsHrId(access.hrId ?? access.loginId);
  if (!actorHr || actorHr !== ownerCompactHrId) {
    throw new Error("Forbidden: employees can dispute only their own deductions.");
  }
  await assertCandidateOpenForDispute(candidateId);
}

export async function addDeductionsComment(input: {
  access: AccessContext;
  body: string;
  candidateId: string;
  /** Pictures the employee attached — owner, 2026-10-09: "upload a picture in both". */
  images?: CheckedDisputeImage[];
}): Promise<DeductionsComment> {
  await assertEmployeeCanCommentOnCandidate(input.access, input.candidateId);
  const images = input.images ?? [];
  // Line breaks are KEPT since 2026-10-09 (they were collapsed into one line before): a dispute is
  // usually a list of times and places, and flattening it is what made one unreadable.
  let body = tidyDisputeText(input.body);
  if (!body && images.length === 0) throw new Error("Comment is required.");
  if (!body) body = picturesOnlyBody(images.length);
  if (body.length > 2000) throw new Error("Comment cannot exceed 2000 characters.");
  const payload = {
    author_hr_id: hrIdForStorage(input.access.hrId),
    author_login_id: input.access.loginId ?? input.access.hrId ?? "employee",
    author_role: input.access.role,
    body,
    candidate_id: input.candidateId,
  };
  const { data, error } = await getSupabaseAdmin()
    .from("deductions_comments")
    .insert(payload)
    .select("id, candidate_id, author_login_id, author_hr_id, author_role, body, created_at")
    .single();
  if (error) throw error;

  await writeAuditLog({
    actorLoginId: payload.author_login_id,
    entityId: input.candidateId,
    entityType: "deductions_comment",
    newValues: { bodyLength: body.length, pictureCount: images.length },
    summary: "Employee dispute comment added to a deduction (unified module).",
  });

  const row = data as CommentRow;
  // The same order as the reply path: the pictures hang off the comment's id, and a comment whose
  // pictures could not be stored is removed again rather than reaching HR as half a message.
  let attachments: Awaited<ReturnType<typeof storeDisputeAttachments>> = [];
  if (images.length > 0) {
    try {
      attachments = await storeDisputeAttachments({ candidateId: input.candidateId, commentId: row.id, images });
    } catch (storeError) {
      await discardDisputeComment(row.id);
      throw storeError;
    }
  }

  await notifyDeductionsComment({
    authorHrId: input.access.hrId ?? null,
    body,
    candidateId: input.candidateId,
    messageKey: row.id,
    pictureCount: attachments.length,
  });

  return { ...mapCommentRow(row), attachments };
}

/**
 * An HR / admin reply on a published deduction — the other side of the conversation.
 *
 * The thread began one-sided (only the employee could write, and HR read the email), but the owner
 * asked for a reply box "to open conversation" (2026-10-06). So this is the admin's write path:
 * same table, same "only after publication" gate, but the author is an admin and the message is
 * sent TO the employee (their portal), opening a two-way thread. Super Admin ONLY — the owner's
 * decision, 2026-10-06 ("keep replies super-admin only"): CEO and HR Operations read the dispute
 * but cannot answer it, the same actor that decides and publishes a deduction.
 *
 * A reply may carry up to four pictures (owner, 2026-10-08), already checked by checkDisputeImage —
 * the route does that BEFORE this runs, so a bad file never leaves a half-written reply. A reply of
 * pictures alone is allowed: the text then reads "Picture attached.", because the row's body cannot be blank.
 */
export async function addDeductionsReply(input: {
  access: AccessContext;
  body: string;
  candidateId: string;
  images?: CheckedDisputeImage[];
}): Promise<{ comment: DeductionsComment; delivery: DeductionDisputeDelivery | null }> {
  assertDeductionsDecisionActor(input.access);
  const ownerCompactHrId = await findDeductionsCandidateOwner(input.candidateId);
  if (!ownerCompactHrId) throw new Error("Deduction candidate not found.");
  await assertCandidateOpenForDispute(input.candidateId);

  const images = input.images ?? [];
  let body = tidyDisputeText(input.body);
  if (!body && images.length === 0) throw new Error("Reply is required.");
  if (!body) body = picturesOnlyBody(images.length);
  if (body.length > 2000) throw new Error("Reply cannot exceed 2000 characters.");

  const payload = {
    author_hr_id: hrIdForStorage(input.access.hrId),
    author_login_id: input.access.loginId ?? input.access.hrId ?? "admin",
    author_role: input.access.role,
    body,
    candidate_id: input.candidateId,
  };
  const { data, error } = await getSupabaseAdmin()
    .from("deductions_comments")
    .insert(payload)
    .select("id, candidate_id, author_login_id, author_hr_id, author_role, body, created_at")
    .single();
  if (error) throw error;

  await writeAuditLog({
    actorLoginId: payload.author_login_id,
    entityId: input.candidateId,
    entityType: "deductions_comment",
    newValues: { bodyLength: body.length, pictureCount: images.length, reply: true },
    summary: "HR reply added to a published deduction dispute (unified module).",
  });

  const row = data as CommentRow;
  // The pictures are stored AFTER the reply row exists (they hang off its id). If they cannot be
  // stored the reply is removed again, so the employee is never shown half a message and is never
  // notified of one.
  let attachments: Awaited<ReturnType<typeof storeDisputeAttachments>> = [];
  if (images.length > 0) {
    try {
      attachments = await storeDisputeAttachments({ candidateId: input.candidateId, commentId: row.id, images });
    } catch (storeError) {
      await discardDisputeComment(row.id);
      throw storeError;
    }
  }

  const delivery = await notifyDeductionsReply({
    authorHrId: input.access.hrId ?? null,
    body,
    candidateId: input.candidateId,
    messageKey: row.id,
    pictureCount: attachments.length,
  });

  const [comment] = await attachAuthorNames([mapCommentRow(row)]);
  return { comment: { ...comment, attachments }, delivery };
}

/**
 * Deliver an HR reply TO the employee whose deduction it is — the counterpart to
 * notifyDeductionsComment, which runs the other direction. To = the employee (submitter), CC = the
 * HR author AND the employee's managers (the direct manager and the one above — owner, 2026-10-08:
 * "CC their managers, in the email, Telegram, in-app"), landing on the employee's own portal
 * deductions page. The managers are `participantHrIds`, so each gets their own in-app, Telegram
 * and push notice and rides the employee's email on its cc line.
 *
 * Returns who it addressed and whether Telegram can reach each of them, so the Disputes inbox can
 * show the sender what their reply did instead of a bare "sent". Best-effort: the reply row is
 * already committed, so a delivery failure is logged and swallowed (returned as null), never thrown.
 */
async function notifyDeductionsReply(input: {
  authorHrId: string | null;
  body: string;
  candidateId: string;
  messageKey: string;
  /** How many pictures rode with the reply — the message says so, because an email and a Telegram
   *  line cannot show them and the employee must know to open the portal. */
  pictureCount?: number;
}): Promise<DeductionDisputeDelivery | null> {
  try {
    // The employee and their name come from the active published line — the same row the portal
    // shows them, so the notification names the person the deduction belongs to, not an HR id.
    const { data: lineRow } = await getSupabaseAdmin()
      .from("deductions_publication_lines")
      .select("employee_hr_id, employee_name")
      .eq("candidate_id", input.candidateId)
      .eq("line_status", "active")
      .limit(1)
      .maybeSingle();
    const employeeHrId = (lineRow as { employee_hr_id?: string | null } | null)?.employee_hr_id ?? null;
    const storedEmployeeName = String((lineRow as { employee_name?: string | null } | null)?.employee_name ?? "").trim() || null;
    if (!employeeHrId) {
      logError("Deductions reply has no published line to address", {
        labels: { event: "deductions_reply_no_line", candidateId: input.candidateId },
      });
      return null;
    }

    const pictureCount = input.pictureCount ?? 0;
    const audience = await resolveDisputeAudience(employeeHrId);
    const managerHrIds = audience.managers.map((manager) => manager.hrId);

    // Display names on the message (owner, 2026-11-03); the line's own column stays as stamped.
    const names = await namesByHrId([input.authorHrId, employeeHrId]);
    const authorName = names.get(input.authorHrId);
    const employeeName = names.get(employeeHrId) ?? storedEmployeeName;

    await notifyConversationMessage({
      // The employee's OWN portal deductions page — where their published deductions and this
      // thread live. (The HR side lands on /admin/deductions?tab=disputes; this is its mirror.)
      actionUrl: "/employee-portals/deductions",
      authorHrId: input.authorHrId,
      authorName,
      body: pictureCount > 0 ? `${input.body}\n\n${picturesNotice(pictureCount)}` : input.body,
      eventType: "deductions_comment",
      // Per-message key, so a second reply on one deduction is its own notification rather than
      // collapsing onto the first — the same reason the employee→HR path carries one.
      messageKey: input.messageKey,
      metadata: { candidateId: input.candidateId, pictureCount, reply: true },
      module: "deductions",
      participantHrIds: [employeeHrId, input.authorHrId, ...managerHrIds].filter((id): id is string => Boolean(id)),
      recordId: input.candidateId,
      submitterHrId: employeeHrId,
      subjectLabel: employeeName ?? "your deduction",
      threadLabel: "published deduction for",
    });

    // What the sender is shown afterwards. Built from the same audience the send used, plus the
    // one thing the send cannot promise: whether Telegram can reach each person.
    const reach = await loadTelegramReach([employeeHrId, input.authorHrId, ...managerHrIds]);
    const linked = (hrId: string | null | undefined) => {
      const key = canonicalHrIdKey(hrId);
      return key ? reach.get(key) === true : false;
    };
    const cc: DeductionDisputeDelivery["cc"] = audience.managers.map((manager) => ({
      name: manager.name,
      relation: "manager",
      telegramLinked: linked(manager.hrId),
      title: manager.title,
    }));
    if (authorName) {
      cc.push({ name: authorName, relation: "sender", telegramLinked: linked(input.authorHrId), title: null });
    }
    return {
      cc,
      to: {
        name: audience.employee?.name ?? employeeName ?? "the employee",
        telegramLinked: linked(employeeHrId),
        title: audience.employee?.title ?? null,
      },
    };
  } catch (error) {
    logError("Deductions reply failed to notify the employee", {
      labels: { event: "deductions_reply_notify_failed", candidateId: input.candidateId },
      error,
    });
    return null;
  }
}

/**
 * Send an employee's comment on their own published deduction to HR.
 *
 * "HR gets the deductions comment" - the owner's answer on 2026-09-03, asked before any recipient
 * was wired because this thread could not answer the question itself. It is the one conversation in
 * the system with only ONE side: assertEmployeeCanCommentOnCandidate means the employee is the only
 * person who can ever write here, so the row names no counterparty. Until now nothing was sent at
 * all - somebody disputing a deduction wrote into a table nobody was watching.
 *
 * Best-effort: the comment row is already committed and a delivery failure must not undo it.
 */
async function notifyDeductionsComment(input: {
  authorHrId: string | null;
  body: string;
  candidateId: string;
  /** How many pictures rode with the comment — an email cannot show them. */
  pictureCount?: number;
  /** The comment's own id — see `messageKey` on `ConversationNotificationInput`. Without it a
   *  second comment on the same published deduction collapses onto the first one's notification
   *  and HR is never told, because the thread's title and action url never change between messages. */
  messageKey: string;
}): Promise<void> {
  try {
    // The employee's NAME, never their HR id: the owner's standing rule is that a human-readable
    // name is shown everywhere, in the UI and in a message alike — the display name (2026-11-03).
    const authorName = (await namesByHrId([input.authorHrId])).get(input.authorHrId);

    await notifyHrConversationMessage({
      // The admin screen's Disputes tab, deep-linked to the exact candidate — NOT the portal page,
      // which shows the VIEWER's own deductions and is the wrong record for an HR reader.
      //
      // This URL used to be a bare "/admin/deductions", which landed the reader on the collection
      // workspace for the CURRENT month with no comment anywhere on it — a dispute on any earlier
      // month was unreachable in-app, and the owner reported exactly that ("I receive a comment on
      // a deduction and I can never reach it"). The Disputes tab now lists every published-deduction
      // comment, month-independent, and `?tab=disputes&candidate=<id>` opens it on this one and
      // scrolls it into view. The EMAIL still carries the comment in full as the fallback.
      actionUrl: `/admin/deductions?tab=disputes&candidate=${encodeURIComponent(input.candidateId)}`,
      authorHrId: input.authorHrId,
      authorName,
      body: (input.pictureCount ?? 0) > 0 ? `${input.body}\n\n${picturesNotice(input.pictureCount ?? 0)}` : input.body,
      eventType: "deductions_comment",
      messageKey: input.messageKey,
      metadata: { candidateId: input.candidateId, pictureCount: input.pictureCount ?? 0 },
      module: "deductions",
      recordId: input.candidateId,
      subjectLabel: authorName ?? "an employee",
      threadLabel: "published deduction for",
    });
  } catch (error) {
    logError("Deductions comment failed to notify HR", {
      labels: { event: "deductions_comment_notify_failed", candidateId: input.candidateId },
      error,
    });
  }
}

/**
 * HOW MANY DISPUTES ARE WAITING ON HR — the Deduction Disputes sidebar badge.
 *
 * A dispute is a two-way thread (`addDeductionsReply`), so "open" cannot mean "has comments": a
 * thread HR already answered is closed work, and a badge that kept counting it would never clear
 * and would teach the reader to ignore it. What is waiting is a thread whose NEWEST line came from
 * the employee's side — nobody has answered since.
 *
 * "The employee's side" is read off `author_role` rather than by matching the author against the
 * candidate's owner, and that is the cheaper AND the more honest test. A reply is Super Admin only
 * (`isDeductionsDecisionActor`, the owner's 2026-10-06 decision), so any other role on the newest
 * line means the employee spoke last. It also stays correct for the one odd case a hr-id comparison
 * gets wrong: the owner is himself B-10, and a thread where HE spoke last IS answered, whichever
 * side of it he was writing from.
 *
 * ONE read, no hydration. The inbox read (`listPublishedDeductionCommentThreads`) also loads every
 * publication line and resolves every author's name, which is right for a screen and far too much
 * for a number polled every 30 seconds. It reads the whole history page by page: a single read is
 * cut at 1,000 rows, and a thread whose newest line sat past that would be judged by an older one.
 *
 * Deliberately NOT gated in here. Every other badge domain in /api/approvals/badge-counts asserts
 * at its own door and settles at 0 for a role that cannot see it; this one's door is
 * assertDeductionsReadActor on the route.
 */
export async function countOpenDeductionsDisputes(): Promise<number> {
  // `id` descending too, so two lines written in the same instant still arrive newest first.
  const data = await fetchAllRows<{ author_role?: string | null; candidate_id?: string | null }>(
    () =>
      getSupabaseAdmin()
        .from("deductions_comments")
        .select("candidate_id, author_role, created_at")
        .order("created_at", { ascending: false })
        .order("id", { ascending: false }),
    "id",
  );

  const newestByCandidate = new Map<string, string | null>();
  for (const row of data) {
    const candidateId = String(row.candidate_id ?? "");
    // Rows arrive newest first, so the FIRST sighting of a candidate is its newest line.
    if (!candidateId || newestByCandidate.has(candidateId)) continue;
    newestByCandidate.set(candidateId, row.author_role ?? null);
  }

  const awaitingHr: string[] = [];
  for (const [candidateId, authorRole] of newestByCandidate) {
    // `?? ""` rather than a cast straight off `string | null`: a null does not overlap a role
    // union, so `as` on the nullable type is a type error, and an empty string is simply not a
    // decision actor — which is the right answer for a row whose author_role never got written.
    if (!isDeductionsDecisionActor({ role: (authorRole ?? "") as AccessContext["role"] })) awaitingHr.push(candidateId);
  }
  if (awaitingHr.length === 0) return 0;

  // Only a deduction still ACTIVE on the payslip is a dispute (owner, 2026-10-08): one set to
  // "Do Not Take Action" has its line withdrawn, deducts nothing, and is not listed in the tab, so
  // it must not hold the badge up either. The same filter as loadPublishedLinesByCandidate.
  let waiting = 0;
  for (let i = 0; i < awaitingHr.length; i += 100) {
    const { data: lines, error: linesError } = await getSupabaseAdmin()
      .from("deductions_publication_lines")
      .select("candidate_id")
      .in("candidate_id", awaitingHr.slice(i, i + 100))
      .eq("line_status", "active");
    if (linesError) throw linesError;
    waiting += new Set((lines ?? []).map((line: { candidate_id: string }) => line.candidate_id)).size;
  }
  return waiting;
}
