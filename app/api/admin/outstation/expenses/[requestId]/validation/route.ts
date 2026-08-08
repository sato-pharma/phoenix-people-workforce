import { NextResponse } from "next/server";

import { assertOutstationExpenseApprovalReviewAccess } from "@/lib/auth/permissions";
import { unauthenticatedSessionResponse } from "@/lib/auth/api-session-response";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getOutstationClaimValidation } from "@/lib/outstation/expense-claim-validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Claim validation for one outstation expense — does the day's CRM activity corroborate it?
 *
 * Read-only and gated to the roles that may REVIEW approvals (Super Admin and, since 2026-08-08,
 * the CEO). Deliberately a per-request endpoint rather than a field on the list read: assembling
 * this costs several round trips to a database on another continent, and computing it for every
 * row in the queue would pay that cost over and over for panels nobody opens.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ requestId: string }> },
) {
  try {
    const access = await resolveAccessContext(request);
    const unauthenticated = unauthenticatedSessionResponse(access);
    if (unauthenticated) return unauthenticated;
    assertOutstationExpenseApprovalReviewAccess(access, "outstation claim validation");

    const { requestId: rawId } = await params;
    const requestId = Number(rawId);
    if (!Number.isFinite(requestId)) {
      return NextResponse.json(
        { error: "invalid_outstation_id", message: "Request id is invalid." },
        { status: 400 },
      );
    }

    // getOutstationClaimValidation never throws — a CRM outage returns { available: false }
    // rather than failing the approval screen this panel sits inside.
    return NextResponse.json(await getOutstationClaimValidation(requestId));
  } catch (error) {
    return NextResponse.json(
      {
        error: isForbiddenError(error) ? "forbidden" : "outstation_claim_validation_failed",
        message: error instanceof Error ? error.message : "Unable to load the claim validation.",
      },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
