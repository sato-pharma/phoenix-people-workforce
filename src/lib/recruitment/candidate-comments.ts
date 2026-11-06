// Recruitment / ATS — what a manager said about a CV.
//
// The owner, 2026-08-30, asking for the National Sales Manager to be able to look at the CVs sitting
// with the managers below him: *"and can also give a comment on him. On the CV itself, I mean."*
//
// The comment is VISIBLE, not private. A note only its author can read helps nobody: the point of an
// NSM reading a CV that was pushed to one of his district managers is to tell that manager, and
// Talent Acquisition, what he thinks of the person. So a comment is shown to everyone who can
// already see the candidate — which is the manager it was pushed to, anyone above them in the org,
// and Talent Acquisition.
//
// Who may WRITE one is decided by the route, from hiring-manager-team.ts. Nothing in this file
// decides scope; it is the storage layer and it trusts its caller, exactly like every other service
// in this module.

import { systemAdministratorRoles } from "@/lib/auth/permissions";
import { canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import { activeAdministratorHrIds } from "@/lib/recruitment/candidate-comment-administrators";
import { adminCandidateHref, portalCandidatesHref } from "@/lib/recruitment/candidate-page-link";
import { chunkIds } from "@/lib/recruitment/db-batch";
import { recruitmentDb } from "@/lib/recruitment/db";
import { CANDIDATE_COMMENT_MAX_LENGTH, type CandidateComment } from "@/lib/recruitment/types";
import { notifyConversationMessage, resolveInAppOnlyAudience } from "@/lib/conversations/notify";
import { logError } from "@/lib/observability/log";
import { fetchAllRows } from "@/lib/supabase/paginated";

export { CANDIDATE_COMMENT_MAX_LENGTH } from "@/lib/recruitment/types";

function mapComment(row: Record<string, unknown>): CandidateComment {
  const text = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    const trimmed = String(value).trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  return {
    authorHrId: text(row.author_hr_id),
    authorJobTitle: text(row.author_job_title),
    authorName: text(row.author_name),
    body: String(row.body ?? ""),
    candidateId: String(row.candidate_id ?? ""),
    createdAt: String(row.created_at ?? ""),
    id: String(row.id ?? ""),
  };
}

/**
 * Every comment on one candidate, newest first.
 *
 * Returns an empty list rather than throwing when the table is not there yet (42703/42P01), because
 * this is read on a card that must keep rendering the CV itself. A missing comment list is a gap; a
 * card that fails to render is the manager losing the candidate.
 */
export async function listCandidateComments(candidateId: string): Promise<CandidateComment[]> {
  const { data, error } = await recruitmentDb()
    .from("ats_candidate_comments")
    .select("*")
    .eq("candidate_id", candidateId)
    .order("created_at", { ascending: false });
  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "42P01" || code === "42703") return [];
    throw error;
  }
  return ((data ?? []) as Array<Record<string, unknown>>).map(mapComment);
}

/**
 * Comment counts for a set of candidates, so a list can show "2 comments" without N reads.
 *
 * Batched through `chunkIds`: a PostgREST `.in()` carrying several hundred ids fails outright — the
 * values go in the request URL and undici caps headers around 16KB — and a card silently reading
 * "no comments" is exactly the failure this module cannot afford. The size lives in db-batch.ts with
 * the arithmetic behind it; this file spelled its own 50 and so ran twice the round trips for no
 * reason, 15 of them against a table holding 8 rows on the screening queue's whole-pool call.
 */
export async function countCommentsByCandidate(candidateIds: readonly string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const ids = Array.from(new Set(candidateIds.filter((id) => id.length > 0)));
  if (ids.length === 0) return counts;

  const supabase = recruitmentDb();
  for (const batch of chunkIds(ids)) {
    // Each batch paged to a short page by the unique `id`: a count read from a capped response would
    // under-report, and a card would read "no comments" over a thread somebody wrote.
    let data: Array<Record<string, unknown>>;
    try {
      data = await fetchAllRows<Record<string, unknown>>(
        () => supabase.from("ats_candidate_comments").select("candidate_id").in("candidate_id", batch),
        "id",
      );
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "42P01" || code === "42703") return counts;
      throw error;
    }
    for (const row of data) {
      const key = String(row.candidate_id ?? "");
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Comment counts AND the newest comment's timestamp, for a set of candidates.
 *
 * The timestamp is what lets the work-queue rail tell "sent to a manager and still waiting" from
 * "sent, and somebody answered" — see screening-workspace.ts. Counting alone cannot: a comment
 * written BEFORE the send is not an answer to it, and a pile that empties on any comment at all
 * would quietly lose the candidate it exists to chase.
 *
 * Batched through `chunkIds`, for the same reason the counter above is, and through the SAME helper
 * so the two cannot drift apart on the size.
 */
export async function summarizeCommentsByCandidate(
  candidateIds: readonly string[],
): Promise<Map<string, { count: number; latestAt: string | null }>> {
  const summary = new Map<string, { count: number; latestAt: string | null }>();
  const ids = Array.from(new Set(candidateIds.filter((id) => id.length > 0)));
  if (ids.length === 0) return summary;

  const supabase = recruitmentDb();
  for (const batch of chunkIds(ids)) {
    // Paged like the counter above: a newest-comment time read from a capped response could be stale.
    let data: Array<Record<string, unknown>>;
    try {
      data = await fetchAllRows<Record<string, unknown>>(
        () => supabase.from("ats_candidate_comments").select("candidate_id,created_at").in("candidate_id", batch),
        "id",
      );
    } catch (error) {
      const code = (error as { code?: string }).code;
      // Same fail-soft as the counter: a missing table is a gap in a side panel, never a reason for
      // the screening queue itself to fail to render.
      if (code === "42P01" || code === "42703") return summary;
      throw error;
    }
    for (const row of data) {
      const key = String(row.candidate_id ?? "");
      if (!key) continue;
      const at = String(row.created_at ?? "").trim() || null;
      const existing = summary.get(key) ?? { count: 0, latestAt: null };
      existing.count += 1;
      if (at && (!existing.latestAt || at > existing.latestAt)) existing.latestAt = at;
      summary.set(key, existing);
    }
  }
  return summary;
}

/**
 * Write one comment.
 *
 * The author's name and job title are stamped HERE, from what the caller resolved at request time,
 * and never joined at read time — HR_IDs are reused when a seat is refilled, so a later join would
 * eventually put one manager's words in their successor's mouth.
 */
export async function addCandidateComment(input: {
  authorHrId: string | null;
  authorJobTitle: string | null;
  authorName: string | null;
  body: string;
  candidateId: string;
}): Promise<CandidateComment> {
  const body = input.body.trim();
  if (!body) throw new Error("A comment cannot be empty.");
  if (body.length > CANDIDATE_COMMENT_MAX_LENGTH) {
    throw new Error(`Keep the comment under ${CANDIDATE_COMMENT_MAX_LENGTH} characters.`);
  }

  const { data, error } = await recruitmentDb()
    .from("ats_candidate_comments")
    .insert({
      author_hr_id: input.authorHrId,
      author_job_title: input.authorJobTitle,
      author_name: input.authorName,
      body,
      candidate_id: input.candidateId,
    })
    .select("*")
    .single();
  if (error) throw error;
  const comment = mapComment(data as Record<string, unknown>);
  await notifyCandidateComment({
    authorHrId: input.authorHrId,
    authorName: input.authorName,
    body,
    candidateId: input.candidateId,
    messageKey: comment.id,
  });
  return comment;
}

/**
 * The system administrators — the accounts a comment on a CV is copied to in the app.
 *
 * The owner's answer, 2026-09-19: the Super Admin, and not HR Advisory. `systemAdministratorRoles`
 * is the role list the rest of the app already names that account by.
 *
 * Fail-soft to an empty list, with its own log line: this copy is an addition to the thread's notice,
 * and a lookup that fails must not take the thread's own notice down with it.
 */
async function administratorHrIds(): Promise<string[]> {
  try {
    const { data, error } = await recruitmentDb()
      .from("app_auth_users")
      .select("hr_id,is_active")
      .in("role", [...systemAdministratorRoles]);
    if (error) throw error;
    return activeAdministratorHrIds((data ?? []) as Array<{ hr_id?: unknown; is_active?: unknown }>);
  } catch (error) {
    logError("Candidate comment could not resolve the administrator recipients", {
      labels: { event: "candidate_comment_administrators_failed" },
      error,
    });
    return [];
  }
}

/**
 * Tell the candidate's thread about a comment, and the Super Admin in the app.
 *
 * Until 2026-09-03 this table was written and NOBODY was told - eight comments in production, not
 * one notification, so a manager's opinion of an applicant sat unread unless somebody happened to
 * reopen the card. `manager_notified_hr_id` is the owner of the thread because it names the manager
 * the CV was actually pushed to; it is emphatically NOT the candidate (see the standing note that
 * every `manager_notified_*` column describes the manager, never the applicant's own answer), so
 * no applicant is ever mailed from here.
 *
 * The thread is emailed To the manager who owns it and CC the sender. The Super Admin is NOT on that
 * email — who receives an email is the owner's decision — but gets the same comment in the app
 * (owner, 2026-09-19: "I want the comments to come in in-app notifications"), unless they wrote the
 * comment themselves. That copy carries the candidate's admin page, because the thread's link is the
 * manager's own portal list.
 *
 * Best-effort: the comment row is already committed, and a delivery problem must not fail the write
 * that succeeded.
 */
async function notifyCandidateComment(input: {
  authorHrId: string | null;
  authorName: string | null;
  body: string;
  candidateId: string;
  /** The comment's own id — see `messageKey` on `ConversationNotificationInput`. Without it the
   *  second comment on a candidate collapses onto the first one's notification and is silently
   *  dropped, because the thread's title and action url never change between messages. */
  messageKey: string;
}): Promise<void> {
  try {
    const { data: candidateRow } = await recruitmentDb()
      .from("ats_candidates")
      .select("id,full_name,manager_notified_hr_id")
      .eq("id", input.candidateId)
      .maybeSingle();
    const candidate = candidateRow as { full_name?: string | null; manager_notified_hr_id?: string | null } | null;
    const ownerHrId = candidate?.manager_notified_hr_id ?? null;

    // Everyone who has already spoken in this thread, so a running conversation keeps its audience
    // instead of only ever reaching the manager.
    const { data: priorRows } = await recruitmentDb()
      .from("ats_candidate_comments")
      .select("author_hr_id")
      .eq("candidate_id", input.candidateId);
    const participantHrIds = ((priorRows ?? []) as Array<{ author_hr_id?: string | null }>)
      .map((row) => row.author_hr_id ?? null);

    // The administrators' in-app copy. A comment the administrator wrote themselves is not told back
    // to them: the author is taken out here, so the check below sees the audience that is really left.
    const administrators = resolveInAppOnlyAudience({
      addressed: [],
      authorHrId: input.authorHrId,
      hrIds: await administratorHrIds(),
    });

    // With no manager on the record there is no thread owner to address, and mailing the author
    // their own comment back is noise rather than a notification. The administrators' copy still
    // goes: a comment on a candidate nobody owns yet is the one they most need to see.
    if (!ownerHrId && participantHrIds.filter(Boolean).length <= 1 && administrators.length === 0) return;

    // The thread's link is the manager's own list, and it now names the candidate so that anybody
    // who opens it from the admin shell is sent on to that candidate (the portal page does that
    // hop). The administrators' copy skips the hop and points at the candidate's admin page directly.
    await notifyConversationMessage({
      actionUrl: portalCandidatesHref(input.candidateId),
      authorHrId: input.authorHrId,
      authorName: input.authorName,
      body: input.body,
      eventType: "candidate_comment",
      inAppOnly: { actionUrl: adminCandidateHref(input.candidateId), hrIds: administrators },
      messageKey: input.messageKey,
      metadata: { candidateId: input.candidateId },
      module: "recruitment",
      participantHrIds,
      recordId: input.candidateId,
      submitterHrId: ownerHrId,
      subjectLabel: String(candidate?.full_name ?? "").trim() || input.candidateId,
      threadLabel: "candidate",
    });
  } catch (error) {
    logError("Candidate comment failed to notify the thread", {
      labels: { event: "candidate_comment_notify_failed", candidateId: input.candidateId },
      error,
    });
  }
}

/**
 * The author's name and title, resolved once at write time.
 *
 * A targeted read rather than a roster load: this runs on the write path of a single comment, and
 * the whole roster is 179 rows it does not need. `hrIdLookupKeys` because HR_IDs are mixed case —
 * a plain equality match here would stamp an anonymous comment for anyone whose id is stored in a
 * different case from their session's, which reads on screen as a comment by nobody.
 *
 * Both halves may come back null. That is a recorded fact, not a failure: the comment still carries
 * the HR_ID, and the screen shows the id rather than inventing a name.
 */
export async function resolveCommentAuthor(
  hrId: string | null | undefined,
): Promise<{ name: string | null; jobTitle: string | null }> {
  const keys = hrIdLookupKeys(hrId);
  if (keys.length === 0) return { jobTitle: null, name: null };
  const { data, error } = await recruitmentDb()
    .from("employees")
    .select("full_name,job_title")
    .in("hr_id", keys)
    .limit(1);
  if (error) throw error;
  const row = ((data ?? []) as Array<Record<string, unknown>>)[0];
  if (!row) return { jobTitle: null, name: null };
  const text = (value: unknown): string | null => {
    const trimmed = String(value ?? "").trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  return { jobTitle: text(row.job_title), name: text(row.full_name) };
}

/**
 * Retract a comment — the author's own only.
 *
 * The correction path, and the reason this table is not append-only like its siblings. It is a
 * DELETE rather than an edit on purpose: a comment somebody has already read must not change text
 * under them, but a person must be able to take back something they said.
 *
 * The author check is done HERE rather than in the route, because it is a property of the record
 * and not of any one screen. `canonicalHrIdKey` on both sides — HR_IDs are mixed case, and a plain
 * comparison would refuse an author their own comment depending on how their id was typed.
 */
export async function deleteOwnCandidateComment(input: {
  authorHrId: string | null | undefined;
  commentId: string;
}): Promise<void> {
  const actor = canonicalHrIdKey(input.authorHrId);
  if (!actor) throw new Error("Forbidden: no HR_ID on this session.");

  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_candidate_comments")
    .select("id,author_hr_id")
    .eq("id", input.commentId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("That comment no longer exists.");
  if (canonicalHrIdKey(String((data as { author_hr_id?: unknown }).author_hr_id ?? "")) !== actor) {
    throw new Error("Forbidden: you can only delete your own comment.");
  }

  const { error: deleteError } = await supabase
    .from("ats_candidate_comments")
    .delete()
    .eq("id", input.commentId);
  if (deleteError) throw deleteError;
}
