import { NextResponse } from "next/server";

import { generateFingerprintReportWorkbook } from "@/lib/attendance/fingerprint-report-export";
import { getFingerprintAttendanceReport } from "@/lib/attendance/fingerprint-report";
import { resolveAttendanceScopeHrIds } from "@/lib/attendance/employee-attendance";
import { assertFingerprintReportPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage, toApiError } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { DOWNLOAD_NO_STORE_HEADERS } from "@/lib/http/download-headers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function filename() {
  return `phoenix-fingerprint-attendance-report-${new Date().toISOString().slice(0, 10)}.xlsx`;
}

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
    await assertFingerprintReportPermission(access);
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:attendance:fingerprint" });
    const scopeHrIds = await resolveAttendanceScopeHrIds(access);

    const url = new URL(request.url);
    const data = await getFingerprintAttendanceReport({
      dateFrom: url.searchParams.get("dateFrom") ?? undefined,
      dateTo: url.searchParams.get("dateTo") ?? undefined,
      deduction: url.searchParams.get("deduction") ?? undefined,
      department: url.searchParams.get("department") ?? undefined,
      deviceUserId: url.searchParams.get("deviceUserId") ?? undefined,
      employeeHrId: url.searchParams.get("employeeHrId") ?? undefined,
      employeeHrIds: scopeHrIds ?? undefined,
      employeeName: url.searchParams.get("employeeName") ?? undefined,
      jobTitle: url.searchParams.get("jobTitle") ?? undefined,
      search: url.searchParams.get("search") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
    });
    const workbook = await generateFingerprintReportWorkbook(data);
    const buffer = await workbook.xlsx.writeBuffer();

    return new NextResponse(buffer, {
      headers: {
        ...DOWNLOAD_NO_STORE_HEADERS,
        "Content-Disposition": `attachment; filename="${filename()}"`,
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
    return apiResponse(error, "Fingerprint attendance report export failed.");
  }
}
