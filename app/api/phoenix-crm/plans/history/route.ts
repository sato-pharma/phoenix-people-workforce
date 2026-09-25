import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadPlanHistory } from "@/lib/phoenix-crm/server/plan-history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = last month's iReports360 plan for this seat, as a REFERENCE for "Copy last month": each doctor
// the rep planned last month, the weekdays he was on, and the native customer he maps to (or, if he has
// left the list, his name only, not placeable). It reads the old system; it never writes back to it, and
// the copy itself is replayed through the ordinary weekly save. A missing mirror degrades to no reference.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const history = await loadPlanHistory(viewer, { seatId: search.get("seatId"), test: search.get("test"), month: search.get("month") });
    return NextResponse.json({ history, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load last month's plan.");
  }
}
