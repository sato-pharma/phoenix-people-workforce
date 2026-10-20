import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  getPortalWeeklyDashboard,
  mayReadManagersWeeklySales,
  toPortalWeeklyScopeView,
  type PortalWeeklyFilters,
} from "@/lib/sales/weekly/portal-weekly-dashboard";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only feed for the employee-portal Weekly Sales dashboard.
// Scope (line / region / product) is resolved from the SESSION inside getPortalWeeklyDashboard
// — query params only carry the user's own filter selections; callers cannot widen past their role.

function splitList(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseMode(value: string | null): "include" | "exclude" {
  return value?.trim() === "exclude" ? "exclude" : "include";
}

function parseIntList(value: string | null): number[] {
  return splitList(value)
    .map((part) => parseInt(part, 10))
    .filter((n) => !Number.isNaN(n));
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");
    // The company-wide readers (CEO, Super Admin, SFE Manager) consume this same feed from the
    // admin Field Sales pages (/admin/field-sales/weekly-sales). Scope still resolves server-side
    // from the session — each lands on his own tier and cannot widen anything via query params.
    if (!mayReadManagersWeeklySales(access.role)) {
      return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const filters: PortalWeeklyFilters = {
      cycleMonths: splitList(searchParams.get("months")),
      cycleMonthMode: parseMode(searchParams.get("monthsMode")),
      weekNumbers: parseIntList(searchParams.get("weeks")),
      weekNumberMode: parseMode(searchParams.get("weeksMode")),
      distributorCodes: splitList(searchParams.get("distributors")),
      distributorFilterMode: parseMode(searchParams.get("distributorsMode")),
      regionCodes: splitList(searchParams.get("regions")),
      regionFilterMode: parseMode(searchParams.get("regionsMode")),
      productCodes: splitList(searchParams.get("products")),
      productFilterMode: parseMode(searchParams.get("productsMode")),
      lineCodes: splitList(searchParams.get("lines")),
      lineFilterMode: parseMode(searchParams.get("linesMode")),
      unitProductCode: searchParams.get("unitProduct")?.trim() || null,
    };

    const { data, scope, comparison, fieldForce } = await getPortalWeeklyDashboard(filters, access, { includeFieldForce: true });
    return NextResponse.json({
      success: true,
      data,
      scope: toPortalWeeklyScopeView(scope),
      comparison,
      fieldForce,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }
    return NextResponse.json(
      {
        success: false,
        error: clientSafeErrorMessage(error, "Failed to load weekly sales dashboard."),
      },
      { status: 500 },
    );
  }
}
