import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { medicalInsuranceErrorResponse } from "@/lib/medical-insurance/route-helpers";
import { uploadMedicalInsuranceInvoice } from "@/lib/medical-insurance/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Reads an invoice, compares it with the plan and files it. It pays nothing and writes nothing to payroll. */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "medical_insurance_invoices", "create");

    const form = await request.formData();
    const upload = form.get("file");
    if (!(upload instanceof File) || upload.size === 0) {
      return NextResponse.json({ error: "no_file", message: "Choose the insurer's PDF." }, { status: 400 });
    }
    const invoice = await uploadMedicalInsuranceInvoice(access, {
      bytes: Buffer.from(await upload.arrayBuffer()),
      contentType: upload.type || "application/pdf",
      fileName: upload.name || "invoice.pdf",
    });
    return NextResponse.json({ id: invoice.id }, { status: 201 });
  } catch (error) {
    return medicalInsuranceErrorResponse(error, "medical_insurance_invoice_upload_failed");
  }
}
