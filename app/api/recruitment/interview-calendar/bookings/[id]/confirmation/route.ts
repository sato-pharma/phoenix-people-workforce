import { NextResponse } from "next/server";

import { assertSameOriginMutation, readJsonObject, recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertInterviewBookingVisible } from "@/lib/recruitment/workspace/fence";
import { interviewCalendarCaller, setInterviewerConfirmation } from "@/lib/recruitment/interview-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The chosen interviewer confirms ("I'll conduct it") or declines ("I can't") the assignment (owner,
// 2026-09-26, Tier 3). Only the lead interviewer may, and only before the interview happens
// (setInterviewerConfirmation checks). A decline keeps the row for reassignment, stops that
// interviewer's reminders, and alerts the booker and requester. Body: { decision, reason? }.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { id } = await params;
    await assertInterviewBookingVisible(access, id);
    const body = await readJsonObject(request);
    const booking = await setInterviewerConfirmation(caller, id, body.decision, body.reason);
    return NextResponse.json({ booking, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not save your answer.");
  }
}
