import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { loadWeeklyStockDashboard, parseWeeklyStockSearchParams } from "@/lib/sales/weekly/stock-dashboard-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Admin-shell feed for Weekly Stock. Scope resolves from the SESSION inside loadWeeklyStockDashboard;
// query params only narrow inside it.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "read");
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
