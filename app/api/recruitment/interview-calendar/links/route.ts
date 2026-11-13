import { NextResponse } from "next/server";

import { assertSameOriginMutation, readJsonObject, recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { interviewCalendarCaller } from "@/lib/recruitment/interview-calendar";
import { createInterviewCalendarLink, listInterviewCalendarLinks } from "@/lib/recruitment/interview-calendar-links";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The calendar's copy links — as Google Sheets does it: a level, the whole calendar or one week, on
// or off. The owner only.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const links = await listInterviewCalendarLinks(caller);
    return NextResponse.json({ links, success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return recruitmentApiError(error, "Could not load the calendar's links.");
  }
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const body = await readJsonObject(request);
    // The new link comes back whole this once (`created`) — only its hash is kept after this.
    const { created, links } = await createInterviewCalendarLink(caller, {
      accessLevel: body.accessLevel,
      guestCvs: body.guestCvs,
      weekStart: body.weekStart,
    });
    return NextResponse.json({ created, links, success: true }, { headers: { "Cache-Control": "no-store" }, status: 201 });
  } catch (error) {
    return recruitmentApiError(error, "Could not make the link.");
  }
}
