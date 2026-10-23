import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { canReadAllProbation } from "@/lib/probation/service";
import { canSubmitSfeAssessment } from "@/lib/probation/intelligence/assessments";
import { getCaseScore } from "@/lib/probation/intelligence/scoring-service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Live provisional score + contradictions for a probation case. Advisory only (no decision).
// Company-wide oversight surface (+ SFE Manager), matching the report page gate.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ caseId: string }> },
) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "probation", "read");
    if (!canReadAllProbation(access) && !canSubmitSfeAssessment(access)) {
      return NextResponse.json({ error: "Forbidden: the probation score requires company-wide probation access." }, { status: 403 });
    }
    const { caseId } = await params;
    const result = await getCaseScore(caseId);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    const message = String((error as { message?: unknown })?.message ?? error);
    if (message.toLowerCase().includes("not found")) return NextResponse.json({ error: message }, { status: 404 });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
