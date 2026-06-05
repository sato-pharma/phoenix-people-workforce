import { NextResponse } from "next/server";

import { getOfferLetterVersion, renderSalarySummaryHtml } from "@/lib/recruitment/offer-letters";
import { recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Returns a print-ready HTML salary summary (the user saves it as PDF from the browser).
export async function GET(request: Request, { params }: { params: Promise<{ versionId: string }> }) {
  try {
    await requireRecruitmentAccess(request, "offers", "read");
    const { versionId } = await params;
    const version = await getOfferLetterVersion(versionId);
    if (!version) {
      return NextResponse.json({ error: "not_found", message: "Salary summary not found.", success: false }, { status: 404 });
    }
    return new NextResponse(renderSalarySummaryHtml(version), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (error) {
    return recruitmentApiError(error, "Failed to render salary summary.");
  }
}
