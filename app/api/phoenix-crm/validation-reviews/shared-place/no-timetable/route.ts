import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { setSharedPlaceNoTimetable } from "@/lib/phoenix-crm/server/failing-timetables";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST ONLY: declare that one polyclinic or centre has NO timetable, or take that back (owner, 14 Nov
// 2026, "List + declare"). It is its own route beside the building's decision and its restore, because it
// decides nothing: it writes the screen marker on the building (`timetable_exempt_at`, `_by_hr_id`) and
// validates nobody.
//
// The Super Admin ALONE, gated in the service by `canDecideSharedPlaces`; `update` here is gate one, which
// the SFE Manager does not hold.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "update");
    const viewer = await resolvePhoenixCrmViewer(access);
    const declaration = await setSharedPlaceNoTimetable(viewer, await request.json());
    return NextResponse.json({ declaration, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save this building's timetable marker.");
  }
}
