import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { commitMonthlyUpload } from "@/lib/sales/sales-upload";
import { validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Persist a raw monthly sheet. Blocks (persists nothing) if any row is unmapped; replaces a prior
// upload for the same distributor+period so re-uploading never double-counts.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    const form = await request.formData();
    const file = form.get("file");
    const distributorCode = String(form.get("distributorCode") ?? "").trim();
    const periodOverride = String(form.get("period") ?? "").trim();
    const acknowledgeWarnings = String(form.get("acknowledgeWarnings") ?? "").trim() === "true";
    if (!(file instanceof File)) return NextResponse.json({ success: false, error: "A raw sheet is required." }, { status: 400 });
    if (!distributorCode) return NextResponse.json({ success: false, error: "Distributor is required." }, { status: 400 });

    const validation = validateSpreadsheetFile(file, {
      ...xlsxSpreadsheetValidation,
      emptyError: "invalid_sales_file", emptyMessage: "The sheet is empty.",
      tooLargeError: "sales_file_too_large", tooLargeMessage: "The sheet exceeds the 10MB upload limit.",
      unsupportedError: "unsupported_sales_file_type", unsupportedMessage: "Upload the raw sheet in .xlsx format.",
    });
    if (!validation.ok) return NextResponse.json({ success: false, error: validation.message, code: validation.error }, { status: validation.status });

    const uploadedBy = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    const result = await commitMonthlyUpload({ distributorCode, file, periodOverride, uploadedBy, acknowledgeWarnings });
    if (result.status === "blocked") {
      return NextResponse.json({
        success: false,
        code: "blocked_unmapped",
        reconciliation: result.reconciliation,
        data: result.preview,
        error: `${result.reconciliation.rowsBlocked} row(s) could not be imported — map them in Mapping Database, then re-upload.`,
      });
    }
    if (result.status === "blocked_validation") {
      const blocker = result.validation.errorCount > 0
        ? `${result.validation.errorCount} validation error(s) must be fixed before importing.`
        : `${result.validation.warningCount} validation warning(s) need to be reviewed and acknowledged before importing.`;
      return NextResponse.json({
        success: false,
        code: "blocked_validation",
        reconciliation: result.reconciliation,
        data: result.preview,
        validation: result.validation,
        error: blocker,
      });
    }
    return NextResponse.json({ success: true, batchId: result.batchId, period: result.period, importedRows: result.importedRows, reconciliation: result.reconciliation, validation: result.validation, message: `Imported ${result.importedRows} rows for ${result.period}.` });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    if (error instanceof SalesWorkflowError) return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Failed to import the sheet." }, { status: 500 });
  }
}
