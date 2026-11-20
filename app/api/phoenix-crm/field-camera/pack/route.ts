import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { captureClientOf } from "@/lib/phoenix-crm/server/capture-client";
import { loadFieldCameraPack } from "@/lib/phoenix-crm/server/field-camera-sync";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = what the Phoenix Camera keeps for a day with no network: the rep's territory, his customers with today's
// plan, the line's products. The app's alone (a bearer token, no session cookie); a browser is answered 404.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const pack = await loadFieldCameraPack(viewer, { seatId: searchOf(request).get("seatId") }, captureClientOf(request.headers));
    return NextResponse.json({ pack, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load your list.");
  }
}
