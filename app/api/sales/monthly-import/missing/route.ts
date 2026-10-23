import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { RESTRICTED_PRODUCT_CODES, canViewRestrictedProducts } from "@/lib/sales/access-scope";
import { normalizeUploadedFile, summarizePreview } from "@/lib/sales/normalizer/service";
import { spreadsheetTooLargeMessage, validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Analyze a distributor's RAW export against the saved mappings WITHOUT persisting anything, and
// return coverage % plus the DISTINCT unknown products / territories / customers (each with a
// fuzzy suggestion). The user maps the few unknowns once; nothing is written until they save.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const form = await request.formData();
    const file = form.get("file");
    const distributorCode = String(form.get("distributorCode") ?? "").trim();
    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: "A raw sheet is required." }, { status: 400 });
    }
    if (!distributorCode) {
      return NextResponse.json({ success: false, error: "Distributor is required." }, { status: 400 });
    }

    const validation = validateSpreadsheetFile(file, {
      ...xlsxSpreadsheetValidation,
      emptyError: "invalid_sales_file",
      emptyMessage: "The sheet is empty.",
      tooLargeError: "sales_file_too_large",
      tooLargeMessage: spreadsheetTooLargeMessage("The sheet"),
      unsupportedError: "unsupported_sales_file_type",
      unsupportedMessage: "Upload the raw sheet in .xlsx format.",
    });
    if (!validation.ok) {
      return NextResponse.json({ success: false, error: validation.message, code: validation.error }, { status: validation.status });
    }

    const normalized = await normalizeUploadedFile(distributorCode, file);

    if (normalized.status === "coded_sheet") {
      // The sheet already has Phoenix-coded columns — it belongs in the Import section, not Analyze.
      return NextResponse.json({
        success: false,
        code: "coded_sheet_detected",
        distributorName: normalized.distributorName,
        error: "This sheet has already been processed. Use the Import section directly — the Analyzer is for raw distributor files only.",
      });
    }

    if (normalized.status === "header_error") {
      return NextResponse.json({
        success: false,
        code: "header_validation_error",
        distributorName: normalized.distributorName,
        missingGroups: normalized.missingGroups,
        fingerprintWarning: normalized.fingerprintWarning ?? null,
        error: `Sheet is missing required columns: ${normalized.missingGroups.map((g) => g.label).join(", ")}.`,
      }, { status: 422 });
    }

    if (normalized.status === "template_error") {
      // Unreachable from this page (it always posts a real distributor), but the recognizer's result
      // is a closed union and this keeps the message the recognizer wrote rather than a cast.
      return NextResponse.json({ success: false, code: "template_error", error: normalized.message }, { status: 422 });
    }

    const { result, distributorName, products } = normalized;
    // Confidential products (LA003/LA004/SS001) must never appear in this raw row sample for a
    // viewer who isn't cleared to see them.
    const excludeProductCodes = canViewRestrictedProducts(access.role) ? [] : [...RESTRICTED_PRODUCT_CODES];
    return NextResponse.json({ success: true, data: summarizePreview(distributorCode, distributorName, result, products, excludeProductCodes) });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Failed to analyze the sheet.") },
      { status: 500 },
    );
  }
}
