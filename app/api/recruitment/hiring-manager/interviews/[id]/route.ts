import { NextResponse } from "next/server";

import { getInterviewRow, recordInterviewOutcome, type RecordInterviewInput } from "@/lib/recruitment/interviews";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Gated on `hiring_interviews` (not `recruitment`) — see hiring-manager-view.ts. Restricted to
// interviewType "hiring_manager" so this narrow surface can never touch a phone/hr/cv-screening
// record Talent Acquisition owns, even for a candidate already in the caller's own scope.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "hiring_interviews", "update");
    const { id } = await params;

    const existing = await getInterviewRow(id);
    if (existing.interviewType !== "hiring_manager") {
      return NextResponse.json(
        { error: "forbidden", message: "Only your own hiring-manager interview can be recorded here.", success: false },
        { status: 403 },
      );
    }

    const body = await readJsonObject(request);
    const input: RecordInterviewInput = {};
    if ("outcome" in body) input.outcome = str(body.outcome);
    if ("score" in body) {
      input.score = body.score && typeof body.score === "object" ? (body.score as Record<string, unknown>) : null;
    }
    if ("notes" in body) input.notes = str(body.notes);

    const interview = await recordInterviewOutcome(access, id, input);
    return NextResponse.json({ success: true, interview });
  } catch (error) {
    return recruitmentApiError(error, "Failed to record the interview outcome.");
  }
}
