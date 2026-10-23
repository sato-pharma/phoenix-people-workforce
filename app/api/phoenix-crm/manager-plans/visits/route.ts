import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadManagerToday, logManagerVisit, saveManagerVisitDetail } from "@/lib/phoenix-crm/server/manager-visits";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// His own single visits (owner, 2026-10-16): planned or unplanned, location optional, no photo, products
// and comment optional. They count in HIS OWN report only — never a rep's figure, never a territory KPI.
//
// GET = today's planned single-visit customers and what he already logged. `read`, narrowed in the
// service to the district manager himself.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const today = await loadManagerToday(viewer, { test: search.get("test") });
    return NextResponse.json({ today, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load today's single visits.");
  }
}

// POST = one visit logged. `read`, narrowed in the service to the manager who plans the week himself
// (`assertManagerPlanWriter`).
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const today = await logManagerVisit(viewer, body);
    return NextResponse.json({ today, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the visit.");
  }
}

// PATCH = the write-up he comes back and adds to a visit he already logged (owner, 2026-10-23). `read`,
// the same permission as logging one, narrowed twice in the service: `assertManagerPlanWriter` for the
// kind of viewer, then the visit's own `manager_hr_id` for this visit — it moves `detail_comment` and
// nothing else, so the door comment, the products and the location stay as they were recorded.
export async function PATCH(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const today = await saveManagerVisitDetail(viewer, body);
    return NextResponse.json({ today, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the write-up.");
  }
}
