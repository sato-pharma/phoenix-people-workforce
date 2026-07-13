import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { submitDvFeedback } from "@/lib/probation/intelligence/feedback-workflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function mapError(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? error);
  const lower = message.toLowerCase();
  if (isForbiddenError(error) || lower.includes("forbidden")) return { status: 403, message };
  if (lower.includes("not found")) return { status: 404, message };
  if (lower.includes("conflict")) return { status: 409, message };
  if (lower.includes("validation failed") || lower.includes("invalid state")) return { status: 400, message };
  return { status: 500, message };
}

// Submit the structured scorecard feedback for a validated DV-Day. Row-level authorization
// (caller is the DV-Day evaluator, or an audited admin override) is enforced in the service.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ dvDayId: string }> },
) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "probation", "read");

    const { dvDayId } = await params;
    const body = await request.json();

    const feedback = await submitDvFeedback(access, dvDayId, {
      scores: (body.scores && typeof body.scores === "object" ? body.scores : {}) as Record<string, unknown>,
      recommendation: body.recommendation ? String(body.recommendation) : null,
      strengths: body.strengths ? String(body.strengths) : null,
      developmentAreas: body.developmentAreas ? String(body.developmentAreas) : null,
      objectiveObservations: body.objectiveObservations ? String(body.objectiveObservations) : null,
      confidentialNote: body.confidentialNote ? String(body.confidentialNote) : null,
      developmentActions: Array.isArray(body.developmentActions)
        ? body.developmentActions
            .filter((a: unknown): a is { title: unknown } => Boolean(a) && typeof a === "object")
            .map((a: Record<string, unknown>) => ({
              title: String(a.title ?? ""),
              description: a.description ? String(a.description) : null,
              ownerHrId: a.ownerHrId ? String(a.ownerHrId) : null,
              dueDate: a.dueDate ? String(a.dueDate) : null,
              scoreCategory: a.scoreCategory ? String(a.scoreCategory) : null,
            }))
        : undefined,
    });

    return NextResponse.json({ feedback }, { status: 201 });
  } catch (error) {
    const { status, message } = mapError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
