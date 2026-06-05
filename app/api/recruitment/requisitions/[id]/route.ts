import { NextResponse } from "next/server";

import { getRequisition } from "@/lib/recruitment/requisitions";
import { recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await requireRecruitmentAccess(request, "recruitment", "read");
    const { id } = await params;
    const requisition = await getRequisition(access, id);
    if (!requisition) {
      return NextResponse.json({ error: "not_found", message: "Requisition not found.", success: false }, { status: 404 });
    }
    return NextResponse.json({ success: true, requisition });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load requisition.");
  }
}
