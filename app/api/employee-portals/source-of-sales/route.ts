import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getPortalSosDashboard, isPortalSosRole, toPortalSosScopeView } from "@/lib/sales/portal-sos-dashboard";
import type { SosDashboardFilters } from "@/lib/sales/sos-dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only feed for the employee-portal Source-of-Sales dashboard. Scope (line/region/product)
// is resolved from the SESSION inside getPortalSosDashboard — query params only carry the user's
// own filter selections, so a scoped caller can never widen past their role via the URL.

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

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");
    // Company executives consume this same feed from the admin Field Sales pages
    // (/admin/field-sales/source-of-sales). Scope still resolves server-side from the
    // session — CEO / Super Admin land on the full COMPANY scope and cannot widen
    // anything via query params.
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

    const { data, scope, comparison, uploadStatus } = await getPortalSosDashboard(filters, access);
    return NextResponse.json({ success: true, data, scope: toPortalSosScopeView(scope), comparison, uploadStatus });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: error instanceof Error ? error.message : "Forbidden." },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to load source-of-sales dashboard." },
      { status: 500 },
    );
  }
}
