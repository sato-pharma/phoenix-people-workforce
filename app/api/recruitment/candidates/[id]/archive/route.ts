import { NextResponse } from "next/server";

import { isUuid } from "@/lib/http/uuid";
import { assertCandidateVisible, CANDIDATE_NOT_FOUND } from "@/lib/recruitment/workspace/fence";
import { assertWorkspaceWorker, setCandidateArchived } from "@/lib/recruitment/workspace/candidate-actions";
import {
  assertSameOriginMutation,
  recruitmentApiError,
  recruitmentProblem,
  requireRecruitmentAccess,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST moves a CV to the archive — out of every tab, still kept and found by search and by the
 * "Archived" filter; DELETE brings it back. Rejections also move there on their own after 30 days
 * (archive.ts); this is the same state, set by hand. Nothing is deleted either way.
 */
async function handle(request: Request, params: Promise<{ id: string }>, archived: boolean) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "candidates", "update");
    assertWorkspaceWorker(access);
    const { id } = await params;
    if (!isUuid(id)) return recruitmentProblem(CANDIDATE_NOT_FOUND, 404);
    await assertCandidateVisible(access, id);

    const result = await setCandidateArchived(access, id, archived);
    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    return recruitmentApiError(error, archived ? "Could not archive this CV." : "Could not bring this CV back.");
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(request, params, true);
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(request, params, false);
}
