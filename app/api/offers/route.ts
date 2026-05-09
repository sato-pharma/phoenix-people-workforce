import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  createOffer,
  getOfferDashboard,
  isOfferEnvMissing,
  isOfferPublicUrlMissing,
  isOfferSchemaMissing,
  isOfferTimeout,
  offerErrorMessage,
} from "@/lib/offers/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function offerApiError(error: unknown) {
  if (isForbiddenError(error)) {
    return { message: offerErrorMessage(error), status: 403 };
  }
  if (isOfferTimeout(error)) {
    return { message: "Supabase request timed out. Check your connection and try again.", status: 504 };
  }
  if (isOfferPublicUrlMissing(error)) {
    return { message: "Offer public URL is missing. Add APP_URL or NEXT_PUBLIC_APP_URL before sending offers.", status: 409 };
  }
  if (isOfferEnvMissing(error)) {
    return { message: "Supabase environment variables are missing.", status: 409 };
  }
  if (isOfferSchemaMissing(error)) {
    return { message: "Supabase schema is not ready. Run supabase/phoenix-offer-lifecycle.sql in Supabase SQL editor.", status: 409 };
  }
  return { message: offerErrorMessage(error), status: 500 };
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "offers", "read");
    return NextResponse.json(await getOfferDashboard());
  } catch (error) {
    const { message, status } = offerApiError(error);
    return NextResponse.json({ error: "offer_dashboard_failed", message }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "offers", "create");
    const payload = await request.json();

    if (!payload?.candidateName || !payload?.candidateEmail || !payload?.jobTitle) {
      return NextResponse.json(
        { error: "missing_offer_fields", message: "Candidate name, candidate email, and job title are required." },
        { status: 400 },
      );
    }

    return NextResponse.json(
      await createOffer({
        areaId: payload.areaId,
        areaScope: payload.areaScope ? String(payload.areaScope) : null,
        candidateEmail: String(payload.candidateEmail),
        candidateName: String(payload.candidateName),
        candidatePhone: payload.candidatePhone ? String(payload.candidatePhone) : null,
        createdByHrId: access.hrId,
        departmentId: payload.departmentId,
        expiresInDays: payload.expiresInDays,
        jobTitle: String(payload.jobTitle),
        lineId: payload.lineId,
        managerHrId: payload.managerHrId ? String(payload.managerHrId) : null,
        positionId: payload.positionId,
        salaryAmount: payload.salaryAmount,
        startDate: payload.startDate ? String(payload.startDate) : null,
        templateKey: payload.templateKey ? String(payload.templateKey) : null,
      }),
      { status: 201 },
    );
  } catch (error) {
    const { message, status } = offerApiError(error);
    return NextResponse.json({ error: "offer_create_failed", message }, { status });
  }
}
