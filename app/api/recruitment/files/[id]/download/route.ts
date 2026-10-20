import { NextResponse } from "next/server";
import { assertCandidateFileVisible } from "@/lib/recruitment/workspace/fence";

import { recruitmentFileResponse } from "@/lib/recruitment/file-response";
import { getFileForDownload } from "@/lib/recruitment/files";
import { recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await requireRecruitmentAccess(request, "candidates", "read");
    const { id } = await params;
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant's file answers as if absent.
    await assertCandidateFileVisible(access, id);
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
