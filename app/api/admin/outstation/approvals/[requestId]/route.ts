import { NextResponse } from "next/server";

import { unauthenticatedSessionResponse } from "@/lib/auth/api-session-response";
import { assertOutstationExpenseApprovalReviewAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import { deskRouteFailure, positiveInteger } from "@/lib/outstation/approvals/route-failure";
import { loadDeskTripFile } from "@/lib/outstation/approvals/trip-file";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/admin/outstation/approvals/:requestId";

/**
 * Expense Approvals — one trip, whole, in one request: the claim with its checks, and for the
 * approver the photos, tickets, journey, road route and Phoenix CRM day by day.
 *
 * Read only. Whoever may read the desk may read the claim and its checks (Super Admin, CEO). The
 * photos and the Phoenix CRM reading stay behind the approver's own gate, the same one their own
 * routes use: a reader without it gets the claim and `evidenceWithheld: true`, never a 403 that
 * would hide the claim too.
 */
export async function GET(request: Request, { params }: { params: Promise<{ requestId: string }> }) {
  let access: Awaited<ReturnType<typeof resolveAccessContext>> | null = null;
  try {
    access = await resolveAccessContext(request);
    const unauthenticated = unauthenticatedSessionResponse(access);
    if (unauthenticated) return unauthenticated;
    assertOutstationExpenseApprovalReviewAccess(access, "expense approvals");

    const requestId = positiveInteger((await params).requestId);
    if (requestId === null) {
      return NextResponse.json({ error: "invalid_outstation_id", message: "Request id is invalid." }, { status: 400 });
    }

    let includeEvidence = false;
    try {
      await assertOutstationAdminAccess(access, "approve");
      includeEvidence = true;
    } catch (error) {
      if (!isForbiddenError(error)) throw error;
    }

    const file = await loadDeskTripFile(access, requestId, { includeEvidence });
    if (!file) {
      return NextResponse.json({ error: "not_found", message: "This claim is not on your list any more." }, { status: 404 });
    }
    return NextResponse.json(file);
  } catch (error) {
    return deskRouteFailure({ access, code: "expense_approvals_trip_failed", error, fallback: "Unable to open this trip.", route: ROUTE });
  }
}
