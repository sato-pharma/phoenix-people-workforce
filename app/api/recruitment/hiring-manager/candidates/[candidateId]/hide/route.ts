import { NextResponse } from "next/server";

import { isCandidateSentToCaller } from "@/lib/recruitment/hiring-manager-view";
import { hideCandidateFromManager } from "@/lib/recruitment/manager-recall";
import {
  assertSameOriginMutation,
  recruitmentApiError,
  requireRecruitmentAccess,
} from "@/app/api/recruitment/_lib/http";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A manager hides a CV that reached him.
 *
 * The owner, 2026-10-16: "make district manager able to hide the CV if he received him." One press and
 * no reason: his hold on the CV ends (his send, the legacy stamp, and the `sent_to_manager` status when
 * nobody else holds it), so it leaves his folders, his "Sent to you" list and the hourly reminder.
 * Talent Acquisition keeps the CV and a re-push brings it back.
 *
 * Gated like the decision route (`hiring_interviews:update`, which a district manager holds) and
 * then on the CV having been sent to THIS caller. The manager is always the session's: there is no
 * body, so nobody can hide a CV from somebody else.
 */
export async function POST(request: Request, { params }: { params: Promise<{ candidateId: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "hiring_interviews", "update");
    const { candidateId } = await params;
    await assertCandidateVisible(access, candidateId);

    if (!(await isCandidateSentToCaller(access, candidateId))) {
      return NextResponse.json(
        { error: "forbidden", message: "That candidate was not sent to you.", success: false },
        { status: 403 },
      );
    }

    const result = await hideCandidateFromManager(access, candidateId);
    return NextResponse.json({ result, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to hide that candidate.");
  }
}
