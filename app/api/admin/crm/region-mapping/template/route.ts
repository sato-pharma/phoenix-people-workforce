import ExcelJS from "exceljs";
import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { canUseAdminCrmWorkspace } from "@/lib/crm/admin-access";
import { getActiveBricksForTemplateReference, getAllCrmRegionsForTemplate } from "@/lib/crm/region-brick";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Download/upload round-trip for the Region Mapping tab: exports every CRM region ever seen (mapped,
// ignored, or still pending) with its current Brick ID/Status pre-filled, so an admin bulk-fills in
// Excel and re-uploads via /api/admin/crm/region-mapping/import.
//
// The admin fills in ONLY the Brick ID (a dropdown of every active brick); the Brick Name, Block,
// Area and Region (code + name) columns beside it AUTO-FILL from that Brick ID via in-sheet VLOOKUP
// formulas against an embedded "Bricks" reference sheet — so a mapping can be chosen and verified
// without leaving the file, and typos are prevented by the dropdown. The upload reads only the Brick
// ID / regionID / Status columns and ignores the auto-filled ones, so the round-trip is unaffected.
// The core headers ("CRM regionID", "CRM region name", "Brick ID") still match the owner's own
// manually-built mapping spreadsheet (2026-07-22) so that file uploads here unchanged.
function fileName() {
  return `phoenix-crm-region-brick-mapping-${new Date().toISOString().slice(0, 10)}.xlsx`;
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!canUseAdminCrmWorkspace(access)) {
      return NextResponse.json(
        { error: "forbidden", message: "This action is limited to the admin CRM workspace roles.", success: false },
        { status: 403 },
      );
    }

    const [regions, bricks] = await Promise.all([
      getAllCrmRegionsForTemplate(),
      getActiveBricksForTemplateReference(),
    ]);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Phoenix Workforce";
    workbook.created = new Date();

    const HEADER_FILL = { fgColor: { argb: "FF0F172A" }, pattern: "solid" as const, type: "pattern" as const };
    const REF = "Bricks"; // single-word sheet name → formulas/validation need no quoting
    const brickLastRow = bricks.length + 1; // header on row 1, then one row per brick

    // --- Main sheet FIRST so it stays workbook.worksheets[0] — the import reads the first sheet. Fill
    //     ONLY "Brick ID" (dropdown of valid bricks); every geography column to its right auto-fills
    //     from that Brick ID via an in-sheet VLOOKUP against the Bricks reference sheet below.
    const sheet = workbook.addWorksheet("Region Mapping");
    const header = sheet.addRow([
      "CRM regionID",
      "CRM region name",
      "Visit Count (all-time)",
      "Brick ID",
      "Brick Name",
      "Block Code",
      "Block Name",
      "Area Code",
      "Area Name",
      "Region Code",
      "Region Name",
      "Status",
    ]);
    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    header.eachCell((cell) => {
      cell.fill = HEADER_FILL;
    });

    // Brick ID sits in column D; auto-fill columns E..K map to Bricks reference columns 2..8.
    const geoFormula = (rowNumber: number, refColIndex: number) => ({
      formula: `IFERROR(VLOOKUP($D${rowNumber},${REF}!$A:$H,${refColIndex},FALSE),"")`,
      result: "",
    });

    regions.forEach((region, index) => {
      const rowNumber = index + 2; // data starts on row 2
      const row = sheet.addRow([
        region.crmRegionId,
        region.crmRegionName,
        region.visitCount,
        region.brickId ?? "",
        geoFormula(rowNumber, 2), // Brick Name
        geoFormula(rowNumber, 3), // Block Code
        geoFormula(rowNumber, 4), // Block Name
        geoFormula(rowNumber, 5), // Area Code
        geoFormula(rowNumber, 6), // Area Name
        geoFormula(rowNumber, 7), // Region Code
        geoFormula(rowNumber, 8), // Region Name
        region.status,
      ]);
      // Dropdown of every active brick on the editable Brick ID cell. A WARNING (not a hard block) so
      // an admin can still paste a value from their own sheet; the upload validates against the master
      // regardless and rejects unknown/inactive IDs into the summary.
      row.getCell(4).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [`${REF}!$A$2:$A$${brickLastRow}`],
        showErrorMessage: true,
        errorStyle: "warning",
        errorTitle: "Not in the active brick list",
        error: "This Brick ID isn't in the active brick master. You can keep it, but it may be rejected on upload.",
      };
      // Tint the auto-filled geography columns grey so it's obvious they're computed, not for editing.
      for (let col = 5; col <= 11; col += 1) {
        row.getCell(col).font = { color: { argb: "FF64748B" } };
      }
    });

    [14, 26, 20, 16, 24, 12, 24, 12, 24, 12, 20, 12].forEach((width, index) => {
      sheet.getColumn(index + 1).width = width;
    });
    sheet.getColumn(3).alignment = { horizontal: "right" };
    sheet.autoFilter = { from: { column: 1, row: 1 }, to: { column: 12, row: 1 } };
    sheet.views = [{ state: "frozen", xSplit: 4, ySplit: 1 }];

    // --- Reference sheet: every active brick pre-joined to its block/area/region (code + name). Feeds
    //     both the Brick ID dropdown and the auto-fill VLOOKUPs above.
    const ref = workbook.addWorksheet(REF);
    const refHeader = ref.addRow([
      "Brick ID",
      "Brick Name",
      "Block Code",
      "Block Name",
      "Area Code",
      "Area Name",
      "Region Code",
      "Region Name",
    ]);
    refHeader.font = { bold: true, color: { argb: "FFFFFFFF" } };
    refHeader.eachCell((cell) => {
      cell.fill = HEADER_FILL;
    });
    for (const brick of bricks) {
      ref.addRow([
        brick.brickId,
        brick.brickName,
        brick.blockCode,
        brick.blockName,
        brick.areaCode,
        brick.areaName,
        brick.regionCode,
        brick.regionName,
      ]);
    }
    [16, 26, 12, 24, 12, 24, 12, 20].forEach((width, index) => {
      ref.getColumn(index + 1).width = width;
    });
    ref.autoFilter = { from: { column: 1, row: 1 }, to: { column: 8, row: 1 } };
    ref.views = [{ state: "frozen", ySplit: 1 }];

    const notes = workbook.addWorksheet("Instructions");
    notes.columns = [
      { header: "Field", key: "field", width: 30 },
      { header: "Guidance", key: "guidance", width: 110 },
    ];
    notes.addRows([
      { field: "How to map", guidance: "Fill in ONLY the Brick ID column (there's a dropdown of every active brick). Brick Name, Block, Area and Region — code and name — auto-fill beside it so you can confirm you picked the right place, then re-upload this exact file via \"Upload Mapping\"." },
      { field: "CRM regionID / CRM region name", guidance: "Read-only reference — do not edit. Used to match rows back on upload; a row with no matching regionID is rejected." },
      { field: "Visit Count (all-time)", guidance: "Informational only, ignored on upload. Higher counts = higher priority to map." },
      { field: "Brick ID", guidance: "Pick a real brick from the dropdown (sourced from the Bricks sheet). Validated against source_of_sales_bricks on upload — an unknown or inactive brick ID is rejected, not silently skipped." },
      { field: "Brick Name / Block / Area / Region", guidance: "Auto-filled from the Brick ID by an in-sheet formula (VLOOKUP against the Bricks sheet) — do not type here; they update the moment you choose a Brick ID. Geography is line-independent: every area serves all product lines, so the brick alone determines block/area/region." },
      { field: "Status", guidance: "Leave blank when Brick ID is filled (defaults to \"mapped\"). Type \"ignored\" with Brick ID blank to mark a region as never worth mapping (e.g. a CRM geography artifact). A blank Brick ID + blank Status leaves that region's decision unchanged." },
      { field: "Bricks (reference sheet)", guidance: "The CURRENT brick master (Brick ID → Block / Area / Region, code + name). Superseded pre-rebuild bricks are deliberately NOT listed — they stay active in the database so historical sales/customer rows keep resolving, but a new mapping must never point at a replaced brick. Areas the rebuild never touched (the Others areas: North & South Sinai, New Valley, Hurgada, Luxor, Aswan, Ismailia) still show their existing bricks, since those are the only bricks they have. Feeds the Brick ID dropdown and the auto-fill formulas — do not delete or rename this sheet." },
    ]);
    notes.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    notes.getRow(1).eachCell((cell) => {
      cell.fill = HEADER_FILL;
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
      { error: "region_mapping_template_failed", message: clientSafeErrorMessage(error, "Failed to build the region mapping template."), success: false },
      { status: 500 },
    );
  }
}
