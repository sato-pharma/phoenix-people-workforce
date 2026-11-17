import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { medicalInsuranceErrorResponse, medicalInsuranceFileResponse } from "@/lib/medical-insurance/route-helpers";
import { getMedicalInsuranceInvoiceFile } from "@/lib/medical-insurance/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The insurer's own paper for a bill, streamed through this route so every read stays behind the check. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "medical_insurance_invoices", "read");
    const { id } = await params;
    const file = await getMedicalInsuranceInvoiceFile(id);
    if (!file) return NextResponse.json({ error: "not_found", message: "No paper is on file for that bill." }, { status: 404 });
    return medicalInsuranceFileResponse(file, new URL(request.url).searchParams.get("download") === "1");
  } catch (error) {
    return medicalInsuranceErrorResponse(error, "medical_insurance_invoice_file_failed");
  }
}
