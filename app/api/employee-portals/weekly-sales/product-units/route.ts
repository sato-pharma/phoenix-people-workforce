import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { mayReadManagersWeeklySales } from "@/lib/sales/weekly/portal-weekly-dashboard";
import {
  getPortalWeeklyProductUnits,
  WEEKLY_PRODUCT_UNITS_MONTHS,
} from "@/lib/sales/weekly/portal-weekly-product-units";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only feed for the Weekly Sales review's PER-PRODUCT UNITS tab.
//
// Its own route, and not part of the dashboard feed, for the reason the field force itself is
// opt-in there: this grid reads the row grain for SEVERAL months and runs the field-force build once
// per month. Paying that on every dashboard load — for a tab most readers never open — would have
// made the whole page slower for nothing. The tab fetches when it is first opened and never again
// unless the reader asks for a different window.
//
// Scope (line / region / product / own areas) is resolved from the SESSION inside
// getPortalWeeklyProductUnits. Query params carry only the month window; a caller cannot widen
// past the role it signed in with.

function splitList(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");
    // The admin Field Sales pages render this same review, so a company-wide reader reaches it here
    // too — on his own tier, resolved server-side exactly as the dashboard feed does.
    if (!mayReadManagersWeeklySales(access.role)) {
      return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const monthsParam = parseInt(searchParams.get("monthsBack") ?? "", 10);
    const matrix = await getPortalWeeklyProductUnits(access, {
      cycleMonths: splitList(searchParams.get("months")),
      months: Number.isNaN(monthsParam) ? WEEKLY_PRODUCT_UNITS_MONTHS : monthsParam,
    });

    return NextResponse.json({ success: true, productUnits: matrix });
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
        error: clientSafeErrorMessage(error, "Failed to load per-product units."),
      },
      { status: 500 },
    );
  }
}
