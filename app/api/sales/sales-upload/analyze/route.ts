import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { RESTRICTED_PRODUCT_CODES, canViewRestrictedProducts } from "@/lib/sales/access-scope";
import { removeSalesUploadObject, resolveUploadedSpreadsheet } from "@/lib/sales/monthly-import-request";
import { analyzeMonthlyUpload } from "@/lib/sales/sales-upload";
import { spreadsheetTooLargeMessage, spreadsheetUploadLimitBytes, validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Dry-run: recognize + summarize a raw monthly sheet WITHOUT persisting. Same recognizer the commit
// step uses, so analyze and upload can never disagree. Large workbooks (> ~4MB) arrive by Storage
// reference (storagePath) instead of in the body, so they bypass Vercel's ~4.5MB function body cap.
export async function POST(request: Request) {
  let cleanupStoragePath: string | null = null;
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    const resolved = await resolveUploadedSpreadsheet(request, access);
    if (!resolved.ok) return NextResponse.json({ success: false, error: resolved.error }, { status: resolved.status });
    cleanupStoragePath = resolved.storagePath;
    const file = resolved.file;
    const distributorCode = resolved.field("distributorCode");
    const periodOverride = resolved.field("period");
    if (!distributorCode) return NextResponse.json({ success: false, error: "Distributor is required." }, { status: 400 });

    const validation = validateSpreadsheetFile(file, {
      ...xlsxSpreadsheetValidation,
      emptyError: "invalid_sales_file", emptyMessage: "The sheet is empty.",
      tooLargeError: "sales_file_too_large",
      // The bucket path exists for files over 4 MB, so it is held to the bucket's limit (audit F-06).
      maxBytes: spreadsheetUploadLimitBytes(resolved.storagePath !== null),
      tooLargeMessage: spreadsheetTooLargeMessage("The sheet", spreadsheetUploadLimitBytes(resolved.storagePath !== null)),
      unsupportedError: "unsupported_sales_file_type", unsupportedMessage: "Upload the raw sheet in .xlsx format.",
    });
    if (!validation.ok) return NextResponse.json({ success: false, error: validation.message, code: validation.error }, { status: validation.status });

    // Confidential products (LA003/LA004/SS001) are stripped from the breakdown tables for every
    // role except CEO / Super Admin — the upload's per-product/region/brick view must not leak them.
    const excludeProductCodes = canViewRestrictedProducts(access.role) ? [] : [...RESTRICTED_PRODUCT_CODES];
    const result = await analyzeMonthlyUpload(distributorCode, file, periodOverride, excludeProductCodes);
    if (result.status === "coded_sheet") {
      return NextResponse.json({ success: false, code: "coded_sheet_detected", distributorName: result.distributorName, error: "This sheet is already coded — upload the raw distributor export." });
    }
    if (result.status === "header_error") {
      return NextResponse.json({ success: false, code: "header_validation_error", distributorName: result.distributorName, missingGroups: result.missingGroups, fingerprintWarning: result.fingerprintWarning ?? null, aiExplanation: result.aiExplanation ?? null, error: `Sheet is missing required columns: ${result.missingGroups.map((g) => g.label).join(", ")}.` }, { status: 422 });
    }
    return NextResponse.json({ success: true, data: result.preview, reconciliation: result.reconciliation, breakdowns: result.breakdowns, needsPeriod: result.needsPeriod, validation: result.validation, isRegionOnly: result.isRegionOnly ?? false });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Failed to analyze the sheet.") }, { status: 500 });
  } finally {
    // Analyze never persists, so always delete the temp Storage object once we're done with it.
    await removeSalesUploadObject(cleanupStoragePath);
  }
}
