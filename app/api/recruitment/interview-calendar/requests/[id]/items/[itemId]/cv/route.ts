import { NextResponse } from "next/server";
import { assertInterviewRequestItemVisible } from "@/lib/recruitment/workspace/fence";

import { recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { recruitmentFileResponse } from "@/lib/recruitment/file-response";
import { interviewCalendarCaller } from "@/lib/recruitment/interview-calendar";
import { getInterviewRequestItemCv } from "@/lib/recruitment/interview-requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The CV on one item of an interview request that has not been given a time yet — what the inbox's
// "View CV" opens. Gated by the REQUEST (who may read it), not by a booking, which does not exist yet.
// Shares CvPreviewModal with every other CV surface, so it offers the same inline / base64 / download
// modes — see file-response.ts.
export async function GET(request: Request, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { id, itemId } = await params;
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant's CV answers as if absent.
    await assertInterviewRequestItemVisible(access, itemId);
    const download = await getInterviewRequestItemCv(caller, id, itemId);
    if (!download) {
      return NextResponse.json({ error: "not_found", message: "No CV is on record for this person.", success: false }, { status: 404 });
    }
    if (download.kind === "external") {
      return NextResponse.redirect(download.url);
    }
    return recruitmentFileResponse(request, download);
  } catch (error) {
    return recruitmentApiError(error, "Could not open the CV.");
  }
}
