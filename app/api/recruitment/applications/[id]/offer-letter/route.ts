import { NextResponse } from "next/server";
import { assertApplicationVisible } from "@/lib/recruitment/workspace/fence";

import { assertPermission } from "@/lib/auth/permissions";
import { addDays, DEFAULT_OFFER_VALIDITY_DAYS, todayInCairo } from "@/lib/offers/dates";
import { createOffer, findDraftOfferFor, listOfferJobTitles } from "@/lib/offers/service";
import { getApplication, recordApplicationOfferLetter } from "@/lib/recruitment/applications";
import { buildOfferLetterDraft } from "@/lib/recruitment/offer-letter-bridge";
import { getOffer } from "@/lib/recruitment/offers";
import { hrIdForStorage } from "@/lib/hr-id";
import {
  assertSameOriginMutation,
  recruitmentApiError,
  requireRecruitmentAccess,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Open an offer LETTER pre-filled from this application's approved offer.
 *
 * The two modules have never exchanged a value, so every offer has been written twice — once as
 * approved terms in recruitment, once retyped into the letter somebody signs. This carries the
 * first copy into the second.
 *
 * ── TWO GATES, NOT ONE ──────────────────────────────────────────────────────────────────────
 *
 * Seeing the application and issuing a company letter are different privileges, and this needs
 * both: `requireRecruitmentAccess` scopes the application (it throws if the requisition is out of
 * the caller's reach) and `offers: create` is what says this person may put the company's name on
 * a letter. A recruiter who may read a pipeline is not thereby allowed to issue an offer.
 *
 * The approval rule itself is NOT re-stated here. `buildOfferLetterDraft` runs the same
 * `offerSendBlockReason` that guards sending, so an unapproved offer cannot be composed. That is
 * deliberate: the workflow registry is editable at runtime, so approval is read from `approvedAt`
 * and never inferred from a stage.
 *
 * ── WHAT THE OFFERS MODULE ANSWERS FOR ITSELF ───────────────────────────────────────────────
 *
 * The bridge carries only what the ATS knows and refuses to guess the rest. Cost of living,
 * contract term and who they report to are per JOB TITLE and live in the offers module's own
 * catalogue, so they are read from there. Reference and template are left to `createOffer`, which
 * allocates a reference when the field is blank and resolves the title's own design.
 *
 * ── WHY IT DOES NOT MAKE A SECOND DRAFT ─────────────────────────────────────────────────────
 *
 * Pressing the button twice would otherwise leave two draft letters for one person, and the risk
 * is not clutter — it is sending the wrong one, on a document somebody signs. So an existing DRAFT
 * for the same candidate and title is returned instead of a new row. The match uses only offers
 * data (email and title), because the offers module holds no application id and must not learn
 * one: an offer there may be issued to somebody who never entered the ATS.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await requireRecruitmentAccess(request, "recruitment", "approve");
    await assertPermission(access, "offers", "create");

    const { id } = await params;
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant's application answers as if absent.
    await assertApplicationVisible(access, id);
    const application = await getApplication(access, id);
    if (!application) {
      return NextResponse.json({ message: "That application no longer exists.", success: false }, { status: 404 });
    }

    const offer = await getOffer(id);
    const bridged = buildOfferLetterDraft({ offer, candidate: application.candidate });
    // 409, not 400: the request is well formed and the caller is allowed. What is wrong is the
    // state of the offer, and the reason names which gate stopped it in the recruiter's words.
    if (!bridged.ok) {
      return NextResponse.json({ message: bridged.reason, success: false }, { status: 409 });
    }

    const { draft, carried, leftForYou } = bridged;

    // The title's own entry. A title the catalogue does not carry is not an error — the letter is
    // still worth pre-filling, and the composer collects the rest — but the caller is told, because
    // a zero cost of living silently reshapes the whole compensation table.
    const jobTitles = await listOfferJobTitles();
    const match = jobTitles.find(
      (row) => row.active && row.title.trim().toLowerCase() === draft.title.trim().toLowerCase(),
    );

    // Asked of the database for THIS candidate's drafts: the list of offers is only the newest 200, and
    // a draft older than that used to be missed, so the same candidate got a second letter for the job.
    const existing = await findDraftOfferFor(draft.title, draft.candidateEmail);
    if (existing) {
      // The link is stored for a REUSED draft exactly as for a new one. An application whose letter
      // was reused is no less linked, and recording only the created case would leave a gap that
      // reads as "no offer yet".
      await recordApplicationOfferLetter(application.id, existing.id);
      return NextResponse.json({
        carried,
        leftForYou,
        offerId: existing.id,
        reference: existing.reference,
        reused: true,
        success: true,
        titleInCatalogue: Boolean(match),
      });
    }

    const today = todayInCairo();
    const created = await createOffer(
      {
        ...draft,
        contractTerm: match?.contractTerm ?? "",
        costOfLiving: match?.costOfLiving ?? 0,
        dateOfIssue: today,
        // Blank on purpose: createOffer allocates the real number at insert time, from the same
        // rules, so nothing here can reserve one it then fails to use.
        reference: "",
        reportsTo: match?.reportsTo ?? "",
        // What the letter says this job is, from the position's own catalogue row. "" when the title
        // is not in the catalogue or has no wording yet, and that prints the role-neutral standard
        // sentence — the one answer that is right for a position nobody has worded.
        roleSummary: match?.roleSummary ?? "",
        templateId: match?.templateId ?? null,
        validUntil: addDays(today, DEFAULT_OFFER_VALIDITY_DAYS),
      },
      hrIdForStorage(access.hrId) ?? access.loginId ?? null,
    );

    // Store which letter this application produced. `ats_applications.offer_id` has existed since
    // the table was created and nothing has ever written it, so the two halves of an offer have
    // never been connected — see recordApplicationOfferLetter for why the pointer lives on this
    // side and the offers module gains nothing.
    await recordApplicationOfferLetter(application.id, created.id);

    return NextResponse.json({
      carried,
      leftForYou,
      offerId: created.id,
      reference: created.reference,
      reused: false,
      success: true,
      titleInCatalogue: Boolean(match),
    });
  } catch (error) {
    return recruitmentApiError(error, "Failed to open an offer letter for this application.");
  }
}
