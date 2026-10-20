import { NextResponse } from "next/server";

import { assertSameOriginMutation, readJsonObject, recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertInterviewBookingVisible } from "@/lib/recruitment/workspace/fence";
import { interviewCalendarCaller, saveInterviewScorecard } from "@/lib/recruitment/interview-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// File (or update) the signed-in caller's OWN scorecard for an interview: a rating 1-5, a verdict and
// an optional note. Only someone ON the interview — the lead or a panel member — may, and only their
// own row (saveInterviewScorecard checks). It records an opinion; it moves nothing in Recruitment.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { id } = await params;
    await assertInterviewBookingVisible(access, id);
    const body = await readJsonObject(request);
    const booking = await saveInterviewScorecard(caller, id, { comment: body.comment, rating: body.rating, verdict: body.verdict });
    return NextResponse.json({ booking, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not save the scorecard.");
  }
}
