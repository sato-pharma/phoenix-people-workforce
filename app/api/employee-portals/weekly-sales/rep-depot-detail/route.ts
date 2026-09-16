import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { isPortalWeeklyRepRole } from "@/lib/sales/weekly/portal-weekly-rep";
import {
  getPortalWeeklyRepDepotDetail,
  parseRepWeeklyDepotDetailParams,
} from "@/lib/sales/weekly/portal-weekly-rep-depot-detail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Feed for a Medical Rep's own "Depot detail" tab: his own area's share of every depot, and nothing
// wider. Medical Rep only; the managers read their detail from /depot-detail, which refuses a rep.
// His seat, and so everything he can see, resolves from the SESSION inside the loader.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");
    if (!isPortalWeeklyRepRole(access.role)) {
      return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
    }
    const payload = await getPortalWeeklyRepDepotDetail(
      access,
      parseRepWeeklyDepotDetailParams(new URL(request.url).searchParams),
    );
    return NextResponse.json({ success: true, ...payload });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Failed to load your weekly sales depot detail.") },
      { status: 500 },
    );
  }
}
