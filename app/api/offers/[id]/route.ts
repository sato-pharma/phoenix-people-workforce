import { NextResponse, type NextRequest } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { getOffer, setOfferStatus, updateOffer } from "@/lib/offers/service";
import { offerJsonError } from "@/lib/offers/http";
import type { OfferFields, OfferStatus } from "@/lib/offers/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const statuses: readonly OfferStatus[] = ["accepted", "declined", "draft", "sent", "withdrawn"];

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "offers", "read");
    const { id } = await context.params;
    return NextResponse.json({ offer: await getOffer(id), success: true });
  } catch (error) {
    return offerJsonError(error, "Failed to load this offer.");
  }
}

/**
 * Edit a draft, or move a sent offer's status.
 *
 * These are two different things and the service enforces the split: content is editable only
 * while the offer is a draft, because once it has been sent the candidate holds a PDF and
 * Phoenix's copy must not silently disagree with it. Status, by contrast, keeps moving after the
 * send — that is how "accepted" and "declined" get recorded.
 */
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "offers", "update");

    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    if (typeof body.status === "string") {
      if (!statuses.includes(body.status as OfferStatus)) {
        return NextResponse.json({ message: "That offer status is not recognised.", success: false }, { status: 400 });
      }
      // A sent offer cannot be pulled back to draft — that would re-open editing on a document
      // somebody already holds. Withdrawing is the honest move, and it is a separate state.
      if (body.status === "draft") {
        return NextResponse.json(
          { message: "An offer cannot be returned to draft. Withdraw it and create a new one.", success: false },
          { status: 400 },
        );
      }
      return NextResponse.json({ offer: await setOfferStatus(id, body.status as OfferStatus), success: true });
    }

    // Only keys the caller actually sent are forwarded. Building a full object here would write a
    // blank over every field the edit form did not include.
    const patch: Partial<OfferFields> & { templateId?: string | null } = {};
    const textKeys: (keyof OfferFields)[] = [
      "candidateEmail", "candidateName", "contractTerm", "dateOfIssue", "reference",
      "reportsTo", "salutationName", "startDate", "territory", "title", "validUntil",
    ];
    for (const key of textKeys) {
      if (typeof body[key] === "string") (patch as Record<string, unknown>)[key] = String(body[key]).trim();
    }
    if (body.totalMonthly !== undefined) patch.totalMonthly = Number(body.totalMonthly);
    if (body.costOfLiving !== undefined) patch.costOfLiving = Number(body.costOfLiving);
    if (body.templateId !== undefined) {
      patch.templateId = typeof body.templateId === "string" && body.templateId ? body.templateId : null;
    }

    const current = await getOffer(id);
    const total = patch.totalMonthly ?? current.totalMonthly;
    const col = patch.costOfLiving ?? current.costOfLiving;
    if (Number.isFinite(total) && Number.isFinite(col) && col > total) {
      return NextResponse.json(
        { message: "The cost of living cannot be larger than the total package it is part of.", success: false },
        { status: 400 },
      );
    }

    return NextResponse.json({ offer: await updateOffer(id, patch), success: true });
  } catch (error) {
    return offerJsonError(error, "Failed to update this offer.");
  }
}
