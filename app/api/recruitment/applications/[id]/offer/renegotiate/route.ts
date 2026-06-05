import { NextResponse } from "next/server";

import { reprepareAfterNegotiation } from "@/lib/recruitment/applications";
import {
  assertSameOriginMutation,
  recruitmentApiError,
  requireRecruitmentAccess,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Offer pipeline — re-prepare a negotiating offer back to draft for a new version.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const { id } = await params;
    const result = await reprepareAfterNegotiation(id, access);
    return NextResponse.json({ success: true, application: result.application, offerId: result.offerId });
  } catch (error) {
    return recruitmentApiError(error, "Failed to re-prepare the offer.");
  }
}
