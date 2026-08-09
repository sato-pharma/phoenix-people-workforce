import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getSalesDashboard } from "@/lib/sales/service";
import type { SalesDashboardFilters } from "@/lib/sales/types";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only feed for the Monthly Sales Dashboard. All aggregation, ownership, access scoping and
// restricted-product stripping live in getSalesDashboard(); this handler only turns query-string
// filters into a SalesDashboardFilters shape and enforces the "sales" / "read" permission. Filtering
// is server-side (not client-side over the capped transactions feed) so every KPI/chart/table total
// stays correct for the selected slice.

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
    const filters: SalesDashboardFilters = {
      line: firstValue(searchParams.get("line")),
      salesType: firstValue(searchParams.get("salesType")),
      manager: firstValue(searchParams.get("manager")),
      territory: firstValue(searchParams.get("territory")),
      family: firstValue(searchParams.get("family")),
      periods: splitList(searchParams.get("periods")),
      products: splitList(searchParams.get("products")),
    };

    const data = await getSalesDashboard(filters, access);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Failed to load monthly sales dashboard.") },
      { status: 500 },
    );
  }
}
