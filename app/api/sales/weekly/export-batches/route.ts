import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { resolveWeeklyAccessScope } from "@/lib/sales/weekly/access";
import { buildCombinedReportExport } from "@/lib/sales/weekly/combined-report";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The Upload screen's Combined Report. It reads with the service-role client, so the viewer's weekly
// access scope is applied to the rows here (combined-report.ts) — the same scope every other weekly
// export applies, which keeps the restricted products and the Head Office line to the CEO and the
// Super Admin. It had no scope and no rate limit until 2026-09-20; it shares neither budget with the
// other exports (its own rate-limit scope).
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "import");
    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:sales:weekly-combined",
    });

    const body = (await request.json()) as { batchIds?: unknown };
    const rawIds = body?.batchIds;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      return new Response(JSON.stringify({ error: "batchIds must be a non-empty array." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (rawIds.length > 20) {
      return new Response(JSON.stringify({ error: "Cannot export more than 20 batches at once." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const batchIds = rawIds.filter((id): id is string => typeof id === "string");
    if (batchIds.length === 0) {
      return new Response(JSON.stringify({ error: "No valid batch IDs provided." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const scope = await resolveWeeklyAccessScope(access);
    const buffer = await buildCombinedReportExport(getSupabaseAdmin(), batchIds, scope);
    if (!buffer) {
      return new Response(JSON.stringify({ error: "No batches found." }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    const filename = `phoenix-weekly-combined_${batchIds.length}-batches.xlsx`;

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
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
    if (error instanceof SalesWorkflowError) {
      return new Response(JSON.stringify({ error: error.message }), { status: error.status, headers: { "Content-Type": "application/json" } });
    }
    return new Response(
      JSON.stringify({ error: clientSafeErrorMessage(error, "Export failed.") }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
