import { NextResponse } from "next/server";

import { downloadHiringManagerCandidateFile } from "@/lib/recruitment/hiring-manager-view";
import { recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Gated on the narrow `hiring_interviews` resource (not `recruitment`/`candidates`) — see
// hiring-manager-view.ts for why.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ candidateId: string; fileId: string }> },
) {
  try {
    const access = await requireRecruitmentAccess(request, "hiring_interviews", "read");
    const { candidateId, fileId } = await params;
    const download = await downloadHiringManagerCandidateFile(access, candidateId, fileId);
    if (!download) {
      return NextResponse.json({ error: "not_found", message: "File not found.", success: false }, { status: 404 });
    }
    if (download.kind === "external") {
      return NextResponse.redirect(download.url);
    }
    return new NextResponse(download.bytes as unknown as BodyInit, {
      headers: {
        "Content-Disposition": `attachment; filename="${download.fileName.replace(/"/g, "")}"`,
        "Content-Type": download.mimeType,
      },
    });
  } catch (error) {
    return recruitmentApiError(error, "File download failed.");
  }
}
