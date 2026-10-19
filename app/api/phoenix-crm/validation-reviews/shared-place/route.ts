import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { decideSharedPlace } from "@/lib/phoenix-crm/server/shared-places";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST ONLY, deliberately: the Polyclinics section is drawn from `loadSharedPlaceBoard` on the page
// itself (a server component), so a GET here would be a second, unused way into the same read — one
// more public surface to gate for nothing. The decision is the only thing the browser sends.
//
// POST = approve one, or reject it. A rejection retires the venue, retires every place seated in it and
// sends each of those customers back to To validate (owner, 2026-10-09: the administrator has the right
// to review the schedule). The Super Admin and the SFE Manager, as above (`approve` here is gate one).
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "approve");
    const viewer = await resolvePhoenixCrmViewer(access);
    const decided = await decideSharedPlace(viewer, await request.json());
    return NextResponse.json({ decided, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the decision.");
  }
}
