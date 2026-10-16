import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadDoubleVisitPlan } from "@/lib/phoenix-crm/server/double-visit-plans";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The district manager's double-visit plan (owner, 2026-10-02): which of his reps he joins on which
// day, AM or PM, and afterwards whether he did. The rep never sees it.
//
// GET = one week of it. `read` here, and narrowed in the service to that district manager, the SFE
// Manager and the Super Admin (`resolveDoubleVisitPlanReader`) — a rep, another district manager, a
// regional or national manager and the CEO are refused.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const plan = await loadDoubleVisitPlan(viewer, { week: search.get("week"), manager: search.get("manager"), test: search.get("test") });
    return NextResponse.json({ plan, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the double visits.");
  }
}

// POST = 410 Gone. The district manager's weekly plan (owner, 2026-10-16) replaced this planner: he now
// plans each half-day with a rep, an admin activity or single visits at /api/phoenix-crm/manager-plans,
// sent to his RSM/NSM. The GET stays, so a week planned here can still be read. Same gate as before, so
// a stale screen is answered and a stranger is still refused.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    await resolvePhoenixCrmViewer(access);
    return NextResponse.json(
      {
        error: "superseded",
        message: "The double-visit planner was replaced by the weekly plan. Open Phoenix CRM, then Plan, to plan your week.",
        success: false,
      },
      { status: 410 },
    );
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the double visit.");
  }
}
