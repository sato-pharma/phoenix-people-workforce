import { NextResponse } from "next/server";

import { listCandidatesSentToManager } from "@/lib/recruitment/candidates";
import { recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The CVs a recruiter sent straight to the caller — no requisition, no application, no seat.
 *
 * Gated on the narrow `hiring_interviews` resource, like every route in this folder: `recruitment`
 * and `candidates` are hard-boundary-locked to Super Admin / Talent Acquisition and can never be
 * granted to a District Manager, which is exactly why this parallel resource exists.
 *
 * The scope is the caller's own HR_ID and nothing else — it is read from the session, never from the
 * query string, so there is no id to guess and no way to ask for somebody else's pushes.
 */
export async function GET(request: Request) {
  try {
    const access = await requireRecruitmentAccess(request, "hiring_interviews", "read");
    const candidates = await listCandidatesSentToManager(access.hrId);
    return NextResponse.json({ candidates, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load the candidates sent to you.");
  }
}
