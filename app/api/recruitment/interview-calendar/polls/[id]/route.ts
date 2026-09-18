import { NextResponse } from "next/server";

import { assertSameOriginMutation, recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { interviewCalendarCaller } from "@/lib/recruitment/interview-calendar";
import { removeInterviewPoll, retryInterviewPoll } from "@/lib/recruitment/interview-calendar-zoom-extras";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

// POST — try Zoom again for a poll it refused or that waited for a meeting. DELETE — take the poll
// off the interview and off its Zoom meeting. Editors and the owner.
export async function POST(request: Request, { params }: Context) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { id } = await params;
    const polls = await retryInterviewPoll(caller, id);
    return NextResponse.json({ polls, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not reach Zoom.");
  }
}

export async function DELETE(request: Request, { params }: Context) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { id } = await params;
    const polls = await removeInterviewPoll(caller, id);
    return NextResponse.json({ polls, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not remove the poll.");
  }
}
