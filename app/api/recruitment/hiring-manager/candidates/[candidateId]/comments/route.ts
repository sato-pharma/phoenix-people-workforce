import { NextResponse } from "next/server";

import { canSeeAllRecruitment } from "@/lib/recruitment/access";
import {
  addCandidateComment,
  CANDIDATE_COMMENT_MAX_LENGTH,
  listCandidateComments,
  resolveCommentAuthor,
} from "@/lib/recruitment/candidate-comments";
import {
  isCandidateInViewerTeamDistrict,
  isCandidateWithinViewerTeam,
} from "@/lib/recruitment/hiring-manager-team";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Whether this caller may read and write comments on this candidate.
 *
 * Three ways in, and they are the same three the rest of the module already recognises: Talent
 * Acquisition and Super Admin see every candidate, a manager sees a CV that was pushed to them or to
 * somebody beneath them in the org, and — since 2026-08-31 — a manager sees an applicant who asked
 * for one of his own areas.
 *
 * THE THIRD IS WHAT MAKES A DISTRICT FOLDER USABLE. Those CVs were pushed to nobody, so without it
 * every card in a folder would render a comment box that answers 403 on load. The permission itself
 * is unchanged: this is still `hiring_interviews`, and the scope is still the caller's own seats.
 *
 * ASKED FOR BOTH VERBS, not just the write. A comment is a manager's opinion of a named job
 * applicant, so reading one is exactly as sensitive as writing one — gating only the POST would put
 * every comment in the company behind a URL anybody with this permission could type.
 */
async function assertCanComment(access: Parameters<typeof isCandidateWithinViewerTeam>[0], candidateId: string) {
  if (canSeeAllRecruitment(access)) return;
  if (await isCandidateWithinViewerTeam(access, candidateId)) return;
  if (await isCandidateInViewerTeamDistrict(access, candidateId)) return;
  throw new Error(
    "Forbidden: that candidate is not with you, with anyone reporting to you, or in one of your areas.",
  );
}

export async function GET(request: Request, { params }: { params: Promise<{ candidateId: string }> }) {
  try {
    const access = await requireRecruitmentAccess(request, "hiring_interviews", "read");
    const { candidateId } = await params;
    await assertCandidateVisible(access, candidateId);
    await assertCanComment(access, candidateId);
    return NextResponse.json({ comments: await listCandidateComments(candidateId), success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load the comments on that candidate.");
  }
}

/**
 * Write one comment.
 *
 * Gated on `hiring_interviews:update` — the same permission the manager's own answer uses, and
 * deliberately not `candidates:update`, which is hard-boundary-locked to Super Admin and Talent
 * Acquisition and so can never be granted to a National Sales Manager even by an override.
 *
 * Commenting does NOT change the candidate's status, and must not start doing so. The manager the CV
 * was pushed to owns that decision; a comment from above is an opinion offered into it, and the two
 * being separate is what lets the history say which was which.
 */
export async function POST(request: Request, { params }: { params: Promise<{ candidateId: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "hiring_interviews", "update");
    const { candidateId } = await params;
    await assertCandidateVisible(access, candidateId);
    await assertCanComment(access, candidateId);

    const body = str((await readJsonObject(request)).body);
    if (!body) {
      return NextResponse.json(
        { error: "validation", message: "Write something before saving the comment.", success: false },
        { status: 400 },
      );
    }
    if (body.length > CANDIDATE_COMMENT_MAX_LENGTH) {
      return NextResponse.json(
        {
          error: "validation",
          message: `Keep the comment under ${CANDIDATE_COMMENT_MAX_LENGTH} characters.`,
          success: false,
        },
        { status: 400 },
      );
    }

    const author = await resolveCommentAuthor(access.hrId);
    const comment = await addCandidateComment({
      authorHrId: access.hrId,
      authorJobTitle: author.jobTitle,
      authorName: author.name,
      body,
      candidateId,
    });
    return NextResponse.json({ comment, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to save your comment.");
  }
}
