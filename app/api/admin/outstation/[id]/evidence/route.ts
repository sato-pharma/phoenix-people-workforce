import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { releaseOutstationRequestWithoutEvidence } from "@/lib/outstation/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Release a request the evidence gate is holding on a photo that can never arrive.
 *
 *   { reason: "..." }  -> waive the evidence gate and push the request into payroll
 *
 * Super Admin only, enforced inside the service (assertOutstationAdminAccess with "approve", which
 * excludes the execution-only finance roles). The route does not re-implement that check — one
 * authority for it, in the domain — and it deliberately lives apart from the workload repair route
 * so a waiver can never be reached by sending an unexpected `action` to a different endpoint.
 */
function evidenceReleaseStatus(error: unknown) {
  if (isForbiddenError(error)) return 403;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  // Not a failure of the request — a statement that this is the wrong tool for this row.
  if (message.includes("not held by the evidence gate") || message.includes("waiting on its workload")) {
    return 409;
  }
  if (message.includes("required") || message.includes("not available")) return 400;
  return 500;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);

    const { id: rawId } = await params;
    const id = Number(rawId);
    if (!Number.isFinite(id)) {
      return NextResponse.json(
        { error: "invalid_outstation_id", message: "Request id is invalid." },
        { status: 400 },
      );
    }

    const body = (await request.json()) as Record<string, unknown>;
    const result = await releaseOutstationRequestWithoutEvidence(id, access, {
      reason: body.reason,
    });

    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    return NextResponse.json(
      {
        error: isForbiddenError(error) ? "forbidden" : "outstation_evidence_release_failed",
        message: error instanceof Error ? error.message : "Unable to release the request.",
      },
      { status: evidenceReleaseStatus(error) },
    );
  }
}
