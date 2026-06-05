import { NextResponse } from "next/server";

import { generateOfferLetter, listOfferLetterVersions } from "@/lib/recruitment/offer-letters";
import {
  assertSameOriginMutation,
  recruitmentApiError,
  requireRecruitmentAccess,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ offerId: string }> }) {
  try {
    await requireRecruitmentAccess(request, "offers", "read");
    const { offerId } = await params;
    const versions = await listOfferLetterVersions(offerId);
    return NextResponse.json({ success: true, versions });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load offer letters.");
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ offerId: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "offers", "update");
    const { offerId } = await params;
    const version = await generateOfferLetter(access, offerId);
    return NextResponse.json({ success: true, version }, { status: 201 });
  } catch (error) {
    return recruitmentApiError(error, "Failed to generate offer letter.");
  }
}
