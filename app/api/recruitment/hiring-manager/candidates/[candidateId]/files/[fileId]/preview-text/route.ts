import { NextResponse } from "next/server";

import { extractRawTextFromFile } from "@/lib/recruitment/cv-extraction";
import { detectCvFileKind } from "@/lib/recruitment/cv-file-kind";
import { downloadHiringManagerCandidateFile } from "@/lib/recruitment/hiring-manager-view";
import { recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Gated on the narrow `hiring_interviews` resource (not `recruitment`/`candidates`) — see
// hiring-manager-view.ts for why. On-demand DOCX text extraction only (PDFs render via the
// existing sibling download route in an iframe) — mirrors app/api/recruitment/files/[id]/
// preview-text/route.ts's Talent Acquisition equivalent.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ candidateId: string; fileId: string }> },
) {
  try {
    const access = await requireRecruitmentAccess(request, "hiring_interviews", "read");
    const { candidateId, fileId } = await params;
    const download = await downloadHiringManagerCandidateFile(access, candidateId, fileId);
    if (!download || download.kind !== "binary") {
      return NextResponse.json({ error: "not_found", message: "File not found.", success: false }, { status: 404 });
    }
    const kind = detectCvFileKind(download.mimeType, download.fileName);
    if (kind !== "docx") {
      return NextResponse.json(
        { error: "invalid_request", message: "Only Word (.docx) files use the text preview.", success: false },
        { status: 400 },
      );
    }
    const text = await extractRawTextFromFile(download.bytes, download.mimeType, download.fileName);
    return NextResponse.json({ success: true, text });
  } catch (error) {
    return recruitmentApiError(error, "Failed to preview this file.");
  }
}
