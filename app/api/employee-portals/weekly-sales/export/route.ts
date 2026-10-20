import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  buildPortalWeeklyExportFilename,
  buildPortalWeeklyWorkbook,
} from "@/lib/sales/weekly/portal-weekly-export";
import {
  getPortalWeeklyDashboard,
  mayReadManagersWeeklySales,
  toPortalWeeklyScopeView,
  type PortalWeeklyFilters,
} from "@/lib/sales/weekly/portal-weekly-dashboard";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    // The company-wide readers export from the admin Field Sales pages — same session-side
    // scope resolution and the same gate as the dashboard feed.
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
    };

    const { data, scope } = await getPortalWeeklyDashboard(filters, access);
    const workbook = buildPortalWeeklyWorkbook(data, toPortalWeeklyScopeView(scope));
    const buffer = await workbook.xlsx.writeBuffer();
    const filename = buildPortalWeeklyExportFilename(data);

    return new Response(buffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
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
        error: clientSafeErrorMessage(error, "Failed to generate weekly sales export."),
      },
      { status: 500 },
    );
  }
}
