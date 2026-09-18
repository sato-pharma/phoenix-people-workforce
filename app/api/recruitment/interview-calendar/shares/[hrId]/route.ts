import { NextResponse } from "next/server";

import { assertSameOriginMutation, recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { interviewCalendarCaller, unshareInterviewCalendar } from "@/lib/recruitment/interview-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Stop sharing the calendar with one person. The owner only.
export async function DELETE(request: Request, { params }: { params: Promise<{ hrId: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { hrId } = await params;
    const shares = await unshareInterviewCalendar(caller, decodeURIComponent(hrId));
    return NextResponse.json({ shares, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not stop sharing the calendar.");
  }
}
