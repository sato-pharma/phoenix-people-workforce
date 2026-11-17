import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { medicalInsuranceErrorResponse, readJsonBody } from "@/lib/medical-insurance/route-helpers";
import { updateMedicalInsurancePolicy } from "@/lib/medical-insurance/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sets the policy number once the insurer issues it, or replaces one plan's band rates. A rate decides
 * every amount, so this holds medical_insurance_invoices, which the HR seats do not.
 */
export async function PATCH(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "medical_insurance_invoices", "update");
    await updateMedicalInsurancePolicy(access, await readJsonBody(request));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return medicalInsuranceErrorResponse(error, "medical_insurance_policy_update_failed");
  }
}
