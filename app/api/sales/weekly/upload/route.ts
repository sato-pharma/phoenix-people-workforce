import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { removeSalesUploadObjects, resolveWeeklyUploadRequest } from "@/lib/sales/monthly-import-request";
import { importWeeklySalesFile } from "@/lib/sales/weekly/service";
import { validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Confirms and persists a validated weekly upload.
// Called after the user reviews the /validate dry-run result and presses "Confirm Upload".
// Re-parses the file and persists only if the result is still "validated".
//
// Large weekly workbooks (> ~4MB) arrive as a Storage reference (JSON storagePath /
// salesStoragePath+stockStoragePath) to bypass Vercel's ~4.5MB body cap; small files keep the multipart
// POST. resolveWeeklyUploadRequest handles both. The temp Storage object is deleted once persisted.
export async function POST(request: Request) {
  let cleanupPaths: string[] = [];
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "import");
    const uploadedBy = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";

    const resolved = await resolveWeeklyUploadRequest(request);
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
        tooLargeMessage: "Weekly workbook exceeds the 10MB upload limit.",
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
      result = await importWeeklySalesFile({ distributorCode, salesFile: sales.file, stockFile: stock.file, uploadedBy, periodDate, weekNumber, cycleMonth });
    } else {
      const single = checkFile(resolved.file, "A weekly file");
      if (!single.ok) return single.response;
      result = await importWeeklySalesFile({ distributorCode, file: single.file, uploadedBy, periodDate, weekNumber, cycleMonth });
    }

    const blocked = result.status !== "validated";
    return NextResponse.json(
      {
        success: !blocked,
        data: result,
        error: blocked ? "Validation blocked — nothing was stored. Fix the flagged rows and try again." : undefined,
        message: blocked ? "Validation blocked." : "Stored successfully.",
      },
      { status: blocked ? 400 : 200 },
    );
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
      { success: false, error: clientSafeErrorMessage(error, "Upload failed.") },
      { status: 500 },
    );
  } finally {
    // The temp Storage object is disposable once rows are persisted (large-file path only).
    await removeSalesUploadObjects(cleanupPaths);
  }
}
