import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { medicalInsuranceErrorResponse, medicalInsuranceWorkbookResponse } from "@/lib/medical-insurance/route-helpers";
import { getMedicalInsuranceInvoice, getMedicalInsuranceView } from "@/lib/medical-insurance/service";
import { buildMedicalInsuranceInvoiceWorkbook } from "@/lib/medical-insurance/workbooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The invoice as XLSX: the statement, every certificate, and how it stood against the plan. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "medical_insurance_invoices", "export");
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:medical-insurance-invoice" });

    const { id } = await params;
    const [invoice, view] = await Promise.all([getMedicalInsuranceInvoice(id), getMedicalInsuranceView()]);
    if (!invoice || !view) return NextResponse.json({ error: "not_found", message: "That invoice is no longer on file." }, { status: 404 });

    const generatedAtIso = new Date().toISOString();
    const buffer = await buildMedicalInsuranceInvoiceWorkbook({
      comparedAt: invoice.comparedAt,
      comparison: invoice.comparison,
      exportedByName: view.employees.find((employee) => employee.hrId === access.hrId)?.name ?? access.loginId ?? "Phoenix user",
      generatedAtIso,
      parsed: invoice.parsed,
      policy: view.policy,
    });
    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: id,
      entityType: "medical_insurance_export",
      summary: `Exported medical insurance bill ${invoice.billNumber}`,
    });
    return medicalInsuranceWorkbookResponse(buffer, `medical-insurance-invoice-${invoice.billNumber.replace(/[^A-Za-z0-9-]+/g, "-")}.xlsx`);
  } catch (error) {
    return medicalInsuranceErrorResponse(error, "medical_insurance_invoice_export_failed");
  }
}
