import { NextResponse } from "next/server";

import { recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { interviewCalendarCaller, listInterviewJobTitleOptions } from "@/lib/recruitment/interview-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET  the job titles suggested on the booking form — the offer catalogue's active titles, names
//      only, behind the CALENDAR's own gate rather than the offers permission (the people who book
//      interviews are not the people who write offer letters, and no figure leaves with the names).
//      The field itself is free text: a role the catalogue does not hold is typed.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const titles = await listInterviewJobTitleOptions(caller);
    return NextResponse.json({ success: true, titles }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return recruitmentApiError(error, "Could not load the job titles.");
  }
}
