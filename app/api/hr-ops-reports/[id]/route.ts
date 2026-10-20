import { NextResponse, type NextRequest } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { hrOpsErrorResponse, reportIdOrNull } from "@/lib/hr-ops-reports/http";
import { viewReportWithLines } from "@/lib/hr-ops-reports/serialize";
import { getReport, getReportLines } from "@/lib/hr-ops-reports/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One report with every row, through the allow-list in serialize.ts — days only, never an amount.
// The HR Manager's priced view is a separate route (./priced) that her seat cannot reach.
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "hr_ops_reports", "read");

    const id = reportIdOrNull((await context.params).id);
    if (!id) return NextResponse.json({ message: "That report does not exist." }, { status: 404 });
    const report = await getReport(id);
    if (!report) return NextResponse.json({ message: "That report does not exist." }, { status: 404 });
    return NextResponse.json(viewReportWithLines(report, await getReportLines(id)));
  } catch (error) {
    return hrOpsErrorResponse(error, "Failed to load the report.");
  }
}
