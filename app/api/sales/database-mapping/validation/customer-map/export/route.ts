import ExcelJS from "exceljs";
import { NextResponse } from "next/server";

import { systemIdentity } from "@/config/system-settings";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { listCustomerMap } from "@/lib/sales/normalizer/customer-map";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only export: serialise the customer -> brick crosswalk (optionally one distributor) to a
// Phoenix-branded XLSX. Persists nothing.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "export");
    const distributor = new URL(request.url).searchParams.get("distributor") ?? "";
    const filtered = distributor && distributor !== "ALL" ? distributor : "";
    const rows = await listCustomerMap(filtered ? { distributorCode: filtered } : undefined);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = systemIdentity.appName;
    const sheet = workbook.addWorksheet("Customer map");
    const header = sheet.addRow(["Distrub ID", "Customer code", "Customer name", "Address", "Brick ID", "Area ID", "Region ID"]);
    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    header.eachCell((cell) => { cell.fill = { fgColor: { argb: "FF0B0B0B" }, pattern: "solid", type: "pattern" }; });
    rows.forEach((r) => sheet.addRow([r.distributorCode, r.customerCode, r.customerName, r.address, r.brickId, r.areaCode, r.regionCode]));
    [12, 16, 28, 34, 12, 10, 10].forEach((w, i) => { sheet.getColumn(i + 1).width = w; });

    const buffer = await workbook.xlsx.writeBuffer();
    const fileName = `phoenix-customer-map-${filtered || "all"}.xlsx`;
    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Export failed." }, { status: 500 });
  }
}
