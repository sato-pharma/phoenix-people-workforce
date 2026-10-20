import { NextResponse } from "next/server";

import { assertSameOriginMutation, recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertInterviewBookingVisible } from "@/lib/recruitment/workspace/fence";
import { interviewCalendarCaller, retryInterviewZoomMeeting } from "@/lib/recruitment/interview-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Ask Zoom again for a Zoom interview that has no meeting — it was not connected, or it refused.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { id } = await params;
    await assertInterviewBookingVisible(access, id);
    const booking = await retryInterviewZoomMeeting(caller, id);
    return NextResponse.json({ booking, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not reach Zoom.");
  }
}
