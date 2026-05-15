import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { exportActiveEmployeesAccrualToExcel } from "@/lib/leave/service";
import type { LeaveRequestFilters } from "@/lib/leave/types";

export const dynamic = "force-dynamic";

function filtersFromUrl(url: string): LeaveRequestFilters {
  const params = new URL(url).searchParams;
  return {
    area: params.get("area") || undefined,
    employee: params.get("employee") || undefined,
    employeeHrId: params.get("employeeHrId") || undefined,
    line: params.get("line") || undefined,
    sortBy: params.get("sortBy") || undefined,
    sortOrder: params.get("sortOrder") === "asc" ? "asc" : params.get("sortOrder") === "desc" ? "desc" : undefined,
    year: params.get("year") ? Number(params.get("year")) : undefined,
  };
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const buffer = await exportActiveEmployeesAccrualToExcel(access, filtersFromUrl(request.url));
    return new Response(buffer, {
      headers: {
        "Content-Disposition": `attachment; filename="phoenix-employees-accrual-sheet-${new Date().toISOString().slice(0, 10)}.xlsx"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to export active employees accrual." }, { status: 400 });
  }
}
