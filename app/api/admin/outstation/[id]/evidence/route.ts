import { NextResponse } from "next/server";
import { z } from "zod";

import { assertSignedIn } from "@/lib/auth/require-signed-in";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import { releaseOutstationRequestWithoutEvidence } from "@/lib/outstation/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { ApiError, clientSafeErrorMessage } from "@/lib/http/api-errors";
import { parseJsonBody } from "@/lib/http/request-body";
import { parseOutstationRequestId } from "@/lib/outstation/request-id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What Held Requests sends (held-requests-panel.tsx): the written reason. The service requires it and says so. */
const EvidenceReleaseBodySchema = z.object({
  reason: z.string().nullable().optional(),
});

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
  if (error instanceof ApiError && error.status === 401) return 401;
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
    // REC-080: the caller is judged before the id and the body — the service's own first gate, repeated here.
    assertSignedIn(access);
    await assertOutstationAdminAccess(access, "approve");

    const { id: rawId } = await params;
    const id = parseOutstationRequestId(rawId);
    if (id === null) {
      return NextResponse.json(
        { error: "invalid_outstation_id", message: "Request id is invalid." },
        { status: 400 },
      );
    }

    const parsedBody = await parseJsonBody(request, EvidenceReleaseBodySchema);
    if (!parsedBody.ok) {
      return NextResponse.json({ error: "invalid_request_body", message: parsedBody.message }, { status: 400 });
    }
    const body = parsedBody.data;
    const result = await releaseOutstationRequestWithoutEvidence(id, access, {
      reason: body.reason,
    });

    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    return NextResponse.json(
      {
        error: isForbiddenError(error) ? "forbidden" : "outstation_evidence_release_failed",
        message: clientSafeErrorMessage(error, "Unable to release the request."),
      },
      { status: evidenceReleaseStatus(error) },
    );
  }
}
