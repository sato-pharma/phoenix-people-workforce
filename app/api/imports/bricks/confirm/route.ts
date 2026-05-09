import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { saveBrickReferenceWorkbook } from "@/lib/bricks/service";
import { excelSpreadsheetValidation, validateSpreadsheetFile } from "@/lib/uploads/spreadsheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "imports", "import");

    const formData = await request.formData();
    const file = formData.get("file");
    const line = String(formData.get("line") ?? "Pedia").trim() || "Pedia";

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "missing_file", message: "Brick reference workbook is required." },
        { status: 400 },
      );
    }

    const fileValidation = validateSpreadsheetFile(file, {
      ...excelSpreadsheetValidation,
      emptyError: "invalid_brick_reference_file",
      emptyMessage: "Brick reference workbook is empty.",
      tooLargeError: "brick_reference_file_too_large",
      tooLargeMessage: "Brick reference workbook exceeds the 10MB upload limit.",
      unsupportedError: "unsupported_brick_reference_file",
      unsupportedMessage: "Upload a brick reference workbook in .xls or .xlsx format.",
    });
    if (!fileValidation.ok) {
      return NextResponse.json(
        { error: fileValidation.error, message: fileValidation.message },
        { status: fileValidation.status },
      );
    }

    const uploadedBy =
      resolveEmployeeIdentityId(access) ?? access.loginId ?? access.hrId ?? "system";
    const result = await saveBrickReferenceWorkbook({
      file,
      line,
      uploadedBy,
    });

    return NextResponse.json({
      fileName: result.fileName,
      line,
      summary: result.summary,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: error instanceof Error ? error.message : "Forbidden." },
        { status: 403 },
      );
    }

    const message =
      error instanceof Error ? error.message : "Unable to import the brick reference workbook.";
    return NextResponse.json(
      { error: "brick_reference_import_failed", message },
      { status: 500 },
    );
  }
}
