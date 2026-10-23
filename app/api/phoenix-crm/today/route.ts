import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { startServerTimer } from "@/lib/http/server-timing";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadPhoenixCrmToday } from "@/lib/phoenix-crm/server/today";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = one territory's day, as the rep works it: today's stops in the order he will drive them,
//       each one done or not, the visits he made off the plan beside them, and his AM and PM counts
//       against their targets — apart, never averaged.
//
// A read, for anyone who reads the territory. There is no POST: entering a visit is the visits route's
// job, and this screen only ever hands the customer to it.
export async function GET(request: Request) {
  const timer = startServerTimer("crm_today");
  try {
    const access = await resolveAccessContext(request);
    timer.lap("access");
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await timer.measure("viewer", () => resolvePhoenixCrmViewer(access));
    const search = searchOf(request);
    const today = await timer.measure("load", () => loadPhoenixCrmToday(viewer, { seatId: search.get("seatId"), test: search.get("test") }));
    return NextResponse.json({ today, success: true }, { headers: timer.headers() });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load today.");
  }
}
