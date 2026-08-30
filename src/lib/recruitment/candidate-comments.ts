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

import { canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import { recruitmentDb } from "@/lib/recruitment/db";
import { CANDIDATE_COMMENT_MAX_LENGTH, type CandidateComment } from "@/lib/recruitment/types";

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
 * Chunked at 50: a PostgREST `.in()` carrying several hundred ids returns zero rows and no error,
 * and a card silently reading "no comments" is exactly the failure this module cannot afford.
 */
export async function countCommentsByCandidate(candidateIds: readonly string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const ids = Array.from(new Set(candidateIds.filter((id) => id.length > 0)));
  if (ids.length === 0) return counts;

  const supabase = recruitmentDb();
  for (let index = 0; index < ids.length; index += 50) {
    const { data, error } = await supabase
      .from("ats_candidate_comments")
      .select("candidate_id")
      .in("candidate_id", ids.slice(index, index + 50));
    if (error) {
      const code = (error as { code?: string }).code;
      if (code === "42P01" || code === "42703") return counts;
      throw error;
    }
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const key = String(row.candidate_id ?? "");
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
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
  return mapComment(data as Record<string, unknown>);
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
