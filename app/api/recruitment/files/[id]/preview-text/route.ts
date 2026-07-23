import { NextResponse } from "next/server";

import { extractRawTextFromFile } from "@/lib/recruitment/cv-extraction";
import { detectCvFileKind } from "@/lib/recruitment/cv-file-kind";
import { getFileForDownload } from "@/lib/recruitment/files";
import { recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// On-demand text extraction for the CV preview modal — only used for DOCX (PDFs render
// natively via the existing download route in an iframe). Not persisted anywhere; a small
// re-parse cost on each preview open is an acceptable trade-off for not adding a new column.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireRecruitmentAccess(request, "candidates", "read");
    const { id } = await params;
    const download = await getFileForDownload(id);
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
