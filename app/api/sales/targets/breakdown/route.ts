import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { loadAreaTrend, loadSourceBreakdownDetail } from "@/lib/sales/monthly-targets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/sales/targets/breakdown?period=&line=&area=&product=
// Lazy per-row drill-down: the distributor × brick source lines behind one area/product cell.
// Reconciles to the closing number for that cell. Gated to the Targets surface (sales:import).
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const url = new URL(request.url);
    const period = (url.searchParams.get("period") ?? "").trim();
    const line = (url.searchParams.get("line") ?? "").trim();
    const area = (url.searchParams.get("area") ?? "").trim();
    const product = (url.searchParams.get("product") ?? "").trim() || null;
    if (!period || !line || !area) {
      return NextResponse.json({ success: false, error: "period, line and area are required." }, { status: 400 });
    }

    const [rows, trend] = await Promise.all([
      loadSourceBreakdownDetail(period, line, area, product ?? ""),
      loadAreaTrend(line, area, product),
    ]);
    const totalUnits = rows.reduce((sum, row) => sum + row.units, 0);
    const totalValue = rows.reduce((sum, row) => sum + row.value, 0);
    return NextResponse.json({ success: true, rows, trend, totalUnits, totalValue });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    }
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Failed to load the breakdown." }, { status: 500 });
  }
}
