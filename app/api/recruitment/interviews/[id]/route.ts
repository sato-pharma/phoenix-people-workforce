import { NextResponse } from "next/server";

import { recordInterviewOutcome, type RecordInterviewInput } from "@/lib/recruitment/interviews";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const { id } = await params;
    const body = await readJsonObject(request);

    // Only patch the fields actually supplied (avoid clobbering outcome/score).
    const input: RecordInterviewInput = {};
    if ("outcome" in body) input.outcome = str(body.outcome);
    if ("score" in body) {
      input.score = body.score && typeof body.score === "object" ? (body.score as Record<string, unknown>) : null;
    }
    if ("notes" in body) input.notes = str(body.notes);
    if ("scheduledAt" in body) input.scheduledAt = str(body.scheduledAt);
    if ("location" in body) input.location = str(body.location);
    if ("meetingLink" in body) input.meetingLink = str(body.meetingLink);

    const interview = await recordInterviewOutcome(access, id, input);
    return NextResponse.json({ success: true, interview });
  } catch (error) {
    return recruitmentApiError(error, "Failed to record interview.");
  }
}
