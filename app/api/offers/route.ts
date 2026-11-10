import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { createOffer, listOfferJobTitles, listOfferTemplates, listOffers } from "@/lib/offers/service";
import { offerJsonError } from "@/lib/offers/http";
import { readOfferVacancyId } from "@/lib/offers/hire-draft";
import { resolveOfferSender } from "@/lib/offers/identity";
import type { OfferFields } from "@/lib/offers/types";
import { normalizeOfferEmailMessage } from "@/lib/offers/revision-rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The offers workspace, in one request.
 *
 * Templates, job titles and offers arrive together because the editor needs all three to draw a
 * single screen, and three round-trips to render one page is three chances to show a half-loaded
 * form with a salary field in it.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "offers", "read");

    const [offers, templates, jobTitles] = await Promise.all([
      listOffers(),
      listOfferTemplates(),
      listOfferJobTitles(),
    ]);

    const sender = resolveOfferSender();

    return NextResponse.json({
      jobTitles,
      offers,
      // `from` is shown to HR before they send, because the identity is the point of this module:
      // the letter must go out as the company, not as Phoenix. `isConfigured: false` means
      // JOB_OFFER_EMAIL_FROM is unset — or `refusedFrom` names what it held and why it was not
      // used: an offer fires only from the two mailboxes in `allowedFrom` (owner, 2026-10-13).
      sender: {
        allowedFrom: sender.allowedFrom,
        from: sender.from,
        isConfigured: sender.isConfigured,
        refusedFrom: sender.refusedFrom,
        replyTo: sender.replyTo,
      },
      success: true,
      templates,
    });
  } catch (error) {
    return offerJsonError(error, "Failed to load the job-offer workspace.");
  }
}

function readFields(body: Record<string, unknown>): OfferFields & {
  templateId?: string | null;
  vacancyId?: number | null;
} {
  const text = (key: string) => String(body[key] ?? "").trim();
  return {
    candidateEmail: text("candidateEmail"),
    candidateName: text("candidateName"),
    contractTerm: text("contractTerm"),
    costOfLiving: Number(body.costOfLiving ?? 0),
    dateOfIssue: text("dateOfIssue"),
    reference: text("reference"),
    reportsTo: text("reportsTo"),
    // Prefilled from the job title, overridable for this one letter. Empty is a real value — it
    // prints the standard paragraph — so an offer posted without it is complete, not broken.
    roleSummary: text("roleSummary"),
    salutationName: text("salutationName"),
    startDate: text("startDate"),
    templateId: typeof body.templateId === "string" && body.templateId ? body.templateId : null,
    territory: text("territory"),
    title: text("title"),
    totalMonthly: Number(body.totalMonthly ?? 0),
    // The open seat this letter is written against, when one was chosen. Optional in every sense:
    // an offer may be issued before anybody has settled which chair it fills.
    vacancyId: readOfferVacancyId(body.vacancyId),
    validUntil: text("validUntil"),
  };
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "offers", "create");

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const fields = readFields(body);
    // HR's own words for the email body (owner, 2026-11-10). Judged here, so an over-long one is refused
    // in a sentence rather than by the database.
    const email = normalizeOfferEmailMessage(body.emailMessage);
    if (email.problem) {
      return NextResponse.json({ message: email.problem, success: false }, { status: 400 });
    }

    if (!fields.candidateName) {
      return NextResponse.json({ message: "A candidate name is required.", success: false }, { status: 400 });
    }
    if (!fields.title) {
      return NextResponse.json({ message: "A job title is required.", success: false }, { status: 400 });
    }
    if (!Number.isFinite(fields.totalMonthly) || fields.totalMonthly <= 0) {
      return NextResponse.json(
        { message: "A total monthly package greater than zero is required.", success: false },
        { status: 400 },
      );
    }
    // The database refuses this too (offers_cost_of_living_within_package). Answering here means
    // HR sees a sentence about the offer rather than a constraint name.
    if (fields.costOfLiving > fields.totalMonthly) {
      return NextResponse.json(
        { message: "The cost of living cannot be larger than the total package it is part of.", success: false },
        { status: 400 },
      );
    }

    const offer = await createOffer({ ...fields, emailMessage: email.message }, access.hrId ?? null);
    return NextResponse.json({ offer, success: true });
  } catch (error) {
    return offerJsonError(error, "Failed to create this offer.");
  }
}
