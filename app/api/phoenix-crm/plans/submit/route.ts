import { after, NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { noticeFirstPlanOnUnstartedTeam } from "@/lib/crm/phoenix-team-start-notice";
import { validationError } from "@/lib/http/api-errors";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { transitionPlan } from "@/lib/phoenix-crm/server/plans";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = the rep's own moves on a week's plan: send it to the reviewing manager, or take it back to
// change it. A manager's decision is /plans/decide, under `approve`, so neither route carries the other.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const action = body && typeof body === "object" ? (body as Record<string, unknown>).action : null;
    if (action !== "submit" && action !== "reopen") throw validationError("Reload the page and try again.");
    const plan = await transitionPlan(viewer, body);
    // The first real plan sent on a team that is not counted from Phoenix CRM tells the Super Admin, once
    // per team (owner, 2026-10-02). After the answer has gone, and never able to fail the send.
    if (action === "submit" && plan.status === "submitted") after(() => noticeFirstPlanOnUnstartedTeam(plan.planId));
    return NextResponse.json({ plan, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not send the plan.");
  }
}
