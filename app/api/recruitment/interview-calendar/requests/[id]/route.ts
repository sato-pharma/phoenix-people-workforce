import { NextResponse } from "next/server";

import { assertSameOriginMutation, recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { interviewCalendarCaller } from "@/lib/recruitment/interview-calendar";
import { cancelInterviewRequest, getInterviewRequest } from "@/lib/recruitment/interview-requests";
import { assertInterviewRequestVisible, fenceInterviewRequest } from "@/lib/recruitment/workspace/fence";

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
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant's CV is not on the request she
    // reads, and a request only about HR applicants answers as gone.
    const found = await fenceInterviewRequest(access, await getInterviewRequest(caller, id));
    return NextResponse.json({ request: found, success: true }, { headers: { "Cache-Control": "no-store" } });
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
    // Asked BEFORE the cancel, so a request only about HR applicants cannot be withdrawn by her either.
    await assertInterviewRequestVisible(access, id);
    const cancelled = await fenceInterviewRequest(access, await cancelInterviewRequest(caller, id));
    return NextResponse.json({ request: cancelled, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not cancel the interview request.");
  }
}
