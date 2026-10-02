import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadVisitAskInbox } from "@/lib/phoenix-crm/server/visit-asks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = the visit asks the viewer answers or reads (owner, 2026-10-02): a district manager's "Asked by
// your reps", a product manager's "Visit asks", the manager above told of a chain visit, and every ask
// in scope for SFE and the Super Admin. `read`, narrowed in the service (`visitAskInboxReach`): a rep
// reads his own asks on his customer's page and is refused here.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const inbox = await loadVisitAskInbox(viewer, { test: search.get("test") });
    return NextResponse.json({ inbox, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the visit asks.");
  }
}
