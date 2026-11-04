import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { medicalInsuranceErrorResponse } from "@/lib/medical-insurance/route-helpers";
import { recompareMedicalInsuranceInvoice } from "@/lib/medical-insurance/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Replaces the stored comparison with one against the register as it stands now. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "medical_insurance_invoices", "update");
    const { id } = await params;
    await recompareMedicalInsuranceInvoice(access, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return medicalInsuranceErrorResponse(error, "medical_insurance_invoice_compare_failed");
  }
}
