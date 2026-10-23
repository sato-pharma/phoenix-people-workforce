import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { loadCrmDoctorAreas, loadCrmDoctorsForArea } from "@/lib/marketing-requests/crm-doctor-pick-service";
import { assertMarketingRequestAccess } from "@/lib/marketing-requests/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Customer Validation's area → doctor pick (owner, 2026-10-23). With no `?area=` it answers the areas
 * the viewer may choose; with one, that area's reps' Phoenix CRM doctors. Read-only.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    assertMarketingRequestAccess(access);
    const area = new URL(request.url).searchParams.get("area");
    return NextResponse.json(area ? await loadCrmDoctorsForArea(access, area) : await loadCrmDoctorAreas(access));
  } catch (error) {
    const apiError = toApiError(error, "Could not load the doctor list.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
