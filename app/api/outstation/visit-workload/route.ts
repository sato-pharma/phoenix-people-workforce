import { NextResponse } from "next/server";

import { unauthenticatedSessionResponse } from "@/lib/auth/api-session-response";
import { assertPermission, normalizeHrIdForAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getRepTripVisitWorkload } from "@/lib/crm/visit-workload";
import { canViewEmployeeExpenseScope } from "@/lib/outstation/expenses";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-day field-visit workload for a person across a trip window, read from Phoenix CRM through the
 * CRM visits door (the iReports360 archive only before his team's start). Backs the outstation
 * expense-review "Verify workload" panel and the employee's own trip panel.
 * Counts every field visit where the rep is the primary agent OR the double-visit partner —
 * unlike the double-visit evidence route, which misses solo days and drops partner-side visits
 * whose primary agent has since departed.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    // An expired session must not be reported as a missing permission — see
    // api-session-response.ts. A guest is already denied everything, so this only changes how the
    // denial reads, never who gets through.
    const unauthenticated = unauthenticatedSessionResponse(access);
    if (unauthenticated) return unauthenticated;

    await assertPermission(access, "outstation", "read");

    const url = new URL(request.url);
    const employeeHrId = url.searchParams.get("employeeHrId") || access.hrId || access.loginId;
    const requestedKey = normalizeHrIdForAccess(employeeHrId);
    const ownKeys = [access.hrId, access.loginId]
      .map(normalizeHrIdForAccess)
      .filter((value): value is string => Boolean(value));
    if (
      requestedKey &&
      !ownKeys.includes(requestedKey) &&
      !(await canViewEmployeeExpenseScope(access, employeeHrId ?? ""))
    ) {
      return NextResponse.json(
        { error: "forbidden", message: "You can only view CRM visit workload for employees within your access scope." },
        { status: 403 },
      );
    }

    const tripStartDate = url.searchParams.get("tripStartDate");
    const tripEndDate = url.searchParams.get("tripEndDate") || tripStartDate;
    if (!tripStartDate || !tripEndDate) {
      return NextResponse.json(
        { error: "missing_date_range", message: "Provide tripStartDate and tripEndDate to resolve CRM visit workload." },
        { status: 400 },
      );
    }

    // Phoenix CRM's positions are a check-in on an approver's or a manager's screen, never on the
    // employee's own (owner, 2026-10-02): only a caller looking at SOMEONE ELSE's trip — who passed the
    // scope check above — gets them.
    const viewingSomeoneElse = Boolean(requestedKey) && !ownKeys.includes(requestedKey as string);
    const data = await getRepTripVisitWorkload({
      hrId: employeeHrId,
      includePhoenixCheckins: viewingSomeoneElse,
      tripEndDate,
      tripStartDate,
    });
    return NextResponse.json({ data, success: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: "You do not have access to CRM visit workload." },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { error: "visit_workload_failed", message: clientSafeErrorMessage(error, "CRM visit workload lookup failed.") },
      { status: 500 },
    );
  }
}
