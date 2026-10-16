import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadDoubleVisitCustomerView } from "@/lib/phoenix-crm/server/double-visit-requests";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = one customer's double-visit requests, with the answer of every person asked (owner, 2026-10-16).
// `read`, narrowed in the service by the list's own seat gate (`territoryForRead`): whoever may open the
// customer reads them. There is no POST here on purpose — a request is raised only by the rep's own visit
// (the last question of Add visit), and it is never cancelled.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const view = await loadDoubleVisitCustomerView(viewer, {
      seatId: search.get("seatId"),
      customerId: search.get("customerId"),
      test: search.get("test"),
    });
    return NextResponse.json({ success: true, view });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load this customer's double visit requests.");
  }
}
