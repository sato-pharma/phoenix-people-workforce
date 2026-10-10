import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { seatPlacesInVenue } from "@/lib/phoenix-crm/server/place-move";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = move standalone customers of one rep INTO a polyclinic he has already validated (owner,
// 2026-10-10). The Super Admin alone — the coarse verb is `update`, the same one the shared-place
// decision uses, NOT `approve`, which the SFE Manager also holds. The service repeats the gate with
// `canDecideSharedPlaces` before anything is read.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "update");
    const viewer = await resolvePhoenixCrmViewer(access);
    const seated = await seatPlacesInVenue(viewer, await request.json());
    return NextResponse.json({ seated, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not move the customers into the polyclinic.");
  }
}
