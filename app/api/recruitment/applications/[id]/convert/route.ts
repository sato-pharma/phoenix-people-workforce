import { NextResponse } from "next/server";

import { approveAndConvert } from "@/lib/recruitment/applications";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "approve");
    const { id } = await params;
    const body = await readJsonObject(request);
    const result = await approveAndConvert(id, access, { manualHrId: str(body.manualHrId) });
    return NextResponse.json({ success: true, application: result.application, employeeHrId: result.employeeHrId });
  } catch (error) {
    return recruitmentApiError(error, "Failed to convert hire.");
  }
}
