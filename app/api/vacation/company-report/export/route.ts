import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertSystemAdministratorWorkspaceAccess, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { generateCompanyVacationReportWorkbook } from "@/lib/vacation/company-vacation-report-export";
import { getCompanyVacationReport } from "@/lib/vacation/company-vacation-report";
import { toApiError } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_START_DATE = "2026-01-01";

function apiResponse(error: unknown, fallback: string) {
  if (isForbiddenError(error)) {
    return NextResponse.json({
      error: "forbidden",
      message: error instanceof Error ? error.message : "Forbidden.",
      success: false,
    }, { status: 403 });
  }

  const apiError = toApiError(error, fallback);
  return NextResponse.json({ error: apiError.code, message: apiError.message, success: false }, { status: apiError.status });
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    assertSystemAdministratorWorkspaceAccess(access, "the company vacation report");
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:admin:company-vacation-report" });

    const url = new URL(request.url);
    const startDate = url.searchParams.get("startDate") ?? DEFAULT_START_DATE;
    const endDate = url.searchParams.get("endDate") ?? new Date().toISOString().slice(0, 10);

    const rows = await getCompanyVacationReport({ endDate, startDate });

    await writeAuditLog({
      actorLoginId: resolveEmployeeIdentityId(access) ?? access.loginId ?? "system",
      entityId: `${startDate}:${endDate}`,
      entityType: "vacation_report_export",
      newValues: { endDate, rowCount: rows.length, startDate },
      summary: "Company vacation report exported.",
    });

    const workbook = generateCompanyVacationReportWorkbook({ endDate, rows, startDate });
    const buffer = await workbook.xlsx.writeBuffer();

    return new NextResponse(buffer, {
      headers: {
        "Content-Disposition": `attachment; filename="company-vacation-report-${startDate}-to-${endDate}.xlsx"`,
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
    return apiResponse(error, "Company vacation report export failed.");
  }
}
