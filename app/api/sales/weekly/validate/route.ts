import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { importWeeklySalesFile } from "@/lib/sales/weekly/service";
import { validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Weekly files are small (a few hundred rows), so a plain multipart upload is enough — no signed
// storage URL path like the monthly importer needs.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "import");

    const formData = await request.formData();
    const file = formData.get("file");
    const distributorCode = String(formData.get("distributorCode") ?? "").trim();
    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: "No file was uploaded.", code: "invalid_weekly_file" }, { status: 400 });
    }

    // The weekly parser only reads .xlsx (ExcelJS xlsx.load). Reject legacy .xls up front with a
    // clean 400 instead of letting it fail mid-parse as a 500.
    const fileValidation = validateSpreadsheetFile(file, {
      ...xlsxSpreadsheetValidation,
      emptyError: "invalid_weekly_file",
      tooLargeMessage: "Weekly workbook exceeds the 10MB upload limit.",
    });
    if (!fileValidation.ok) {
      return NextResponse.json(
        { success: false, error: fileValidation.message, code: fileValidation.error },
        { status: fileValidation.status },
      );
    }

    const uploadedBy = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    const result = await importWeeklySalesFile({ distributorCode, file, uploadedBy });
    const blocked = result.status !== "validated";

    return NextResponse.json(
      {
        success: !blocked,
        data: result,
        error: blocked ? "Validation blocked. Fix the flagged rows, then re-upload." : undefined,
        message: blocked ? "Validation blocked." : "Validation passed and stored.",
      },
      { status: blocked ? 400 : 200 },
    );
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    }
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json(
        { success: false, error: error.message, code: error.code, details: error.details },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Weekly sales validation failed." },
      { status: 500 },
    );
  }
}
