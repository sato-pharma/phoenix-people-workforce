import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { analyzeWeeklyForNormalization } from "@/lib/sales/weekly/normalizer";
import { spreadsheetTooLargeMessage, validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Weekly Normalizer — analyze a RAW weekly file and report coverage + every unresolved value.
// Read-only by construction: it parses in memory and never touches weekly_sales_batches/_rows.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "update");

    const form = await request.formData();
    const distributorCode = String(form.get("distributorCode") ?? "").trim();
    if (!distributorCode) {
      return NextResponse.json({ success: false, error: "Pick a distributor." }, { status: 400 });
    }

    const pick = (name: string) => {
      const value = form.get(name);
      return value instanceof File && value.size > 0 ? value : null;
    };
    const file = pick("file");
    const salesFile = pick("salesFile");
    const stockFile = pick("stockFile");
    if (!file && !salesFile && !stockFile) {
      return NextResponse.json({ success: false, error: "Choose a raw weekly file first." }, { status: 400 });
    }
    for (const candidate of [file, salesFile, stockFile]) {
      if (!candidate) continue;
      const validation = validateSpreadsheetFile(candidate, {
        ...xlsxSpreadsheetValidation,
        emptyError: "invalid_weekly_file",
        tooLargeMessage: spreadsheetTooLargeMessage("Weekly workbook"),
      });
      if (!validation.ok) {
        return NextResponse.json({ success: false, error: validation.message, code: validation.error }, { status: validation.status });
      }
    }

    const periodDate = String(form.get("periodDate") ?? "").trim() || null;
    const data = await analyzeWeeklyForNormalization({ distributorCode, file, salesFile, stockFile, periodDate });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Failed to analyze the weekly file.") }, { status: 500 });
  }
}
