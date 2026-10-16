import { NextResponse } from "next/server";

import { sendCandidateToManager } from "@/lib/recruitment/candidates";
import {
  assertSameOriginMutation,
  positionInput,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Send a candidate to a manager with no position attached.
 *
 * The sibling route under applications/[id] needs an application, an application needs a
 * requisition, and a requisition needs a job title, line, area, seat and owner. Measured in
 * production on 2026-08-15, that ceremony is why 214 of 221 candidates had never been shown to
 * anyone. This route is the short path: a candidate, a manager, done.
 *
 * The pickable managers are rendered from a server prop, so there is no GET twin here — but the
 * posted HR_ID is still re-validated against that same list inside sendCandidateToManager, because
 * anything arriving in a request body is user input however the form was drawn.
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
      return NextResponse.json({ error: "Choose the manager to send this candidate to.", success: false }, { status: 400 });
    }
    // The position rides along optionally. A body that names none still sends — see positionInput.
    // The folder on his shelf is optional too: left out, it is chosen from the position and the CV.
    const result = await sendCandidateToManager(access, id, managerHrId, positionInput(body), str(body.folderArea));
    return NextResponse.json({ result, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to send the candidate to that manager.");
  }
}
