import { NextResponse } from "next/server";

import { unauthenticatedSessionResponse } from "@/lib/auth/api-session-response";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import { loadCrmTripEvidence } from "@/lib/outstation/crm-trip-evidence-reader";
import { parseOutstationRequestId } from "@/lib/outstation/request-id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Phoenix CRM on one outstation trip, day by day, for Expense Approvals (owner, 2026-11-07: "wire
 * the Phoenix CRM with the expense module"). Read-only. The Super Admin who approves alone: the
 * reading carries the open location warnings, which are his alone on the integrity board.
 * `found: false` (200) when the source request no longer exists, so an imported trip degrades to
 * "nothing to read" instead of an error.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    const unauthenticated = unauthenticatedSessionResponse(access);
    if (unauthenticated) return unauthenticated;
    await assertOutstationAdminAccess(access, "approve");

    const { id: rawId } = await params;
    const id = parseOutstationRequestId(rawId);
    if (id === null) {
      return NextResponse.json({ error: "invalid_outstation_id", message: "Request id is invalid." }, { status: 400 });
    }
    return NextResponse.json(await loadCrmTripEvidence(id));
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Phoenix CRM could not be read for this trip.");
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "crm_evidence_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
