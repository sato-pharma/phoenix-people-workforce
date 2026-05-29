import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  buildFieldWorkforceCompliancePreviewFromWorkbook,
  FieldWorkforcePreviewError,
} from "@/lib/field-workforce-compliance/preview";
import {
  fieldWorkforceMonthKey,
} from "@/lib/field-workforce-compliance/archive";
import { validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "hr_calendar", "import");

    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({
        error: "missing_file",
        message: "Upload one monthly Field Workforce Compliance Excel file.",
        success: false,
      }, { status: 400 });
    }

    const fileValidation = validateSpreadsheetFile(file, {
      ...xlsxSpreadsheetValidation,
      emptyError: "invalid_excel_file",
      emptyMessage: "Field Workforce Compliance upload is empty.",
      tooLargeError: "field_workforce_file_too_large",
      tooLargeMessage: "Field Workforce Compliance upload exceeds the 10MB upload limit.",
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
    const monthKey = fieldWorkforceMonthKey(preview.metadata.year, preview.metadata.month);
    await writeAuditLog({
      actorLoginId: resolveEmployeeIdentityId(access) ?? access.loginId ?? "system",
      entityId: monthKey,
      entityType: "field_workforce_compliance_import",
      newValues: {
        employeeCount: preview.metadata.employeeCount,
        highSeverityCount: preview.severityCounts.High,
        monthKey,
        reviewCandidateCount: preview.reviewCandidates.length,
        sourceFilename: preview.metadata.fileName,
      },
      summary: "Field Workforce Compliance preview generated.",
    });

    return NextResponse.json({
      data: preview,
      success: true,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({
        error: "forbidden",
        message: "You do not have access to preview Field Workforce Compliance uploads.",
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

    return NextResponse.json({
      error: "field_workforce_preview_failed",
      message: error instanceof Error ? error.message : "Field Workforce Compliance preview failed.",
      success: false,
    }, { status: 500 });
  }
}
