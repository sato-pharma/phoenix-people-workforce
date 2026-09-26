import { NextResponse } from "next/server";

import { recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { interviewCalendarCaller } from "@/lib/recruitment/interview-calendar";
import { calendarFeedPath, getOrCreateMyCalendarFeedToken } from "@/lib/recruitment/interview-calendar-ics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The signed-in person's own .ics subscription path. Get-or-create: one token per person, so the
// URL a person saved keeps working. The client turns the path into a full webcal:// / https:// URL
// with its own origin. It writes only the caller's own token row, keyed to their own hr id, and
// getOrCreateMyCalendarFeedToken is the gate — it mints a token only for a signed-in Phoenix person.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const token = await getOrCreateMyCalendarFeedToken(caller);
    return NextResponse.json({ path: calendarFeedPath(token), success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return recruitmentApiError(error, "Could not make your calendar link.");
  }
}
