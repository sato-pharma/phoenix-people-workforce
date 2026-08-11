import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { resolveWeeklyAccessScope } from "@/lib/sales/weekly/access";
import { loadWeeklyManagerIndex } from "@/lib/sales/weekly/manager-attribution";
import {
  buildWeeklySummaryWorkbook,
  currentCairoCycleMonth,
  cycleMonthsOfCurrentYear,
} from "@/lib/sales/weekly/summary-workbook";
import { loadWeeklyDashboard } from "@/lib/sales/weekly/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Weekly Sales — "Summarized Report" (5-tab management workbook).
//
// A SECOND export alongside the analyst BI workbook at /api/sales/weekly/export, which is untouched.
// Same auth posture as that route: weekly_sales:read + the viewer's weekly access scope, so a
// product- or territory-scoped viewer gets the same redaction they get on screen. Its own rate-limit
// scope, so downloading this cannot consume the BI workbook's budget.
//
// Note the sibling /api/sales/weekly/export-batches route has neither a rate limit nor an access
// scope — it reads with the service-role client directly. That is not a pattern to copy here; doing
// so would leak restricted products and out-of-territory branches into a management workbook.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "read");
    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:sales:weekly-summary",
    });

    const params = new URL(request.url).searchParams;
    const parseList = (key: string) =>
      params
        .getAll(key)
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean);
    const mode = (key: string): "include" | "exclude" =>
      (params.get(key) ?? "").toLowerCase() === "exclude" ? "exclude" : "include";

    const accessScope = await resolveWeeklyAccessScope(access);

    // Non-period filters (distributor / region / product / line) apply to ALL five tabs, so a
    // manager exporting their own line sees a coherent workbook. The PERIOD filters apply only to
    // Tabs 1-2 — Tabs 3-5 define their own period by construction (this month / this year).
    const sharedFilters = {
      lineCodes: parseList("line"),
      lineFilterMode: mode("lineMode"),
      distributorCodes: parseList("distributor"),
      distributorFilterMode: mode("distributorMode"),
      regionCodes: parseList("region"),
      regionFilterMode: mode("regionMode"),
      productCodes: parseList("product"),
      productFilterMode: mode("productMode"),
      accessScope,
      includeFactRows: true,
    } as const;

    const cycleMonths = parseList("month");
    const weekNumbers = parseList("weekNum")
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
    const ytdMonths = cycleMonthsOfCurrentYear();

    // allWeeks is mandatory on the MTD/YTD loads: without it the batch query caps at 200 batches
    // (newest-first) and would silently truncate the year.
    const [weekly, mtd, ytd, managerIndex] = await Promise.all([
      loadWeeklyDashboard({
        ...sharedFilters,
        cycleMonths,
        cycleMonthMode: mode("monthMode"),
        weekNumbers,
        weekNumberMode: mode("weekNumMode"),
      }),
      loadWeeklyDashboard({ ...sharedFilters, allWeeks: true, cycleMonths: [currentCairoCycleMonth()] }),
      loadWeeklyDashboard({ ...sharedFilters, allWeeks: true, cycleMonths: ytdMonths }),
      loadWeeklyManagerIndex(),
    ]);

    const monthLabel = cycleMonths.length > 0 ? cycleMonths.map((m) => m.slice(0, 7)).join(", ") : "All months";
    const weekLabel = weekNumbers.length > 0 ? weekNumbers.map((w) => `W${w}`).join(", ") : "All weeks";
    const periodLabel = `${monthLabel} · ${weekLabel}`;
    const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";

    const buffer = await buildWeeklySummaryWorkbook({
      weekly,
      mtd,
      ytd,
      managerIndex,
      ytdMonths,
      periodLabel,
      generatedAt,
    });

    const periodSegment =
      cycleMonths.length > 0 ? cycleMonths.map((m) => m.slice(0, 7)).join("-") : "all-months";
    const weekSegment = weekNumbers.length > 0 ? `_${weekNumbers.map((w) => `w${w}`).join("-")}` : "";
    const filename = `phoenix-weekly-summary_${periodSegment}${weekSegment}.xlsx`;

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
      return new Response(JSON.stringify({ error: "Forbidden." }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (error instanceof SalesWorkflowError) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: error.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: clientSafeErrorMessage(error, "Summarized report failed.") }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
