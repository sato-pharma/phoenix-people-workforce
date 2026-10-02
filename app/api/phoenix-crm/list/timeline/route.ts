import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadCustomerTimeline } from "@/lib/phoenix-crm/server/customer-timeline";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = one customer's past Phoenix visits, newest first, for his page (owner, 2026-10-02): the day,
// AM or PM, the products discussed, the customer's objection and the rep's comment, and the next step.
// Read through the list's own seat gate, and carrying no location, distance or flag of any kind.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const timeline = await loadCustomerTimeline(viewer, {
      seatId: search.get("seatId"),
      test: search.get("test"),
      customerId: search.get("customerId"),
    });
    return NextResponse.json({ timeline, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load this customer's visits.");
  }
}
