import { NextResponse } from "next/server";

import { runRequisitionWorkflow } from "@/lib/recruitment/requisitions";
import type { RecruitmentActionKey } from "@/lib/recruitment/types";
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
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const { id } = await params;
    const body = await readJsonObject(request);
    const action = str(body.action) as RecruitmentActionKey | null;
    if (!action) {
      return NextResponse.json({ error: "invalid_request", message: "An action is required.", success: false }, { status: 400 });
    }
    const requisition = await runRequisitionWorkflow(id, action, access, { reason: str(body.reason) });
    return NextResponse.json({ success: true, requisition });
  } catch (error) {
    return recruitmentApiError(error, "Failed to update requisition.");
  }
}
