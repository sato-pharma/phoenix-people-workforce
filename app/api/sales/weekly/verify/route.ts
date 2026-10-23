import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { removeSalesUploadObjects, resolveWeeklyUploadRequest } from "@/lib/sales/monthly-import-request";
import { hasWeeklyVerifyAi, verifyWeeklyUpload } from "@/lib/sales/weekly/ai-verify";
import { assertApiRateLimit, isApiRateLimitError, rateLimitIdentity } from "@/lib/security/api-rate-limit";
import { spreadsheetTooLargeMessage, spreadsheetUploadLimitBytes, validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Pre-upload column verification. Reads ONLY the uploaded file's header row, compares it to the
// per-distributor column contract, and (when an AI key is set) asks the model to flag drift. This
// NEVER persists — it is the advisory step before the real /validate upload. Same permission and
// file-validation as /validate; an actor-scoped rate limit guards the upstream AI spend.
//
// Verify reads the whole workbook to extract its headers, so it hits Vercel's ~4.5MB body cap on large
// files just like /validate. Large workbooks therefore arrive as a Storage reference (JSON storagePath /
// salesStoragePath+stockStoragePath) and the temp object is deleted once headers are read.
export async function POST(request: Request) {
  let cleanupPaths: string[] = [];
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "import");
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.hrId || access.loginId, request }),
      limit: 15,
      scope: "weekly_sales_ai_verify",
      windowMs: 60_000,
    });

    const resolved = await resolveWeeklyUploadRequest(request, access);
    cleanupPaths = resolved.storagePaths;
    if (!resolved.ok) {
      return NextResponse.json({ success: false, error: resolved.error, code: resolved.code }, { status: resolved.status });
    }
    const { distributorCode } = resolved;
    if (!distributorCode) {
      return NextResponse.json({ success: false, error: "Pick a distributor first." }, { status: 400 });
    }

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

    // PS / Overseas ships two matrix files; everyone else ships one combined workbook.
    let result;
    if (distributorCode.toUpperCase() === "PS") {
      const sales = checkFile(resolved.salesFile, "The Overseas POS sales matrix file");
      if (!sales.ok) return sales.response;
      const stock = checkFile(resolved.stockFile, "The Overseas POS stock matrix file");
      if (!stock.ok) return stock.response;
      result = await verifyWeeklyUpload({
        distributorCode,
        salesBuffer: await sales.file.arrayBuffer(),
        salesFileName: sales.file.name,
        stockBuffer: await stock.file.arrayBuffer(),
        stockFileName: stock.file.name,
      });
    } else {
      const single = checkFile(resolved.file, "A weekly file");
      if (!single.ok) return single.response;
      result = await verifyWeeklyUpload({
        distributorCode,
        fileBuffer: await single.file.arrayBuffer(),
        fileName: single.file.name,
      });
    }

    return NextResponse.json({ success: true, data: result, aiConfigured: hasWeeklyVerifyAi() });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { success: false, error: error.message },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Verification failed.") },
      { status: 500 },
    );
  } finally {
    // Verify never persists, so always delete the temp Storage object(s) (large-file path only).
    await removeSalesUploadObjects(cleanupPaths);
  }
}
