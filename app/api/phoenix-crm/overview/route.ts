import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { startServerTimer } from "@/lib/http/server-timing";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { loadPhoenixCrmOverview } from "@/lib/phoenix-crm/server/overview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = the page's opening read: who is looking, their tabs, the territories their pickers offer and
// what waits for their decision. The viewer is always the session.
export async function GET(request: Request) {
  const timer = startServerTimer("crm_overview");
  try {
    const access = await resolveAccessContext(request);
    timer.lap("access");
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await timer.measure("viewer", () => resolvePhoenixCrmViewer(access));
    const overview = await timer.measure("load", () => loadPhoenixCrmOverview(viewer));
    return NextResponse.json({ overview, success: true }, { headers: timer.headers() });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not open Phoenix CRM.");
  }
}
