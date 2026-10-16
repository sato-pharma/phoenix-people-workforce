import { NextResponse } from "next/server";

import { sendCandidatesToManager } from "@/lib/recruitment/candidates";
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
 * Send SEVERAL candidates to one manager in a single message.
 *
 * Sibling of candidates/[id]/notify-manager, which stays for the one-candidate case on the profile
 * screen; both delegate to the same service, so the two can never drift. The manager receives ONE
 * notification naming everyone in it rather than one alert per person — at 152 CVs a week, mostly
 * to the same District Sales Managers, per-candidate alerts are how a useful signal gets muted.
 *
 * The posted HR_ID is re-validated against the real manager list inside the service: the dropdown
 * is drawn from a server prop, but anything arriving in a request body is user input regardless.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const body = await readJsonObject(request);

    const managerHrId = str(body.managerHrId);
    if (!managerHrId) {
      return NextResponse.json(
        { error: "validation", message: "Choose the manager to send these candidates to.", success: false },
        { status: 400 },
      );
    }

    const raw = Array.isArray(body.candidateIds) ? body.candidateIds : [];
    const candidateIds = raw.map((value) => str(value)).filter((value): value is string => Boolean(value));
    if (candidateIds.length === 0) {
      return NextResponse.json(
        { error: "validation", message: "Choose at least one candidate to send.", success: false },
        { status: 400 },
      );
    }

    // The position rides along optionally. A body that names none still sends — see positionInput.
    // The folder on his shelf is optional too: left out, it is chosen from the position and the CV.
    const result = await sendCandidatesToManager(access, candidateIds, managerHrId, positionInput(body), str(body.folderArea));
    return NextResponse.json({ result, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to send those candidates to that manager.");
  }
}
