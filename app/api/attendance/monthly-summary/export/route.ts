import { NextResponse } from "next/server";

import { generateMonthlyAttendanceSummaryWorkbook } from "@/lib/attendance/monthly-summary-export";
import { getMonthlyAttendanceSummary, resolveSummaryMonth } from "@/lib/attendance/monthly-summary";
import { resolveAttendanceScopeHrIds } from "@/lib/attendance/employee-attendance";
import { assertAttendanceMonthlySummaryPermission, assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage, toApiError } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function apiResponse(error: unknown, fallback: string) {
  if (isForbiddenError(error)) {
    return NextResponse.json(
      { error: "forbidden", message: clientSafeErrorMessage(error, "Forbidden.") },
      { status: 403 },
    );
  }

  const apiError = toApiError(error, fallback);
  return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employees", "read");
    // The workbook carries each employee's total deduction value in EGP: closed to the salary-blind
    // seat, who holds employees:read for the Employee Master only (owner, 2026-10-20).
    await assertAttendanceMonthlySummaryPermission(access);
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:attendance:monthly-summary" });
    const scopeHrIds = await resolveAttendanceScopeHrIds(access);

    const url = new URL(request.url);
    const month = resolveSummaryMonth(url.searchParams.get("month") ?? undefined);
    const data = await getMonthlyAttendanceSummary({ month, employeeHrIds: scopeHrIds ?? undefined });
    const workbook = await generateMonthlyAttendanceSummaryWorkbook(data);
    const buffer = await workbook.xlsx.writeBuffer();

    return new NextResponse(buffer, {
      headers: {
        "Content-Disposition": `attachment; filename="phoenix-attendance-monthly-summary-${data.month}.xlsx"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: error.message },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    return apiResponse(error, "Monthly attendance summary export failed.");
  }
}
