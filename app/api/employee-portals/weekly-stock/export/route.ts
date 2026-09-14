import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import {
  isPortalWeeklyStockRole,
  loadWeeklyStockDashboard,
  parseWeeklyStockSearchParams,
} from "@/lib/sales/weekly/stock-dashboard-service";
import { respondWithWeeklyStockWorkbook } from "@/lib/sales/weekly/stock-export-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");
    const isCompanyExecutive = access.role === "CEO" || access.role === "Super Admin";
    if (!isPortalWeeklyStockRole(access.role) && !isCompanyExecutive) {
      return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
    }
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:sales:weekly-stock" });
    const payload = await loadWeeklyStockDashboard(parseWeeklyStockSearchParams(new URL(request.url).searchParams), access);
    return await respondWithWeeklyStockWorkbook(payload);
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
      { success: false, error: clientSafeErrorMessage(error, "Failed to generate weekly stock export.") },
      { status: 500 },
    );
  }
}
