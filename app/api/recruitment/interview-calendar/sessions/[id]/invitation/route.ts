import { NextResponse } from "next/server";

import { recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { interviewCalendarCaller } from "@/lib/recruitment/interview-calendar";
import { getInterviewInvitation } from "@/lib/recruitment/interview-calendar-zoom-extras";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Zoom's invitation text for a session's meeting, to copy or open WhatsApp with. Nothing is sent.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { id } = await params;
    const invitation = await getInterviewInvitation(caller, { id, kind: "session" });
    return NextResponse.json({ invitation, success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return recruitmentApiError(error, "Could not get the Zoom invitation.");
  }
}
