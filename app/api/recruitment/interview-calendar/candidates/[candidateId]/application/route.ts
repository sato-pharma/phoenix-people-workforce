import { NextResponse } from "next/server";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";

import { recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { getInterviewCalendarCandidateApplication, interviewCalendarCaller } from "@/lib/recruitment/interview-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Whether an interviewee has a WhatsApp application to download or print, for the two buttons beside the
// CV. It answers `{ application: { sessionId } }` or `{ application: null }` and builds nothing: the file
// itself comes from the WhatsApp Applicants route and print page, each behind its own gate.
//
// Same door as the CV beside it: the candidate must be on the calendar in a week open to the caller. On
// top of that the answer is `null` for anyone who could not open the application from WhatsApp Applicants
// — a person the calendar is shared with may hold no recruitment permission at all, and the buttons must
// not be drawn for them.
export async function GET(request: Request, { params }: { params: Promise<{ candidateId: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { candidateId } = await params;
    await assertCandidateVisible(access, candidateId);
    const application = await getInterviewCalendarCandidateApplication(caller, candidateId);
    return NextResponse.json({ application, success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return recruitmentApiError(error, "Could not look up the candidate's application.");
  }
}
