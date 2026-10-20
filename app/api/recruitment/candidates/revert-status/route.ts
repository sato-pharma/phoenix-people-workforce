import { NextResponse } from "next/server";
import { assertCandidatesVisible } from "@/lib/recruitment/workspace/fence";

import { revertCandidateStatuses, type StatusRevert } from "@/lib/recruitment/candidates";
import { BULK_DECISION_MAX } from "@/lib/recruitment/candidate-status";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function validationError(message: string) {
  return NextResponse.json({ error: "validation", message, success: false }, { status: 400 });
}

/**
 * Undo a screening decision — put each candidate back to the status and note it carried before.
 *
 * ITS OWN ROUTE, not a mode of the bulk one, because it is a different operation: this restores a
 * per-row status and is deliberately not bound by `bulkDecidableStatuses` (see the service for why
 * putting somebody BACK to `sent_to_manager` tells no lie, while deciding them into it would).
 * Folding the two together behind a flag would put that distinction one boolean away from being lost.
 *
 * `candidates: update` — the same permission as making the decision in the first place. Undoing your
 * own press must not need more authority than the press did, and must not need less.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "candidates", "update");
    const body = await readJsonObject(request);

    const rawMoves = body.moves;
    if (!Array.isArray(rawMoves)) {
      return validationError("Send the candidates to restore as a `moves` array.");
    }
    if (rawMoves.length > BULK_DECISION_MAX) {
      return validationError(`One undo covers up to ${BULK_DECISION_MAX} candidates; this is ${rawMoves.length}.`);
    }

    // Shape only. The statuses themselves are normalised in the service against the real vocabulary,
    // so there is one authority for what a status is rather than a second copy here that can drift.
    const moves: StatusRevert[] = rawMoves.map((value) => {
      const row = (value ?? {}) as Record<string, unknown>;
      return {
        id: String(row.id ?? "").trim(),
        note: row.note === null || row.note === undefined ? null : String(row.note),
        status: String(row.status ?? "").trim(),
      };
    });
    if (moves.some((move) => !move.id || !move.status)) {
      return validationError("Every restore needs a candidate and the status to put back.");
    }

    // An undo naming someone she may not see is refused whole, as not found (owner, 2026-10-20).
    await assertCandidatesVisible(access, moves.map((move) => move.id));
    const result = await revertCandidateStatuses(access, moves);
    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to undo that decision.");
  }
}
