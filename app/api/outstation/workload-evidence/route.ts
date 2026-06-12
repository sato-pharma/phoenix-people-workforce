import { NextResponse } from "next/server";

import { assertPermission, canAccess, normalizeHrIdForAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getDoubleVisitExpenseWorkloadEvidence } from "@/lib/double-visit-analytics/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "outstation", "read");

    const url = new URL(request.url);
    const employeeHrId = url.searchParams.get("employeeHrId") || access.hrId || access.loginId;
    const requestedKey = normalizeHrIdForAccess(employeeHrId);
    const ownKeys = [access.hrId, access.loginId].map(normalizeHrIdForAccess).filter((value): value is string => Boolean(value));
    if (requestedKey && !ownKeys.includes(requestedKey) && !(await canAccess(access, "outstation", "approve"))) {
      return NextResponse.json({ error: "forbidden", message: "You can only view your own Double Visit workload evidence." }, { status: 403 });
    }
    const tripStartDate = url.searchParams.get("tripStartDate");
    const tripEndDate = url.searchParams.get("tripEndDate") || tripStartDate;
    if (!tripStartDate || !tripEndDate) {
      return NextResponse.json({
        error: "missing_date_range",
        message: "Provide tripStartDate and tripEndDate to resolve Double Visit workload evidence.",
      }, { status: 400 });
    }

    const evidence = await getDoubleVisitExpenseWorkloadEvidence({
      employeeHrId,
      tripEndDate,
      tripStartDate,
    });
    return NextResponse.json({ data: evidence, success: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to Double Visit workload evidence." }, { status: 403 });
    }
    return NextResponse.json({
      error: "double_visit_workload_evidence_failed",
      message: error instanceof Error ? error.message : "Double Visit workload evidence lookup failed.",
    }, { status: 500 });
  }
}
