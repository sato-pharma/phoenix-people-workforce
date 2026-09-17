import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadVisitForm } from "@/lib/phoenix-crm/server/visits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = what the Add Visit form offers on one territory today: its validated customers with today's
// receiving hours, its managers, the line's products. Only for someone who may enter its visits.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const form = await loadVisitForm(viewer, { seatId: search.get("seatId"), test: search.get("test") });
    return NextResponse.json({ form, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not open Add Visit.");
  }
}
