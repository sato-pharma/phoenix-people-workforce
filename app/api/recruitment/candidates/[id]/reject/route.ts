import { NextResponse } from "next/server";

import { isUuid } from "@/lib/http/uuid";
import { assertCandidateVisible, CANDIDATE_NOT_FOUND } from "@/lib/recruitment/workspace/fence";
import { assertWorkspaceWorker, rejectWithReason } from "@/lib/recruitment/workspace/candidate-actions";
import { rejectionRefusal } from "@/lib/recruitment/workspace/vocabulary";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  recruitmentProblem,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Reject one CV with a reason from the owner's fixed list (#24: "it makes rejections countable"), and
 * an optional note — required for "Other". Answers with what the CV was before, which is what the
 * screen's 10-second Undo hands to the existing revert-status route.
 *
 * The sorry message is NOT sent here and never automatically: the screen offers it, and sends it as
 * its own call (`/rejection-message`) only after the Undo window has passed.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "candidates", "update");
    assertWorkspaceWorker(access);
    const { id } = await params;
    if (!isUuid(id)) return recruitmentProblem(CANDIDATE_NOT_FOUND, 404);
    await assertCandidateVisible(access, id);

    const body = await readJsonObject(request);
    const reason = str(body.reason);
    const note = str(body.note);
    // Asked here as well as in the service so a missing reason is a 400 that names the problem.
    const refusal = rejectionRefusal(reason, note);
    if (refusal) return recruitmentProblem(refusal, 400);

    const { previous } = await rejectWithReason(access, id, reason, note);
    return NextResponse.json({ previous, status: "rejected", success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not reject this CV.");
  }
}
