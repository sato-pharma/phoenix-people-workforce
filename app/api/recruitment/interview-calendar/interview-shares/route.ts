import { NextResponse } from "next/server";

import { assertSameOriginMutation, readJsonObject, recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { getInterviewManagerSharePlan, interviewCalendarCaller, saveInterviewManagerShare } from "@/lib/recruitment/interview-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One interviewer's upcoming interviews shared with one manager, interview by interview — the
// manager sees only the ticked ones, view only. The calendar owner only. The manager is told in
// Phoenix and on their phone, never by email.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const url = new URL(request.url);
    const plan = await getInterviewManagerSharePlan(caller, {
      interviewerHrId: url.searchParams.get("interviewer"),
      managerHrId: url.searchParams.get("manager"),
    });
    return NextResponse.json({ plan, success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return recruitmentApiError(error, "Could not load the interviews to share.");
  }
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const body = await readJsonObject(request);
    const plan = await saveInterviewManagerShare(caller, {
      bookingIds: body.bookingIds,
      interviewerHrId: body.interviewerHrId,
      managerHrId: body.managerHrId,
    });
    return NextResponse.json({ plan, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not share the interviews.");
  }
}
