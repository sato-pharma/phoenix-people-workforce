import { NextResponse } from "next/server";

import { assertSameOriginMutation, readJsonObject, recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { fenceInterviewBookings } from "@/lib/recruitment/workspace/fence";
import {
  cancelInterviewSession,
  getInterviewSession,
  interviewCalendarCaller,
  updateInterviewSession,
} from "@/lib/recruitment/interview-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

// One session: read it with its booked slots, change it (its slots move with it), or cancel it (its
// meeting and the interviews in its slots go with it).
export async function GET(request: Request, { params }: Context) {
  try {
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { id } = await params;
    const result = await getInterviewSession(caller, id);
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant's slot is not shown to her.
    const bookings = await fenceInterviewBookings(access, result.bookings);
    return NextResponse.json({ success: true, ...result, bookings }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return recruitmentApiError(error, "Could not load the interview session.");
  }
}

export async function PATCH(request: Request, { params }: Context) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { id } = await params;
    const body = await readJsonObject(request);
    const session = await updateInterviewSession(caller, id, {
      dateKey: body.dateKey,
      durationMinutes: body.durationMinutes,
      notes: body.notes,
      platform: body.platform,
      slotMinutes: body.slotMinutes,
      startMinutes: body.startMinutes,
      title: body.title,
    });
    return NextResponse.json({ session, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not change the interview session.");
  }
}

export async function DELETE(request: Request, { params }: Context) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { id } = await params;
    const result = await cancelInterviewSession(caller, id);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return recruitmentApiError(error, "Could not cancel the interview session.");
  }
}
