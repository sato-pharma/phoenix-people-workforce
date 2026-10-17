import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadManagerPlanReport } from "@/lib/phoenix-crm/server/manager-plan-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = one week of a district manager's plan against what happened (owner, 2026-10-16: "actual versus
// planned"). `read`, narrowed in the service to him, his RSM, his NSM, SFE, the CEO and the Super Admin.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const report = await loadManagerPlanReport(viewer, { week: search.get("week"), manager: search.get("manager"), test: search.get("test") });
    return NextResponse.json({ report, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the report.");
  }
}
