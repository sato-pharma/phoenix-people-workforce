import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { listManagerPlanConversation, postManagerPlanConversation } from "@/lib/phoenix-crm/server/manager-plan-conversation";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A manager's weekly-plan conversation (owner, 2026-11-01). `read`, narrowed in the service to whoever opens
// that week in the Approvals Hub: the manager, his approvers, the managers above him, SFE, the CEO and the
// Super Admin. The thread's component posts to the same address it reads, so the plan is in the query string.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const data = await listManagerPlanConversation(viewer, { plan: search.get("plan"), test: search.get("test") });
    return NextResponse.json({ data, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not read this week's conversation.");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const posted = (await request.json().catch(() => ({}))) as { body?: unknown };
    const data = await postManagerPlanConversation(viewer, { plan: search.get("plan"), test: search.get("test"), body: posted.body });
    return NextResponse.json({ data, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not post your message.");
  }
}
