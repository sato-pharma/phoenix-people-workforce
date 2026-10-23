import { hrIdForStorage } from "@/lib/hr-id";
import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { removeSalesUploadObjects, resolveWeeklyUploadRequest } from "@/lib/sales/monthly-import-request";
import { importWeeklySalesFile } from "@/lib/sales/weekly/service";
import { spreadsheetTooLargeMessage, spreadsheetUploadLimitBytes, validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Dry-run validation only — never persists. Returns the full validation result (tables, totals,
// issues) so the UI can show them before the user decides to confirm upload.
// The actual persist step is /api/sales/weekly/upload.
//
// Large weekly workbooks (> ~4MB) can't be POSTed through the function (Vercel caps the body at
// ~4.5MB). For those the browser streams the file(s) straight to the sales-imports Storage bucket and
// sends only the reference (JSON storagePath / salesStoragePath+stockStoragePath); small files keep the
// original multipart POST. resolveWeeklyUploadRequest handles both transports identically.
export async function POST(request: Request) {
  let cleanupPaths: string[] = [];
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "import");
    const uploadedBy = hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";

    const resolved = await resolveWeeklyUploadRequest(request, access);
    cleanupPaths = resolved.storagePaths;
    if (!resolved.ok) {
      return NextResponse.json({ success: false, error: resolved.error, code: resolved.code }, { status: resolved.status });
    }
    const { distributorCode, periodDate, weekNumber, cycleMonth } = resolved;

    const checkFile = (value: File | null, label: string) => {
      if (!value) {
        return { ok: false as const, response: NextResponse.json({ success: false, error: `${label} is required.`, code: "invalid_weekly_file" }, { status: 400 }) };
      }
      const validation = validateSpreadsheetFile(value, {
        ...xlsxSpreadsheetValidation,
        emptyError: "invalid_weekly_file",
        // The bucket path exists for files over 4 MB, so it is held to the bucket's limit (audit F-06).
        maxBytes: spreadsheetUploadLimitBytes(resolved.storagePaths.length > 0),
        tooLargeMessage: spreadsheetTooLargeMessage("Weekly workbook", spreadsheetUploadLimitBytes(resolved.storagePaths.length > 0)),
      });
      if (!validation.ok) {
        return { ok: false as const, response: NextResponse.json({ success: false, error: validation.message, code: validation.error }, { status: validation.status }) };
      }
      return { ok: true as const, file: value };
    };

    let result: Awaited<ReturnType<typeof importWeeklySalesFile>>;
    if (distributorCode.toUpperCase() === "PS") {
      const sales = checkFile(resolved.salesFile, "The Overseas POS sales matrix file");
      if (!sales.ok) return sales.response;
      const stock = checkFile(resolved.stockFile, "The Overseas POS stock matrix file");
      if (!stock.ok) return stock.response;
      result = await importWeeklySalesFile({ distributorCode, salesFile: sales.file, stockFile: stock.file, uploadedBy, periodDate, weekNumber, cycleMonth, dryRun: true });
    } else {
      const single = checkFile(resolved.file, "A weekly file");
      if (!single.ok) return single.response;
      result = await importWeeklySalesFile({ distributorCode, file: single.file, uploadedBy, periodDate, weekNumber, cycleMonth, dryRun: true });
    }

    // Always 200 — the result carries its own status ("validated" | "blocked").
    // The UI reads result.status to decide whether to show the Confirm Upload button.
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json(
        { success: false, error: error.message, code: error.code, details: error.details },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Validation failed.") },
      { status: 500 },
    );
  } finally {
    // Validation never persists, so always delete the temp Storage object(s) (large-file path only).
    await removeSalesUploadObjects(cleanupPaths);
  }
}
