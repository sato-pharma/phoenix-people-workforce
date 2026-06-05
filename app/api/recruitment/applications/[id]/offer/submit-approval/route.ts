import { NextResponse } from "next/server";

import { submitOfferForApproval } from "@/lib/recruitment/applications";
import {
  assertSameOriginMutation,
  recruitmentApiError,
  requireRecruitmentAccess,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Offer pipeline step 2 — submit the draft for the threshold approval chain.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const { id } = await params;
    const application = await submitOfferForApproval(id, access);
    return NextResponse.json({ success: true, application });
  } catch (error) {
    return recruitmentApiError(error, "Failed to submit offer for approval.");
  }
}
