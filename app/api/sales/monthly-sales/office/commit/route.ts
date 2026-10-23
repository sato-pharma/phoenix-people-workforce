import { hrIdForStorage } from "@/lib/hr-id";
import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { OFFICE_DISTRIBUTOR_CODE } from "@/lib/sales/office-allocation";
import { commitOfficeAllocation } from "@/lib/sales/office-upload";
import { confirmStep } from "@/lib/sales/monthly-sales-run";
import { officeCommitMessage, settleStepConfirmation, type StepConfirmation } from "@/lib/sales/step-confirmation";
import { salesSpreadsheetValidation, spreadsheetTooLargeMessage, validateSpreadsheetFile } from "@/lib/uploads/spreadsheets";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    const uploadedBy = hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";

    const formData = await request.formData();
    const formFile = formData.get("file");
    const file = formFile instanceof File ? formFile : null;
    const period = String(formData.get("period") ?? "").trim();

    if (!file) return NextResponse.json({ success: false, error: "Office workbook file is required." }, { status: 400 });
    if (!period) return NextResponse.json({ success: false, error: "Period is required." }, { status: 400 });

    const fileValidation = validateSpreadsheetFile(file, {
      ...salesSpreadsheetValidation,
      emptyError: "invalid_office_file",
      emptyMessage: "Office workbook is empty.",
      tooLargeError: "office_file_too_large",
      tooLargeMessage: spreadsheetTooLargeMessage("Office workbook"),
      unsupportedError: "unsupported_office_file_type",
      unsupportedMessage: "Upload the office sales sheet in .xls or .xlsx format.",
    });
    if (!fileValidation.ok) {
      return NextResponse.json({ success: false, error: fileValidation.message, code: fileValidation.error }, { status: fileValidation.status });
    }

    const buffer = await file.arrayBuffer();
    const result = await commitOfficeAllocation({ buffer, fileName: file.name, period, uploadedBy });
    const blocked = result.status === "blocked";

    // On a clean commit, mark the Office step confirmed in the run. The allocation is already saved,
    // so a failed confirm does not fail the request — but it is reported, never swallowed.
    let stepConfirmation: StepConfirmation | null = null;
    const batchId = result.batchId;
    if (!blocked && batchId) {
      stepConfirmation = await settleStepConfirmation(
        () => confirmStep(period, OFFICE_DISTRIBUTOR_CODE, batchId),
        (error) => console.error("[office-commit] saved, but the Office step was not confirmed", { period, error }),
      );
    }

    return NextResponse.json(
      {
        success: !blocked,
        data: { ...result, stepConfirmation },
        message: blocked ? "Some office product names are not mapped." : officeCommitMessage(stepConfirmation),
      },
      { status: blocked ? 400 : 200 },
    );
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Office commit failed.") }, { status: 500 });
  }
}
