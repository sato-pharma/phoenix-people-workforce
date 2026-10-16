import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadDoubleVisitReport } from "@/lib/phoenix-crm/server/double-visit-requests";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = the managers' Double visit requests report (owner, 2026-10-16: "all managers must have access on
// this report as per their scope up to the CEO"). `read`, narrowed in the service
// (`doubleVisitReportAudience`): a manager reads the territories beneath him, the Super Admin, the CEO and
// SFE read every territory in scope, a person who holds no seat reads the requests addressed to him, and a
// rep is refused (he reads his own on the customer's page).
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const report = await loadDoubleVisitReport(viewer, { test: search.get("test") });
    return NextResponse.json({ success: true, report });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the double visit requests.");
  }
}
