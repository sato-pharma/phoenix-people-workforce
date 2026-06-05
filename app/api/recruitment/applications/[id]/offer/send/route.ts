import { NextResponse } from "next/server";

import { sendPreparedOffer } from "@/lib/recruitment/applications";
import {
  assertSameOriginMutation,
  recruitmentApiError,
  requireRecruitmentAccess,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Offer pipeline step 5 — send the generated offer to the candidate.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const { id } = await params;
    const result = await sendPreparedOffer(id, access);
    return NextResponse.json({ success: true, application: result.application, offerId: result.offerId });
  } catch (error) {
    return recruitmentApiError(error, "Failed to send the prepared offer.");
  }
}
