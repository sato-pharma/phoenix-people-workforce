import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { excelCellText, loadExcelWorkbook } from "@/lib/uploads/exceljs-rows";
import type ExcelJS from "exceljs";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import type { WeeklyContractSheetRole } from "@/lib/sales/weekly/column-contract";
import { matchWeeklySheet, weeklySheetMatcher } from "@/lib/sales/weekly/sheet-match";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only "what does my file actually have at these columns?" preview for the WEEKLY column editor.
// The admin uploads a sample file + the DRAFT sheets they're editing; we read the header cell at each
// configured column index and echo it back so an off-by-one / wrong column is caught BEFORE saving.
// Nothing is persisted. Only header text leaves the parse (no data rows).
//
// The worksheet is picked by sheet-match.ts, the rule the importer itself uses, keyed by the distributor
// — never by the draft's sheet names and never by falling back to whatever sheet comes first. A sheet
// the import would not find is named back in `missingSheets`.

type DraftField = { field: string; label?: string; columnIndex: number };
type DraftSheet = { role: string; headerRowNumber?: number; formField?: string; fields?: DraftField[] };
type PreviewColumn = { sheetRole: string; field: string; label: string; columnIndex: number; observedHeader: string; status: "filled" | "empty" };

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "import");

    const form = await request.formData();
    const distributorCode = String(form.get("distributorCode") ?? "").trim();
    if (!distributorCode) {
      return NextResponse.json({ success: false, error: "Pick a distributor, then preview again." }, { status: 400 });
    }
    let sheets: DraftSheet[] = [];
    try {
      sheets = JSON.parse(String(form.get("sheets") ?? "[]")) as DraftSheet[];
    } catch {
      return NextResponse.json({ success: false, error: "Invalid sheets payload." }, { status: 400 });
    }
    if (!Array.isArray(sheets) || sheets.length === 0) {
      return NextResponse.json({ success: false, error: "No sheets to preview." }, { status: 400 });
    }

    // Load each provided file once, keyed by the form field it came in on.
    const workbooks = new Map<string, ExcelJS.Workbook>();
    for (const key of ["file", "salesFile", "stockFile"]) {
      const value = form.get(key);
      if (value && typeof value === "object" && "arrayBuffer" in value) {
        try {
          workbooks.set(key, await loadExcelWorkbook(await (value as File).arrayBuffer()));
        } catch {
          return NextResponse.json({ success: false, error: `Could not read the ${key} as an .xlsx workbook.` }, { status: 400 });
        }
      }
    }
    if (workbooks.size === 0) {
      return NextResponse.json({ success: false, error: "Attach a sample file to preview." }, { status: 400 });
    }

    const columns: PreviewColumn[] = [];
    const missingFiles = new Set<string>();
    const missingSheets: string[] = [];
    for (const sheet of sheets) {
      const formField = sheet.formField ?? "file";
      const workbook = workbooks.get(formField);
      if (!workbook) {
        missingFiles.add(formField);
        continue;
      }
      const matcher = weeklySheetMatcher(distributorCode, sheet.role as WeeklyContractSheetRole);
      const match = matcher ? matchWeeklySheet(workbook, matcher) : null;
      if (!matcher || !match) {
        missingSheets.push(matcher ? `"${matcher.name}" (${sheet.role})` : sheet.role);
        continue;
      }
      const headerRow = match.worksheet.getRow(sheet.headerRowNumber === 2 ? 2 : 1);
      for (const field of sheet.fields ?? []) {
        const observedHeader = excelCellText(headerRow.getCell(field.columnIndex).value);
        columns.push({
          sheetRole: sheet.role,
          field: field.field,
          label: field.label ?? field.field,
          columnIndex: field.columnIndex,
          observedHeader,
          status: observedHeader ? "filled" : "empty",
        });
      }
    }

    return NextResponse.json({ success: true, columns, missingFiles: [...missingFiles], missingSheets });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Preview failed.") }, { status: 500 });
  }
}
