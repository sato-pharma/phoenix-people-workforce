import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { readWorldFor, resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { askSingleVisitDay, loadSingleVisitDaysView } from "@/lib/phoenix-crm/server/manager-single-visit-days";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A district sales manager's ask for a second or third day of single visits (owner, 2026-10-20): one named
// date, decided by his regional manager and then the national sales manager above him.
//
// GET = his asks for this week and the coming one, and the days he may still ask for. `read`, narrowed in
// the service to the district manager himself — anyone else reads an empty view.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const days = await loadSingleVisitDaysView(viewer, readWorldFor(viewer, searchOf(request).get("test")));
    return NextResponse.json({ days, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load your asks for a day of single visits.");
  }
}

// POST = he asks for one date. `read`, narrowed in the service to a district manager who plans his own week
// (`assertManagerPlanWriter`); its approvers decide it in the Approvals Hub.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const days = await askSingleVisitDay(viewer, body);
    return NextResponse.json({ days, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not send the ask for a day of single visits.");
  }
}
