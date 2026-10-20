import { NextResponse } from "next/server";

import { isUuid } from "@/lib/http/uuid";
import { assertCandidateVisible, CANDIDATE_NOT_FOUND } from "@/lib/recruitment/workspace/fence";
import {
  assertWorkspaceWorker,
  placeCandidate,
  placementTabRefusal,
  unplaceCandidate,
} from "@/lib/recruitment/workspace/candidate-actions";
import { isWorkspaceRoleTab } from "@/lib/recruitment/workspace/role-tabs";
import {
  assertSameOriginMutation,
  bool,
  readJsonObject,
  recruitmentApiError,
  recruitmentProblem,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * HR files a CV in a role tab — with its region, and for a Medical Rep its area — or takes it out of
 * one (`remove: true`). Answers with every tab the person is now filed in.
 *
 * `candidates: update`, the grant hard-locked to the Super Admin and Talent Acquisition, plus the
 * workspace's own work gate (the CEO reads, never files). A tab the viewer does not see is a 403: the
 * Talent Acquisition seat filing someone into an HR tab would hide that person from her own queue.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "candidates", "update");
    const viewer = assertWorkspaceWorker(access);
    const { id } = await params;
    if (!isUuid(id)) return recruitmentProblem(CANDIDATE_NOT_FOUND, 404);
    await assertCandidateVisible(access, id);

    const body = await readJsonObject(request);
    const roleTab = str(body.roleTab);
    if (!roleTab) return recruitmentProblem("Choose the tab.", 400);
    if (!isWorkspaceRoleTab(roleTab)) return recruitmentProblem("Choose one of the role tabs.", 400);
    const refusal = placementTabRefusal(viewer, roleTab);
    if (refusal) return recruitmentProblem(refusal, 403);

    const placements =
      bool(body.remove) === true
        ? await unplaceCandidate(access, id, roleTab)
        : await placeCandidate(access, id, { areaCode: str(body.areaCode), regionCode: str(body.regionCode), roleTab });
    return NextResponse.json({ placements, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not file this CV.");
  }
}
