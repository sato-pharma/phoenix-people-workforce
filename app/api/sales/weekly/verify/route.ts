import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { hasWeeklyVerifyAi, verifyWeeklyUpload } from "@/lib/sales/weekly/ai-verify";
import { assertApiRateLimit, isApiRateLimitError, rateLimitIdentity } from "@/lib/security/api-rate-limit";
import { validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Pre-upload column verification. Reads ONLY the uploaded file's header row, compares it to the
// per-distributor column contract, and (when an AI key is set) asks the model to flag drift. This
// NEVER persists — it is the advisory step before the real /validate upload. Same permission and
// file-validation as /validate; an actor-scoped rate limit guards the upstream AI spend.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "import");
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.hrId || access.loginId, request }),
      limit: 15,
      scope: "weekly_sales_ai_verify",
      windowMs: 60_000,
    });

    const formData = await request.formData();
    const distributorCode = String(formData.get("distributorCode") ?? "").trim();
    if (!distributorCode) {
      return NextResponse.json({ success: false, error: "Pick a distributor first." }, { status: 400 });
    }

    const checkFile = (value: FormDataEntryValue | null, label: string) => {
      if (!(value instanceof File)) {
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

    // PS / Overseas ships two matrix files; everyone else ships one combined workbook.
    let result;
    if (distributorCode.toUpperCase() === "PS") {
      const sales = checkFile(formData.get("salesFile"), "The Overseas POS sales matrix file");
      if (!sales.ok) return sales.response;
      const stock = checkFile(formData.get("stockFile"), "The Overseas POS stock matrix file");
      if (!stock.ok) return stock.response;
      result = await verifyWeeklyUpload({
        distributorCode,
        salesBuffer: await sales.file.arrayBuffer(),
        salesFileName: sales.file.name,
        stockBuffer: await stock.file.arrayBuffer(),
        stockFileName: stock.file.name,
      });
    } else {
      const single = checkFile(formData.get("file"), "A weekly file");
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
      return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    }
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { success: false, error: error.message },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Verification failed." },
      { status: 500 },
    );
  }
}
