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
  FieldWorkforcePreviewResult,
  FieldWorkforceValidationIssue,
} from "@/lib/field-workforce-compliance/types";
import { loadExcelWorkbook } from "@/lib/uploads/exceljs-rows";
import { getEgyptianNationalHolidays } from "@/lib/vacation/national-holidays";

export class FieldWorkforcePreviewError extends Error {
  code: string;
  errors: FieldWorkforceValidationIssue[];
  status: number;
  warnings: FieldWorkforceValidationIssue[];

  constructor(input: {
    code: string;
    errors?: FieldWorkforceValidationIssue[];
    message: string;
    status: number;
    warnings?: FieldWorkforceValidationIssue[];
  }) {
    super(input.message);
    this.name = "FieldWorkforcePreviewError";
    this.code = input.code;
    this.errors = input.errors ?? [];
    this.status = input.status;
    this.warnings = input.warnings ?? [];
  }
}

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

export async function buildFieldWorkforceCompliancePreviewFromWorkbook(input: {
  arrayBuffer: ArrayBuffer;
  fileName: string;
}): Promise<FieldWorkforcePreviewResult> {
  let workbook;
  try {
    workbook = await loadExcelWorkbook(input.arrayBuffer);
  } catch {
    throw new FieldWorkforcePreviewError({
      code: "invalid_excel_file",
      message: "The workbook could not be read as a valid .xlsx file.",
      status: 400,
    });
  }

  const worksheet = findUsableFieldWorkforceWorksheet(workbook);
  if (!worksheet) {
    throw new FieldWorkforcePreviewError({
      code: "empty_workbook",
      message: "No usable worksheet was found in the workbook.",
      status: 400,
    });
  }

  const parsed = parseFieldWorkforceComplianceWorksheet({
    fileName: input.fileName,
    worksheet,
  });

  if (parsed.errors.length > 0 || !parsed.month || !parsed.year) {
    throw new FieldWorkforcePreviewError({
      code: "invalid_workbook_structure",
      errors: parsed.errors,
      message: "The workbook structure must be corrected before preview.",
      status: 400,
      warnings: parsed.warnings,
    });
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

  return buildFieldWorkforceCompliancePreview({
    employeeReferences: employeeReferences.references,
    holidayConnected: holidays.connected,
    holidayMessage: holidays.message,
    holidaySourceLabel: holidays.sourceLabel,
    holidays: holidays.holidays,
    parsed,
  });
}
