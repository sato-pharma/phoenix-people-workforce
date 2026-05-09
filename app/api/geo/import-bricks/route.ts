import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { importBricksWorkbook } from "@/lib/geo-intelligence/service";
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
    const line = String(formData.get("line") ?? "").trim();

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "missing_file", message: "Brick workbook file is required." },
        { status: 400 },
      );
    }

    const validation = validateSpreadsheetFile(file, {
      ...excelSpreadsheetValidation,
      emptyError: "invalid_geo_bricks_file",
      emptyMessage: "Brick workbook is empty.",
      tooLargeError: "geo_bricks_file_too_large",
      tooLargeMessage: "Brick workbook exceeds the 10MB upload limit.",
      unsupportedError: "unsupported_geo_bricks_file",
      unsupportedMessage: "Upload a brick workbook in .xls or .xlsx format.",
    });
    if (!validation.ok) {
      return NextResponse.json(
        { error: validation.error, message: validation.message },
        { status: validation.status },
      );
    }

    const result = await importBricksWorkbook({ file, line: line || null });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to import bricks workbook.";
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "geo_import_bricks_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
