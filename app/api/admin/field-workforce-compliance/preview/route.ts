import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import {
  buildFieldWorkforceCompliancePreview,
} from "@/lib/field-workforce-compliance/classifier";
import {
  findUsableFieldWorkforceWorksheet,
  parseFieldWorkforceComplianceWorksheet,
} from "@/lib/field-workforce-compliance/parser";
import type {
  FieldWorkforceEmployeeReference,
  FieldWorkforceHoliday,
  FieldWorkforceValidationIssue,
} from "@/lib/field-workforce-compliance/types";
import {
  loadExcelWorkbook,
} from "@/lib/uploads/exceljs-rows";
import { validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";
import { getEgyptianNationalHolidays } from "@/lib/vacation/national-holidays";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function loadEmployeeReferences(): Promise<{
  references: FieldWorkforceEmployeeReference[];
  warning: FieldWorkforceValidationIssue | null;
}> {
  try {
    const employees = await getEmployeeDirectoryRows({ includeInactive: true });
    return {
      references: employees.map((employee) => ({
        departmentName: employee.departmentName,
        fullName: employee.fullName,
        hireDate: employee.hireDate,
        hrId: employee.hrId,
        jobTitle: employee.jobTitle,
        lineName: employee.lineName,
        managerName: employee.managerName,
      })),
      warning: null,
    };
  } catch (error) {
    return {
      references: [],
      warning: {
        code: "employee_directory_unavailable",
        message: error instanceof Error
          ? `Employee matching is unavailable: ${error.message}`
          : "Employee matching is unavailable.",
        severity: "warning",
      },
    };
  }
}

async function loadHolidays(month: number, year: number): Promise<{
  connected: boolean;
  holidays: FieldWorkforceHoliday[];
  message: string | null;
  sourceLabel: string;
}> {
  try {
    const result = await getEgyptianNationalHolidays({ month, year });
    return {
      connected: result.connected,
      holidays: result.holidays.map((holiday) => ({
        endDate: holiday.endDate,
        name: holiday.name,
        startDate: holiday.startDate,
      })),
      message: result.message,
      sourceLabel: result.sourceLabel,
    };
  } catch (error) {
    return {
      connected: false,
      holidays: [],
      message: error instanceof Error ? error.message : "National holiday lookup failed.",
      sourceLabel: "Egypt public holidays",
    };
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

    let workbook;
    try {
      workbook = await loadExcelWorkbook(await file.arrayBuffer());
    } catch {
      return NextResponse.json({
        error: "invalid_excel_file",
        message: "The workbook could not be read as a valid .xlsx file.",
        success: false,
      }, { status: 400 });
    }

    const worksheet = findUsableFieldWorkforceWorksheet(workbook);
    if (!worksheet) {
      return NextResponse.json({
        error: "empty_workbook",
        message: "No usable worksheet was found in the workbook.",
        success: false,
      }, { status: 400 });
    }

    const parsed = parseFieldWorkforceComplianceWorksheet({
      fileName: file.name,
      worksheet,
    });

    if (parsed.errors.length > 0 || !parsed.month || !parsed.year) {
      return NextResponse.json({
        errors: parsed.errors,
        message: "The workbook structure must be corrected before preview.",
        success: false,
        warnings: parsed.warnings,
      }, { status: 400 });
    }

    const [employeeReferences, holidays] = await Promise.all([
      loadEmployeeReferences(),
      loadHolidays(parsed.month, parsed.year),
    ]);

    if (employeeReferences.warning) {
      parsed.warnings.push(employeeReferences.warning);
    }
    if (!holidays.connected && holidays.message) {
      parsed.warnings.push({
        code: "public_holiday_lookup_unavailable",
        message: `Public holiday overlay is unavailable: ${holidays.message}`,
        severity: "warning",
      });
    }

    const preview = buildFieldWorkforceCompliancePreview({
      employeeReferences: employeeReferences.references,
      holidayConnected: holidays.connected,
      holidayMessage: holidays.message,
      holidaySourceLabel: holidays.sourceLabel,
      holidays: holidays.holidays,
      parsed,
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

    return NextResponse.json({
      error: "field_workforce_preview_failed",
      message: error instanceof Error ? error.message : "Field Workforce Compliance preview failed.",
      success: false,
    }, { status: 500 });
  }
}
