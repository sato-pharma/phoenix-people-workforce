import { NextResponse } from "next/server";

import { recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { interviewCalendarCaller, searchInterviewCalendarPeople } from "@/lib/recruitment/interview-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// People to share the calendar with (the owner only) or, with ?for=interviewer, to choose as an
// interview's interviewer (anyone who can book), by name or job title.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const params = new URL(request.url).searchParams;
    const people = await searchInterviewCalendarPeople(caller, params.get("q"), params.get("for") === "interviewer" ? "interviewer" : "share");
    return NextResponse.json({ people, success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return recruitmentApiError(error, "Could not search for people.");
  }
}
