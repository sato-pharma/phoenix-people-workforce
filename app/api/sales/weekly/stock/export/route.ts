import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { respondWithWeeklyStockWorkbook } from "@/lib/sales/weekly/stock-export-response";
import { loadWeeklyStockDashboard, parseWeeklyStockSearchParams } from "@/lib/sales/weekly/stock-dashboard-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "read");
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:sales:weekly-stock" });
    const payload = await loadWeeklyStockDashboard(parseWeeklyStockSearchParams(new URL(request.url).searchParams), access);
    return await respondWithWeeklyStockWorkbook(payload);
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return new Response(JSON.stringify({ error: "rate_limited", message: error.message }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": String(error.retryAfterSeconds) },
      });
    }
    if (isForbiddenError(error)) {
      return new Response(JSON.stringify({ error: "Forbidden." }), { status: 403, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: clientSafeErrorMessage(error, "Export failed.") }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
