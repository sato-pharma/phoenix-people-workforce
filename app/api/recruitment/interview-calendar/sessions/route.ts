import { NextResponse } from "next/server";

import { assertSameOriginMutation, readJsonObject, recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { createInterviewSession, interviewCalendarCaller } from "@/lib/recruitment/interview-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST — an interview SESSION: one block of one day under one meeting, cut into slots of 15 to 60
// minutes, a candidate to each slot now or later. Editors and the owner; the week's list
// (GET /bookings?week=) returns the sessions beside the interviews.
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const body = await readJsonObject(request);
    const session = await createInterviewSession(caller, {
      dateKey: body.dateKey,
      durationMinutes: body.durationMinutes,
      notes: body.notes,
      platform: body.platform,
      slotMinutes: body.slotMinutes,
      startMinutes: body.startMinutes,
      title: body.title,
    });
    return NextResponse.json({ session, success: true }, { status: 201 });
  } catch (error) {
    return recruitmentApiError(error, "Could not create the interview session.");
  }
}
