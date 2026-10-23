import { NextResponse } from "next/server";

import { assertPermission, canSeeEmployee, hrIdsMatch } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { readCrmWorkAfterDate } from "@/lib/resignations/crm-work-after-date";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/resignations/crm-work-after?hrId=<id>&date=<YYYY-MM-DD>
 *
 * The CRM work a person did after a last working day the exit forms are about to save, for the
 * warning beside the date (src/lib/resignations/crm-work-after-date.ts). Read-only, and scoped to
 * the people the viewer may already see.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "resignations", "read");

    const url = new URL(request.url);
    const hrId = String(url.searchParams.get("hrId") ?? "").trim();
    const date = String(url.searchParams.get("date") ?? "").trim();
    if (!hrId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json(
        { error: "invalid_request", message: "An employee and a date (YYYY-MM-DD) are required." },
        { status: 400 },
      );
    }

    const employee = (await getEmployeeDirectoryRows({ includeInactive: true })).find((row) =>
      hrIdsMatch(row.hrId, hrId),
    );
    if (!employee) {
      return NextResponse.json({ error: "not_found", message: "Employee was not found." }, { status: 404 });
    }
    if (!canSeeEmployee(access, employee)) {
      return NextResponse.json({ error: "forbidden", message: "You cannot see this employee." }, { status: 403 });
    }

    const data = await readCrmWorkAfterDate({
      afterDate: date,
      areaName: employee.areaName,
      employeeCrmId: employee.crmId,
      hrId: employee.hrId,
      lineName: employee.lineName,
    });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You cannot read this." }, { status: 403 });
    }
    const message = clientSafeErrorMessage(error, "Could not read the CRM.");
    return NextResponse.json({ error: "crm_work_after_failed", message }, { status: 500 });
  }
}
