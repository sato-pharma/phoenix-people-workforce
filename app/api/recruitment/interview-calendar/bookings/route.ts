import { NextResponse } from "next/server";

import { assertSameOriginMutation, readJsonObject, recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import {
  createInterviewBooking,
  listInterviewBookingsForDay,
  listInterviewBookingsForWeek,
  listUpcomingInterviewsForCandidate,
  requireInterviewCalendarRole,
} from "@/lib/recruitment/interview-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET  ?week=YYYY-MM-DD        the week's interviews (the calendar)
//      ?day=YYYY-MM-DD         one day's interviews (the schedule dialog's taken half hours)
//      ?candidateId=<uuid>     one candidate's interviews from today on (shown before booking again)
// POST                         book one
//
// Every branch passes the calendar's own gate first — see src/lib/recruitment/interview-calendar.ts.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await requireInterviewCalendarRole(access, "view");
    const params = new URL(request.url).searchParams;
    const candidateId = params.get("candidateId");
    const day = params.get("day");
    const week = params.get("week");

    const bookings = candidateId
      ? await listUpcomingInterviewsForCandidate(candidateId, access.hrId)
      : day
        ? await listInterviewBookingsForDay(day, access.hrId)
        : await listInterviewBookingsForWeek(week ?? "", access.hrId);
    return NextResponse.json({ bookings, success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return recruitmentApiError(error, "Could not load the interview calendar.");
  }
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const body = await readJsonObject(request);
    const booking = await createInterviewBooking(access, {
      candidateId: body.candidateId,
      dateKey: body.dateKey,
      durationMinutes: body.durationMinutes,
      notes: body.notes,
      platform: body.platform,
      startMinutes: body.startMinutes,
    });
    return NextResponse.json({ booking, success: true }, { status: 201 });
  } catch (error) {
    return recruitmentApiError(error, "Could not book the interview.");
  }
}
