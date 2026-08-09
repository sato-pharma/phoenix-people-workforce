import ExcelJS from "exceljs";
import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { getActiveBricksForTemplateReference } from "@/lib/crm/region-brick";
import { canUseAdminCrmWorkspace } from "@/lib/crm/admin-access";
import { getAllCrmCustomersForTemplate } from "@/lib/crm/customer-brick";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Download/upload round-trip for the Customer Mapping tab: exports every CRM customer/contact ever
// seen (mapped, ignored, or still pending) with its current Brick ID/Status pre-filled, so an admin
// bulk-fills in Excel and re-uploads via /api/admin/crm/customer-mapping/import.
//
// One level finer than the Region Mapping tab (same self-populating design, see that route's own
// notes): the admin fills in ONLY the Brick ID (a dropdown of every CURRENT brick — the same
// reference list Region Mapping uses, so the two tabs can never disagree about what's a valid
// target); Brick Name, Block, Area and Region auto-fill beside it via in-sheet VLOOKUP formulas
// against the embedded "Bricks" reference sheet.
function fileName() {
  return `phoenix-crm-customer-brick-mapping-${new Date().toISOString().slice(0, 10)}.xlsx`;
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

    const [customers, bricks] = await Promise.all([
      getAllCrmCustomersForTemplate(),
      getActiveBricksForTemplateReference(),
    ]);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Phoenix Workforce";
    workbook.created = new Date();

    const HEADER_FILL = { fgColor: { argb: "FF0F172A" }, pattern: "solid" as const, type: "pattern" as const };
    const REF = "Bricks"; // single-word sheet name → formulas/validation need no quoting
    const brickLastRow = bricks.length + 1; // header on row 1, then one row per brick

    // --- Main sheet FIRST so it stays workbook.worksheets[0] — the import reads the first sheet. Fill
    //     ONLY "Brick ID" (dropdown of current bricks); every geography column to its right auto-fills
    //     from that Brick ID via an in-sheet VLOOKUP against the Bricks reference sheet below.
    const sheet = workbook.addWorksheet("Customer Mapping");
    const header = sheet.addRow([
      "CRM contactID",
      "CRM contact name",
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

    customers.forEach((customer, index) => {
      const rowNumber = index + 2; // data starts on row 2
      const row = sheet.addRow([
        customer.crmContactId,
        customer.crmContactName,
        customer.visitCount,
        customer.brickId ?? "",
        geoFormula(rowNumber, 2), // Brick Name
        geoFormula(rowNumber, 3), // Block Code
        geoFormula(rowNumber, 4), // Block Name
        geoFormula(rowNumber, 5), // Area Code
        geoFormula(rowNumber, 6), // Area Name
        geoFormula(rowNumber, 7), // Region Code
        geoFormula(rowNumber, 8), // Region Name
        customer.status,
      ]);
      // Dropdown of every current brick on the editable Brick ID cell. A WARNING (not a hard block) so
      // an admin can still paste a value from their own sheet; the upload validates against the CURRENT
      // brick index regardless and rejects unknown/inactive/superseded IDs into the summary.
      row.getCell(4).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [`${REF}!$A$2:$A$${brickLastRow}`],
        showErrorMessage: true,
        errorStyle: "warning",
        errorTitle: "Not in the current brick list",
        error: "This Brick ID isn't in the current brick master. You can keep it, but it may be rejected on upload.",
      };
      // Tint the auto-filled geography columns grey so it's obvious they're computed, not for editing.
      for (let col = 5; col <= 11; col += 1) {
        row.getCell(col).font = { color: { argb: "FF64748B" } };
      }
    });

    [14, 30, 20, 16, 24, 12, 24, 12, 24, 12, 20, 12].forEach((width, index) => {
      sheet.getColumn(index + 1).width = width;
    });
    sheet.getColumn(3).alignment = { horizontal: "right" };
    sheet.autoFilter = { from: { column: 1, row: 1 }, to: { column: 12, row: 1 } };
    sheet.views = [{ state: "frozen", xSplit: 4, ySplit: 1 }];

    // --- Reference sheet: every current brick pre-joined to its block/area/region (code + name).
    //     Feeds both the Brick ID dropdown and the auto-fill VLOOKUPs above. Identical content to the
    //     Region Mapping template's own Bricks sheet — same source function, same "current" rule.
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
      { field: "How to map", guidance: "Fill in ONLY the Brick ID column (there's a dropdown of every current brick). Brick Name, Block, Area and Region — code and name — auto-fill beside it so you can confirm you picked the right place, then re-upload this exact file via \"Upload Mapping\"." },
      { field: "CRM contactID / CRM contact name", guidance: "Read-only reference — do not edit. Used to match rows back on upload; a row with no matching contactID is rejected." },
      { field: "Visit Count (all-time)", guidance: "Informational only, ignored on upload. Higher counts = higher priority to map." },
      { field: "Brick ID", guidance: "Pick a real brick from the dropdown (sourced from the Bricks sheet). Validated against the current brick master on upload — an unknown, inactive, or superseded brick ID is rejected, not silently skipped." },
      { field: "Brick Name / Block / Area / Region", guidance: "Auto-filled from the Brick ID by an in-sheet formula (VLOOKUP against the Bricks sheet) — do not type here; they update the moment you choose a Brick ID." },
      { field: "Status", guidance: "Leave blank when Brick ID is filled (defaults to \"mapped\"). Type \"ignored\" with Brick ID blank to mark a customer as never worth mapping (e.g. a CRM-side duplicate or artifact contact). A blank Brick ID + blank Status leaves that customer's decision unchanged." },
      { field: "Why map by customer, not just region?", guidance: "A CRM region (\"Dokki\") groups many different customers into one rough locality. Mapping the CUSTOMER directly is more precise — it wins over that customer's region mapping wherever both exist — but is more work (~12.5k contacts vs ~300 regions), so most admins should map regions first and only drop to customer-level for high-volume or misresolved doctors/pharmacies." },
      { field: "Bricks (reference sheet)", guidance: "The CURRENT brick master only (Brick ID → Block / Area / Region, code + name) — the exact same list the Region Mapping template uses. Superseded pre-rebuild bricks are deliberately NOT listed. Feeds the Brick ID dropdown and the auto-fill formulas — do not delete or rename this sheet." },
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
      { error: "customer_mapping_template_failed", message: clientSafeErrorMessage(error, "Failed to build the customer mapping template."), success: false },
      { status: 500 },
    );
  }
}
