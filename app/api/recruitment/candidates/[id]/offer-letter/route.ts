import { NextResponse } from "next/server";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";

import { setCandidateOfferLetter } from "@/lib/recruitment/candidate-offer-link";
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
 * "This job offer letter is this candidate's" — and, with a blank, "it is not."
 *
 * THE ONE PATH FOR A STANDALONE OFFER. A letter produced through an application is pointed at
 * automatically by the offer-letter bridge beside this route. Most letters are not: production holds
 * 27 offers against 15 applications, which is exactly why `ats_applications.offer_id` read 0 of 15
 * rows for as long as it was the only pointer. Somebody has to say who those belong to, because
 * nothing stored can answer it — the letters carry a name and an e-mail as free text, and one
 * address is the recipient on six different people's offers.
 *
 * `candidates: update`, matching the background and folder routes beside it. It changes what the send
 * screen fills in for a person — the agreed first working day — so it is not a `read`.
 *
 * THE ID IS CONFIRMED, NOT TRUSTED. `setCandidateOfferLetter` asks the offers module whether the
 * letter exists before storing the pointer, and refuses in words if it does not. An id one character
 * wrong would otherwise point this candidate at somebody else's letter, and the start date on that
 * letter is what reaches a new hire as the day they are expected at work.
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

    // A BLANK CLEARS IT, deliberately. Taking a wrong link off has to be as easy as putting one on,
    // or the only way to correct a mistake is to point the candidate at a second wrong letter.
    const body = await readJsonObject(request);
    const offerId = str(body.offerId) || null;

    const candidate = await setCandidateOfferLetter(candidateId, offerId);
    return NextResponse.json({ candidate, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not link that offer letter.");
  }
}
