import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { importWeeklySalesFile } from "@/lib/sales/weekly/service";
import { validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Dry-run validation only — never persists. Returns the full validation result (tables, totals,
// issues) so the UI can show them before the user decides to confirm upload.
// The actual persist step is /api/sales/weekly/upload.
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
      result = await importWeeklySalesFile({ distributorCode, salesFile: sales.file, stockFile: stock.file, uploadedBy, periodDate, dryRun: true });
    } else {
      const single = checkFile(formData.get("file"), "A weekly file");
      if (!single.ok) return single.response;
      result = await importWeeklySalesFile({ distributorCode, file: single.file, uploadedBy, periodDate, dryRun: true });
    }

    // Always 200 — the result carries its own status ("validated" | "blocked").
    // The UI reads result.status to decide whether to show the Confirm Upload button.
    return NextResponse.json({ success: true, data: result });
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
      { success: false, error: error instanceof Error ? error.message : "Validation failed." },
      { status: 500 },
    );
  }
}
