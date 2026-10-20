import { NextResponse } from "next/server";
import { fenceRowsByCandidate } from "@/lib/recruitment/workspace/fence";

import { getRequisitionSelectionBoard } from "@/lib/recruitment/selection";
import { recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await requireRecruitmentAccess(request, "recruitment", "read");
    const { id } = await params;
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant is not on her board.
    const board = await fenceRowsByCandidate(
      access,
      await getRequisitionSelectionBoard(access, id),
      (entry) => entry.application.candidateId,
    );
    return NextResponse.json({ success: true, board });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load the selection board.");
  }
}
