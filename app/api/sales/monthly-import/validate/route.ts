import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { importSourceOfSalesFile } from "@/lib/sales/source-of-sales-upload";
import { salesSpreadsheetValidation, validateSpreadsheetFile } from "@/lib/uploads/spreadsheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const formData = await request.formData();
    const file = formData.get("file");
    const distributorCode = String(formData.get("distributorCode") ?? "").trim();

    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: "Sales workbook file is required." }, { status: 400 });
    }
    if (!distributorCode) {
      return NextResponse.json({ success: false, error: "Distributor is required." }, { status: 400 });
    }

    const fileValidation = validateSpreadsheetFile(file, {
      ...salesSpreadsheetValidation,
      emptyError: "invalid_sales_file",
      emptyMessage: "Sales workbook is empty.",
      tooLargeError: "sales_file_too_large",
      tooLargeMessage: "Sales workbook exceeds the 10MB upload limit.",
      unsupportedError: "unsupported_sales_file_type",
      unsupportedMessage: "Upload a distributor monthly sales sheet in .xls or .xlsx format.",
    });
    if (!fileValidation.ok) {
      return NextResponse.json(
        { success: false, error: fileValidation.message, code: fileValidation.error },
        { status: fileValidation.status },
      );
    }

    const uploadedBy = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    const result = await importSourceOfSalesFile({ distributorCode, file, uploadedBy });
    const blocked = result.status === "blocked";

    return NextResponse.json(
      {
        success: !blocked,
        data: result,
        error: blocked ? "Validation blocked. Fix the failed rows before importing." : undefined,
        message: blocked
          ? "Validation blocked."
          : "Validation passed.",
      },
      { status: blocked ? 400 : 200 },
    );
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: error instanceof Error ? error.message : "Forbidden." },
        { status: 403 },
      );
    }
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json(
        { success: false, error: error.message, code: error.code, details: error.details },
        { status: error.status },
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Sales validation failed.",
      },
      { status: 500 },
    );
  }
}
