import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { importExpensesWorkbook } from "@/lib/geo-intelligence/service";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { excelSpreadsheetValidation, validateSpreadsheetFile } from "@/lib/uploads/spreadsheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "geo_intelligence", "import");

    const formData = await request.formData();
    const file = formData.get("file");
    const sourceFileMonth = String(formData.get("sourceFileMonth") ?? "").trim();

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "missing_file", message: "Expenses workbook file is required." },
        { status: 400 },
      );
    }

    const validation = validateSpreadsheetFile(file, {
      ...excelSpreadsheetValidation,
      emptyError: "invalid_geo_expenses_file",
      emptyMessage: "Expenses workbook is empty.",
      tooLargeError: "geo_expenses_file_too_large",
      tooLargeMessage: "Expenses workbook exceeds the 10MB upload limit.",
      unsupportedError: "unsupported_geo_expenses_file",
      unsupportedMessage: "Upload an expenses workbook in .xls or .xlsx format.",
    });
    if (!validation.ok) {
      return NextResponse.json(
        { error: validation.error, message: validation.message },
        { status: validation.status },
      );
    }

    const result = await importExpensesWorkbook({
      file,
      sourceFileMonth: sourceFileMonth || null,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to import expenses workbook.";
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "geo_import_expenses_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
