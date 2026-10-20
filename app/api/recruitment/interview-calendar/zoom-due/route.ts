import { NextResponse } from "next/server";

import { recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { interviewCalendarCaller, listDueZoomInterviews } from "@/lib/recruitment/interview-calendar";
import { fenceRowsByInterviewBooking } from "@/lib/recruitment/workspace/fence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Zoom interviews whose time has come for the signed-in person — the calendar polls this and
// opens the link itself. Someone the calendar is only shared with gets nothing for interviews that
// are not theirs; the domain module decides which are.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant's meeting never pops up for her.
    const due = await fenceRowsByInterviewBooking(access, await listDueZoomInterviews(caller), (row) => row.bookingId);
    return NextResponse.json({ due, success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return recruitmentApiError(error, "Could not check for interviews that are starting.");
  }
}
