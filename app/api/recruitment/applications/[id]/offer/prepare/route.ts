import { NextResponse } from "next/server";

import { prepareOffer, type LaunchOfferInput } from "@/lib/recruitment/applications";
import {
  assertSameOriginMutation,
  num,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Offer pipeline step 1 — prepare a draft offer (auto-filled from the requisition).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const { id } = await params;
    const body = await readJsonObject(request);
    const input: LaunchOfferInput = {
      baseSalary: num(body.baseSalary),
      startDate: str(body.startDate),
      expiresInDays: num(body.expiresInDays),
      fuelAllowance: num(body.fuelAllowance),
      extraCostOfLiving: num(body.extraCostOfLiving),
      socialInsurance: num(body.socialInsurance),
      taxes: num(body.taxes),
      compensationLines: body.compensationLines,
      compensationNotes: str(body.compensationNotes),
      templateKey: str(body.templateKey),
      benefits: body.benefits,
      probationPeriodMonths: num(body.probationPeriodMonths),
    };
    const result = await prepareOffer(id, access, input);
    return NextResponse.json({ success: true, application: result.application, offerId: result.offerId });
  } catch (error) {
    return recruitmentApiError(error, "Failed to prepare offer.");
  }
}
