import { NextResponse } from "next/server";

import { isUuid } from "@/lib/http/uuid";
import { assertCandidateVisible, CANDIDATE_NOT_FOUND } from "@/lib/recruitment/workspace/fence";
import { assertWorkspaceWorker, CALL_NOTE_MAX_LENGTH, recordCallResult } from "@/lib/recruitment/workspace/candidate-actions";
import { isCallResult } from "@/lib/recruitment/workspace/vocabulary";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  recruitmentProblem,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One tap on the opened CV's call bar (owner, 2026-10-20, #23 "one-tap call results"): Called, No
 * answer, Interested, Not interested, Call back — with an optional short note. Each tap is kept, so
 * the row shows the latest and the timeline can show them all. `candidates: update`: it writes to the
 * record, and the CEO, who only reads the workspace, cannot log a call.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "candidates", "update");
    assertWorkspaceWorker(access);
    const { id } = await params;
    if (!isUuid(id)) return recruitmentProblem(CANDIDATE_NOT_FOUND, 404);
    await assertCandidateVisible(access, id);

    const body = await readJsonObject(request);
    const result = str(body.result);
    if (!isCallResult(result)) return recruitmentProblem("Choose what the call came to.", 400);
    const note = str(body.note);
    if (note && note.length > CALL_NOTE_MAX_LENGTH) {
      return recruitmentProblem(`Keep the note to ${CALL_NOTE_MAX_LENGTH} characters.`, 400);
    }

    const latestCall = await recordCallResult(access, id, result, note);
    return NextResponse.json({ latestCall, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not save the call result.");
  }
}
