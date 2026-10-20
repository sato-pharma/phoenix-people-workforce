import { NextResponse } from "next/server";

import { recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertInterviewBookingVisible } from "@/lib/recruitment/workspace/fence";
import { interviewCalendarCaller } from "@/lib/recruitment/interview-calendar";
import { getInterviewInvitation } from "@/lib/recruitment/interview-calendar-zoom-extras";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Zoom's invitation text for an interview's meeting (a slot's is its session's), to copy or to open
// WhatsApp with. Phoenix sends nothing — the person pressing the button does, if they choose.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { id } = await params;
    await assertInterviewBookingVisible(access, id);
    const invitation = await getInterviewInvitation(caller, { id, kind: "booking" });
    return NextResponse.json({ invitation, success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return recruitmentApiError(error, "Could not get the Zoom invitation.");
  }
}
