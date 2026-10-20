import { NextResponse } from "next/server";

import { recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertInterviewBookingVisible } from "@/lib/recruitment/workspace/fence";
import { interviewCalendarCaller } from "@/lib/recruitment/interview-calendar";
import { getInterviewZoomInsights } from "@/lib/recruitment/interview-calendar-zoom-extras";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// What Zoom reported for an interview's meeting — attendance, poll answers, the AI summary; for a
// slot in a session, the session's. Everyone the calendar is shared with, link holders included.
// `?refresh=1` asks Zoom again (once a minute).
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { id } = await params;
    await assertInterviewBookingVisible(access, id);
    const refresh = new URL(request.url).searchParams.get("refresh") === "1";
    const insights = await getInterviewZoomInsights(caller, { id, kind: "booking" }, { refresh });
    return NextResponse.json({ insights, success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return recruitmentApiError(error, "Could not read Zoom's report.");
  }
}
