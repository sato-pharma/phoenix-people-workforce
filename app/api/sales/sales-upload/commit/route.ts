import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { removeSalesUploadObject, resolveUploadedSpreadsheet } from "@/lib/sales/monthly-import-request";
import { commitMonthlyUpload } from "@/lib/sales/sales-upload";
import { validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Persist a raw monthly sheet. Only TWO things block (persist nothing): unmapped rows, and a
// duplicate sheet (this distributor's month is already imported). Every other finding is an advisory
// warning that never blocks. Large workbooks (> ~4MB) arrive by Storage reference (storagePath)
// instead of in the body, bypassing Vercel's ~4.5MB function body cap.
export async function POST(request: Request) {
  let cleanupStoragePath: string | null = null;
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    const resolved = await resolveUploadedSpreadsheet(request);
    if (!resolved.ok) return NextResponse.json({ success: false, error: resolved.error }, { status: resolved.status });
    cleanupStoragePath = resolved.storagePath;
    const file = resolved.file;
    const distributorCode = resolved.field("distributorCode");
    const periodOverride = resolved.field("period");
    if (!distributorCode) return NextResponse.json({ success: false, error: "Distributor is required." }, { status: 400 });

    const validation = validateSpreadsheetFile(file, {
      ...xlsxSpreadsheetValidation,
      emptyError: "invalid_sales_file", emptyMessage: "The sheet is empty.",
      tooLargeError: "sales_file_too_large", tooLargeMessage: "The sheet exceeds the 10MB upload limit.",
      unsupportedError: "unsupported_sales_file_type", unsupportedMessage: "Upload the raw sheet in .xlsx format.",
    });
    if (!validation.ok) return NextResponse.json({ success: false, error: validation.message, code: validation.error }, { status: validation.status });

    const uploadedBy = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    const result = await commitMonthlyUpload({ distributorCode, file, periodOverride, uploadedBy });
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
      // A hard-block error (duplicate sheet, unreadable/unrecognized file, or broken geography).
      // Surface the first error's message.
      const firstError = result.validation.findings.find((f) => f.severity === "error");
      return NextResponse.json({
        success: false,
        code: "blocked_validation",
        reconciliation: result.reconciliation,
        data: result.preview,
        validation: result.validation,
        error: firstError ? `${firstError.title} — ${firstError.detail}` : "This upload is blocked.",
      });
    }
    return NextResponse.json({ success: true, batchId: result.batchId, period: result.period, importedRows: result.importedRows, reconciliation: result.reconciliation, validation: result.validation, message: `Imported ${result.importedRows} rows for ${result.period}.` });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    if (error instanceof SalesWorkflowError) return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Failed to import the sheet." }, { status: 500 });
  } finally {
    // Delete the temp Storage object once the import is persisted (or has failed) — the bucket only
    // ever holds in-flight uploads.
    await removeSalesUploadObject(cleanupStoragePath);
  }
}
