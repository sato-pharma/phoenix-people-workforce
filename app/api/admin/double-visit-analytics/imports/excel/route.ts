import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { buildAndSaveDoubleVisitExcelImport } from "@/lib/double-visit-analytics/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "double_visit_analytics", "import");

    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "missing_file", message: "Upload one Double Visit Excel file." }, { status: 400 });
    }

    const fileValidation = validateSpreadsheetFile(file, {
      ...xlsxSpreadsheetValidation,
      emptyError: "invalid_double_visit_file",
      emptyMessage: "Double Visit upload is empty.",
      tooLargeError: "double_visit_file_too_large",
      tooLargeMessage: "Double Visit upload exceeds the 10MB upload limit.",
      unsupportedError: "unsupported_format",
      unsupportedMessage: "Upload a Double Visit Excel file in .xlsx format.",
    });
    if (!fileValidation.ok) {
      return NextResponse.json({ error: fileValidation.error, message: fileValidation.message }, { status: fileValidation.status });
    }

    const result = await buildAndSaveDoubleVisitExcelImport({
      actorLoginId: access.loginId ?? access.hrId ?? "system",
      arrayBuffer: await file.arrayBuffer(),
      fileName: file.name,
    });
    return NextResponse.json({ data: result, success: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to import Double Visit files." }, { status: 403 });
    }
    return NextResponse.json({
      error: "double_visit_excel_import_failed",
      message: error instanceof Error ? error.message : "Double Visit Excel import failed.",
    }, { status: 500 });
  }
}
