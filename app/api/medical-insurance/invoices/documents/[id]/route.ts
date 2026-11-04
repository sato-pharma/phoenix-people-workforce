import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { medicalInsuranceErrorResponse, medicalInsuranceFileResponse } from "@/lib/medical-insurance/route-helpers";
import { getMedicalInsuranceDocumentFile, removeMedicalInsuranceDocument, RESTRICTED_DOCUMENT_KINDS } from "@/lib/medical-insurance/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "medical_insurance_invoices", "read");
    const { id } = await params;
    const file = await getMedicalInsuranceDocumentFile(id, RESTRICTED_DOCUMENT_KINDS);
    if (!file) return NextResponse.json({ error: "not_found", message: "That file is no longer on file." }, { status: 404 });
    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: id,
      entityType: "medical_insurance_document",
      summary: `Opened a medical insurance document: ${file.fileName}`,
    });
    return medicalInsuranceFileResponse(file, new URL(request.url).searchParams.get("download") === "1");
  } catch (error) {
    return medicalInsuranceErrorResponse(error, "medical_insurance_document_read_failed");
  }
}

/** Takes a document off the page. The stored file is kept. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "medical_insurance_invoices", "update");
    const { id } = await params;
    await removeMedicalInsuranceDocument(access, id, RESTRICTED_DOCUMENT_KINDS);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return medicalInsuranceErrorResponse(error, "medical_insurance_document_remove_failed");
  }
}
