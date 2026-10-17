import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { decideOldCrmPlan } from "@/lib/phoenix-crm/server/old-crm-plan-approval";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = a decision on the week a rep filed in the OLD CRM: the district manager (or the regional manager
// above him) approves it, or takes that approval back. The one route that writes a rep's week into
// iReports360 from the Team tab; the service holds the gates (the role list, the `crm_plans:approve` grant,
// the viewer's reach against the plan's own rep) and the Phoenix refusals (the Super Admin decides nothing).
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "approve");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json().catch(() => ({}))) as unknown;
    const decision = await decideOldCrmPlan(viewer, body);
    return NextResponse.json({ decision, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the decision on the old CRM plan.");
  }
}
