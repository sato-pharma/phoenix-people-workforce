import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { getTerritoryClosingTotals } from "@/lib/sales/territory/service";

import { isTerritoryDrilldownRole, jsonError } from "../_lib/route-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Region and area totals at a glance, from the closing engine over the window's published months.
// Fetched by the tree after first paint, so the page never waits on it. The service re-derives the
// caller's scope and skeleton on this request, so the totals name only the caller's own areas.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");
    if (!isTerritoryDrilldownRole(access.role)) {
      return NextResponse.json(
        { success: false, error: "forbidden", message: "This role doesn't have a territory drilldown yet." },
        { status: 403 },
      );
    }

    // Super Admin / CEO drill a line they pick; every other role's line is derived and this is ignored.
    const selectedLine = new URL(request.url).searchParams.get("line");
    const totals = await getTerritoryClosingTotals(access, selectedLine);
    return NextResponse.json({ success: true, totals });
  } catch (error) {
    return jsonError(error, "Failed to load territory totals.");
  }
}
