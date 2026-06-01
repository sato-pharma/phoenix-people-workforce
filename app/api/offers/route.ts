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
    if (!payload?.departmentId || !payload?.positionId || !payload?.lineId || !payload?.areaId || !payload?.managerHrId || !payload?.vacancyId) {
      return NextResponse.json(
        { error: "missing_offer_assignment", message: "Department, position, line, vacant area, manager, and vacancy are required." },
        { status: 400 },
      );
    }
    if (!Number.isFinite(Number(payload?.expiresInDays)) || Number(payload.expiresInDays) < 1 || Number(payload.expiresInDays) > 60) {
      return NextResponse.json(
        { error: "invalid_offer_expiry", message: "Offer expiry must be between 1 and 60 days." },
        { status: 400 },
      );
    }
    if (!payload?.startDate) {
      return NextResponse.json(
        { error: "missing_offer_start_date", message: "Hiring date is required before sending an offer." },
        { status: 400 },
      );
    }
    if (!Number.isFinite(Number(payload?.baseSalary)) || Number(payload.baseSalary) <= 0) {
      return NextResponse.json(
        { error: "missing_offer_base_salary", message: "Base salary must be greater than zero." },
        { status: 400 },
      );
    }

    return NextResponse.json(
      await createOffer(
        {
          areaId: payload.areaId,
          areaScope: payload.areaScope ? String(payload.areaScope) : null,
          baseSalary: payload.baseSalary,
          candidateEmail: String(payload.candidateEmail),
          candidateName: String(payload.candidateName),
          candidatePhone: payload.candidatePhone ? String(payload.candidatePhone) : null,
          compensationLines: payload.compensationLines,
          compensationNotes: payload.compensationNotes ? String(payload.compensationNotes) : null,
          createdByHrId: access.hrId,
          departmentId: payload.departmentId,
          expiresInDays: payload.expiresInDays,
          extraCostOfLiving: payload.extraCostOfLiving,
          fuelAllowance: payload.fuelAllowance,
          jobTitle: String(payload.jobTitle),
          lineId: payload.lineId,
          managerHrId: payload.managerHrId ? String(payload.managerHrId) : null,
          positionId: payload.positionId,
          salaryAmount: payload.salaryAmount,
          socialInsurance: payload.socialInsurance,
          startDate: payload.startDate ? String(payload.startDate) : null,
          taxes: payload.taxes,
          templateKey: payload.templateKey ? String(payload.templateKey) : null,
          vacancyId: payload.vacancyId,
        },
        access,
      ),
      { status: 201 },
    );
  } catch (error) {
    const { message, status } = offerApiError(error);
    return NextResponse.json({ error: "offer_create_failed", message }, { status });
  }
}
