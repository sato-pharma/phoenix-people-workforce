import { NextResponse } from "next/server";

import { loadCallClaims } from "@/lib/recruitment/candidate-call-claims-db";
import { listCandidatesSentToManager } from "@/lib/recruitment/candidates";
import { recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";
import { fenceRowsByCandidate } from "@/lib/recruitment/workspace/fence";

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
 *
 * NOTHING IS REDACTED (owner, 2026-10-16: once a CV reaches a manager there is "no any restriction —
 * can download, can see number, can do anything"). The phone number was withheld here until the manager
 * pressed "I will call"; a CV pushed to the caller now arrives complete. The claims still travel so a
 * screen can show a reservation somebody else made.
 */
export async function GET(request: Request) {
  try {
    const access = await requireRecruitmentAccess(request, "hiring_interviews", "read");
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant pushed to her does not arrive.
    const candidates = await fenceRowsByCandidate(access, await listCandidatesSentToManager(access.hrId), (candidate) => candidate.id);
    const claims = await loadCallClaims(candidates.map((candidate) => candidate.id));
    return NextResponse.json({
      callClaims: claims,
      candidates,
      success: true,
    });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load the candidates sent to you.");
  }
}
