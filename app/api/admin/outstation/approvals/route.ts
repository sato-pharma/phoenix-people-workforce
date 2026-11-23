import { NextResponse } from "next/server";

import { unauthenticatedSessionResponse } from "@/lib/auth/api-session-response";
import {
  assertOutstationExpenseApprovalReviewAccess,
  assertSystemAdministratorWorkspaceAccess,
  canDecideOutstationExpenseApprovals,
} from "@/lib/auth/permissions";
import { assertRealSessionForDecision, isPreviewSession } from "@/lib/auth/preview-session-guard";
import { resolveAccessContext } from "@/lib/auth/server";
import { parseJsonBody } from "@/lib/http/request-body";
import { decideDeskClaims } from "@/lib/outstation/approvals/decide";
import { DeskDecideBodySchema } from "@/lib/outstation/approvals/decision-body";
import { loadDeskQueue } from "@/lib/outstation/approvals/queue";
import { deskRouteFailure } from "@/lib/outstation/approvals/route-failure";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/admin/outstation/approvals";

/**
 * Expense Approvals — what waits, and the press that decides it.
 *
 * GET reads the claims that wait (never the history) with each one's checks. Reading is open to the
 * Super Admin and the CEO; `canDecide` tells the page whether to draw the buttons, and is a courtesy
 * only — POST below is the boundary.
 *
 * POST decides one claim or the whole Ready lane. Order: same-origin, a signed-in session, the
 * Super Admin's workspace, a REAL session (never the development preview or View as Seat), then the
 * body. Each claim answers for itself (`saved`, `changed`, `refused`), so one stale claim never
 * fails the others. What a press may carry is `DeskDecideBodySchema`: five fields, no figures.
 */
export async function GET(request: Request) {
  let access: Awaited<ReturnType<typeof resolveAccessContext>> | null = null;
  try {
    access = await resolveAccessContext(request);
    const unauthenticated = unauthenticatedSessionResponse(access);
    if (unauthenticated) return unauthenticated;
    assertOutstationExpenseApprovalReviewAccess(access, "expense approvals");

    const canDecide = canDecideOutstationExpenseApprovals(access) && !isPreviewSession(access);
    return NextResponse.json(await loadDeskQueue(access, { canDecide }));
  } catch (error) {
    return deskRouteFailure({ access, code: "expense_approvals_load_failed", error, fallback: "Unable to load the expense approvals.", route: ROUTE });
  }
}

export async function POST(request: Request) {
  let access: Awaited<ReturnType<typeof resolveAccessContext>> | null = null;
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    access = await resolveAccessContext(request);
    const unauthenticated = unauthenticatedSessionResponse(access);
    if (unauthenticated) return unauthenticated;
    assertSystemAdministratorWorkspaceAccess(access, "expense approvals");
    assertRealSessionForDecision(access, "decide an expense claim");

    const parsed = await parseJsonBody(request, DeskDecideBodySchema);
    if (!parsed.ok) {
      return NextResponse.json({ error: "invalid_request_body", message: parsed.message }, { status: 400 });
    }

    const outcomes = await decideDeskClaims(access, parsed.data.decisions);
    return NextResponse.json({ outcomes, saved: outcomes.filter((outcome) => outcome.code === "saved").length });
  } catch (error) {
    return deskRouteFailure({ access, code: "expense_approvals_decide_failed", error, fallback: "The server failed part-way through. A decision may have been saved: read the list again.", route: ROUTE });
  }
}
