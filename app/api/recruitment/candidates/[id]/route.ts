import { NextResponse } from "next/server";

import { deleteCandidate } from "@/lib/recruitment/candidates";
import {
  assertSameOriginMutation,
  recruitmentApiError,
  requireRecruitmentAccess,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    await requireRecruitmentAccess(request, "candidates", "delete");
    const { id } = await params;
    await deleteCandidate(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to delete candidate.");
  }
}
