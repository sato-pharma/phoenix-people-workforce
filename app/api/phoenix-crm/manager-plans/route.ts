import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadManagerPlanBoard, saveManagerPlanSlot } from "@/lib/phoenix-crm/server/manager-plans";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The district manager's weekly plan in Phoenix CRM (owner, 2026-10-16): for each half-day he goes with a
// rep and ticks that rep's own customers, does an admin activity, or makes single visits in an area of his
// district. The rep never sees it.
//
// GET = one week of it. `read`, narrowed in the service (`resolveManagerPlanReader`) to that district
// manager, the managers above him, SFE, the CEO and the Super Admin — a rep is refused.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const board = await loadManagerPlanBoard(viewer, {
      week: search.get("week"),
      manager: search.get("manager"),
      test: search.get("test"),
      scope: search.get("scope"),
    });
    return NextResponse.json({ board, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the weekly plan.");
  }
}

// POST = one half-day set, changed or cleared. `read`, narrowed in the service to the manager's OWN week
// (`assertManagerPlanWriter`, which also asks a district manager for `create`): a regional, national or
// product manager plans his week with `read` alone (owner, 2026-10-17). The Super Admin plans nobody's week.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const board = await saveManagerPlanSlot(viewer, body);
    return NextResponse.json({ board, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the half-day.");
  }
}
