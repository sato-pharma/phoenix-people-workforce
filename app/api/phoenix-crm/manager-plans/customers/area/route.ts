import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadAreaCustomers } from "@/lib/phoenix-crm/server/manager-customers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = the customers of one area of his district for a single visit: that area's rep lists, then his own
// list. `read`, narrowed in the service to the district manager himself and the territories under him — or,
// for a planner who picks a scope, to the half's district or line (`scope`).
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const area = await loadAreaCustomers(viewer, { area: search.get("area"), test: search.get("test"), scope: search.get("scope") });
    return NextResponse.json({ area, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the area's customers.");
  }
}
