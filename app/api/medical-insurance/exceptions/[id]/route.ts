import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { medicalInsuranceErrorResponse } from "@/lib/medical-insurance/route-helpers";
import { revokeMedicalInsuranceException } from "@/lib/medical-insurance/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Removes an exception. The row stays, marked revoked, so the record of the decision remains. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "medical_insurance", "update");
    const { id } = await params;
    await revokeMedicalInsuranceException(access, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return medicalInsuranceErrorResponse(error, "medical_insurance_exception_revoke_failed");
  }
}
