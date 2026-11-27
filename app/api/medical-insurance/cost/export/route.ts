import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { buildMedicalInsuranceMonthlyCostWorkbook } from "@/lib/medical-insurance/cost-workbook";
import { medicalInsuranceErrorResponse, medicalInsuranceWorkbookResponse } from "@/lib/medical-insurance/route-helpers";
import { getMedicalInsuranceMonthlyCost } from "@/lib/medical-insurance/service";
import { medicalInsuranceFileDay } from "@/lib/medical-insurance/workbooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/medical-insurance/cost/export — every employee and what their cover costs a month, the company's part
 * and theirs, with each person covered on a second sheet (owner, 2026-11-27: "export XLX sheet with the employee
 * and the monthly cost on him"). The Cost tab's "Who pays each month" as a file.
 *
 * 🔴 It carries amounts, so it is held to medical_insurance_invoices (Super Admin only), asserted here before
 * anything is read — never the register export's medical_insurance seat.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "medical_insurance_invoices", "read");
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:medical-insurance-monthly-cost" });

    const cost = await getMedicalInsuranceMonthlyCost(access.hrId);
    if (!cost) return NextResponse.json({ error: "no_policy", message: "No medical insurance policy has been set up yet." }, { status: 404 });

    const generatedAtIso = new Date().toISOString();
    const buffer = await buildMedicalInsuranceMonthlyCostWorkbook({
      asOf: cost.asOf,
      exportedByName: cost.exporterName ?? access.loginId ?? "Phoenix user",
      generatedAtIso,
      policy: cost.policy,
      split: cost.split,
    });
    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: cost.policy.id,
      entityType: "medical_insurance_export",
      summary: `Exported the medical insurance monthly cost (${cost.split.totals.employees} employees, ${cost.split.totals.people} people)`,
    });
    return medicalInsuranceWorkbookResponse(buffer, `medical-insurance-monthly-cost-${medicalInsuranceFileDay(generatedAtIso)}.xlsx`);
  } catch (error) {
    return medicalInsuranceErrorResponse(error, "medical_insurance_monthly_cost_export_failed");
  }
}
