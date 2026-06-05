import { NextResponse } from "next/server";

import { deleteRequisition, getRequisition } from "@/lib/recruitment/requisitions";
import {
  assertSameOriginMutation,
  recruitmentApiError,
  requireRecruitmentAccess,
} from "@/app/api/recruitment/_lib/http";

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

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "delete");
    const { id } = await params;
    await deleteRequisition(access, id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to delete requisition.");
  }
}
