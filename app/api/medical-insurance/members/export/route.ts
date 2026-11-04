import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { medicalInsuranceErrorResponse, medicalInsuranceWorkbookResponse } from "@/lib/medical-insurance/route-helpers";
import { getMedicalInsuranceView } from "@/lib/medical-insurance/service";
import { buildMedicalInsuranceRegisterWorkbook, medicalInsuranceFileDay } from "@/lib/medical-insurance/workbooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The register as XLSX. It holds no amount, so the HR seats may take it. */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "medical_insurance", "export");
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:medical-insurance-register" });

    const view = await getMedicalInsuranceView();
    if (!view) return NextResponse.json({ error: "no_policy", message: "No medical insurance policy has been set up yet." }, { status: 404 });

    const generatedAtIso = new Date().toISOString();
    const buffer = await buildMedicalInsuranceRegisterWorkbook({
      exportedByName: view.employees.find((employee) => employee.hrId === access.hrId)?.name ?? access.loginId ?? "Phoenix user",
      generatedAtIso,
      members: view.members,
      policy: view.policy,
    });
    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: view.policy.id,
      entityType: "medical_insurance_export",
      summary: `Exported the medical insurance register (${view.members.length} people)`,
    });
    return medicalInsuranceWorkbookResponse(buffer, `medical-insurance-register-${medicalInsuranceFileDay(generatedAtIso)}.xlsx`);
  } catch (error) {
    return medicalInsuranceErrorResponse(error, "medical_insurance_register_export_failed");
  }
}
