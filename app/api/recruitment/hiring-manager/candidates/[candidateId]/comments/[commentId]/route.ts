import { NextResponse } from "next/server";

import { deleteOwnCandidateComment } from "@/lib/recruitment/candidate-comments";
import {
  assertSameOriginMutation,
  recruitmentApiError,
  requireRecruitmentAccess,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Retract your own comment.
 *
 * The correction path, and the reason ats_candidate_comments is not append-only like its siblings:
 * this codebase already carries one human judgement written with no way to fix it — a marketing
 * licence verdict is write-once at approval and is then displayed, wrong, on a register forever.
 *
 * Deleting rather than editing is the deliberate half. A comment somebody has already read must not
 * change its words underneath them; taking it back is a different act and leaves nothing misleading
 * behind. The author check lives in the service, because it is a property of the record — not of
 * this screen — and no other caller can forget to make it.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ commentId: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "hiring_interviews", "update");
    const { commentId } = await params;
    await deleteOwnCandidateComment({ authorHrId: access.hrId, commentId });
    return NextResponse.json({ success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to delete that comment.");
  }
}
