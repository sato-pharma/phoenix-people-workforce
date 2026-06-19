import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { importWeeklySalesFile } from "@/lib/sales/weekly/service";
import { validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Confirms and persists a validated weekly upload.
// Called after the user reviews the /validate dry-run result and presses "Confirm Upload".
// Re-parses the file and persists only if the result is still "validated".
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "import");

    const formData = await request.formData();
    const distributorCode = String(formData.get("distributorCode") ?? "").trim();
    const periodDate = String(formData.get("periodDate") ?? "").trim() || null;
    const uploadedBy = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";

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

    let result: Awaited<ReturnType<typeof importWeeklySalesFile>>;
    if (distributorCode.toUpperCase() === "PS") {
      const sales = checkFile(formData.get("salesFile"), "The Overseas POS sales matrix file");
      if (!sales.ok) return sales.response;
      const stock = checkFile(formData.get("stockFile"), "The Overseas POS stock matrix file");
      if (!stock.ok) return stock.response;
      result = await importWeeklySalesFile({ distributorCode, salesFile: sales.file, stockFile: stock.file, uploadedBy, periodDate });
    } else {
      const single = checkFile(formData.get("file"), "A weekly file");
      if (!single.ok) return single.response;
      result = await importWeeklySalesFile({ distributorCode, file: single.file, uploadedBy, periodDate });
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
      return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    }
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json(
        { success: false, error: error.message, code: error.code, details: error.details },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Upload failed." },
      { status: 500 },
    );
  }
}
