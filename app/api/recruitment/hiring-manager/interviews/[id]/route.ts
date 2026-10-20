import { NextResponse } from "next/server";

import { getInterviewRow, recordInterviewOutcome, type RecordInterviewInput } from "@/lib/recruitment/interviews";
import { hiringManagerInterviewType } from "@/lib/recruitment/access";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";
import { assertApplicationVisible } from "@/lib/recruitment/workspace/fence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Gated on `hiring_interviews` (not `recruitment`) — see hiring-manager-view.ts. Restricted to
// the interviewType the caller's own role would have created (hiring_manager for District
// Manager, rm_interview/nsm_interview/ceo_interview for Regional Manager/National Sales
// Manager/CEO) so this narrow surface can never touch a phone/hr/cv-screening record Talent
// Acquisition owns, or another role's own round, even for a candidate already in scope.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "hiring_interviews", "update");
    const { id } = await params;

    const existing = await getInterviewRow(id);
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant's round answers as not there.
    await assertApplicationVisible(access, existing.applicationId, "Interview not found.");
    if (existing.interviewType !== hiringManagerInterviewType(access.role)) {
      return NextResponse.json(
        { error: "forbidden", message: "Only your own interview round can be recorded here.", success: false },
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
