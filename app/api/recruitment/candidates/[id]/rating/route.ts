import { NextResponse } from "next/server";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";

import { candidateRatings } from "@/lib/recruitment/candidate-rating";
import { setCandidateRating } from "@/lib/recruitment/candidates";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Star a CV 1, 2 or 3 — or take the star off.
 *
 * The owner, 2026-09-12: *"i want be able to favorite a cv more"*, and he chose degrees over a
 * single bookmark so the CVs he likes rank against each other rather than sitting in one flat pile.
 *
 * `candidates: update`, the same permission as the status and folder routes beside it. A star
 * reorders the shared queue for everybody who screens, so it is a change to the record and not a
 * read — and it must not demand more than a decision does either, since it is the lighter act of
 * the two.
 *
 * PATCH rather than PUT, because it changes one field and leaves the rest of the candidate alone.
 *
 * `rating: null` CLEARS it, and that is the only meaning of an absent or null value here — never
 * "leave it alone". A route that silently did nothing when the body was malformed would be
 * indistinguishable, from the screen's side, from one that cleared the star; this way the caller
 * always knows what it asked for. Sending 0 is a VALIDATION ERROR rather than a quiet clear, for
 * the reason candidate-rating.ts gives: unrated has exactly one representation and it is null.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "candidates", "update");

    const { id } = await params;
    await assertCandidateVisible(access, id);
    const candidateId = str(id);
    if (!candidateId) {
      return NextResponse.json(
        { error: "validation", message: "Which candidate?", success: false },
        { status: 400 },
      );
    }

    const body = await readJsonObject(request);
    // `null` and a missing key both mean CLEAR. Anything else must be a number on the ladder — a
    // string "2" from a form control is accepted and read as 2, which is what the service's own
    // parser does, but a word or a 4 is refused here so the message can name the ladder.
    const raw = body.rating;
    const asked = raw === null || raw === undefined ? null : Number(raw);
    if (asked !== null && !(candidateRatings as readonly number[]).includes(asked)) {
      return NextResponse.json(
        {
          error: "validation",
          message: `A star is ${candidateRatings.join(", ")} — or null to take it off.`,
          success: false,
        },
        { status: 400 },
      );
    }

    const candidate = await setCandidateRating(access, candidateId, asked);
    return NextResponse.json({ candidate, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not save that star.");
  }
}
