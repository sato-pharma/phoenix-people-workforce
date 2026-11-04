import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { medicalInsuranceErrorResponse, medicalInsuranceFileResponse } from "@/lib/medical-insurance/route-helpers";
import { downloadMedicalInsuranceFile, getMedicalInsuranceInvoice } from "@/lib/medical-insurance/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The insurer's own PDF, streamed through this route so every read stays behind the check. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "medical_insurance_invoices", "read");
    const { id } = await params;
    const invoice = await getMedicalInsuranceInvoice(id);
    if (!invoice) return NextResponse.json({ error: "not_found", message: "That invoice is no longer on file." }, { status: 404 });
    const bytes = await downloadMedicalInsuranceFile(invoice.storagePath);
    return medicalInsuranceFileResponse({ bytes, contentType: invoice.contentType, fileName: invoice.fileName }, new URL(request.url).searchParams.get("download") === "1");
  } catch (error) {
    return medicalInsuranceErrorResponse(error, "medical_insurance_invoice_file_failed");
  }
}
