import { NextResponse } from "next/server";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";

import {
  addCandidateComment,
  CANDIDATE_COMMENT_MAX_LENGTH,
  listCandidateComments,
  resolveCommentAuthor,
} from "@/lib/recruitment/candidate-comments";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Recruiter notes on one candidate — the Notes tab of the screening workstation.
 *
 * ONE STORE, NOT A SECOND ONE. These are `ats_candidate_comments`, the same rows a hiring manager
 * writes through the hiring-manager route and the same rows the timeline reads. A separate
 * "recruiter notes" table would have split one conversation about one applicant across two places
 * that neither could see, which is precisely the shape this rebuild exists to remove — and it would
 * have made every existing note invisible on the new screen.
 *
 * SO A NOTE IS VISIBLE, not private, and the placeholder in the UI says so. The owner's rule when
 * he asked for manager comments was that a note only its author can read helps nobody.
 *
 * The gate differs by verb on purpose. Reading a note is reading the candidate (`candidates: read`,
 * the same grant that opens the CV). Writing one is acting on the pipeline (`recruitment: update`,
 * the same grant that sends a CV to a manager) — an audience that can look at a candidate is wider
 * than the one that should be able to add to their permanent record.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await requireRecruitmentAccess(request, "candidates", "read");
    const { id } = await params;
    await assertCandidateVisible(access, id);
    const notes = await listCandidateComments(id);
    return NextResponse.json({ notes, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load the notes on this candidate.");
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const { id } = await params;
    await assertCandidateVisible(access, id);

    const payload = await readJsonObject(request);
    const body = (str(payload.body) ?? "").trim();
    if (!body) {
      return NextResponse.json({ error: "Write something before saving the note.", success: false }, { status: 400 });
    }
    if (body.length > CANDIDATE_COMMENT_MAX_LENGTH) {
      return NextResponse.json(
        { error: `Keep the note under ${CANDIDATE_COMMENT_MAX_LENGTH} characters.`, success: false },
        { status: 400 },
      );
    }

    // The author's name and job title are stamped at WRITE time, never joined on render: HR_IDs are
    // reused when a seat is refilled, so a later join would eventually put one recruiter's words in
    // their successor's mouth. Same rule the manager route follows, for the same reason.
    const author = await resolveCommentAuthor(access.hrId).catch(() => ({ jobTitle: null, name: null }));
    const note = await addCandidateComment({
      authorHrId: access.hrId ?? null,
      authorJobTitle: author.jobTitle,
      authorName: author.name,
      body,
      candidateId: id,
    });

    return NextResponse.json({ note, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to save the note.");
  }
}
