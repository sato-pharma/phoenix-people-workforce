import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { medicalInsuranceErrorResponse } from "@/lib/medical-insurance/route-helpers";
import { recordMedicalInsuranceInvoice } from "@/lib/medical-insurance/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Records a bill or credit note as read off the insurer's paper, with the paper when attached, and compares
 * it with the plan. It pays nothing and writes nothing to payroll.
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "medical_insurance_invoices", "create");

    const form = await request.formData();
    const upload = form.get("file");
    const file = upload instanceof File && upload.size > 0 ? { bytes: Buffer.from(await upload.arrayBuffer()), fileName: upload.name || "bill.pdf" } : null;
    const invoice = await recordMedicalInsuranceInvoice(access, {
      coversFrom: form.get("coversFrom"),
      coversTo: form.get("coversTo"),
      file,
      invoiceNumber: form.get("invoiceNumber"),
      issuedOn: form.get("issuedOn"),
      kind: form.get("kind"),
      note: form.get("note"),
      totalDue: form.get("totalDue"),
    });
    return NextResponse.json({ id: invoice.id }, { status: 201 });
  } catch (error) {
    return medicalInsuranceErrorResponse(error, "medical_insurance_invoice_record_failed");
  }
}
