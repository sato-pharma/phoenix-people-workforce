import { NextResponse } from "next/server";

import { jsonError } from "@/app/api/territory-management/_lib/route-utils";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { loadTerritoryScopeOverview } from "@/lib/territory-management/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    // Same boundary as /filters and /map: sales:read gates the route, resolveTerritoryScope
    // (inside loadTerritoryScopeOverview) narrows the actual content to the caller's own patch.
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");

    return NextResponse.json({ lines: await loadTerritoryScopeOverview(access) });
  } catch (error) {
    return jsonError(error, "Failed to load your territory scope.");
  }
}
