import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { medicalInsuranceErrorResponse, readJsonBody } from "@/lib/medical-insurance/route-helpers";
import { addMedicalInsuranceException } from "@/lib/medical-insurance/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Records an exception to the everyone-from-day-one rule, with its reason. */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "medical_insurance", "update");
    await addMedicalInsuranceException(access, await readJsonBody(request));
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (error) {
    return medicalInsuranceErrorResponse(error, "medical_insurance_exception_failed");
  }
}
