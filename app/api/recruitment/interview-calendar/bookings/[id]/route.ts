import { NextResponse } from "next/server";

import { assertSameOriginMutation, readJsonObject, recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertInterviewBookingVisible } from "@/lib/recruitment/workspace/fence";
import {
  cancelInterviewBooking,
  getInterviewBooking,
  interviewCalendarCaller,
  updateInterviewBooking,
} from "@/lib/recruitment/interview-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

// One interview: read it (a link from an export lands here when its week is not known), move it —
// to another time, into a session's slot, or out of one — or cancel it. The domain module checks the
// level the caller holds on the week it is in, and on the week it moves to.
export async function GET(request: Request, { params }: Context) {
  try {
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { id } = await params;
    await assertInterviewBookingVisible(access, id);
    const booking = await getInterviewBooking(caller, id);
    return NextResponse.json({ booking, success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return recruitmentApiError(error, "Could not load the interview.");
  }
}

export async function PATCH(request: Request, { params }: Context) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { id } = await params;
    await assertInterviewBookingVisible(access, id);
    const body = await readJsonObject(request);
    const booking = await updateInterviewBooking(caller, id, {
      dateKey: body.dateKey,
      durationMinutes: body.durationMinutes,
      external: body.external,
      interviewerHrId: body.interviewerHrId,
      panelistHrIds: body.panelistHrIds,
      area: body.area,
      line: body.line,
      jobTitle: body.jobTitle,
      location: body.location,
      notes: body.notes,
      platform: body.platform,
      sessionId: body.sessionId,
      startMinutes: body.startMinutes,
    });
    return NextResponse.json({ booking, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not move the interview.");
  }
}

export async function DELETE(request: Request, { params }: Context) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { id } = await params;
    await assertInterviewBookingVisible(access, id);
    const result = await cancelInterviewBooking(caller, id);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return recruitmentApiError(error, "Could not cancel the interview.");
  }
}
