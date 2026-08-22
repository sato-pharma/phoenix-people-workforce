import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { listAreaConsolidationCandidates } from "@/lib/territory-management/area-consolidation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Legacy areas that still have rows attached, with the target the owner has ruled for each (or
// none, when he has not ruled yet). Access is enforced inside the service (Super Admin only), not
// here — the route is a transport, the service is the boundary.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const candidates = await listAreaConsolidationCandidates(access);
    return NextResponse.json({ candidates, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not load the area consolidation candidates.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
