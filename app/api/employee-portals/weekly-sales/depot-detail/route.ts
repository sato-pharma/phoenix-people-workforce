import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import {
  loadWeeklySalesDepotDetail,
  parseWeeklySalesDetailManagerParams,
} from "@/lib/sales/weekly/depot-detail-service";
import { mayReadManagersWeeklySales } from "@/lib/sales/weekly/portal-weekly-dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Feed for the managers' Weekly Sales "Depot Detail" tab: every product at every depot, laid out like
// Weekly Stock. Same gate as the managers' Weekly Sales feed, so a Medical Rep is refused here and reads
// his own area's detail from /rep-depot-detail. Scope resolves from the SESSION inside the loader.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");
    if (!mayReadManagersWeeklySales(access.role)) {
      return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
    }
    const payload = await loadWeeklySalesDepotDetail(
      parseWeeklySalesDetailManagerParams(new URL(request.url).searchParams),
      access,
    );
    return NextResponse.json({ success: true, ...payload });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Failed to load the weekly sales depot detail.") },
      { status: 500 },
    );
  }
}
