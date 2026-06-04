import { NextResponse } from "next/server";

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
    return new NextResponse(download.bytes as unknown as BodyInit, {
      headers: {
        "Content-Type": download.mimeType,
        "Content-Disposition": `attachment; filename="${download.fileName.replace(/"/g, "")}"`,
      },
    });
  } catch (error) {
    return recruitmentApiError(error, "File download failed.");
  }
}
