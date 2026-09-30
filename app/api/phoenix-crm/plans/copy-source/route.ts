import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadPlanCopySource } from "@/lib/phoenix-crm/server/plans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = the customers a territory's own Phoenix plans placed between two days — what "Copy last month",
// "Copy last week" and "Copy a day" replay. Read-only; the copy is placed on the phone and saved through
// the ordinary plan save.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const source = await loadPlanCopySource(viewer, {
      seatId: search.get("seatId"),
      test: search.get("test"),
      from: search.get("from"),
      to: search.get("to"),
    });
    return NextResponse.json({ source, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the plan to copy.");
  }
}
