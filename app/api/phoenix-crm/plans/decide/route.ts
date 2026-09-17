import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { validationError } from "@/lib/http/api-errors";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { transitionPlan } from "@/lib/phoenix-crm/server/plans";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = a decision on a sent plan: the territory's reviewing manager approves or returns it; the SFE
// Manager can only return one. A return carries a note for the rep. Nothing is ever approved by the
// system. Both narrowings live in the service (assertReviewer, assertCanReturnPlan).
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "approve");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const action = body && typeof body === "object" ? (body as Record<string, unknown>).action : null;
    if (action !== "approve" && action !== "return") throw validationError("Reload the page and try again.");
    const plan = await transitionPlan(viewer, body);
    return NextResponse.json({ plan, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the decision on the plan.");
  }
}
