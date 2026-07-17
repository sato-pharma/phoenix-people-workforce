import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { decideProbation } from "@/lib/probation/intelligence/decision";
import type { ProbationCaseDecision } from "@/lib/probation/intelligence/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function mapError(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? error);
  const lower = message.toLowerCase();
  if (isForbiddenError(error) || lower.includes("forbidden")) return { status: 403, message };
  if (lower.includes("not found")) return { status: 404, message };
  if (lower.includes("conflict")) return { status: 409, message };
  if (lower.includes("validation failed")) return { status: 400, message };
  return { status: 500, message };
}

// Record the authorized human final decision (Pass / Terminate). Side effects run exactly once.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ caseId: string }> },
) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    // Coarse gate; the fine authority (CEO / Super Admin / NSM-in-scope) is enforced in the service.
    await assertPermission(access, "probation", "read");

    const { caseId } = await params;
    const body = await request.json();

    const result = await decideProbation(access, caseId, {
      outcome: String(body.outcome ?? "") as ProbationCaseDecision,
      comment: body.comment ? String(body.comment) : "",
      evidenceAcknowledged: body.evidenceAcknowledged === true,
      overrideReason: body.overrideReason ? String(body.overrideReason) : null,
    });

    return NextResponse.json({ result }, { status: 201 });
  } catch (error) {
    const { status, message } = mapError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
