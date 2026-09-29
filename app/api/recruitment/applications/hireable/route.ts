import { NextResponse } from "next/server";

import { listApplications } from "@/lib/recruitment/applications";
import { buildSeatHireCandidates } from "@/lib/recruitment/seat-hire-candidates";
import { recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The candidates an OPEN SEAT could be filled with — read by Add Employee when it was opened
 * from a vacancy, so the person can be picked instead of typed.
 *
 * Read-only, and it creates nothing. Scoping is `listApplications`' own: it already drops every
 * application this viewer may not see, so this endpoint adds no visibility of its own — it only
 * narrows to the stages the recruitment hub itself calls hireable.
 *
 * The seat arrives as lineId/areaId/positionId and only decides ORDER. Candidates whose
 * requisition points elsewhere are still listed, because a requisition opened against one area
 * routinely ends up filling a neighbouring one.
 */
export async function GET(request: Request) {
  try {
    const access = await requireRecruitmentAccess(request, "recruitment", "read");
    const url = new URL(request.url);

    const applications = await listApplications(access);
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
