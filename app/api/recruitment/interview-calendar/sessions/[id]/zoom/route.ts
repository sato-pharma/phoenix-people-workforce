import { NextResponse } from "next/server";

import { assertSameOriginMutation, recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { interviewCalendarCaller, retryInterviewSessionZoom } from "@/lib/recruitment/interview-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Ask Zoom again for a Zoom session that has no meeting — it was not connected, or it refused.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { id } = await params;
    const session = await retryInterviewSessionZoom(caller, id);
    return NextResponse.json({ session, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not reach Zoom.");
  }
}
