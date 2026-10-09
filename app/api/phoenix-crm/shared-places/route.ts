import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { createSharedPlace, loadSharedPlacesFor } from "@/lib/phoenix-crm/server/shared-places";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = the polyclinics, medical centres, towers and hospital outpatient suites already captured in one
// territory, for the picker on the validate and add-a-place screens. A reader of the territory.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const sharedPlaces = await loadSharedPlacesFor(viewer, { seatId: search.get("seatId"), test: search.get("test") });
    return NextResponse.json({ sharedPlaces, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the polyclinics and centres.");
  }
}

// POST = capture one at its door: the live photo of the sign on the building and the two location
// readings, once and for good (owner, 2026-10-09 — "the rep validates it at the door"). The
// territory's own rep or one of its managers, which is what `territoryForValidation` in the service
// means; `create` here is gate one.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const sharedPlace = await createSharedPlace(viewer, await request.json());
    return NextResponse.json({ sharedPlace, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save this polyclinic or centre.");
  }
}
