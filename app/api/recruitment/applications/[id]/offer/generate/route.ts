import { NextResponse } from "next/server";

import { generateOfferDocuments } from "@/lib/recruitment/applications";
import {
  assertSameOriginMutation,
  recruitmentApiError,
  requireRecruitmentAccess,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Offer pipeline step 4 — generate the offer letter + salary summary (shared version).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const { id } = await params;
    const result = await generateOfferDocuments(id, access);
    return NextResponse.json({ success: true, application: result.application, version: result.version });
  } catch (error) {
    return recruitmentApiError(error, "Failed to generate offer documents.");
  }
}
