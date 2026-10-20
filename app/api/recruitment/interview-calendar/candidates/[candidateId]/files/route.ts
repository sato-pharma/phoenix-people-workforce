import { NextResponse } from "next/server";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";

import { recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { interviewCalendarCaller, listInterviewCalendarCandidateFiles } from "@/lib/recruitment/interview-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The files of a candidate who is ON the calendar, for anyone the calendar is shared with.
//
// A Viewer may hold no recruitment permission at all — that is the point of sharing — so the CV
// cannot come through the recruitment file routes, which would refuse them. This road is narrow on
// purpose: the candidate must have an interview booked in a week open to the caller, and only their
// own files are listed.
export async function GET(request: Request, { params }: { params: Promise<{ candidateId: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { candidateId } = await params;
    await assertCandidateVisible(access, candidateId);
    const files = await listInterviewCalendarCandidateFiles(caller, candidateId);
    return NextResponse.json({ files, success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return recruitmentApiError(error, "Could not load the candidate's files.");
  }
}
