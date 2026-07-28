import { NextResponse } from "next/server";

import { jsonError } from "@/app/api/territory-management/_lib/route-utils";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { loadTerritoryFilters } from "@/lib/territory-management/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    // Territory Management reads sales geography. Nav hides the link for roles without it, but
    // this is the boundary.
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");

    const lineCode = new URL(request.url).searchParams.get("lineCode");
    return NextResponse.json(await loadTerritoryFilters(lineCode));
  } catch (error) {
    return jsonError(error, "Failed to load territory filters.");
  }
}
