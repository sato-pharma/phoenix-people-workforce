import { NextResponse } from "next/server";

import { assertSameOriginMutation, recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertInterviewBookingVisible } from "@/lib/recruitment/workspace/fence";
import { interviewCalendarCaller, setInterviewOutcome } from "@/lib/recruitment/interview-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Record how an interview went — or clear it with { "outcome": null }. Only the interviewer and the
// calendar's owner may (setInterviewOutcome checks). Nothing is sent to the candidate.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { id } = await params;
    await assertInterviewBookingVisible(access, id);
    const body = (await request.json().catch(() => null)) as { outcome?: unknown } | null;
    if (!body || !("outcome" in body)) {
      return NextResponse.json({ message: "Say which outcome to record.", success: false }, { status: 400 });
    }
    const result = await setInterviewOutcome(caller, id, body.outcome);
    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not record the outcome.");
  }
}
