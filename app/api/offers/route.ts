import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { createOffer, listOfferJobTitles, listOfferTemplates, listOffers } from "@/lib/offers/service";
import { offerJsonError } from "@/lib/offers/http";
import { resolveOfferSender } from "@/lib/offers/identity";
import type { OfferFields } from "@/lib/offers/types";

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
      // the letter must go out as the company, not as Phoenix. `senderConfigured: false` means
      // JOB_OFFER_EMAIL_FROM is unset and a placeholder address would be used.
      sender: { from: sender.from, isConfigured: sender.isConfigured, replyTo: sender.replyTo },
      success: true,
      templates,
    });
  } catch (error) {
    return offerJsonError(error, "Failed to load the job-offer workspace.");
  }
}

function readFields(body: Record<string, unknown>): OfferFields & { templateId?: string | null } {
  const text = (key: string) => String(body[key] ?? "").trim();
  return {
    candidateEmail: text("candidateEmail"),
    candidateName: text("candidateName"),
    contractTerm: text("contractTerm"),
    costOfLiving: Number(body.costOfLiving ?? 0),
    dateOfIssue: text("dateOfIssue"),
    reference: text("reference"),
    reportsTo: text("reportsTo"),
    salutationName: text("salutationName"),
    startDate: text("startDate"),
    templateId: typeof body.templateId === "string" && body.templateId ? body.templateId : null,
    territory: text("territory"),
    title: text("title"),
    totalMonthly: Number(body.totalMonthly ?? 0),
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

    const offer = await createOffer(fields, access.hrId ?? null);
    return NextResponse.json({ offer, success: true });
  } catch (error) {
    return offerJsonError(error, "Failed to create this offer.");
  }
}
