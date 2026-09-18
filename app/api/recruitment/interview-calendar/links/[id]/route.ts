import { NextResponse } from "next/server";

import { assertSameOriginMutation, readJsonObject, recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { interviewCalendarCaller } from "@/lib/recruitment/interview-calendar";
import { deleteInterviewCalendarLink, updateInterviewCalendarLink } from "@/lib/recruitment/interview-calendar-links";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

// Change a copy link — its level, its week, whether its CVs open without signing in, on or off — or
// delete it for good. The owner only; a change holds from the holder's next request.
export async function PATCH(request: Request, { params }: Context) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { id } = await params;
    const body = await readJsonObject(request);
    const links = await updateInterviewCalendarLink(caller, id, {
      accessLevel: body.accessLevel,
      guestCvs: body.guestCvs,
      isActive: body.isActive,
      weekStart: body.weekStart,
    });
    return NextResponse.json({ links, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not change the link.");
  }
}

export async function DELETE(request: Request, { params }: Context) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { id } = await params;
    const links = await deleteInterviewCalendarLink(caller, id);
    return NextResponse.json({ links, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not delete the link.");
  }
}
