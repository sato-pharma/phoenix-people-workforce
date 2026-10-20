import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { respondWithWeeklySalesDepotDetailWorkbook } from "@/lib/sales/weekly/depot-detail-export-response";
import {
  loadWeeklySalesDepotDetail,
  parseWeeklySalesDetailManagerParams,
} from "@/lib/sales/weekly/depot-detail-service";
import { mayReadManagersWeeklySales } from "@/lib/sales/weekly/portal-weekly-dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The managers' Depot Detail workbook: the same loader and query as the feed, so the download is the screen.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");
    if (!mayReadManagersWeeklySales(access.role)) {
      return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
    }
    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:sales:weekly-sales-depot-detail",
    });
    const detailRequest = parseWeeklySalesDetailManagerParams(new URL(request.url).searchParams);
    const payload = await loadWeeklySalesDepotDetail(detailRequest, access);
    const fileMonths = detailRequest.page.cycleMonthMode === "exclude" ? [] : (detailRequest.page.cycleMonths ?? []);
    return await respondWithWeeklySalesDepotDetailWorkbook(payload, fileMonths);
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { success: false, error: "rate_limited", message: error.message },
        { status: 429, headers: { "Retry-After": String(error.retryAfterSeconds) } },
      );
    }
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Failed to generate the weekly sales depot detail export.") },
      { status: 500 },
    );
  }
}
