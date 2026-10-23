import { hrIdForStorage } from "@/lib/hr-id";
import { NextResponse } from "next/server";

import { SalesWorkflowError } from "@/lib/sales/contracts";
import { runSalesImportWorkflow } from "@/lib/sales/import-workflow";
import { replaceSalesBatch } from "@/lib/sales/service";
import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { salesSpreadsheetValidation, spreadsheetTooLargeMessage, validateSpreadsheetFile } from "@/lib/uploads/spreadsheets";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    const formData = await request.formData();
    const file = formData.get("file");
    const line = String(formData.get("line") ?? "");
    const replacementForBatchId = String(formData.get("replacementForBatchId") ?? "").trim();

    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: "Sales workbook file is required." }, { status: 400 });
    }
    const fileValidation = validateSpreadsheetFile(file, {
      ...salesSpreadsheetValidation,
      emptyError: "invalid_sales_file",
      emptyMessage: "Sales workbook is empty.",
      tooLargeError: "sales_file_too_large",
      tooLargeMessage: spreadsheetTooLargeMessage("Sales workbook"),
      unsupportedError: "unsupported_sales_file_type",
      unsupportedMessage: "Upload a monthly closing sheet in .xls or .xlsx format.",
    });
    if (!fileValidation.ok) {
      return NextResponse.json(
        { success: false, error: fileValidation.message, code: fileValidation.error },
        { status: fileValidation.status },
      );
    }

    const actorUsername = hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    const actorDisplayName = access.loginId ?? access.hrId ?? access.role;

    const result = await runSalesImportWorkflow({ file, line, uploadedBy: actorUsername });
    if (
      result.success &&
      replacementForBatchId &&
      result.batchSummary &&
      typeof result.batchSummary === "object" &&
      "id" in result.batchSummary
    ) {
      const replacementId = String(result.batchSummary.id ?? "");
      if (replacementId) {
        await replaceSalesBatch(replacementForBatchId, replacementId, actorUsername, actorDisplayName);
        result.message = "Replacement sales sheet uploaded and applied.";
        result.redirectTo = "/sales/import?tab=approvals";
        result.previewUrl = "/sales/import?tab=approvals";
      }
    }

    return NextResponse.json(result, { status: result.success ? 200 : 400 });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json(
        { success: false, error: error.message, code: error.code, details: error.details },
        { status: error.status },
      );
    }
    const message = clientSafeErrorMessage(error, "Upload failed.");
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
