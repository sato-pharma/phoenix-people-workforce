import { NextResponse, type NextRequest } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { buildOfferHireDraft } from "@/lib/offers/hire-draft";
import { findOpenOfferVacancy, formatOfferVacancyLabel } from "@/lib/offers/vacancies";
import { getOffer } from "@/lib/offers/service";
import { offerJsonError } from "@/lib/offers/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What HR's "Add Employee" form can already know from an ACCEPTED offer letter.
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
    const vacancy = await findOpenOfferVacancy(offer.vacancyId);
    const seatTaken = offer.vacancyId !== null && vacancy === null;

    return NextResponse.json({
      candidateName: offer.candidateName,
      draft: buildOfferHireDraft({ offer, vacancy }),
      reference: offer.reference,
      seat: vacancy ? { id: vacancy.vacancyId, label: formatOfferVacancyLabel(vacancy) } : null,
      seatTaken,
      success: true,
    });
  } catch (error) {
    return offerJsonError(error, "Failed to build the hire draft for this offer.");
  }
}
