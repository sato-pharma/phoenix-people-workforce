import { NextResponse } from "next/server";

import { listApplications } from "@/lib/recruitment/applications";
import { recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";
import { fenceRowsByCandidate } from "@/lib/recruitment/workspace/fence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Gated on `hiring_interviews` (not `recruitment` — hard-boundary-locked to HR authority
// roles). listApplications() already scopes to the caller's own requisitions via
// canSeeApplication — see src/lib/recruitment/hiring-manager-view.ts for the full rationale.
export async function GET(request: Request) {
  try {
    const access = await requireRecruitmentAccess(request, "hiring_interviews", "read");
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant is not on her list.
    const applications = await fenceRowsByCandidate(access, await listApplications(access), (application) => application.candidateId);
    return NextResponse.json({ success: true, applications });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load your candidates.");
  }
}
