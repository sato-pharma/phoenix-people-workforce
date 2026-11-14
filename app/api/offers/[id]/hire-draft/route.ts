import { NextResponse, type NextRequest } from "next/server";

import { assertPermission, canAccess } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { buildOfferHireDraft } from "@/lib/offers/hire-draft";
import { checkOfferVacancy, formatOfferVacancyLabel } from "@/lib/offers/vacancies";
import { getOffer } from "@/lib/offers/service";
import { offerJsonError } from "@/lib/offers/http";
import { candidateForOfferLetter } from "@/lib/recruitment/candidate-offer-link";
import { buildCvHireFacts, describeCvHireFacts, withCvHireFacts } from "@/lib/recruitment/cv-hire-facts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What HR's "Add Employee" form can already know from an ACCEPTED offer letter — and, since
 * 2026-09-30, from the CV of the candidate that letter was written for.
 *
 * Read by the employees page when somebody arrives there from the Offers screen
 * (`/employees?fromOffer=<id>`), so a candidate is not retyped into a form standing next to their
 * letter, and the open seat the offer was written against is already chosen.
 *
 * READ-ONLY, and it creates nothing. The employee record is still made by the real HR form, which
 * collects the salary breakdown, the bank account, the insurance numbers and the contract type
 * that an offer has never known.
 *
 * ── Only an ACCEPTED offer ──
 * A draft has not been asked, a sent one has not been answered, a declined one was refused and a
 * withdrawn one was taken back. Hiring against any of those is hiring somebody who has not said
 * yes — the same rule recruitment enforces on its own side in `assertOfferAcceptedForHire`, stated
 * here independently rather than imported, because the offers module does not depend on
 * recruitment (`tests/candidate-offer-pointer.test.ts`).
 *
 * ── Gated on `offers:read` ──
 * The draft carries the agreed package, which is the one sensitive thing on it — and it is already
 * on the Offers screen that anyone holding this grant is looking at. Writing the employee is gated
 * separately by `employees:update` on its own route, where it belongs.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "offers", "read");

    const { id } = await context.params;
    const offer = await getOffer(id);

    if (offer.status !== "accepted") {
      return NextResponse.json(
        {
          message:
            offer.status === "sent"
              ? "This offer has not been answered yet. Record the candidate's acceptance first."
              : `This offer is ${offer.status}, so there is nobody to hire against it.`,
          success: false,
        },
        { status: 409 },
      );
    }

    // Re-read live, and only when still OPEN. A seat filled while the letter was out must not be
    // pre-selected: the hire would aim at an occupied chair and the vacancy closer would find
    // nothing to close. `seatTaken` is the difference between "this offer never named a seat" and
    // "the seat it named is gone", which is the sentence the screen needs to be able to say.
    // `seatUnread` is the third case (REC-034, 14 Nov 2026): the open seats could not be read, which
    // is NOT "the seat is gone" — the screen says so instead of blaming somebody else's hire.
    const seatCheck = await checkOfferVacancy(offer.vacancyId);
    const vacancy = seatCheck.status === "open" ? seatCheck.vacancy : null;
    const seatTaken = seatCheck.status === "closed";
    const seatUnread = seatCheck.status === "unread";

    /**
     * ── And the CV, when the ATS holds one for this letter ──
     *
     * The letter knows the terms and the seat; it has never known a national id, a date of birth,
     * an address or a university. The CV knows all four, and until now the offer door left every
     * one of them blank even though the candidate record points straight at this letter. The
     * pointer read backwards closes it — `candidateForOfferLetter`, on the recruitment side,
     * because `src/lib/offers/` must not learn that a candidate exists.
     *
     * GATED SEPARATELY on `recruitment:read`, and that is deliberate rather than belt-and-braces.
     * This route is gated on `offers:read` because it carries the agreed package, which is already
     * on the Offers screen the caller is looking at. A CV is a different kind of secret — somebody
     * else's national id and home address — so it is released on the grant that governs candidate
     * records, not on the one that governs letters. Anybody actually completing a hire holds both;
     * a seat holding `offers:read` alone sees exactly what it saw before this change.
     *
     * A MISSING CANDIDATE IS NOT AN ERROR. Nine of production's 27 letters belong to people who
     * never entered the ATS (the owner's ruling: leave them without records), so `null` is the
     * ordinary case and the draft is simply the letter's own ten fields.
     */
    const mayReadCandidates = await canAccess(access, "recruitment", "read");
    const candidate = mayReadCandidates ? await candidateForOfferLetter(offer.id) : null;
    const cvFacts = buildCvHireFacts(candidate);

    return NextResponse.json({
      candidateName: offer.candidateName,
      // The CV goes UNDER the letter: anything the offer states wins, always.
      draft: withCvHireFacts(buildOfferHireDraft({ offer, vacancy }), cvFacts),
      // What came off the CV, in the words the notice on the form prints. Empty when there is no
      // candidate behind the letter, or when their record is bare — the screen then says nothing
      // about a CV rather than claiming one was read.
      carriedFromCv: describeCvHireFacts(cvFacts),
      reference: offer.reference,
      seat: vacancy ? { id: vacancy.vacancyId, label: formatOfferVacancyLabel(vacancy) } : null,
      seatTaken,
      seatUnread,
      success: true,
    });
  } catch (error) {
    return offerJsonError(error, "Failed to build the hire draft for this offer.");
  }
}
