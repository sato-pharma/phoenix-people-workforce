import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { medicalInsuranceErrorResponse, medicalInsuranceWorkbookResponse } from "@/lib/medical-insurance/route-helpers";
import { getMedicalInsuranceMovementInput } from "@/lib/medical-insurance/service";
import { buildMedicalInsuranceMovementWorkbook, medicalInsuranceFileDay } from "@/lib/medical-insurance/workbooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The insurer's additions and deletions form, filled from today's list. It builds a file and sends nothing. */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "medical_insurance", "export");
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:medical-insurance-movements" });

    const input = await getMedicalInsuranceMovementInput();
    if (!input) return NextResponse.json({ error: "no_policy", message: "No medical insurance policy has been set up yet." }, { status: 404 });

    const generatedAtIso = new Date().toISOString();
    const { additions, buffer, deletions } = await buildMedicalInsuranceMovementWorkbook({ ...input, generatedAtIso });
    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: input.policy.id,
      entityType: "medical_insurance_export",
      summary: `Built the medical insurance additions and deletions form (${additions} additions, ${deletions} deletions)`,
    });
    return medicalInsuranceWorkbookResponse(buffer, `medical-insurance-additions-deletions-${medicalInsuranceFileDay(generatedAtIso)}.xlsx`);
  } catch (error) {
    return medicalInsuranceErrorResponse(error, "medical_insurance_movement_file_failed");
  }
}
