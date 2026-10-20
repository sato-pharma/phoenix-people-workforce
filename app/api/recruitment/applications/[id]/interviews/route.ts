import { NextResponse } from "next/server";
import { assertApplicationVisible } from "@/lib/recruitment/workspace/fence";

import { createInterview, listInterviewsForApplication } from "@/lib/recruitment/interviews";
import { interviewTypes, type InterviewType } from "@/lib/recruitment/types";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await requireRecruitmentAccess(request, "recruitment", "read");
    const { id } = await params;
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant's application answers as if absent.
    await assertApplicationVisible(access, id);
    const interviews = await listInterviewsForApplication(access, id);
    return NextResponse.json({ success: true, interviews });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load interviews.");
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const { id } = await params;
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant's application answers as if absent.
    await assertApplicationVisible(access, id);
    const body = await readJsonObject(request);
    const interviewType = str(body.interviewType);
    if (!interviewType || !(interviewTypes as readonly string[]).includes(interviewType)) {
      return NextResponse.json(
        { error: "invalid_request", message: "A valid interview type is required.", success: false },
        { status: 400 },
      );
    }
    const interview = await createInterview(access, id, {
      interviewType: interviewType as InterviewType,
      interviewerHrId: str(body.interviewerHrId),
      scheduledAt: str(body.scheduledAt),
      location: str(body.location),
      meetingLink: str(body.meetingLink),
      notes: str(body.notes),
    });
    return NextResponse.json({ success: true, interview }, { status: 201 });
  } catch (error) {
    return recruitmentApiError(error, "Failed to schedule interview.");
  }
}
