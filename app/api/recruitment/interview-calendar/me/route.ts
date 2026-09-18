import { NextResponse } from "next/server";

import { recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { calendarRoleFor, interviewCalendarAbilities, interviewCalendarCaller } from "@/lib/recruitment/interview-calendar";
import type { InterviewCalendarMe } from "@/lib/recruitment/interview-calendar-types";
import { isZoomConfigured } from "@/lib/zoom/meetings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Who the caller is on the interview calendar, so a CV screen knows whether to draw the Schedule
// interview button. Answers `role: null` rather than 403 for someone the calendar was not shared
// with: every CV surface asks this, and a refusal there is not an error, it is "no button". A copy
// link the caller holds counts, at the highest level it gives on any week.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request).catch(() => null);
    const abilities = await interviewCalendarAbilities(access);
    const body: InterviewCalendarMe = {
      ...abilities,
      role: caller ? calendarRoleFor(caller, "any") : null,
      zoomConnected: isZoomConfigured(),
    };
    return NextResponse.json({ success: true, ...body }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return recruitmentApiError(error, "Could not read your access to the interview calendar.");
  }
}
