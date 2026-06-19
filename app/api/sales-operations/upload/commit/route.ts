import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { commitSalesOpsUpload } from "@/lib/sales-operations/upload";
import { validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Persist a raw upload. Blocks (persists nothing) if any row is unmapped, if strict validation finds
// an error, or if there are unacknowledged warnings — never a partial import. Replace-not-merge.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    const form = await request.formData();
    const file = form.get("file");
    const distributorCode = String(form.get("distributorCode") ?? "").trim();
    const periodOverride = String(form.get("period") ?? "").trim();
    const acknowledgeWarnings = String(form.get("acknowledgeWarnings") ?? "") === "true";
    if (!(file instanceof File)) return NextResponse.json({ success: false, error: "A raw sheet is required." }, { status: 400 });
    if (!distributorCode) return NextResponse.json({ success: false, error: "Distributor is required." }, { status: 400 });

    const validation = validateSpreadsheetFile(file, {
      ...xlsxSpreadsheetValidation,
      emptyError: "invalid_sales_file",
      emptyMessage: "The sheet is empty.",
      tooLargeError: "sales_file_too_large",
      tooLargeMessage: "The sheet exceeds the 10MB upload limit.",
      unsupportedError: "unsupported_sales_file_type",
      unsupportedMessage: "Upload the raw sheet in .xlsx format.",
    });
    if (!validation.ok) return NextResponse.json({ success: false, error: validation.message, code: validation.error }, { status: validation.status });

    const result = await commitSalesOpsUpload({ distributorCode, file, periodOverride, uploadedBy: access.hrId ?? access.loginId ?? "system", acknowledgeWarnings });
    if (result.status === "blocked") {
      return NextResponse.json({ success: false, code: "blocked_unmapped", error: "Some rows are unmapped — map them before importing.", reconciliation: result.reconciliation, data: result.preview }, { status: 409 });
    }
    if (result.status === "blocked_validation") {
      return NextResponse.json({ success: false, code: "blocked_validation", error: "Resolve the validation findings (or acknowledge the warnings) before importing.", reconciliation: result.reconciliation, data: result.preview, validation: result.validation }, { status: 409 });
    }
    return NextResponse.json({ success: true, batchId: result.batchId, period: result.period, importedRows: result.importedRows, reconciliation: result.reconciliation, engineVersion: result.engineVersion, validation: result.validation });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    if (error instanceof SalesWorkflowError) return NextResponse.json({ success: false, code: error.code, error: error.message }, { status: error.status });
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Failed to import the sheet." }, { status: 500 });
  }
}
