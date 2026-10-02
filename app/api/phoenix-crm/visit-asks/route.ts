import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadVisitAskCustomerView, raiseVisitAsk } from "@/lib/phoenix-crm/server/visit-asks";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A rep's ask for a visit with somebody (owner, 2026-10-02): his manager, a product manager of his line,
// or his district manager and the manager above — on one customer of his list.
//
// GET = the asks on one customer's page, and what the rep may ask for there. `read`, narrowed in the
// service by the list's own seat gate (`territoryForRead`): whoever may open the customer reads them.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const asks = await loadVisitAskCustomerView(viewer, {
      seatId: search.get("seatId"),
      customerId: search.get("customerId"),
      test: search.get("test"),
    });
    return NextResponse.json({ asks, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load this customer's visit asks.");
  }
}

// POST = the rep asks. `create`, the rep's own work, and narrowed in the service to the territory's own
// rep (`territoryForRepWrite`); who is asked is read from the organogram and his line's product
// managers, never from this body. The person asked is told; nothing is ever emailed.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const asks = await raiseVisitAsk(viewer, body);
    return NextResponse.json({ asks, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not send the ask.");
  }
}
