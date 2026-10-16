import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { editDoubleVisitRequestDays } from "@/lib/phoenix-crm/server/double-visit-requests";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = the rep changes the days of a double-visit request he raised (owner, 2026-10-16: "make him then
// able to edit the timing but never cancel his request"). `create`, the rep's own work, narrowed in the
// service to the territory's own rep and to the rep recorded on the request itself. THERE IS NO CANCEL
// ROUTE, and none is to be added.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const view = await editDoubleVisitRequestDays(viewer, body);
    return NextResponse.json({ success: true, view });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the new days.");
  }
}
