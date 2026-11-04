import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { medicalInsuranceErrorResponse, readJsonBody } from "@/lib/medical-insurance/route-helpers";
import { addMedicalInsuranceMember } from "@/lib/medical-insurance/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Puts someone on the register: an employee, a spouse or child under them, or a person with no Phoenix record. */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "medical_insurance", "create");
    const id = await addMedicalInsuranceMember(access, await readJsonBody(request));
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    return medicalInsuranceErrorResponse(error, "medical_insurance_member_add_failed");
  }
}
