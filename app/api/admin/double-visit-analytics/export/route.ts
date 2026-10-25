import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { buildDoubleVisitExportWorkbook, getDoubleVisitDashboardData } from "@/lib/double-visit-analytics/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { DOWNLOAD_NO_STORE_HEADERS } from "@/lib/http/download-headers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "double_visit_analytics", "export");
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:admin:double-visit" });
    const url = new URL(request.url);
    const data = await getDoubleVisitDashboardData({
      access,
      dateFrom: url.searchParams.get("dateFrom"),
      dateTo: url.searchParams.get("dateTo"),
    });
    const workbook = await buildDoubleVisitExportWorkbook(data);
    const buffer = await workbook.xlsx.writeBuffer();
    const body = buffer instanceof ArrayBuffer ? buffer : Buffer.from(buffer);
    return new NextResponse(body, {
      headers: {
        ...DOWNLOAD_NO_STORE_HEADERS,
        "Content-Disposition": `attachment; filename="double-visit-analytics-${data.dateFrom}-to-${data.dateTo}.xlsx"`,
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
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to export Double Visit Analytics." }, { status: 403 });
    }
    return NextResponse.json({
      error: "double_visit_export_failed",
      message: clientSafeErrorMessage(error, "Double Visit export failed."),
    }, { status: 500 });
  }
}
