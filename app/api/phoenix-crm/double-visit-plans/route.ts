import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadDoubleVisitPlan, saveDoubleVisitSlot } from "@/lib/phoenix-crm/server/double-visit-plans";
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

// POST = one half-day set, changed or cleared. `create`, the district manager's own work, and narrowed
// in the service to the district manager's OWN plan (`assertDoubleVisitPlanWriter`); the Super Admin
// writes one only in test mode. SFE (no `create`) reads and never writes. Nobody is notified.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const plan = await saveDoubleVisitSlot(viewer, body);
    return NextResponse.json({ plan, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the double visit.");
  }
}
