import { NextResponse } from "next/server";

import { recallCandidateFromManager } from "@/lib/recruitment/manager-recall";
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
 * Take a CV back out of one manager's folders.
 *
 * The owner, 2026-10-16: Talent Acquisition pushes a CV "whenever needed and can any time get it
 * back". Gated exactly like sending it (`recruitment:update`), so whoever may put a CV in a folder
 * may take it out, and nobody else can. The posted manager is re-checked against the real send
 * trail inside the service: a CV that manager does not hold is refused, not reported as recalled.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const { id } = await params;
    const body = await readJsonObject(request);
    const managerHrId = str(body.managerHrId) ?? "";
    if (!managerHrId) {
      return NextResponse.json({ error: "Choose the manager to take this CV back from.", success: false }, { status: 400 });
    }
    const result = await recallCandidateFromManager(access, { candidateId: id, managerHrId });
    return NextResponse.json({ result, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to take the CV back from that manager.");
  }
}
