import { NextResponse } from "next/server";

import { assertSameOriginMutation, readJsonObject, recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { interviewCalendarCaller } from "@/lib/recruitment/interview-calendar";
import { scheduleInterviewRequestItem } from "@/lib/recruitment/interview-requests";
import { assertInterviewRequestItemVisible, fenceInterviewRequest } from "@/lib/recruitment/workspace/fence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST  give one CV on the request a real time. Body names the CV (itemId) and the slot (dateKey +
//       startMinutes, or a sessionId), and it becomes a booking on the request's chosen interviewer's
//       calendar and the requester's. Book rights only (HR and the calendar's owners).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { id } = await params;
    const body = await readJsonObject(request);
    const itemId = typeof body.itemId === "string" ? body.itemId : "";
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant's CV on a request cannot be
    // given a time by her — it answers with the words for a CV that is not on the request.
    await assertInterviewRequestItemVisible(access, itemId, "That CV is no longer on the request.");
    const result = await scheduleInterviewRequestItem(caller, {
      dateKey: body.dateKey,
      durationMinutes: body.durationMinutes,
      itemId,
      jobTitle: body.jobTitle,
      notes: body.notes,
      platform: body.platform,
      requestId: id,
      sessionId: body.sessionId,
      startMinutes: body.startMinutes,
    });
    return NextResponse.json({ success: true, ...result, request: await fenceInterviewRequest(access, result.request) }, { status: 201 });
  } catch (error) {
    return recruitmentApiError(error, "Could not book the interview time.");
  }
}
