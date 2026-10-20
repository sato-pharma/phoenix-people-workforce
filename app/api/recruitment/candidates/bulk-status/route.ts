import { NextResponse } from "next/server";
import { assertCandidatesVisible } from "@/lib/recruitment/workspace/fence";

import { bulkUpdateCandidateStatus } from "@/lib/recruitment/candidates";
import {
  BULK_DECISION_MAX,
  CANDIDATE_STATUS_NOTE_MAX_LENGTH,
  bulkDecisionRefusal,
} from "@/lib/recruitment/candidate-status";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function validationError(message: string) {
  return NextResponse.json({ error: "validation", message, success: false }, { status: 400 });
}

/**
 * One screening verdict across many candidates.
 *
 * A COLLECTION route, not a per-candidate one, because the decision is genuinely one action: the
 * service runs it as a single transaction so the batch cannot half-apply. Putting it under
 * `[id]/status` would have implied N calls, which is the shape this exists to replace.
 *
 * The same permission as the single-candidate path — `candidates: update`. Deciding fifty CVs is
 * fifty of the same act, so it must not be reachable by anyone who could not do them one at a time,
 * and it must not demand more either.
 *
 * The refusal is asked through `bulkDecisionRefusal` rather than re-written here, so a caller who
 * asks for a status that cannot be set in bulk gets the same sentence the disabled button shows.
 * Asking it BEFORE the service call is what makes it a 400 rather than a 500: the service keeps its
 * own copy of the check, but a service that throws is mapped to "something went wrong", which is the
 * wrong thing to tell someone whose only mistake was selecting too many rows.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "candidates", "update");
    const body = await readJsonObject(request);

    const rawIds = body.ids;
    if (!Array.isArray(rawIds)) {
      return validationError("Send the candidates as an `ids` array.");
    }
    // Cleaned here as well as in the service so the count the refusal is measured against is the
    // count that will actually be decided — otherwise a list padded with blanks could report a
    // cap breach that the service would not have hit.
    const ids = Array.from(
      new Set(rawIds.map((value) => String(value ?? "").trim()).filter((value) => value.length > 0)),
    );

    const status = str(body.status);
    if (!status) return validationError("Status is required.");

    const refusal = bulkDecisionRefusal(status, ids.length);
    if (refusal) return validationError(refusal);

    const note = str(body.note);
    if (note && note.length > CANDIDATE_STATUS_NOTE_MAX_LENGTH) {
      return validationError(`Keep the note under ${CANDIDATE_STATUS_NOTE_MAX_LENGTH} characters.`);
    }

    // A batch naming someone she may not see is refused whole, as not found (owner, 2026-10-20).
    await assertCandidatesVisible(access, ids);
    const result = await bulkUpdateCandidateStatus(access, ids, status, note);
    // `moved` carries each candidate's previous status, which is what the undo control restores —
    // it cannot be read back afterwards because the row has already been overwritten.
    return NextResponse.json({ ...result, limit: BULK_DECISION_MAX, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to decide those candidates.");
  }
}
