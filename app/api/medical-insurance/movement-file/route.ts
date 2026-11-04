import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { medicalInsuranceErrorResponse, medicalInsuranceWorkbookResponse, readJsonBody } from "@/lib/medical-insurance/route-helpers";
import { prepareMetLifeEdi } from "@/lib/medical-insurance/service";
import { buildMetLifeEdiWorkbook, medicalInsuranceFileDay } from "@/lib/medical-insurance/workbooks";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The insurer's EDI workbook for the people ticked on the page: additions or deletions, one file each.
 * POST because the ticked list rides in the body, not the address. It builds a file and sends nothing;
 * the register does not change.
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "medical_insurance", "export");
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:medical-insurance-movements" });

    const { policyId, request: edi } = await prepareMetLifeEdi(await readJsonBody(request));
    const buffer = await buildMetLifeEdiWorkbook(edi);
    const generatedAtIso = new Date().toISOString();
    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: policyId,
      entityType: "medical_insurance_export",
      summary: `Built the insurer's EDI ${edi.kind} file for ${edi.rows.length} ${edi.rows.length === 1 ? "person" : "people"}`,
    });
    return medicalInsuranceWorkbookResponse(buffer, `MetLife-EDI-${edi.kind}-${medicalInsuranceFileDay(generatedAtIso)}.xlsx`);
  } catch (error) {
    return medicalInsuranceErrorResponse(error, "medical_insurance_movement_file_failed");
  }
}
