import { NextResponse } from "next/server";

import { recruitmentFileResponse } from "@/lib/recruitment/file-response";
import { getFileForDownload } from "@/lib/recruitment/files";
import { recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireRecruitmentAccess(request, "candidates", "read");
    const { id } = await params;
    const download = await getFileForDownload(id);
    if (!download) {
      return NextResponse.json({ error: "not_found", message: "File not found.", success: false }, { status: 404 });
    }
    if (download.kind === "external") {
      return NextResponse.redirect(download.url);
    }
    // The three delivery modes (base64 for the in-page renderer, inline, attachment) and why the
    // renderer must not receive a PDF-looking response live in file-response.ts.
    return recruitmentFileResponse(request, download);
  } catch (error) {
    return recruitmentApiError(error, "File download failed.");
  }
}
