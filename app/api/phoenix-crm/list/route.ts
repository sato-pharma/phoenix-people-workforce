import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadTerritoryList } from "@/lib/phoenix-crm/server/list";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = one territory's customer list: the validated customers with their places and timings, the
// iReports360 reference still to validate, readiness and the grade and drop requests.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const list = await loadTerritoryList(viewer, search.get("seatId"), search.get("test"));
    return NextResponse.json({ list, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the customer list.");
  }
}
