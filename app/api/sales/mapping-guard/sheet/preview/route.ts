import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertGuardSheetOwner, guardSheetFailure } from "@/lib/sales/mapping-guard-sheet-access";
import { previewGuardSheet } from "@/lib/sales/mapping-guard-sheet";
import { parseGuardWorkbook } from "@/lib/sales/mapping-guard-workbook";
import { loadExcelWorkbook } from "@/lib/uploads/exceljs-rows";
import { validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** More rows than the screen can ever list means the file is not an export of it. */
const MAX_SHEET_ROWS = 2000;

/**
 * Read an answered sheet and say what it WOULD do. Writes nothing — not a hold, not a mapping, not a
 * log row. The plan it returns is the only thing the apply step will accept pages of.
 *
 * Super Admin only, server-side, before the file is opened.
 */
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    assertGuardSheetOwner(access);
    await assertPermission(access, "sales", "import");

    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Choose the answered sheet to upload.", success: false }, { status: 400 });
    }
    const checked = validateSpreadsheetFile(file, {
      ...xlsxSpreadsheetValidation,
      unsupportedMessage: "Upload the .xlsx file exported from this screen.",
    });
    if (!checked.ok) {
      return NextResponse.json({ error: checked.message, success: false }, { status: checked.status });
    }

    const workbook = await loadExcelWorkbook(await file.arrayBuffer());
    const parsed = parseGuardWorkbook(workbook);
    if (parsed.length > MAX_SHEET_ROWS) {
      return NextResponse.json(
        { error: `That sheet has ${parsed.length} rows; the held changes never run to more than ${MAX_SHEET_ROWS}.`, success: false },
        { status: 400 },
      );
    }

    return NextResponse.json({ plan: await previewGuardSheet(parsed), sheetRows: parsed.length, success: true });
  } catch (error) {
    return guardSheetFailure(error, "Could not read that sheet.");
  }
}
