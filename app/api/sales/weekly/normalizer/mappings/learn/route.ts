import { hrIdForStorage } from "@/lib/hr-id";
import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { importWeeklyFilledWorkbook } from "@/lib/sales/weekly/normalizer";
import { spreadsheetTooLargeMessage, validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read a filled "unmapped list" workbook back and apply every answered row to the weekly
// dictionaries. Same destination as the on-screen Save — this is just the Excel route to it.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "update");
    const actorId = hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";

    const form = await request.formData();
    const distributorCode = String(form.get("distributorCode") ?? "").trim();
    const file = form.get("file");
    if (!distributorCode) return NextResponse.json({ success: false, error: "Pick a distributor." }, { status: 400 });
    if (!(file instanceof File)) return NextResponse.json({ success: false, error: "An XLSX file is required." }, { status: 400 });
    const validation = validateSpreadsheetFile(file, {
      ...xlsxSpreadsheetValidation,
      emptyError: "invalid_mapping_file",
      tooLargeMessage: spreadsheetTooLargeMessage("Mapping workbook"),
    });
    if (!validation.ok) {
      return NextResponse.json({ success: false, error: validation.message, code: validation.error }, { status: validation.status });
    }

    const data = await importWeeklyFilledWorkbook({ distributorCode, file, actorId });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Learn failed.") }, { status: 500 });
  }
}
