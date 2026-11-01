import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { loadAreaTrend, loadSourceBreakdownDetail } from "@/lib/sales/monthly-targets";
import { assertTargetsAreaInScope } from "@/lib/sales/portal-targets";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/sales/targets/breakdown?period=&line=&area=&product=
// Lazy per-row drill-down: the distributor × brick source lines behind one area/product cell.
// Reconciles to the closing number for that cell.
//
// This is a READ, so it is `sales:read` rather than `sales:import` — that is what lets the scoped
// read-only Targets view (District/Regional/National Sales Manager, and the CEO on the admin page)
// expand a row at all.
//
// `area` is caller-supplied, so the permission relaxation MUST be paired with an area-scope check:
// without assertTargetsAreaInScope, any District Manager could enumerate every other area's
// distributor/brick/customer detail simply by editing the query string. The LINE is checked with the
// area, because an area code repeats across lines (CA1 is CNS and Pedia) and `line` is passed straight
// to the reads below. Company-scope roles pass straight through. The four WRITE/authoring routes beside this one stay on `sales:import`.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");

    const url = new URL(request.url);
    const period = (url.searchParams.get("period") ?? "").trim();
    const line = (url.searchParams.get("line") ?? "").trim();
    const area = (url.searchParams.get("area") ?? "").trim();
    const product = (url.searchParams.get("product") ?? "").trim() || null;
    if (!period || !line || !area) {
      return NextResponse.json({ success: false, error: "period, line and area are required." }, { status: 400 });
    }
    await assertTargetsAreaInScope(access, area, line, period);

    const [rows, trend] = await Promise.all([
      loadSourceBreakdownDetail(period, line, area, product ?? ""),
      loadAreaTrend(line, area, product),
    ]);
    const totalUnits = rows.reduce((sum, row) => sum + row.units, 0);
    const totalValue = rows.reduce((sum, row) => sum + row.value, 0);
    return NextResponse.json({ success: true, rows, trend, totalUnits, totalValue });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Failed to load the breakdown.") }, { status: 500 });
  }
}
