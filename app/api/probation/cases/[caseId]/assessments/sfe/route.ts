import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { submitSfeAssessment } from "@/lib/probation/intelligence/assessments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function mapError(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? error);
  const lower = message.toLowerCase();
  if (isForbiddenError(error) || lower.includes("forbidden")) return { status: 403, message };
  if (lower.includes("not found")) return { status: 404, message };
  if (lower.includes("validation failed")) return { status: 400, message };
  if (lower.includes("blocked")) return { status: 409, message };
  return { status: 500, message };
}

// Submit the SFE assessment (SFE Manager or probation admin). System evidence is recomputed at
// submit time and stored alongside the human score/overrides.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ caseId: string }> },
) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "probation", "read");
    const { caseId } = await params;
    const body = await request.json();

    const assessment = await submitSfeAssessment(access, caseId, {
      score: body.score === null || body.score === undefined ? null : Number(body.score),
      comments: body.comments ? String(body.comments) : null,
      overrides: body.overrides && typeof body.overrides === "object" ? body.overrides : {},
      overrideReason: body.overrideReason ? String(body.overrideReason) : null,
      confidentialNote: body.confidentialNote ? String(body.confidentialNote) : null,
    });

    return NextResponse.json({ assessment }, { status: 201 });
  } catch (error) {
    const { status, message } = mapError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
