import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { startServerTimer } from "@/lib/http/server-timing";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadTerritoryList } from "@/lib/phoenix-crm/server/list";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = one territory's customer list: the validated customers with their places and timings, the
// iReports360 reference still to validate, readiness and the grade and drop requests.
export async function GET(request: Request) {
  const timer = startServerTimer("crm_list");
  try {
    const access = await resolveAccessContext(request);
    timer.lap("access");
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await timer.measure("viewer", () => resolvePhoenixCrmViewer(access));
    const search = searchOf(request);
    const list = await timer.measure("load", () => loadTerritoryList(viewer, search.get("seatId"), search.get("test")));
    return NextResponse.json({ list, success: true }, { headers: timer.headers() });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the customer list.");
  }
}
