import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { transitionManagerPlan } from "@/lib/phoenix-crm/server/manager-plans";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = he sends his week to its first approver. `read`, narrowed in the service to his OWN week
// (`assertManagerPlanWriter`). The action is fixed here, so this route can never decide a week.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const sent = { ...(body && typeof body === "object" ? (body as Record<string, unknown>) : {}), action: "submit" };
    const plan = await transitionManagerPlan(viewer, sent);
    return NextResponse.json({ plan, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not send the week.");
  }
}
