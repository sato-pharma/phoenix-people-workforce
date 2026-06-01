import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  isOfferEnvMissing,
  isOfferPublicUrlMissing,
  isOfferSchemaMissing,
  isOfferTimeout,
  offerErrorMessage,
  runOfferAdminAction,
} from "@/lib/offers/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function offerApiError(error: unknown) {
  const message = offerErrorMessage(error);
  if (isForbiddenError(error)) return { message, status: 403 };
  if (isOfferTimeout(error)) return { message: "Supabase request timed out. Check your connection and try again.", status: 504 };
  if (isOfferPublicUrlMissing(error)) return { message: "Offer public URL is missing. Add APP_URL or NEXT_PUBLIC_APP_URL before sending offers.", status: 409 };
  if (isOfferEnvMissing(error)) return { message: "Supabase environment variables are missing.", status: 409 };
  if (isOfferSchemaMissing(error)) return { message: "Supabase schema is not ready. Run the latest offer lifecycle migration.", status: 409 };
  if (message.toLowerCase().includes("offer not found")) return { message, status: 404 };
  return { message, status: 400 };
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
    const action = String(body?.action ?? "");

    if (action !== "cancel" && action !== "resend" && action !== "withdraw") {
      return NextResponse.json(
        { error: "invalid_offer_action", message: "Action must be resend, withdraw, or cancel." },
        { status: 400 },
      );
    }

    return NextResponse.json(await runOfferAdminAction(offerRef, action, access.hrId));
  } catch (error) {
    const { message, status } = offerApiError(error);
    return NextResponse.json({ error: "offer_workflow_failed", message }, { status });
  }
}
