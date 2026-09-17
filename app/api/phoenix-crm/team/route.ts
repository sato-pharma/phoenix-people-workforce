import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadTeamView } from "@/lib/phoenix-crm/server/team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = the territories beneath the viewer: whose list is ready, and the grade and drop requests
// waiting (the ones this viewer decides marked).
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const team = await loadTeamView(viewer, { test: searchOf(request).get("test") });
    return NextResponse.json({ team, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load your team.");
  }
}
