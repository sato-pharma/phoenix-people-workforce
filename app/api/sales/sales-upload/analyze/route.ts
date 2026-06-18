import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { analyzeMonthlyUpload } from "@/lib/sales/sales-upload";
import { validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Dry-run: recognize + summarize a raw monthly sheet WITHOUT persisting. Same recognizer the commit
// step uses, so analyze and upload can never disagree.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    const form = await request.formData();
    const file = form.get("file");
    const distributorCode = String(form.get("distributorCode") ?? "").trim();
    if (!(file instanceof File)) return NextResponse.json({ success: false, error: "A raw sheet is required." }, { status: 400 });
    if (!distributorCode) return NextResponse.json({ success: false, error: "Distributor is required." }, { status: 400 });

    const validation = validateSpreadsheetFile(file, {
      ...xlsxSpreadsheetValidation,
      emptyError: "invalid_sales_file", emptyMessage: "The sheet is empty.",
      tooLargeError: "sales_file_too_large", tooLargeMessage: "The sheet exceeds the 10MB upload limit.",
      unsupportedError: "unsupported_sales_file_type", unsupportedMessage: "Upload the raw sheet in .xlsx format.",
    });
    if (!validation.ok) return NextResponse.json({ success: false, error: validation.message, code: validation.error }, { status: validation.status });

    const result = await analyzeMonthlyUpload(distributorCode, file);
    if (result.status === "coded_sheet") {
      return NextResponse.json({ success: false, code: "coded_sheet_detected", distributorName: result.distributorName, error: "This sheet is already coded — upload the raw distributor export." });
    }
    if (result.status === "header_error") {
      return NextResponse.json({ success: false, code: "header_validation_error", distributorName: result.distributorName, missingGroups: result.missingGroups, fingerprintWarning: result.fingerprintWarning ?? null, error: `Sheet is missing required columns: ${result.missingGroups.map((g) => g.label).join(", ")}.` }, { status: 422 });
    }
    return NextResponse.json({ success: true, data: result.preview, reconciliation: result.reconciliation, needsPeriod: result.needsPeriod });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Failed to analyze the sheet." }, { status: 500 });
  }
}
