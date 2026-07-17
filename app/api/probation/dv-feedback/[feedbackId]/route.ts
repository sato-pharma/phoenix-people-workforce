import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { editDvFeedback } from "@/lib/probation/intelligence/feedback-workflow";

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

// Edit an existing DV feedback. Creates a new immutable version with the required edit reason;
// row-level authorization is enforced in the service.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ feedbackId: string }> },
) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "probation", "read");

    const { feedbackId } = await params;
    const body = await request.json();
    const editReason = body.editReason ? String(body.editReason) : "";

    const feedback = await editDvFeedback(
      access,
      feedbackId,
      {
        scores: (body.scores && typeof body.scores === "object" ? body.scores : {}) as Record<string, unknown>,
        recommendation: body.recommendation ? String(body.recommendation) : null,
        strengths: body.strengths ? String(body.strengths) : null,
        developmentAreas: body.developmentAreas ? String(body.developmentAreas) : null,
        objectiveObservations: body.objectiveObservations ? String(body.objectiveObservations) : null,
        confidentialNote: body.confidentialNote ? String(body.confidentialNote) : null,
      },
      editReason,
    );

    return NextResponse.json({ feedback });
  } catch (error) {
    const { status, message } = mapError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
