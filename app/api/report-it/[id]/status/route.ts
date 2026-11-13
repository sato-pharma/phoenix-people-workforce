import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { reportItJsonError, reportItSignedOut } from "@/lib/report-it/http";
import { changeReportStatus } from "@/lib/report-it/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Moves one safety report one step — received → under assessment → closed (audit REC-033).
 * Body: { status: "under_assessment" | "closed" }.
 *
 * Every role holds `report_it:read`; the real gate is inside `changeReportStatus`, which refuses
 * anyone who cannot read every report (a `report_it:export` role or a person on the read-all list)
 * before the report is even read. The move and its audit row are one database transaction.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    if (access.source === "guest" || !access.hrId) return reportItSignedOut();
    await assertPermission(access, "report_it", "read");

    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as { status?: unknown };
    const result = await changeReportStatus(access, { reportId: id, to: body.status });
    return NextResponse.json(result);
  } catch (error) {
    return reportItJsonError(error, "Failed to change the report's status.");
  }
}
