import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadAreaBricks } from "@/lib/phoenix-crm/server/manager-customers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = the bricks of one area he plans in, for the brick drop-list under the area drop-list of "Add a
// customer" (owner, 2026-10-18). `read`, narrowed in the service to the areas of his own reach.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const view = await loadAreaBricks(viewer, { area: search.get("area") });
    return NextResponse.json({ bricks: view, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the area's bricks.");
  }
}
