import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getSosDashboard, type SosDashboardFilters } from "@/lib/sales/sos-dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only feed for the Source-of-Sales (distributor) dashboard. All aggregation, value
// computation, restricted-product stripping and filtering live in getSosDashboard(); this handler
// only turns query-string filters into a SosDashboardFilters shape and enforces "sales" / "read".

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

    const data = await getSosDashboard(filters, access);
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
