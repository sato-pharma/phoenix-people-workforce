import { NextResponse } from "next/server";

import { assertSameOriginMutation, readJsonObject, recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { interviewCalendarCaller, listInterviewCalendarShares, shareInterviewCalendar } from "@/lib/recruitment/interview-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Who the calendar is shared with, and sharing it with one more person or changing their level.
// The owner only. The person is told in Phoenix and on their phone — never by email.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const shares = await listInterviewCalendarShares(caller);
    return NextResponse.json({ shares, success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return recruitmentApiError(error, "Could not load who the calendar is shared with.");
  }
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const body = await readJsonObject(request);
    const shares = await shareInterviewCalendar(caller, { accessLevel: body.accessLevel, hrId: body.hrId });
    return NextResponse.json({ shares, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not share the calendar.");
  }
}
