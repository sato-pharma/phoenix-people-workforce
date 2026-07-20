import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { getTerritorySkeleton } from "@/lib/sales/territory/service";

import { isTerritoryDrilldownRole, jsonError } from "./_lib/route-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Tier-1 geography skeleton (names + codes, no sales figures) bounded to the caller's
// resolved root scope. Cheap master data — safe to load in full on every page visit. The
// expensive, scope-varying pharmacy-level data is the separate area/[areaCode] lazy fetch.
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

    const skeleton = await getTerritorySkeleton(access);
    return NextResponse.json({ success: true, skeleton });
  } catch (error) {
    return jsonError(error, "Failed to load territory drilldown.");
  }
}
