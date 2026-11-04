import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { currentCairoDateParts } from "@/lib/i18n/format";
import { unpublishedClosingMessage } from "@/lib/sales/closing-details-publication-gate";
import { SALES_LINES, loadAreaTrend, loadSourceBreakdownDetail } from "@/lib/sales/monthly-targets";
import { assertTargetsAreaInScope } from "@/lib/sales/portal-targets";
import { isSalesPeriodReleased } from "@/lib/sales/unpublished-sales-access";
import { SALES_VS_TARGET_FLOOR, loadPublishedPeriodKeys } from "@/lib/sales/vs-target";
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

    // THE PUBLICATION GATE, BEFORE A SOURCE ROW IS READ, AND FOR EVERY ROLE (owner, 2026-11-04). The
    // grid above this panel withholds an unpublished month's sales, and its expander is hidden then,
    // but `period` is in the query string. The keys run to the current month because the trend does
    // not stop at `period`: it returns every month the line has loaded, so asking for September would
    // otherwise draw October beside it.
    const { year, month } = currentCairoDateParts();
    const publishedKeys = await loadPublishedPeriodKeys(
      SALES_VS_TARGET_FLOOR,
      `${year}-${String(month).padStart(2, "0")}`,
    );
    if (!isSalesPeriodReleased(period, line, publishedKeys)) {
      const lineLabel = SALES_LINES.find((entry) => entry.code === line)?.label ?? line;
      return NextResponse.json(
        { success: false, error: unpublishedClosingMessage(lineLabel, period) },
        { status: 403 },
      );
    }

    const [rows, trend] = await Promise.all([
      loadSourceBreakdownDetail(period, line, area, product ?? ""),
      loadAreaTrend(line, area, product),
    ]);
    const totalUnits = rows.reduce((sum, row) => sum + row.units, 0);
    const totalValue = rows.reduce((sum, row) => sum + row.value, 0);
    return NextResponse.json({
      success: true,
      rows,
      trend: trend.filter((point) => isSalesPeriodReleased(point.period, line, publishedKeys)),
      totalUnits,
      totalValue,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Failed to load the breakdown.") }, { status: 500 });
  }
}
