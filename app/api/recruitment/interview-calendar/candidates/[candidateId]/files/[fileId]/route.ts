import { NextResponse } from "next/server";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";

import { recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { recruitmentFileResponse } from "@/lib/recruitment/file-response";
import { getInterviewCalendarCandidateFile, interviewCalendarCaller } from "@/lib/recruitment/interview-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The CV's bytes, for the calendar's in-place preview. Same gate as the list beside it: the
// candidate must be on the calendar in a week open to the caller, and the file must be theirs.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ candidateId: string; fileId: string }> },
) {
  try {
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { candidateId, fileId } = await params;
    await assertCandidateVisible(access, candidateId, "File not found.");
    const download = await getInterviewCalendarCandidateFile(caller, candidateId, fileId);
    if (!download) {
      return NextResponse.json({ error: "not_found", message: "File not found.", success: false }, { status: 404 });
    }
    if (download.kind === "external") {
      return NextResponse.redirect(download.url);
    }
    // Shares CvPreviewModal with every other CV surface, so it offers the same inline / base64
    // delivery modes — see file-response.ts.
    return recruitmentFileResponse(request, download);
  } catch (error) {
    return recruitmentApiError(error, "File download failed.");
  }
}
