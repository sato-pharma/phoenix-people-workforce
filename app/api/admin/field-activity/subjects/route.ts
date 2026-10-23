/**
 * GET /api/admin/field-activity/subjects — who this viewer may run the report on.
 *
 * The filter list IS the scope. A picker wider than the query behind it is the defect this repo has
 * already paid for twice (the CEO district, the venue picker), so the list is built from the same
 * `DoctorCoverageScope` the report route enforces — never from a role label, never from the
 * viewer's own area string.
 */

import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getEmployeeDirectoryRows, isActiveLifecycleStatus } from "@/lib/employees/employee-directory";
import { canOpenSubject, resolveFieldActivityAccess } from "@/lib/field-activity/access";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    // The coarse gate, stated where a reviewer looks for it. `resolveFieldActivityAccess` checks
    // the same grant itself and then narrows to the viewer's org-tree scope — but server-side
    // access control is THE security boundary in this repo, and a boundary a route handler does
    // not name is one the next edit can quietly move.
    await assertPermission(access, "double_visit_analytics", "read");
    const resolved = await resolveFieldActivityAccess(access);
    if (!resolved) {
      return NextResponse.json({ error: "forbidden", success: false }, { status: 403 });
    }

    const directory = await getEmployeeDirectoryRows();
    const subjects = directory
      .filter((row) => isActiveLifecycleStatus(row.employmentStatus))
      .filter((row) => canOpenSubject(resolved, row.hrId))
      .map((row) => ({
        areaName: row.areaName ?? null,
        hrId: row.hrId,
        jobTitle: row.jobTitle ?? null,
        lineName: row.lineName ?? null,
        name: row.displayName || row.fullName,
        regionName: row.regionName ?? null,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));

    return NextResponse.json({
      data: {
        panels: resolved.panels,
        scopeLabel: resolved.scope.kind === "none" ? "" : resolved.scope.label,
        subjects,
      },
      success: true,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", success: false }, { status: 403 });
    }
    return NextResponse.json(
      { error: "field_activity_subjects_failed", message: clientSafeErrorMessage(error, "Unknown error"), success: false },
      { status: 500 },
    );
  }
}
