import { NextResponse } from "next/server";

import { unauthenticatedSessionResponse } from "@/lib/auth/api-session-response";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { loadPlannedTripAreas } from "@/lib/outstation/crm-trip-evidence-reader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The areas of the caller's OWN sent Phoenix CRM plan on the trip days, for the expense wizard's
 * "your plan for these days" line (owner, 2026-11-07: "Wizard suggests destination"). Only ever the
 * caller's own plan — no hr id is taken from the request. The destination stays the live GPS capture.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const unauthenticated = unauthenticatedSessionResponse(access);
    if (unauthenticated) return unauthenticated;
    await assertPermission(access, "outstation", "read");

    const url = new URL(request.url);
    const start = url.searchParams.get("tripStartDate") ?? "";
    const end = url.searchParams.get("tripEndDate") || start;
    const hrId = access.hrId || access.loginId || "";
    if (!hrId || !start) return NextResponse.json({ areas: [], plannedDays: 0, tripDays: 0 });
    return NextResponse.json(await loadPlannedTripAreas(hrId, start, end));
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Your plan could not be read.");
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "planned_areas_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
