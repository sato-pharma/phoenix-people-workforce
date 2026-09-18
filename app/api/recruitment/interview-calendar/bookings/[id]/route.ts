import { NextResponse } from "next/server";

import { assertSameOriginMutation, readJsonObject, recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import {
  cancelInterviewBooking,
  getInterviewBooking,
  requireInterviewCalendarRole,
  updateInterviewBooking,
} from "@/lib/recruitment/interview-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

// One interview: read it (a link from an export lands here when its week is not known), move it,
// or cancel it. Moving and cancelling need Editor or the owner; the domain module decides.
export async function GET(request: Request, { params }: Context) {
  try {
    const access = await resolveAccessContext(request);
    await requireInterviewCalendarRole(access, "view");
    const { id } = await params;
    const booking = await getInterviewBooking(id, access.hrId);
    return NextResponse.json({ booking, success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return recruitmentApiError(error, "Could not load the interview.");
  }
}

export async function PATCH(request: Request, { params }: Context) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const { id } = await params;
    const body = await readJsonObject(request);
    const booking = await updateInterviewBooking(access, id, {
      dateKey: body.dateKey,
      durationMinutes: body.durationMinutes,
      notes: body.notes,
      platform: body.platform,
      startMinutes: body.startMinutes,
    });
    return NextResponse.json({ booking, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not move the interview.");
  }
}

export async function DELETE(request: Request, { params }: Context) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const { id } = await params;
    const result = await cancelInterviewBooking(access, id);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return recruitmentApiError(error, "Could not cancel the interview.");
  }
}
