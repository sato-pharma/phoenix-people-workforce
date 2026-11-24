import { NextResponse } from "next/server";

import { unauthenticatedSessionResponse } from "@/lib/auth/api-session-response";
import { assertSystemAdministratorWorkspaceAccess } from "@/lib/auth/permissions";
import { assertRealSessionForDecision } from "@/lib/auth/preview-session-guard";
import { resolveAccessContext } from "@/lib/auth/server";
import { parseJsonBody } from "@/lib/http/request-body";
import { editDeskClaimAmounts } from "@/lib/outstation/approvals/amounts";
import { DeskAmountsBodySchema } from "@/lib/outstation/approvals/decision-body";
import { deskRouteFailure } from "@/lib/outstation/approvals/route-failure";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/admin/outstation/approvals/amounts";

/**
 * Expense Approvals — "Save amounts": the Super Admin's own figures for one claim's four parts
 * (owner, 24 Nov 2026: "i want to be able to edit in expense value").
 *
 * The same order as the decide route: same-origin, a signed-in session, the Super Admin's
 * workspace, a REAL session (never the development preview or View as Seat), then the body. The
 * answer is the claim as it stands afterwards, with `saved`, `changed`, `refused` or
 * `amount_not_saved`.
 */
export async function POST(request: Request) {
  let access: Awaited<ReturnType<typeof resolveAccessContext>> | null = null;
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    access = await resolveAccessContext(request);
    const unauthenticated = unauthenticatedSessionResponse(access);
    if (unauthenticated) return unauthenticated;
    assertSystemAdministratorWorkspaceAccess(access, "expense approvals");
    assertRealSessionForDecision(access, "edit an expense claim's amounts");

    const parsed = await parseJsonBody(request, DeskAmountsBodySchema);
    if (!parsed.ok) {
      return NextResponse.json({ error: "invalid_request_body", message: parsed.message }, { status: 400 });
    }

    return NextResponse.json({ outcome: await editDeskClaimAmounts(access, parsed.data) });
  } catch (error) {
    return deskRouteFailure({ access, code: "expense_approvals_amounts_failed", error, fallback: "The server failed part-way through. The amounts may have been saved: read the list again.", route: ROUTE });
  }
}
