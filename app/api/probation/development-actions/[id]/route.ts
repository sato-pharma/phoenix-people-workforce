import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { canDecideProbation } from "@/lib/probation/intelligence/decision";
import { updateDevelopmentAction } from "@/lib/probation/intelligence/dev-actions";
import type { ProbationDevelopmentActionStatus } from "@/lib/probation/intelligence/types";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_STATUS: ProbationDevelopmentActionStatus[] = ["open", "in_progress", "done", "cancelled"];

// Update a probation development action (mark improvement / status). This is a state-changing WRITE, so
// it is gated on decision AUTHORITY (canDecideProbation = CEO / NSM / probation admin), NOT a read/view
// predicate — the coarse probation:read is a universal floor, and canReadAllProbation includes the
// deliberately read-only Training/Marketing Manager oversight roles. The mutation is audited.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "probation", "read");
    if (!canDecideProbation(access)) {
      return NextResponse.json({ error: "Forbidden: managing development actions requires probation decision authority." }, { status: 403 });
    }

    const { id } = await params;
    const body = await request.json();
    const status = body.status as ProbationDevelopmentActionStatus | undefined;
    if (status && !VALID_STATUS.includes(status)) {
      return NextResponse.json({ error: `status must be one of: ${VALID_STATUS.join(", ")}` }, { status: 400 });
    }

    const action = await updateDevelopmentAction(id, {
      status,
      followUpOutcome: body.followUpOutcome !== undefined ? (body.followUpOutcome ? String(body.followUpOutcome) : null) : undefined,
    }, { hrId: access.hrId, loginId: access.loginId });
    return NextResponse.json({ action });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    const message = String((error as { message?: unknown })?.message ?? error);
    if (message.toLowerCase().includes("not found")) return NextResponse.json({ error: message }, { status: 404 });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
