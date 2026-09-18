import { NextResponse } from "next/server";

import { recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { searchInterviewCalendarPeople } from "@/lib/recruitment/interview-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// People to share the calendar with, by name or job title. The owner only.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const people = await searchInterviewCalendarPeople(access, new URL(request.url).searchParams.get("q"));
    return NextResponse.json({ people, success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return recruitmentApiError(error, "Could not search for people.");
  }
}
