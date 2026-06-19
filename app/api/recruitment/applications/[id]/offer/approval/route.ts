import { NextResponse } from "next/server";

import { decideOfferApproval, getOfferApprovalChain } from "@/lib/recruitment/applications";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read the approval chain (+ per-step authority for the caller). The service flags
// which steps the caller may act on via canCastOfferApproval.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await requireRecruitmentAccess(request, "recruitment", "read");
    const { id } = await params;
    const steps = await getOfferApprovalChain(access, id);
    return NextResponse.json({ success: true, steps });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load the approval chain.");
  }
}

// Offer pipeline step 3 — record one approver's decision. The recruitment:read gate
// is the floor; real authority is enforced per-step in the service (canCastOfferApproval).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "read");
    const { id } = await params;
    const body = await readJsonObject(request);
    const stepId = str(body.stepId);
    const decision = str(body.decision);
    if (!stepId || (decision !== "approved" && decision !== "rejected" && decision !== "returned")) {
      return NextResponse.json(
        { error: "validation", message: "A stepId and a decision of approved|rejected|returned are required.", success: false },
        { status: 400 },
      );
    }
    const result = await decideOfferApproval(id, access, { stepId, decision, reason: str(body.reason) });
    return NextResponse.json({ success: true, application: result.application, chainState: result.chainState });
  } catch (error) {
    return recruitmentApiError(error, "Failed to record the approval decision.");
  }
}
