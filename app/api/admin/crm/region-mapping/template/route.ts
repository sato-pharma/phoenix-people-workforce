import ExcelJS from "exceljs";
import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { getAllCrmRegionsForTemplate } from "@/lib/crm/region-brick";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Download/upload round-trip for the Region Mapping tab: this exports every CRM region ever seen
// (mapped, ignored, or still pending) with its current Brick ID/Status pre-filled, so an admin can
// bulk-correct or bulk-fill in Excel and re-upload via /api/admin/crm/region-mapping/import. Column
// headers ("CRM regionID", "CRM region name", "Brick ID") deliberately match the owner's own
// manually-built mapping spreadsheet (2026-07-22) so that file uploads here unchanged.
function fileName() {
  return `phoenix-crm-region-brick-mapping-${new Date().toISOString().slice(0, 10)}.xlsx`;
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin") {
      return NextResponse.json(
        { error: "forbidden", message: "Only Super Admin can export the CRM region mapping template.", success: false },
        { status: 403 },
      );
    }

    const regions = await getAllCrmRegionsForTemplate();

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Phoenix Workforce";
    workbook.created = new Date();

    const sheet = workbook.addWorksheet("Region Mapping");
    const header = sheet.addRow([
      "CRM regionID",
      "CRM region name",
      "Visit Count (all-time)",
      "Brick ID",
      "Status",
    ]);
    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    header.eachCell((cell) => {
      cell.fill = { fgColor: { argb: "FF0F172A" }, pattern: "solid", type: "pattern" };
    });

    for (const region of regions) {
      sheet.addRow([
        region.crmRegionId,
        region.crmRegionName,
        region.visitCount,
        region.brickId ?? "",
        region.status,
      ]);
    }
    [14, 26, 20, 16, 12].forEach((width, index) => {
      sheet.getColumn(index + 1).width = width;
    });
    sheet.getColumn(3).alignment = { horizontal: "right" };
    sheet.autoFilter = { from: { column: 1, row: 1 }, to: { column: 5, row: 1 } };
    sheet.views = [{ state: "frozen", ySplit: 1 }];

    const notes = workbook.addWorksheet("Instructions");
    notes.columns = [
      { header: "Field", key: "field", width: 26 },
      { header: "Guidance", key: "guidance", width: 100 },
    ];
    notes.addRows([
      { field: "CRM regionID / CRM region name", guidance: "Read-only reference — do not edit. Used to match rows back on upload; a row with no matching regionID is rejected." },
      { field: "Visit Count (all-time)", guidance: "Informational only, ignored on upload. Higher counts = higher priority to map." },
      { field: "Brick ID", guidance: "Enter a real brick_id from the Phoenix brick master (e.g. B100-11). Validated against source_of_sales_bricks on upload — an unknown or inactive brick ID is rejected, not silently skipped." },
      { field: "Status", guidance: "Leave blank when Brick ID is filled (defaults to \"mapped\"). Type \"ignored\" with Brick ID blank to mark a region as never worth mapping (e.g. a CRM geography artifact). A blank Brick ID + blank Status leaves that region's decision unchanged." },
    ]);
    notes.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    notes.getRow(1).eachCell((cell) => {
      cell.fill = { fgColor: { argb: "FF0F172A" }, pattern: "solid", type: "pattern" };
    });
    notes.eachRow((row) => {
      row.eachCell((cell) => {
        cell.alignment = { vertical: "top", wrapText: true };
      });
    });

    const buffer = await workbook.xlsx.writeBuffer();
    return new Response(buffer, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${fileName()}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: "region_mapping_template_failed", message: error instanceof Error ? error.message : "Failed to build the region mapping template.", success: false },
      { status: 500 },
    );
  }
}
