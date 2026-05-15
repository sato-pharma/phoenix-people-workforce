import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { exportVacationReportToExcel } from "@/lib/leave/service";
import type { LeaveRequestFilters, VacationReportScope } from "@/lib/leave/types";

function filtersFromUrl(url: string): LeaveRequestFilters {
  const params = new URL(url).searchParams;
  return {
    area: params.get("area") || undefined,
    employee: params.get("employee") || undefined,
    employeeHrId: params.get("employeeHrId") || undefined,
    endDate: params.get("endDate") || undefined,
    leaveTypeId: params.get("leaveTypeId") || undefined,
    line: params.get("line") || undefined,
    managerHrId: params.get("managerHrId") || undefined,
    month: params.get("month") ? Number(params.get("month")) : undefined,
    paymentStatus: params.get("paymentStatus") || undefined,
    startDate: params.get("startDate") || undefined,
    status: params.get("status") || undefined,
    year: params.get("year") ? Number(params.get("year")) : undefined,
  };
}

function reportScope(value: string | null): VacationReportScope {
  return value === "team" || value === "company" ? value : "my";
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const url = new URL(request.url);
    const scope = reportScope(url.searchParams.get("scope"));
    const buffer = await exportVacationReportToExcel(access, scope, filtersFromUrl(request.url));
    return new Response(buffer, {
      headers: {
        "Content-Disposition": `attachment; filename="phoenix-vacation-report-${scope}-${new Date().toISOString().slice(0, 10)}.xlsx"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to export vacation report." }, { status: 400 });
  }
}
