import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { loadPhoenixCrmOverview } from "@/lib/phoenix-crm/server/overview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = the page's opening read: who is looking, their tabs, the territories their pickers offer and
// what waits for their decision. The viewer is always the session.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const overview = await loadPhoenixCrmOverview(viewer);
    return NextResponse.json({ overview, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not open Phoenix CRM.");
  }
}
