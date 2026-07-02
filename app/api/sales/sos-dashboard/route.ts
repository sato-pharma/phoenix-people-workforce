import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getSosDashboard, type SosDashboardFilters, type SosScopeOverrides } from "@/lib/sales/sos-dashboard";
import { isPortalSosRole, resolvePortalSosScope } from "@/lib/sales/portal-sos-dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only feed for the Source-of-Sales (distributor) dashboard. All aggregation, value
// computation, restricted-product stripping and filtering live in getSosDashboard(); this handler
// only turns query-string filters into a SosDashboardFilters shape and enforces "sales" / "read".
//
// Line/region lockdown is enforced inside getSosDashboard from the caller's own role scope even
// without an override — but PRODUCT-code lockdown (PM/GPM bounded to their explicit
// weekly_sales_product_scope assignment) is only ever resolved in resolvePortalSosScope(), which
// this route did not call. A Product/Group Product Manager hitting this admin route directly
// (their session already carries "sales":"read") would see every product in their line instead
// of just their assigned subset. For the portal-scoped roles, resolve the same scope the portal
// wrapper uses and forward it here too, so product (and RM's region-subtree) lockdown applies
// regardless of which route the caller uses. Every other role's behavior is unchanged.

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

    const { searchParams } = new URL(request.url);
    const filters: SosDashboardFilters = {
      period: firstValue(searchParams.get("period")),
      line: firstValue(searchParams.get("line")),
      distributors: splitList(searchParams.get("distributors")),
      regions: splitList(searchParams.get("regions")),
      areas: splitList(searchParams.get("areas")),
      products: splitList(searchParams.get("products")),
    };

    let options: SosScopeOverrides | undefined;
    if (isPortalSosRole(access.role)) {
      const scope = await resolvePortalSosScope(access);
      options = { allowedProductCodes: scope.allowedProductCodes };
      if (scope.regionOverride !== undefined) options.allowedRegionCodes = scope.regionOverride;
    }

    const data = await getSosDashboard(filters, access, options);
    return NextResponse.json({ success: true, data });
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
