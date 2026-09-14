import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import {
  isPortalWeeklyStockRole,
  loadWeeklyStockDashboard,
  parseWeeklyStockSearchParams,
} from "@/lib/sales/weekly/stock-dashboard-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Employee-portal feed for Weekly Stock. Same gate shape as the portal Weekly Sales feed, with Medical
// Rep admitted. Scope (line / region / product) resolves from the SESSION inside the loader.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");
    const isCompanyExecutive = access.role === "CEO" || access.role === "Super Admin";
    if (!isPortalWeeklyStockRole(access.role) && !isCompanyExecutive) {
      return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
    }
    const payload = await loadWeeklyStockDashboard(parseWeeklyStockSearchParams(new URL(request.url).searchParams), access);
    return NextResponse.json({ success: true, ...payload });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Failed to load weekly stock.") },
      { status: 500 },
    );
  }
}
