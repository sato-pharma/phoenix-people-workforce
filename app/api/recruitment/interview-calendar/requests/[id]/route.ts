import { NextResponse } from "next/server";

import { assertSameOriginMutation, recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { interviewCalendarCaller } from "@/lib/recruitment/interview-calendar";
import { cancelInterviewRequest, getInterviewRequest } from "@/lib/recruitment/interview-requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET     one request, hydrated for the screen.
// DELETE  withdraw a request that is still waiting (its requester, or a caller with book rights). Once
//         any of its CVs has a time, the interviews themselves are cancelled instead.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { id } = await params;
    return NextResponse.json({ request: await getInterviewRequest(caller, id), success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return recruitmentApiError(error, "Could not load the interview request.");
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { id } = await params;
    return NextResponse.json({ request: await cancelInterviewRequest(caller, id), success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not cancel the interview request.");
  }
}
