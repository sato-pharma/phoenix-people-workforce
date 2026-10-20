import { NextResponse } from "next/server";

import { BULK_DECISION_MAX, bulkDecisionRefusal } from "@/lib/recruitment/candidate-status";
import { assertCandidatesVisible } from "@/lib/recruitment/workspace/fence";
import { assertWorkspaceWorker, bulkRejectWithReason } from "@/lib/recruitment/workspace/candidate-actions";
import { rejectionRefusal } from "@/lib/recruitment/workspace/vocabulary";
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
 * Reject the ticked CVs with one reason, in one transaction (the existing bulk decision). Answers with
 * how many moved, each one's previous status and note for the 10-second Undo, and any id that matched
 * no CV — "50 selected, 47 moved" is the truth, "done" is not.
 *
 * A batch naming a person the viewer may not see is refused whole, as not found — the same rule as
 * bulk-status beside it.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "candidates", "update");
    assertWorkspaceWorker(access);
    const body = await readJsonObject(request);

    if (!Array.isArray(body.candidateIds)) {
      return recruitmentProblem("Send the CVs as a `candidateIds` array.", 400);
    }
    const ids = Array.from(
      new Set((body.candidateIds as unknown[]).map((value) => String(value ?? "").trim()).filter((value) => value.length > 0)),
    );
    const countRefusal = bulkDecisionRefusal("rejected", ids.length);
    if (countRefusal) return recruitmentProblem(countRefusal, 400);
    const reason = str(body.reason);
    const note = str(body.note);
    const refusal = rejectionRefusal(reason, note);
    if (refusal) return recruitmentProblem(refusal, 400);

    await assertCandidatesVisible(access, ids);
    const result = await bulkRejectWithReason(access, ids, reason, note);
    return NextResponse.json({ ...result, limit: BULK_DECISION_MAX, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not reject those CVs.");
  }
}
