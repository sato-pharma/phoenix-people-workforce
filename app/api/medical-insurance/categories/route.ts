import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { medicalInsuranceErrorResponse, readJsonBody } from "@/lib/medical-insurance/route-helpers";
import { decideMedicalInsuranceCategory } from "@/lib/medical-insurance/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Decides the category a joiner goes on the policy with, before they are on the register. */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "medical_insurance", "update");
    await decideMedicalInsuranceCategory(access, await readJsonBody(request));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return medicalInsuranceErrorResponse(error, "medical_insurance_category_failed");
  }
}
