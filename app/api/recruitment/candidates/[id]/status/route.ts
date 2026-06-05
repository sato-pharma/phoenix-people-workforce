import { NextResponse } from "next/server";

import { updateCandidateStatus } from "@/lib/recruitment/candidates";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    await requireRecruitmentAccess(request, "candidates", "update");
    const { id } = await params;
    const body = await readJsonObject(request);
    const status = str(body.status);
    if (!status) {
      return NextResponse.json({ error: "validation", message: "Status is required.", success: false }, { status: 400 });
    }
    const candidate = await updateCandidateStatus(id, status);
    return NextResponse.json({ success: true, candidate });
  } catch (error) {
    return recruitmentApiError(error, "Failed to update candidate status.");
  }
}
