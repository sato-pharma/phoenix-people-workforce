import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import { getOutstationHeatmapData } from "@/lib/outstation/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertOutstationAdminAccess(access, "approve");
    const data = await getOutstationHeatmapData();
    return NextResponse.json(data);
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Unable to load outstation heatmaps.");
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "outstation_heatmaps_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
