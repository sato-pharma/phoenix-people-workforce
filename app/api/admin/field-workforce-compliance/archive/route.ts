import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  archiveFieldWorkforceCompliancePreview,
  FieldWorkforceArchiveDuplicateError,
  listFieldWorkforceComplianceArchives,
} from "@/lib/field-workforce-compliance/archive";
import {
  buildFieldWorkforceCompliancePreviewFromWorkbook,
  FieldWorkforcePreviewError,
} from "@/lib/field-workforce-compliance/preview";
import { validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function actorFromAccess(access: Awaited<ReturnType<typeof resolveAccessContext>>) {
  return resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "hr_calendar", "read");

    const archives = await listFieldWorkforceComplianceArchives();
    return NextResponse.json({
      data: archives,
      success: true,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({
        error: "forbidden",
        message: "You do not have access to Field Workforce Compliance archives.",
        success: false,
      }, { status: 403 });
    }

    return NextResponse.json({
      error: "field_workforce_archive_list_failed",
      message: error instanceof Error ? error.message : "Field Workforce Compliance archive list failed.",
      success: false,
    }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "hr_calendar", "import");

    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({
        error: "missing_file",
        message: "Upload one monthly Field Workforce Compliance Excel file to archive.",
        success: false,
      }, { status: 400 });
    }

    const fileValidation = validateSpreadsheetFile(file, {
      ...xlsxSpreadsheetValidation,
      emptyError: "invalid_excel_file",
      emptyMessage: "Field Workforce Compliance archive upload is empty.",
      tooLargeError: "field_workforce_file_too_large",
      tooLargeMessage: "Field Workforce Compliance archive upload exceeds the 10MB upload limit.",
      unsupportedError: "unsupported_format",
      unsupportedMessage: "Upload a monthly Excel file in .xlsx format.",
    });

    if (!fileValidation.ok) {
      return NextResponse.json({
        error: fileValidation.error,
        message: fileValidation.message,
        success: false,
      }, { status: fileValidation.status });
    }

    const preview = await buildFieldWorkforceCompliancePreviewFromWorkbook({
      arrayBuffer: await file.arrayBuffer(),
      fileName: file.name,
    });
    const actorLoginId = actorFromAccess(access);
    const archive = await archiveFieldWorkforceCompliancePreview({
      actorLoginId,
      preview,
      uploadedBy: actorLoginId,
    });

    return NextResponse.json({
      data: archive,
      success: true,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({
        error: "forbidden",
        message: "You do not have access to archive Field Workforce Compliance uploads.",
        success: false,
      }, { status: 403 });
    }

    if (error instanceof FieldWorkforcePreviewError) {
      return NextResponse.json({
        error: error.code,
        errors: error.errors,
        message: error.message,
        success: false,
        warnings: error.warnings,
      }, { status: error.status });
    }

    if (error instanceof FieldWorkforceArchiveDuplicateError) {
      return NextResponse.json({
        duplicate: error.duplicate,
        error: "duplicate_month_archive",
        message: `${error.duplicate.monthKey} is already archived. Phase 2 blocks duplicate month archives; no payroll or leave action was taken.`,
        success: false,
      }, { status: 409 });
    }

    return NextResponse.json({
      error: "field_workforce_archive_save_failed",
      message: error instanceof Error ? error.message : "Field Workforce Compliance archive save failed.",
      success: false,
    }, { status: 500 });
  }
}
