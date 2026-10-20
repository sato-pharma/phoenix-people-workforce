import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { buildMonthlySalesDashboardWorkbook } from "@/lib/sales/monthly-dashboard-workbook";
import { getSalesDashboard } from "@/lib/sales/service";
import type { SalesDashboardFilters } from "@/lib/sales/types";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Detailed XLSX export of the Monthly Sales (Achievement) Dashboard. Mirrors the data route's
// filter parsing exactly, then re-runs getSalesDashboard() with the caller's own access context
// (never trusting the query string for scope) — the workbook can never contain more than the
// caller already sees on screen for that filter selection. Unlike the SoS BI workbook this is
// available to everyone who can already read the sales dashboard (gated by sales:export, the
// same permission every other role-scoped sales export uses), not CEO/Super-Admin only.

const EXPORT_TRANSACTION_LIMIT = 20_000;

function splitList(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function firstValue(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Filename segment for one filter value: single code, or empty. */
function seg(value: string | undefined): string | null {
  if (!value) return null;
  // ASCII only: a Content-Disposition header refuses anything else, and a name can carry it.
  return value.toLowerCase().replace(/\s+/g, "-").replace(/[^!-~]/g, "") || null;
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "export");
    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:sales:monthly-dashboard",
    });

    const { searchParams } = new URL(request.url);
    const filters: SalesDashboardFilters = {
      line: firstValue(searchParams.get("line")),
      salesType: firstValue(searchParams.get("salesType")),
      manager: firstValue(searchParams.get("manager")),
      territory: firstValue(searchParams.get("territory")),
      family: firstValue(searchParams.get("family")),
      periods: splitList(searchParams.get("periods")),
      products: splitList(searchParams.get("products")),
    };

    const data = await getSalesDashboard(filters, access, { transactionLimit: EXPORT_TRANSACTION_LIMIT });

    const generatedAtIso = new Date().toISOString();
    const exportedBy = access.hrId ?? access.loginId ?? "system";
    const buffer = await buildMonthlySalesDashboardWorkbook({
      data,
      meta: { exportedByName: exportedBy, exportedByHrId: exportedBy, role: access.role, generatedAtIso, filters },
    });

    const parts = ["phoenix-monthly-sales-dashboard"];
    // The file is named by the manager's NAME, never the filter's `DSM [hr id]` key (owner rule: names, never codes).
    const managerName = filters.manager ? (data.filters.managerLabels?.[filters.manager] ?? filters.manager) : undefined;
    for (const part of [seg(filters.line), seg(filters.salesType), seg(filters.territory), seg(managerName), seg(filters.family)]) {
      if (part) parts.push(part);
    }
    const filename = `${parts.join("_")}_${generatedAtIso.slice(0, 10)}.xlsx`;

    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
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
      return NextResponse.json(
        { success: false, error: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Failed to export monthly sales dashboard.") },
      { status: 500 },
    );
  }
}
