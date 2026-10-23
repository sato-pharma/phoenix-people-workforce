import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { canReadAllProbation } from "@/lib/probation/service";
import { canSubmitSfeAssessment } from "@/lib/probation/intelligence/assessments";
import { buildConsolidatedReport } from "@/lib/probation/intelligence/consolidated-report";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The always-live consolidated probation report for a case. Computed on read (no batch). The
// service redacts confidential content for non-HR/CEO viewers. The full intelligence dossier is a
// company-wide oversight surface (+ the SFE Manager for their assessment), matching the report page
// gate — coarse probation:read alone must not expose any case's dossier by id.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ caseId: string }> },
) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "probation", "read");
    if (!canReadAllProbation(access) && !canSubmitSfeAssessment(access)) {
      return NextResponse.json({ error: "Forbidden: the consolidated probation report requires company-wide probation access." }, { status: 403 });
    }
    const { caseId } = await params;
    const report = await buildConsolidatedReport(access, caseId);
    return NextResponse.json({ report }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    const message = String((error as { message?: unknown })?.message ?? error);
    if (message.toLowerCase().includes("not found")) return NextResponse.json({ error: message }, { status: 404 });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
