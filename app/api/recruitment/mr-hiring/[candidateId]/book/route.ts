import { NextResponse } from "next/server";

import { assertSameOriginMutation, readJsonObject, recruitmentApiError, recruitmentProblem } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { isUuid } from "@/lib/http/uuid";
import { bookMrInterview, rescheduleMrInterview } from "@/lib/recruitment/mr-hiring/book";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Book the next interview of the Medical Rep hiring workflow. HR books (the HR Manager or Talent
// Acquisition — `mayBookMrInterview`); the calendar's own `createInterviewBooking` then applies every
// calendar rule (the Zoom meeting from the Sato Pharma account, the change history). For the DSM
// round the CV is sent to the DSM through Phoenix (§4), and everyone on the interview is notified —
// never by email, never the candidate.
export async function POST(request: Request, { params }: { params: Promise<{ candidateId: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) return recruitmentProblem("Sign in again to book the interview.", 401);
    const { candidateId } = await params;
    if (!isUuid(candidateId)) return recruitmentProblem("Candidate not found.", 404);
    await assertCandidateVisible(access, candidateId);
    const result = await bookMrInterview(access, candidateId, await readJsonObject(request));
    return NextResponse.json({ ...result, success: true }, { status: 201 });
  } catch (error) {
    return recruitmentApiError(error, "Could not book the interview.");
  }
}

// Change the day, time, length, way or place of the interview booked and not yet held (owner,
// 7 Nov 2026: "make me able to change this time"). HR only; the round and the interviewer stay.
export async function PATCH(request: Request, { params }: { params: Promise<{ candidateId: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) return recruitmentProblem("Sign in again to change the interview.", 401);
    const { candidateId } = await params;
    if (!isUuid(candidateId)) return recruitmentProblem("Candidate not found.", 404);
    await assertCandidateVisible(access, candidateId);
    const result = await rescheduleMrInterview(access, candidateId, await readJsonObject(request));
    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not change the interview.");
  }
}
