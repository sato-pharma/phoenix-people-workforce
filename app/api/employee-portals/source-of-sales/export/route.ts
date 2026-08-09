import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getPortalSosDashboard, isPortalSosRole } from "@/lib/sales/portal-sos-dashboard";
import { buildSosDashboardWorkbook } from "@/lib/sales/sos-dashboard-export";
import type { SosDashboardFilters } from "@/lib/sales/sos-dashboard";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Multi-sheet Source-of-Sales workbook (Summary + Product + Region + Area + Distributor). Scope is
// re-resolved from the SESSION inside getPortalSosDashboard, so the export is line/region/product
// scoped and Head-Office/confidential stripped exactly like the on-screen dashboard.

function splitList(value: string | null): string[] {
  if (!value) return [];
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}
function firstValue(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");
    // Company executives export from the admin Field Sales pages — same session-side
    // scope resolution as the dashboard feed (CEO / Super Admin ⇒ full COMPANY scope).
    const isCompanyExecutive = access.role === "CEO" || access.role === "Super Admin";
    if (!isPortalSosRole(access.role) && !isCompanyExecutive) {
      return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const filters: SosDashboardFilters = {
      period: firstValue(searchParams.get("period")),
      lines: splitList(searchParams.get("lines")),
      distributors: splitList(searchParams.get("distributors")),
      regions: splitList(searchParams.get("regions")),
      areas: splitList(searchParams.get("areas")),
      products: splitList(searchParams.get("products")),
    };

    const { data, scope } = await getPortalSosDashboard(filters, access);
    const buffer = await buildSosDashboardWorkbook({ data, scopeSummary: scope.scopeSummary });
    const filename = `source-of-sales-${data.period ?? "export"}.xlsx`;

    return new Response(buffer, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Export failed.") },
      { status: 500 },
    );
  }
}
