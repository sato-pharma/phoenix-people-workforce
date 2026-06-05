import { NextResponse } from "next/server";

import { getRequisitionSelectionBoard } from "@/lib/recruitment/selection";
import { recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await requireRecruitmentAccess(request, "recruitment", "read");
    const { id } = await params;
    const board = await getRequisitionSelectionBoard(access, id);
    return NextResponse.json({ success: true, board });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load the selection board.");
  }
}
