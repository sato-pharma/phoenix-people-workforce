import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { medicalInsuranceErrorResponse, medicalInsuranceWorkbookResponse, readJsonBody } from "@/lib/medical-insurance/route-helpers";
import { prepareLibanoMemberFile } from "@/lib/medical-insurance/service";
import { buildLibanoMemberFileWorkbook, medicalInsuranceFileDay } from "@/lib/medical-insurance/workbooks";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILE_WORDS = { additions: "additions", deletions: "deletions", everyone: "everyone-covered" } as const;

/**
 * Libano-Suisse's member file for the people ticked on the page: additions, deletions, or everyone covered
 * today. POST because the ticked list rides in the body, not the address. It builds a file and sends
 * nothing; the register does not change.
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "medical_insurance", "export");
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:medical-insurance-movements" });

    const file = await prepareLibanoMemberFile(await readJsonBody(request));
    const buffer = await buildLibanoMemberFileWorkbook(file);
    const generatedAtIso = new Date().toISOString();
    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: file.policyId,
      entityType: "medical_insurance_export",
      summary: `Built the insurer's member file (${file.kind}) for ${file.rows.length} ${file.rows.length === 1 ? "person" : "people"}`,
    });
    return medicalInsuranceWorkbookResponse(buffer, `Libano-Suisse-members-${FILE_WORDS[file.kind]}-${medicalInsuranceFileDay(generatedAtIso)}.xlsx`);
  } catch (error) {
    return medicalInsuranceErrorResponse(error, "medical_insurance_movement_file_failed");
  }
}
