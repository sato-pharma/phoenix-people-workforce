import { NextResponse } from "next/server";

import { canSeeAllRecruitment } from "@/lib/recruitment/access";
import { isCandidateWithinViewerTeam } from "@/lib/recruitment/hiring-manager-team";
import { fileCandidateForManager, unfileCandidateForManager } from "@/lib/recruitment/manager-folders";
import { managerFolderKinds } from "@/lib/recruitment/manager-folder-shelf";
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

/** Matches the folder-name ceiling on the recruiter's own route, so one screen cannot accept what the other refuses. */
const FOLDER_KEY_MAX_LENGTH = 120;

function validationError(message: string) {
  return NextResponse.json({ error: "validation", message, success: false }, { status: 400 });
}

/**
 * Whether this caller may file this candidate.
 *
 * The SAME question the comment route asks, and answered by the same function: a manager may act on
 * a CV pushed to them or to somebody beneath them in the org. Two copies of an org walk is how the
 * two screens end up disagreeing about who may touch what, so there is one.
 */
async function assertCanFile(access: Parameters<typeof isCandidateWithinViewerTeam>[0], candidateId: string) {
  if (canSeeAllRecruitment(access)) return;
  if (await isCandidateWithinViewerTeam(access, candidateId)) return;
  throw new Error("Forbidden: that candidate is not with you or with anyone reporting to you.");
}

/**
 * "Put this CV on my shelf" — PATCH with a kind and a key.
 *
 * WRITES TO THE MANAGER'S OWN TABLE, NEVER TO THE CANDIDATE ROW. The recruiter's identical-looking
 * route at /api/recruitment/candidates/[id]/folder updates ats_candidates and thereby removes the CV
 * from the pool every recruiter is working from. A District Manager tidying his inbox must not do
 * that, so this one writes ats_candidate_manager_folders and the recruitment team's screen does not
 * move at all.
 *
 * Gated on `hiring_interviews:update`, like the comment route and for the same reason:
 * `candidates:update` is hard-boundary-locked to Super Admin and Talent Acquisition and can never be
 * granted to a line manager, even by an override.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ candidateId: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "hiring_interviews", "update");
    const { candidateId } = await params;
    await assertCandidateVisible(access, candidateId);
    await assertCanFile(access, candidateId);

    const body = await readJsonObject(request);
    const kind = str(body.kind);
    if (!kind) return validationError("A folder kind is required.");
    // managerFolderKinds, NOT the recruiter's full vocabulary. "paramedical" is a shelf the
    // recruitment team files onto and a manager never sees, so accepting it here would write a
    // filing that hides the CV from his own list and appears on no shelf he can open. The picker
    // already omits it; this is the boundary that makes that true — hiding an option is UX only.
    if (!(managerFolderKinds as readonly string[]).includes(kind)) {
      return validationError(`"${kind}" is not a folder kind. Use one of: ${managerFolderKinds.join(", ")}.`);
    }

    const key = str(body.key);
    if (!key) return validationError("A folder needs a name.");
    if (key.length > FOLDER_KEY_MAX_LENGTH) {
      return validationError(`Keep the folder name under ${FOLDER_KEY_MAX_LENGTH} characters.`);
    }

    const filing = await fileCandidateForManager(access, candidateId, kind, key);
    return NextResponse.json({ filing, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to file this CV.");
  }
}

/**
 * "Put it back in my list."
 *
 * Succeeds on a CV that is already back — see unfileCandidateForManager. Only ever removes the
 * CALLER's own filing: the manager's HR_ID comes off the session and is never accepted from the
 * request, so there is no shape of this call that unfiles somebody else's shelf.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ candidateId: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "hiring_interviews", "update");
    const { candidateId } = await params;
    await assertCandidateVisible(access, candidateId);
    await assertCanFile(access, candidateId);

    await unfileCandidateForManager(access, candidateId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to return this CV to your list.");
  }
}
