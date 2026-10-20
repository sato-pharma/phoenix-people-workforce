import { NextResponse } from "next/server";
import { fenceRowsByCandidate } from "@/lib/recruitment/workspace/fence";

import { listSeatHireApplications } from "@/lib/recruitment/applications";
import { buildSeatHireCandidates } from "@/lib/recruitment/seat-hire-candidates";
import { recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The candidates an OPEN SEAT could be filled with — read by Add Employee when it was opened
 * from a vacancy, so the person can be picked instead of typed.
 *
 * Read-only, and it creates nothing. Scoping is `listApplications`' own — `listSeatHireApplications`
 * runs the same scoped requisition read and the same `canSeeApplication` check, and differs only by
 * asking the database for the three hireable stages instead of every application ever filed. So this
 * endpoint adds no visibility of its own; both of its filters narrow.
 *
 * The seat arrives as lineId/areaId/positionId and only decides ORDER. Candidates whose
 * requisition points elsewhere are still listed, because a requisition opened against one area
 * routinely ends up filling a neighbouring one.
 */
export async function GET(request: Request) {
  try {
    const access = await requireRecruitmentAccess(request, "recruitment", "read");
    const url = new URL(request.url);

    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant is never offered for a seat.
    const applications = await fenceRowsByCandidate(
      access,
      await listSeatHireApplications(access),
      (application) => application.candidateId,
    );
    const candidates = buildSeatHireCandidates(applications, {
      areaId: url.searchParams.get("areaId"),
      lineId: url.searchParams.get("lineId"),
      positionId: url.searchParams.get("positionId"),
    });

    return NextResponse.json({ success: true, candidates });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load hireable candidates.");
  }
}
