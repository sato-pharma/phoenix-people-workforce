import ExcelJS from "exceljs";
import { NextResponse } from "next/server";

import {
  accessBulkCanonicalHeaders,
  accessBulkLineOptions,
  accessBulkPhoenixRoles,
  accessBulkRequiredHeaders,
  accessBulkTemplateFileName,
  buildAccessBulkHeaderMap,
  isAccessBulkRowEmpty,
  isAccessBulkTemplatePlaceholder,
  type AccessBulkDirectoryEmployee,
  type AccessBulkRawRow,
  type AccessBulkRowError,
  validateAccessBulkRows,
} from "@/lib/admin/access-bulk";
import { getAccessControlDashboard, upsertAccessUser } from "@/lib/admin/access-control";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { toApiError, unauthorizedError } from "@/lib/http/api-errors";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { excelSpreadsheetValidation, validateSpreadsheetFile } from "@/lib/uploads/spreadsheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type UploadRowResultStatus = "created" | "updated" | "skipped" | "error";

type UploadRowResult = {
  action: UploadRowResultStatus;
  errorDetails?: AccessBulkRowError[];
  errors: string[];
  hrId: string;
  line: string;
  name: string;
  role: string;
  row: number;
};

type ExistingAccessTemplateUser = {
  email: string | null;
  hr_id: string | null;
  is_active: boolean | null;
  line: string | null;
  login_id: string | null;
  manager_hr_id: string | null;
  name: string | null;
  role: string | null;
  sales_scope_override: string | null;
};

function assertAuthenticated(access: { hrId: string | null; loginId?: string | null }) {
  if (!access.loginId && !access.hrId) {
    throw unauthorizedError();
  }
}

function cellText(value: ExcelJS.CellValue) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "formula" in value) return `=${String(value.formula ?? "").trim()}`;
  if (typeof value === "object" && "text" in value) return String(value.text ?? "").trim();
  if (typeof value === "object" && "result" in value) return String(value.result ?? "").trim();
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

function rowResultFromValidationError(
  row: AccessBulkRawRow,
  errors: AccessBulkRowError[],
): UploadRowResult {
  return {
    action: "error",
    errorDetails: errors,
    errors: errors.map((error) => error.recommendation ? `${error.message} ${error.recommendation}` : error.message),
    hrId: row.values.HR_ID ?? "",
    line: row.values.Line ?? "",
    name: row.values.Name ?? "",
    role: row.values.Role ?? "",
    row: row.row,
  };
}

function workbookError(message: string, code: string, recommendation?: string): AccessBulkRowError {
  return { code, field: "Workbook", message, recommendation };
}

function findHeaderRow(worksheet: ExcelJS.Worksheet) {
  const maxScanRows = Math.min(15, worksheet.rowCount);
  for (let rowNumber = 1; rowNumber <= maxScanRows; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const headers: string[] = [];
    for (let column = 1; column <= Math.max(row.cellCount, accessBulkCanonicalHeaders.length); column += 1) {
      headers.push(cellText(row.getCell(column).value));
    }
    const result = buildAccessBulkHeaderMap(headers);
    if (result.columns.size >= accessBulkRequiredHeaders.length && result.missingRequiredHeaders.length === 0) {
      return { headerRowNumber: rowNumber, headers, result };
    }
  }
  return null;
}

function buildTemplateWorkbook(
  directoryEmployees: AccessBulkDirectoryEmployee[],
  existingUsers: ExistingAccessTemplateUser[],
) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.subject = "Users & Access governed bulk import template";
  workbook.title = "Phoenix Workforce Users & Access Import Template";

  const template = workbook.addWorksheet("Users_Access_Template", {
    views: [{ state: "frozen", ySplit: 4 }],
  });

  template.mergeCells(1, 1, 1, accessBulkCanonicalHeaders.length);
  template.getCell("A1").value = "Phoenix Workforce Users & Access Import";
  template.getCell("A1").font = { bold: true, color: { argb: "FFFFFFFF" }, size: 16 };
  template.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF97316" } };
  template.getCell("A1").alignment = { vertical: "middle" };
  template.getRow(1).height = 28;

  template.mergeCells(2, 1, 2, accessBulkCanonicalHeaders.length);
  template.getCell("A2").value = "Use this workbook to create or update governed access profiles for active employees only. Do not add passwords, setup links, reset URLs, or tokens.";
  template.getCell("A2").font = { color: { argb: "FF475569" }, size: 10 };
  template.getCell("A2").alignment = { wrapText: true };

  template.getRow(4).values = [...accessBulkCanonicalHeaders];
  template.columns = [
    { key: "hr_id", width: 16 },
    { key: "name", width: 28 },
    { key: "email", width: 30 },
    { key: "role", width: 24 },
    { key: "line", width: 18 },
    { key: "manager_hr_id", width: 18 },
    { key: "sales_scope", width: 16 },
    { key: "active", width: 12 },
    { key: "notes", width: 36 },
  ];

  const headerRow = template.getRow(4);
  headerRow.height = 24;
  headerRow.eachCell((cell, columnNumber) => {
    const header = accessBulkCanonicalHeaders[columnNumber - 1];
    const required = accessBulkRequiredHeaders.includes(header as (typeof accessBulkRequiredHeaders)[number]);
    cell.value = `${header}${required ? " *" : ""}`;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: required ? "FFEA580C" : "FF334155" } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = {
      bottom: { color: { argb: "FFE2E8F0" }, style: "thin" },
      left: { color: { argb: "FFE2E8F0" }, style: "thin" },
      right: { color: { argb: "FFE2E8F0" }, style: "thin" },
      top: { color: { argb: "FFE2E8F0" }, style: "thin" },
    };
    cell.note = required
      ? `${header} is required for upload.`
      : `${header} is optional. Unknown columns are rejected.`;
  });

  const existingByHrId = new Map<string, ExistingAccessTemplateUser>();
  for (const user of existingUsers) {
    const key = (user.hr_id || user.login_id || "").trim().toLowerCase();
    if (key) existingByHrId.set(key, user);
  }

  if (directoryEmployees.length === 0) {
    const row = template.addRow({
      active: "TRUE",
      email: "",
      hr_id: "",
      line: "Other",
      manager_hr_id: "",
      name: "",
      notes: "",
      role: "Employee",
      sales_scope: "",
    });
    row.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF7ED" } };
      cell.font = { color: { argb: "FF475569" } };
    });
  } else {
    for (const employee of directoryEmployees) {
      const existing = existingByHrId.get(employee.hrId.trim().toLowerCase());
      const row = template.addRow({
        active: existing ? (existing.is_active === false ? "FALSE" : "TRUE") : "TRUE",
        email: existing?.email ?? employee.workEmail ?? "",
        hr_id: employee.hrId,
        line: existing?.line ?? employee.lineName ?? "Other",
        manager_hr_id: existing?.manager_hr_id ?? employee.managerHrId ?? "",
        name: existing?.name ?? employee.fullName,
        notes: existing ? "Existing access profile. Review before upload." : "Not provisioned. Upload to create access profile.",
        role: existing?.role ?? "Employee",
        sales_scope: existing?.sales_scope_override ?? "",
      });
      row.eachCell((cell) => {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: existing ? "FFEFF6FF" : "FFFFF7ED" },
        };
        cell.font = { color: { argb: "FF334155" } };
      });
    }
  }

  template.autoFilter = {
    from: { row: 4, column: 1 },
    to: { row: 4, column: accessBulkCanonicalHeaders.length },
  };

  const validationRows = { from: 5, to: 500 };
  for (let row = validationRows.from; row <= validationRows.to; row += 1) {
    template.getCell(`D${row}`).dataValidation = {
      allowBlank: false,
      formulae: [`"${accessBulkPhoenixRoles.join(",")}"`],
      showErrorMessage: true,
      type: "list",
    };
    template.getCell(`E${row}`).dataValidation = {
      allowBlank: false,
      formulae: [`"${accessBulkLineOptions.join(",")}"`],
      showErrorMessage: true,
      type: "list",
    };
    template.getCell(`G${row}`).dataValidation = {
      allowBlank: true,
      formulae: ['"SELF,TEAM,HIERARCHY,LINE,COMPANY,NONE"'],
      showErrorMessage: true,
      type: "list",
    };
    template.getCell(`H${row}`).dataValidation = {
      allowBlank: false,
      formulae: ['"TRUE,FALSE"'],
      showErrorMessage: true,
      type: "list",
    };
  }

  const instructions = workbook.addWorksheet("Instructions");
  instructions.columns = [
    { key: "item", width: 28 },
    { key: "detail", width: 90 },
  ];
  instructions.addRows([
    { detail: "Phoenix Workforce Users & Access Template v1", item: "Template" },
    { detail: accessBulkRequiredHeaders.join(", "), item: "Required columns" },
    { detail: accessBulkCanonicalHeaders.filter((header) => !accessBulkRequiredHeaders.includes(header as (typeof accessBulkRequiredHeaders)[number])).join(", "), item: "Optional columns" },
    { detail: "HR_ID must exist as an active employee in Employees. Resigned, terminated, inactive, payroll-ineligible, or hidden organogram employees are rejected.", item: "Employee source" },
    { detail: "Rows can create not-provisioned employees as access profiles or update existing access users. Each changed row is audited.", item: "Import behavior" },
    { detail: "Only authorized actors can create privileged roles. Super Admin import requires a Super Admin actor.", item: "Privilege governance" },
    { detail: "Setup/reset links and passwords must never be entered in this file and are never exported.", item: "Sensitive data" },
    { detail: "The template is populated with active Employees master data. Existing access profiles are filled from Users & Access; not-provisioned employees default to Employee/Active for review.", item: "Populated data" },
    { detail: "Unknown columns are rejected. Empty rows are ignored. Duplicate HR_ID or duplicate Email rows are reported with row numbers.", item: "Validation" },
    { detail: "Accepted Active values: TRUE, FALSE, Active, Inactive, Yes, No, 1, 0.", item: "Active values" },
    { detail: "Accepted Sales_Scope values: SELF, TEAM, HIERARCHY, LINE, COMPANY, NONE. Leave blank to inherit role scope.", item: "Sales scope" },
    { detail: "Example row: E1001, Sample Employee, sample.user@company.com, Employee, Other, M1001, TEAM, TRUE, Provision employee access.", item: "Safe example" },
  ]);
  instructions.getRow(1).font = { bold: true, color: { argb: "FFF97316" }, size: 14 };
  instructions.eachRow((row, rowNumber) => {
    row.eachCell((cell) => {
      cell.alignment = { vertical: "top", wrapText: true };
      cell.border = { bottom: { color: { argb: "FFE2E8F0" }, style: "thin" } };
      if (rowNumber > 1 && Number(cell.col) === 1) cell.font = { bold: true, color: { argb: "FF334155" } };
    });
  });

  return workbook;
}

async function loadTemplateDirectory(): Promise<AccessBulkDirectoryEmployee[]> {
  const directory = await getEmployeeDirectory();
  return directory.employees
    .filter((employee) => employee.hrId.trim())
    .map((employee) => ({
      fullName: employee.fullName,
      hrId: employee.hrId.trim(),
      lineName: employee.lineName,
      managerHrId: employee.managerHrId,
      workEmail: employee.workEmail,
    }));
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    assertAuthenticated(access);
    await assertPermission(access, "user_admin", "read");

    const [directoryEmployees, existingUsersResult] = await Promise.all([
      loadTemplateDirectory(),
      getSupabaseAdmin()
        .from("app_auth_users")
        .select("login_id,hr_id,name,email,role,line,manager_hr_id,sales_scope_override,is_active"),
    ]);
    if (existingUsersResult.error) throw existingUsersResult.error;

    const workbook = buildTemplateWorkbook(
      directoryEmployees,
      (existingUsersResult.data ?? []) as ExistingAccessTemplateUser[],
    );
    const buffer = await workbook.xlsx.writeBuffer();
    return new NextResponse(buffer, {
      headers: {
        "Content-Disposition": `attachment; filename="${accessBulkTemplateFileName}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    const apiError = toApiError(error, "Unable to generate template.");
    if (isForbiddenError(error) || apiError.status === 403) {
      return NextResponse.json({ error: "forbidden", message: apiError.message }, { status: 403 });
    }
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    assertAuthenticated(access);
    await assertPermission(access, "imports", "import");
    await assertPermission(access, "user_admin", "update");

    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "missing_file", message: "Users Excel file is required." }, { status: 400 });
    }

    const fileValidation = validateSpreadsheetFile(file, {
      ...excelSpreadsheetValidation,
      emptyError: "invalid_users_file",
      emptyMessage: "Users import file is empty.",
      tooLargeError: "users_file_too_large",
      tooLargeMessage: "Users import file exceeds the 10MB upload limit.",
      unsupportedError: "unsupported_users_file_type",
      unsupportedMessage: "Upload a users Excel file in .xls or .xlsx format.",
    });
    if (!fileValidation.ok) {
      return NextResponse.json(
        { error: fileValidation.error, message: fileValidation.message },
        { status: fileValidation.status },
      );
    }

    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(await file.arrayBuffer());
    } catch {
      return NextResponse.json({
        error: "invalid_workbook",
        message: "Uploaded file could not be opened as a valid Excel workbook.",
      }, { status: 400 });
    }
    const worksheet = workbook.getWorksheet("Users_Access_Template") ?? workbook.worksheets[0];
    if (!worksheet) {
      return NextResponse.json({ error: "empty_workbook", message: "Workbook does not contain a sheet." }, { status: 400 });
    }

    const headerMatch = findHeaderRow(worksheet);
    if (!headerMatch) {
      return NextResponse.json({
        error: "missing_columns",
        message: `Could not find required headers: ${accessBulkRequiredHeaders.join(", ")}.`,
      }, { status: 400 });
    }

    const { headerRowNumber, result: headerResult } = headerMatch;
    const workbookErrors: AccessBulkRowError[] = [];
    if (headerResult.missingRequiredHeaders.length > 0) {
      workbookErrors.push(workbookError(
        `Missing required columns: ${headerResult.missingRequiredHeaders.join(", ")}.`,
        "missing_required_columns",
        "Download a fresh template and keep the required headers.",
      ));
    }
    if (headerResult.duplicateHeaders.length > 0) {
      workbookErrors.push(workbookError(
        `Duplicate headers: ${headerResult.duplicateHeaders.join(", ")}.`,
        "duplicate_headers",
        "Keep one column per canonical header.",
      ));
    }
    if (headerResult.unknownHeaders.length > 0) {
      workbookErrors.push(workbookError(
        `Unknown columns: ${headerResult.unknownHeaders.join(", ")}.`,
        "unknown_columns",
        "Remove unsupported columns. Unknown columns are rejected so they cannot mutate access silently.",
      ));
    }
    if (workbookErrors.length > 0) {
      return NextResponse.json({
        error: "invalid_workbook_headers",
        errors: workbookErrors.map((error) => error.message),
        rowResults: [{
          action: "error",
          errorDetails: workbookErrors,
          errors: workbookErrors.map((error) => error.recommendation ? `${error.message} ${error.recommendation}` : error.message),
          hrId: "",
          line: "",
          name: "Workbook",
          role: "",
          row: headerRowNumber,
        }],
      }, { status: 400 });
    }

    const rawRows: AccessBulkRawRow[] = [];
    let skipped = 0;
    for (let rowNumber = headerRowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
      const row = worksheet.getRow(rowNumber);
      const values: AccessBulkRawRow["values"] = {};
      for (const header of accessBulkCanonicalHeaders) {
        const column = headerResult.columns.get(header);
        values[header] = column ? cellText(row.getCell(column).value) : "";
      }
      if (isAccessBulkRowEmpty(values) || isAccessBulkTemplatePlaceholder(values)) {
        skipped += 1;
        continue;
      }
      rawRows.push({ row: rowNumber, values });
    }

    const directoryEmployees = await loadTemplateDirectory();
    const validation = validateAccessBulkRows({
      actorRole: access.role,
      directoryEmployees,
      rows: rawRows,
    });
    const rowResults: UploadRowResult[] = [];
    for (const rawRow of rawRows) {
      const errors = validation.errorsByRow.get(rawRow.row);
      if (errors?.length) {
        rowResults.push(rowResultFromValidationError(rawRow, errors));
      }
    }

    const inputLoginIds = Array.from(new Set(validation.rows.map((row) => row.hrId.trim().toLowerCase())));
    let existingLoginIds = new Set<string>();
    const existingEmailsByEmail = new Map<string, string>();
    if (inputLoginIds.length > 0 || validation.rows.some((row) => row.email)) {
      const supabase = getSupabaseAdmin();
      const emails = Array.from(new Set(validation.rows.map((row) => row.email).filter((email): email is string => Boolean(email))));
      const existingUserRows: Array<{ auth_email: string | null; email: string | null; login_id: string | null }> = [];
      if (inputLoginIds.length > 0) {
        const { data } = await supabase
          .from("app_auth_users")
          .select("login_id,email,auth_email")
          .in("login_id", inputLoginIds);
        existingUserRows.push(...((data ?? []) as typeof existingUserRows));
      }
      if (emails.length > 0) {
        const { data: emailRows } = await supabase
          .from("app_auth_users")
          .select("login_id,email,auth_email")
          .in("email", emails);
        existingUserRows.push(...((emailRows ?? []) as typeof existingUserRows));
        const { data: authEmailRows } = await supabase
          .from("app_auth_users")
          .select("login_id,email,auth_email")
          .in("auth_email", emails);
        existingUserRows.push(...((authEmailRows ?? []) as typeof existingUserRows));
      }
      existingLoginIds = new Set(
        existingUserRows
          .map((user: { login_id: string | null }) => user.login_id?.trim().toLowerCase())
          .filter((id): id is string => Boolean(id)),
      );
      for (const user of existingUserRows) {
        const loginId = user.login_id?.trim().toLowerCase();
        const email = user.email?.trim().toLowerCase();
        const authEmail = user.auth_email?.trim().toLowerCase();
        if (loginId && email) existingEmailsByEmail.set(email, loginId);
        if (loginId && authEmail) existingEmailsByEmail.set(authEmail, loginId);
      }
    }

    for (const row of validation.rows) {
      if (row.email) {
        const existingLoginId = existingEmailsByEmail.get(row.email);
        if (existingLoginId && existingLoginId !== row.hrId.trim().toLowerCase()) {
          const error = workbookError(
            `Email ${row.email} already belongs to ${existingLoginId}.`,
            "email_conflict",
            "Use a unique auth email or remove the email value.",
          );
          rowResults.push({
            action: "error",
            errorDetails: [error],
            errors: [error.message],
            hrId: row.hrId,
            line: row.line,
            name: row.name,
            role: row.role,
            row: row.row,
          });
          validation.errorsByRow.set(row.row, [error]);
        }
      }
    }

    let created = 0;
    let updated = 0;
    let failed = validation.errorsByRow.size;
    const validRows = validation.rows.filter((row) => !validation.errorsByRow.has(row.row));

    for (const row of validRows) {
      const normalizedLoginId = row.hrId.trim().toLowerCase();
      try {
        await upsertAccessUser(
          {
            email: row.email,
            governanceReason: row.notes
              ? `Bulk user import row ${row.row}: ${row.notes}`
              : `Bulk user import row ${row.row}`,
            hrId: row.hrId,
            isActive: row.active,
            line: row.line,
            loginId: row.hrId,
            managerHrId: row.managerHrId,
            name: row.name,
            role: row.role,
            salesScopeOverride: row.salesScopeOverride,
          },
          { loginId: access.loginId ?? null, role: access.role },
        );

        const action = existingLoginIds.has(normalizedLoginId) ? "updated" : "created";
        if (action === "updated") updated += 1;
        else created += 1;
        rowResults.push({
          action,
          errors: [],
          hrId: row.hrId,
          line: row.line,
          name: row.name,
          role: row.role,
          row: row.row,
        });
        existingLoginIds.add(normalizedLoginId);
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : "Unknown row mutation error.";
        rowResults.push({
          action: "error",
          errorDetails: [workbookError(message, "row_mutation_failed")],
          errors: [`Failed to create/update user: ${message}`],
          hrId: row.hrId,
          line: row.line,
          name: row.name,
          role: row.role,
          row: row.row,
        });
      }
    }

    const total = rawRows.length + skipped;
    const responseBody = {
      created,
      failed,
      rowResults: rowResults.sort((left, right) => left.row - right.row),
      skipped,
      total,
      updated,
    };

    if (failed > 0) {
      return NextResponse.json({
        ...responseBody,
        dashboard: created > 0 || updated > 0 ? await getAccessControlDashboard() : null,
        error: "bulk_validation_failed",
        errors: rowResults
          .filter((result) => result.action === "error")
          .map((result) => `Row ${result.row}: ${result.errors.join(" | ")}`),
        message: "Bulk upload completed with row-level errors. Review failed rows and upload a corrected workbook.",
      }, { status: 400 });
    }

    return NextResponse.json({
      ...responseBody,
      dashboard: await getAccessControlDashboard(),
    });
  } catch (error) {
    const apiError = toApiError(error, "Bulk user upload failed.");
    if (isForbiddenError(error) || apiError.status === 403) {
      return NextResponse.json({ error: "forbidden", message: apiError.message }, { status: 403 });
    }
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
