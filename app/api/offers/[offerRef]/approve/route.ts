import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  approveAcceptedOffer,
  isOfferEnvMissing,
  isOfferPublicUrlMissing,
  isOfferSchemaMissing,
  isOfferTimeout,
  offerErrorMessage,
} from "@/lib/offers/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function offerApiError(error: unknown) {
  if (isForbiddenError(error)) return { message: offerErrorMessage(error), status: 403 };
  if (isOfferTimeout(error)) return { message: "Supabase request timed out. Check your connection and try again.", status: 504 };
  if (isOfferPublicUrlMissing(error)) return { message: "Offer public URL is missing. Add APP_URL or NEXT_PUBLIC_APP_URL before sending offers.", status: 409 };
  if (isOfferEnvMissing(error)) return { message: "Supabase environment variables are missing.", status: 409 };
  if (isOfferSchemaMissing(error)) return { message: "Supabase schema is not ready. Run supabase/phoenix-offer-lifecycle.sql in Supabase SQL editor.", status: 409 };
  return { message: offerErrorMessage(error), status: 500 };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ offerRef: string }> },
) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "offers", "approve");
    const { offerRef } = await context.params;

    const body = await request.json().catch(() => ({}));
    const hrId = body?.hrId;

    return NextResponse.json(await approveAcceptedOffer(offerRef, access.hrId, hrId));
  } catch (error) {
    const { message, status } = offerApiError(error);
    return NextResponse.json({ error: "offer_approve_failed", message }, { status });
  }
}
