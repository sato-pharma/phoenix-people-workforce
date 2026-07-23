import { NextResponse } from "next/server";

import { createInterview, listInterviewsForApplication } from "@/lib/recruitment/interviews";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Gated on `hiring_interviews` (not `recruitment`) — see hiring-manager-view.ts. Scoped via
// listInterviewsForApplication/createInterview's own getApplication() scope check.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await requireRecruitmentAccess(request, "hiring_interviews", "read");
    const { id } = await params;
    const interviews = await listInterviewsForApplication(access, id);
    return NextResponse.json({ success: true, interviews });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load interviews.");
  }
}

// Interview type is always "hiring_manager" here regardless of the request body — the
// phone/hr/cv screening stages belong to Talent Acquisition's own workspace, not this
// narrow hiring-manager surface.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "hiring_interviews", "update");
    const { id } = await params;
    const body = await readJsonObject(request);
    const interview = await createInterview(access, id, {
      interviewType: "hiring_manager",
      scheduledAt: str(body.scheduledAt),
      location: str(body.location),
      meetingLink: str(body.meetingLink),
      notes: str(body.notes),
    });
    return NextResponse.json({ success: true, interview }, { status: 201 });
  } catch (error) {
    return recruitmentApiError(error, "Failed to schedule the interview.");
  }
}
