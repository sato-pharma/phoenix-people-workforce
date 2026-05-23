import { NextResponse } from "next/server";
import { z } from "zod";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { provisionNewHireAccess } from "@/lib/employees/access-provisioning";
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

const offerApproveBodySchema = z.object({
  hrId: z.string().min(1).optional(),
});

function offerApiError(error: unknown) {
  const message = offerErrorMessage(error);
  if (isForbiddenError(error)) return { message: offerErrorMessage(error), status: 403 };
  if (isOfferTimeout(error)) return { message: "Supabase request timed out. Check your connection and try again.", status: 504 };
  if (isOfferPublicUrlMissing(error)) return { message: "Offer public URL is missing. Add APP_URL or NEXT_PUBLIC_APP_URL before sending offers.", status: 409 };
  if (isOfferEnvMissing(error)) return { message: "Supabase environment variables are missing.", status: 409 };
  if (isOfferSchemaMissing(error)) return { message: "Supabase schema is not ready. Run supabase/phoenix-offer-lifecycle.sql in Supabase SQL editor.", status: 409 };
  if (message.toLowerCase().includes("offer not found")) return { message, status: 404 };
  if (message.toLowerCase().includes("only accepted offers")) return { message, status: 400 };
  return { message, status: 500 };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ offerRef: string }> },
) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "offers", "approve");
    const { offerRef } = await context.params;

    const parsedBody = offerApproveBodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: "invalid_request", message: "Invalid offer approval payload." },
        { status: 400 },
      );
    }

    const result = await approveAcceptedOffer(offerRef, access.hrId, parsedBody.data.hrId);
    const accessProvisioning = await provisionNewHireAccess({
      actor: { loginId: access.loginId ?? null, role: access.role },
      hrIds: [result.employeeHrId],
      source: "offer lifecycle approval",
    });

    return NextResponse.json({ ...result, accessProvisioning });
  } catch (error) {
    const { message, status } = offerApiError(error);
    return NextResponse.json({ error: "offer_approve_failed", message }, { status });
  }
}
