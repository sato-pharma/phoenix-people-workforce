import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { loadIntegrityBoard } from "@/lib/phoenix-crm/server/integrity-board";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = the location-integrity board: captures whose GPS the server could not believe.
//
// The Super Admin's alone, gated twice on purpose — `phoenix_crm:update` here (the same permission
// the settings screen needs, which only he holds) and `viewer.isSuperAdmin` again inside the
// service. There is no POST and no mutation of any kind: a flag is evidence for a person to read,
// never an action the system takes, and nothing here writes back to a visit or tells a rep anything.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "update");
    const viewer = await resolvePhoenixCrmViewer(access);
    const includeTest = new URL(request.url).searchParams.get("test") === "1";
    const board = await loadIntegrityBoard(viewer, { includeTest });
    return NextResponse.json({ board, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the location integrity board.");
  }
}
