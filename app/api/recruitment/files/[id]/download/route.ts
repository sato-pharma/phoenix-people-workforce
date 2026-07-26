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
    // "inline" lets a PDF render inside an <iframe> (the in-app preview) instead of the browser
    // force-downloading it — Chrome/Edge do that for ANY iframe navigation to an "attachment"
    // response, so the two callers genuinely need different dispositions on the same bytes.
    const inline = new URL(request.url).searchParams.get("disposition") === "inline";
    return new NextResponse(download.bytes as unknown as BodyInit, {
      headers: {
        "Content-Type": download.mimeType,
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${download.fileName.replace(/"/g, "")}"`,
      },
    });
  } catch (error) {
    return recruitmentApiError(error, "File download failed.");
  }
}
