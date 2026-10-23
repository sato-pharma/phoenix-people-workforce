import { hrIdForStorage } from "@/lib/hr-id";
import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { previewOfficeAllocation } from "@/lib/sales/office-upload";
import { salesSpreadsheetValidation, spreadsheetTooLargeMessage, validateSpreadsheetFile } from "@/lib/uploads/spreadsheets";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    void (hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? "system");

    const formData = await request.formData();
    const formFile = formData.get("file");
    const file = formFile instanceof File ? formFile : null;
    const period = String(formData.get("period") ?? "").trim();

    if (!file) return NextResponse.json({ success: false, error: "Office workbook file is required." }, { status: 400 });
    if (!period) return NextResponse.json({ success: false, error: "Period is required." }, { status: 400 });

    const fileValidation = validateSpreadsheetFile(file, {
      ...salesSpreadsheetValidation,
      emptyError: "invalid_office_file",
      emptyMessage: "Office workbook is empty.",
      tooLargeError: "office_file_too_large",
      tooLargeMessage: spreadsheetTooLargeMessage("Office workbook"),
      unsupportedError: "unsupported_office_file_type",
      unsupportedMessage: "Upload the office sales sheet in .xls or .xlsx format.",
    });
    if (!fileValidation.ok) {
      return NextResponse.json({ success: false, error: fileValidation.message, code: fileValidation.error }, { status: fileValidation.status });
    }

    const buffer = await file.arrayBuffer();
    const result = await previewOfficeAllocation({ buffer, fileName: file.name, period });
    const blocked = result.status === "blocked";
    return NextResponse.json(
      { success: !blocked, data: result, message: blocked ? "Some office product names are not mapped." : "Office allocation preview ready." },
      { status: blocked ? 400 : 200 },
    );
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Office preview failed.") }, { status: 500 });
  }
}
