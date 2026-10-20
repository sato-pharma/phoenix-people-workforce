import { NextResponse } from "next/server";

import { listHiringManagerCandidateFiles } from "@/lib/recruitment/hiring-manager-view";
import { recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Gated on the narrow `hiring_interviews` resource (not `recruitment`/`candidates` — both
// hard-boundary-locked to HR authority roles), so a hiring-manager-type role like District
// Manager can reach it without a broader recruitment grant. Scoped to the caller's own
// requisitions inside listHiringManagerCandidateFiles.
export async function GET(request: Request, { params }: { params: Promise<{ candidateId: string }> }) {
  try {
    const access = await requireRecruitmentAccess(request, "hiring_interviews", "read");
    const { candidateId } = await params;
    await assertCandidateVisible(access, candidateId);
    const files = await listHiringManagerCandidateFiles(access, candidateId);
    return NextResponse.json({ success: true, files });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load candidate files.");
  }
}
