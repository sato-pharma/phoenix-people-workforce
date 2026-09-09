import { NextResponse } from "next/server";

import { redactCandidateListContact } from "@/lib/recruitment/candidate-call-claims";
import { loadCallClaims } from "@/lib/recruitment/candidate-call-claims-db";
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

    // THE PHONE NUMBERS COME OUT HERE TOO, and this is the route it would be easiest to forget: the
    // portal renders its own list on the server and no screen calls this at all today. It is still
    // live, still reachable by anyone holding `hiring_interviews:read`, and it returned every
    // candidate's number — which would leave the whole rule resting on a page that happens not to
    // ask. Redacted against the same claims, by the same function, as the page.
    const claims = await loadCallClaims(candidates.map((candidate) => candidate.id));
    return NextResponse.json({
      callClaims: claims,
      candidates: redactCandidateListContact(candidates, claims, access.hrId),
      success: true,
    });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load the candidates sent to you.");
  }
}
