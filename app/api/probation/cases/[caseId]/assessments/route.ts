import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { canReadAllProbation } from "@/lib/probation/service";
import {
  getCaseAssessments,
  getSfeEvidencePreview,
  canSubmitSfeAssessment,
} from "@/lib/probation/intelligence/assessments";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Current SFE + HR assessments for a case, plus a live SFE evidence preview. Confidential notes
// are redacted for non-HR/CEO roles inside the service. Company-wide oversight surface (+ SFE
// Manager), matching the report page gate.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ caseId: string }> },
) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "probation", "read");
    if (!canReadAllProbation(access) && !canSubmitSfeAssessment(access)) {
      return NextResponse.json({ error: "Forbidden: probation assessments require company-wide probation access." }, { status: 403 });
    }
    const { caseId } = await params;

    const [assessments, sfeEvidence] = await Promise.all([
      getCaseAssessments(access, caseId),
      getSfeEvidencePreview(caseId).catch(() => null),
    ]);

    return NextResponse.json({ assessments, sfeEvidence }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    const message = String((error as { message?: unknown })?.message ?? error);
    if (message.toLowerCase().includes("not found")) return NextResponse.json({ error: message }, { status: 404 });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
