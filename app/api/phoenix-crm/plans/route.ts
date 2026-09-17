import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadPlanner, savePlan } from "@/lib/phoenix-crm/server/plans";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET  = one territory's week in the planner: the days, what is placed on each, the caps, the
//        suggestions and the far-apart days. Anyone who reads the territory.
// POST = save the week's draft (the rep only; checked against the version on screen, days from today
//        onward only). Sending it for review is /plans/submit.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const planner = await loadPlanner(viewer, { seatId: search.get("seatId"), test: search.get("test"), weekStart: search.get("weekStart") });
    return NextResponse.json({ planner, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not open the weekly plan.");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const plan = await savePlan(viewer, body);
    return NextResponse.json({ plan, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the plan.");
  }
}
