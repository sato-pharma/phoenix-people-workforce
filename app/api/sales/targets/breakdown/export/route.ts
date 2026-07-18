import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  SALES_LINES,
  loadAllCanonicalAreaNames,
  loadDirectBreakdown,
  loadLineSourceBreakdown,
} from "@/lib/sales/monthly-targets";
import { generateSourceAuditWorkbook } from "@/lib/sales/source-audit-workbook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/sales/targets/breakdown/export?period=&line=
// The full sales source audit for a line + month as an .xlsx (distributor×brick + direct channel).
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const url = new URL(request.url);
    const period = (url.searchParams.get("period") ?? "").trim();
    const lineCode = (url.searchParams.get("line") ?? "").trim();
    const line = SALES_LINES.find((entry) => entry.code === lineCode);
    if (!period || !line) {
      return NextResponse.json({ success: false, error: "A valid period and line are required." }, { status: 400 });
    }

    const [indirectRows, directRows, areaNames] = await Promise.all([
      loadLineSourceBreakdown(period, lineCode),
      loadDirectBreakdown(period, lineCode),
      loadAllCanonicalAreaNames(),
    ]);

    const indirect = indirectRows.map((row) => ({
      areaName: areaNames.get(row.areaCode) ?? row.areaCode,
      productName: row.productName,
      distributorName: row.distributorName,
      brickName: row.brickName,
      units: row.units,
      value: row.value,
    }));

    const buffer = await generateSourceAuditWorkbook({ period, lineLabel: line.label, indirect, direct: directRows });
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="sales-source-audit-${line.code}-${period}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    }
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Failed to build the audit workbook." }, { status: 500 });
  }
}
