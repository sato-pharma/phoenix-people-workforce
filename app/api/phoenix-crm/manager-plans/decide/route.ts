import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { validationError } from "@/lib/http/api-errors";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { transitionManagerPlan } from "@/lib/phoenix-crm/server/manager-plans";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = a decision on a sent week: approve it, return it, or return ONE day of it. `read`, narrowed in the
// service to the approver STORED on the row for its stage (`managerPlanDeciderRole`) — his RSM/NSM, the
// NSM after a regional manager, or for a regional, national or product manager his own manager and the CEO,
// who hold `read` alone (owner, 2026-10-17) — or the Administrator in that person's place, recorded as such.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const action = body && typeof body === "object" ? (body as Record<string, unknown>).action : null;
    if (action !== "approve" && action !== "return") throw validationError("Reload the page and try again.");
    const plan = await transitionManagerPlan(viewer, body);
    return NextResponse.json({ plan, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the decision on the week.");
  }
}
