import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { canExportSosDashboard } from "@/lib/sales/access-scope";
import { buildSosBiWorkbook } from "@/lib/sales/sos-bi-workbook";
import { getSosDashboard, type SosDashboardFilters } from "@/lib/sales/sos-dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Flagship Source-of-Sales BI workbook — CEO / Super Admin ONLY (hard role gate below; the
// /sales Export button is hidden for everyone else via the same canExportSosDashboard predicate).
// The engine (getSosDashboard) re-resolves scope + confidential stripping from the SESSION, so
// the workbook can never contain anything the caller can't already see on screen; the query
// string only narrows via the same filters the dashboard uses.

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

/** Filename segment for one multi-filter: single code, "N-noun", or empty. */
function seg(codes: string[], noun: string): string | null {
  if (codes.length === 0) return null;
  if (codes.length === 1) return codes[0].toLowerCase().replace(/\s+/g, "-");
  return `${codes.length}-${noun}`;
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!canExportSosDashboard(access.role)) {
      return new Response(JSON.stringify({ error: "Forbidden." }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
    await assertPermission(access, "sales", "export");
    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:sales:sos-dashboard",
    });

    const { searchParams } = new URL(request.url);
    const filters: SosDashboardFilters = {
      period: firstValue(searchParams.get("period")),
      periods: splitList(searchParams.get("periods")),
      line: firstValue(searchParams.get("line")),
      lines: splitList(searchParams.get("lines")),
      distributors: splitList(searchParams.get("distributors")),
      regions: splitList(searchParams.get("regions")),
      areas: splitList(searchParams.get("areas")),
      products: splitList(searchParams.get("products")),
    };

    const data = await getSosDashboard(filters, access, {
      includeMomComparison: true,
      includeDetailRows: true,
    });

    const filterParts = [
      filters.lines?.length ? `lines: ${filters.lines.join(", ")}` : null,
      filters.distributors?.length ? `distributors: ${filters.distributors.join(", ")}` : null,
      filters.regions?.length ? `regions: ${filters.regions.join(", ")}` : null,
      filters.areas?.length ? `areas: ${filters.areas.join(", ")}` : null,
      filters.products?.length ? `products: ${filters.products.join(", ")}` : null,
    ].filter(Boolean);
    const filterSummary = filterParts.length > 0 ? filterParts.join(" · ") : "No filters (full scope)";

    const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
    const buffer = await buildSosBiWorkbook({
      data,
      generatedBy: access.loginId ?? access.hrId ?? access.role,
      generatedAt,
      filterSummary,
    });

    const parts = ["phoenix-sos-dashboard", data.period ?? "latest"];
    for (const part of [
      seg(filters.lines ?? [], "lines"),
      seg(filters.distributors ?? [], "distributors"),
      seg(filters.regions ?? [], "regions"),
      seg(filters.products ?? [], "products"),
    ]) {
      if (part) parts.push(part);
    }
    const filename = parts.join("_") + ".xlsx";

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
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Export failed." }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
