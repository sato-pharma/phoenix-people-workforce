import { NextResponse, type NextRequest } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { hrOpsErrorResponse } from "@/lib/hr-ops-reports/http";
import { loadReportList } from "@/lib/hr-ops-reports/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Daily & Weekly Reports list — both screens open on it. Titles, statuses and row counts only:
// no row, no day count and no amount crosses here.
export async function GET(request: NextRequest) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "hr_ops_reports", "read");
    return NextResponse.json({ reports: await loadReportList() });
  } catch (error) {
    return hrOpsErrorResponse(error, "Failed to load the reports.");
  }
}
