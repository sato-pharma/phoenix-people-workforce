import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import {
  generateVacationAuditExportWorkbook,
  isVacationSchemaMissing,
  vacationErrorMessage,
} from "@/lib/vacation/service";
import { assertVacationRouteRateLimit } from "@/lib/vacation/route-guards";
import type { VacationReportFilters } from "@/lib/vacation/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function filtersFromUrl(url: URL): VacationReportFilters {
  return {
    dateFrom: url.searchParams.get("dateFrom") ?? undefined,
    dateTo: url.searchParams.get("dateTo") ?? undefined,
    department: url.searchParams.get("department") ?? undefined,
    employee: url.searchParams.get("employee") ?? undefined,
    line: url.searchParams.get("line") ?? undefined,
    manager: url.searchParams.get("manager") ?? undefined,
    paymentStatus: (url.searchParams.get("paymentStatus") ?? undefined) as VacationReportFilters["paymentStatus"],
    requestId: url.searchParams.get("requestId") ?? undefined,
    search: url.searchParams.get("search") ?? undefined,
    status: (url.searchParams.get("status") ?? undefined) as VacationReportFilters["status"],
    vacationType: (url.searchParams.get("vacationType") ?? undefined) as VacationReportFilters["vacationType"],
  };
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertVacationRouteRateLimit({
      actor: access.loginId ?? access.hrId,
      limit: 8,
      request,
      scope: "vacation:export",
      windowMs: 60_000,
    });
    const workbook = await generateVacationAuditExportWorkbook(access, filtersFromUrl(new URL(request.url)));
    const buffer = await workbook.xlsx.writeBuffer();
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="vacation-audit-export-${new Date().toISOString().slice(0, 10)}.xlsx"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    const message = vacationErrorMessage(error) || "Unable to export vacation audit workbook.";
    if (isForbiddenError(error) || message.toLowerCase().startsWith("forbidden:")) {
      return NextResponse.json({ error: "forbidden", message, success: false }, { status: 403 });
    }
    if (isVacationSchemaMissing(error)) {
      return NextResponse.json({ error: "vacation_schema_missing", message, success: false }, { status: 409 });
    }
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message, success: false },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    return NextResponse.json({ error: "vacation_audit_export_failed", message, success: false }, { status: 400 });
  }
}
