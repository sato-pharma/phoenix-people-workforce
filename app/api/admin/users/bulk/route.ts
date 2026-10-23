import ExcelJS from "exceljs";
import { NextResponse } from "next/server";

import { systemDocuments } from "@/config/system-settings";
import { getAccessControlDashboard, phoenixLines, upsertAccessUser } from "@/lib/admin/access-control";
import { assertPermission, parseRoleStrict, phoenixRoles } from "@/lib/auth/permissions";
import { ACTIVE_EMPLOYMENT_STATUSES_IN_LIST } from "@/lib/auth/session-lifecycle";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { excelSpreadsheetValidation, spreadsheetTooLargeMessage, validateSpreadsheetFile } from "@/lib/uploads/spreadsheets";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requiredColumns = [
  "HR_ID",
  "Role",
  "Line",
  "Is Active",
] as const;

const templateHeaders = [
  "HR_ID",
  "Name",
  "Role",
  "Line",
  "Manager_HR_ID",
  "Is Active",
];

function cellText(value: ExcelJS.CellValue) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "text" in value) return String(value.text ?? "").trim();
  if (typeof value === "object" && "result" in value) return String(value.result ?? "").trim();
  return String(value).trim();
}

function parseActive(value: string) {
  const normalized = value.trim().toLowerCase();
  return !["false", "0", "no", "inactive", "disabled"].includes(normalized);
}

type TemplateDirectoryEmployee = {
  fullName: string;
  hrId: string;
  managerHrId: string | null;
  lineName: string | null;
  jobTitle: string | null;
};

async function loadEmployeeDirectoryFallback(
  supabase: ReturnType<typeof getSupabaseAdmin>,
): Promise<TemplateDirectoryEmployee[]> {
  const { data: rawEmployees, error } = await supabase
    .from("employees")
    .select("hr_id,full_name,job_title,line_id,manager_hr_id")
    .not("hr_id", "is", null)
    // This directory becomes the bulk account-creation template. A leaver listed here invites an
    // admin to create a login for somebody who has left the company.
    .or(`employment_status.is.null,employment_status.in.${ACTIVE_EMPLOYMENT_STATUSES_IN_LIST}`)
    .order("full_name", { ascending: true });

  if (error) {
    throw new Error(`Unable to load employee directory: ${error.message}`);
  }

  const safeEmployees = (rawEmployees ?? []).filter((row) => typeof row?.hr_id === "string" && row.hr_id.trim());
  const lineIds = Array.from(
    new Set(
      safeEmployees
        .map((row) => row.line_id)
        .filter((lineId): lineId is number => typeof lineId === "number"),
    ),
  );

  const lineMap = new Map<number, string>();
  if (lineIds.length > 0) {
    const { data: lineRows } = await supabase
      .from("lines")
      .select("id,name")
      .in("id", lineIds);

    for (const line of lineRows ?? []) {
      if (typeof line?.id === "number" && typeof line?.name === "string") {
        lineMap.set(line.id, line.name);
      }
    }
  }

  return safeEmployees.map((row) => ({
    fullName: row.full_name?.trim() || row.hr_id!,
    hrId: row.hr_id!.trim(),
    jobTitle: row.job_title ?? null,
    lineName: row.line_id ? lineMap.get(row.line_id) ?? null : null,
    managerHrId: row.manager_hr_id?.trim() || null,
  }));
}

async function loadTemplateDirectory(supabase: ReturnType<typeof getSupabaseAdmin>): Promise<{
  employees: TemplateDirectoryEmployee[];
  source: "primary" | "fallback";
}> {
  try {
    const directory = await getEmployeeDirectory();
    const employees = directory.employees
      .filter((employee) => employee.hrId.trim())
      .map((employee) => ({
        fullName: employee.fullName,
        hrId: employee.hrId.trim(),
        jobTitle: employee.jobTitle ?? employee.positionTitle ?? null,
        lineName: employee.lineName,
        managerHrId: employee.managerHrId,
      }));

    if (employees.length > 0) {
      return { employees, source: "primary" };
    }
  } catch {
    // Keep fallback in place if directory function fails due relation/version differences.
  }

  const fallback = await loadEmployeeDirectoryFallback(supabase);
  if (fallback.length > 0) {
    return { employees: fallback, source: "fallback" };
  }

  return { employees: [], source: "fallback" };
}

type UploadRowResultStatus = "created" | "updated" | "skipped" | "error";

type UploadRowResult = {
  action: UploadRowResultStatus;
  row: number;
  hrId: string;
  name: string;
  role: string;
  line: string;
  errors: string[];
};

function buildTemplateWorkbook(
  directoryEmployees: TemplateDirectoryEmployee[],
  existingUserHrIds: Set<string>,
  isDirectorySourceFresh: boolean,
) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = systemDocuments.workbookCreator;
  workbook.created = new Date();

  const template = workbook.addWorksheet("Users Template");
  template.addRow(templateHeaders);
  template.columns = [
    { key: "hr_id", width: 15 },
    { key: "name", width: 22 },
    { key: "role", width: 24 },
    { key: "line", width: 16 },
    { key: "manager_hr_id", width: 16 },
    { key: "is_active", width: 12 },
  ];
  template.getRow(1).font = { bold: true };
  template.addRow({
    hr_id: "",
    name: "",
    role: "Employee",
    line: "Other",
    manager_hr_id: "",
    is_active: "true",
  });

  if (directoryEmployees.length === 0) {
    template.addRow({
      hr_id: "NO_DATA",
      name: "No employees were found in the directory",
      role: "Employee",
      line: "Other",
      manager_hr_id: "",
      is_active: "true",
    });
  } else {
    directoryEmployees.forEach((employee) => {
      const row = template.addRow({
        hr_id: employee.hrId,
        name: employee.fullName,
        role: "Employee",
        line: employee.lineName ?? "Other",
        manager_hr_id: employee.managerHrId ?? "",
        is_active: "true",
      });

      if (existingUserHrIds.has(employee.hrId.trim().toLowerCase())) {
        row.eachCell((cell) => {
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "90EE90" },
          };
        });
      }
    });
  }

  const directory = workbook.addWorksheet("Employees Directory");
  directory.columns = [
    { header: "HR_ID", key: "hr_id", width: 15 },
    { header: "Name", key: "name", width: 26 },
    { header: "Job Title", key: "jobTitle", width: 24 },
    { header: "Line", key: "line", width: 18 },
    { header: "Manager_HR_ID", key: "manager", width: 16 },
  ];
  directory.getRow(1).font = { bold: true };
  if (directoryEmployees.length === 0) {
    directory.addRow({
      hr_id: "NO_DATA",
      name: "No employees were found",
      jobTitle: "N/A",
      line: "N/A",
      manager: "",
    });
  } else {
    directory.addRows(
      directoryEmployees.map((employee) => ({
        hr_id: employee.hrId,
        name: employee.fullName,
        jobTitle: employee.jobTitle ?? "N/A",
        line: employee.lineName ?? "Other",
        manager: employee.managerHrId,
      })),
    );
  }

  template.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: templateHeaders.length },
  };

  const guide = workbook.addWorksheet("Template Notes");
  guide.addRow([systemDocuments.titles.userBulkImportTemplate]);
  guide.addRow(["Allowed lines:", phoenixLines.join(", ")]);
  guide.addRow(["Allowed roles:", phoenixRoles.join(", ")]);
  guide.addRow(["Use the Employees Directory sheet to copy valid HR_ID and Line values"]);
  guide.addRow([isDirectorySourceFresh ? "Directory data loaded from employee master source." : "Directory data loaded from fallback employee source."]);
  guide.addRow([""]);
  guide.addRow(["Rows highlighted in LIGHT GREEN already have user accounts"]);
  guide.addRow(["Focus on non-highlighted rows to create new accounts"]);
  if (directoryEmployees.length === 0) {
    guide.addRow(["NO DATA: No employee records with valid HR_ID were found."]);
  }
  guide.getCell("A1").font = { bold: true, size: 12 };
  guide.getCell("A6").font = { bold: true, color: { argb: "008000" } };
  guide.getCell("A7").font = { bold: true, color: { argb: "008000" } };

  return workbook;
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "user_admin", "read");

    const supabase = getSupabaseAdmin();
    const { data: existingUsers } = await supabase.from("app_auth_users").select("hr_id");
    const { employees: directoryEmployees, source } = await loadTemplateDirectory(supabase);
    const existingUserHrIds = new Set<string>(
      (existingUsers ?? [])
        .map((u: { hr_id: string | null }) => u.hr_id?.trim().toLowerCase())
        .filter((id): id is string => Boolean(id)),
    );

    const workbook = buildTemplateWorkbook(
      directoryEmployees,
      existingUserHrIds,
      source === "primary",
    );

    const buffer = await workbook.xlsx.writeBuffer();
    const fileName = "phoenix-workforce-users-template.xlsx";
    return new NextResponse(buffer, {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileName}"`,
      },
    });
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Unable to generate template.");
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message }, { status: 403 });
    }
    return NextResponse.json({ error: "template_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "imports", "import");
    await assertPermission(access, "user_admin", "update");
    if (access.role !== "Super Admin") {
      return NextResponse.json(
        { error: "forbidden", message: "Forbidden: only Super Admin can import user access." },
        { status: 403 },
      );
    }

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
      tooLargeMessage: spreadsheetTooLargeMessage("Users import file"),
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
    await workbook.xlsx.load(await file.arrayBuffer());
    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      return NextResponse.json({ error: "empty_workbook", message: "Workbook does not contain a sheet." }, { status: 400 });
    }

    const headerRow = worksheet.getRow(1);
    const columnMap = new Map<string, number>();
    headerRow.eachCell((cell, colNumber) => {
      columnMap.set(cellText(cell.value).toLowerCase(), colNumber);
    });

    const missingColumns = requiredColumns.filter((column) => !columnMap.has(column.toLowerCase()));
    if (missingColumns.length > 0) {
      return NextResponse.json(
        { error: "missing_columns", message: `Missing columns: ${missingColumns.join(", ")}` },
        { status: 400 },
      );
    }

    const supabase = getSupabaseAdmin();
    const { employees: directoryEmployees } = await loadTemplateDirectory(supabase);
    const employeeHrIds = new Set(directoryEmployees.map((employee) => employee.hrId.trim().toLowerCase()));
    const total = Math.max(0, worksheet.rowCount - 1);

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    const errors: string[] = [];

    type ParsedRow = {
      row: number;
      hrId: string;
      roleText: string;
      role: ReturnType<typeof parseRoleStrict>;
      line: string;
      name: string;
      managerHrId: string;
      isActive: string;
      email: string | null;
    };

    const parsedRows: ParsedRow[] = [];
    const rowResults: UploadRowResult[] = [];

    for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
      const row = worksheet.getRow(rowNumber);
      const read = (column: (typeof requiredColumns)[number]) =>
        cellText(row.getCell(columnMap.get(column.toLowerCase())!).value);
      const readOptional = (column: string) => {
        const col = columnMap.get(column.toLowerCase());
        if (!col) return "";
        return cellText(row.getCell(col).value);
      };

      const hrId = read("HR_ID");
      const roleText = read("Role");
      const lineRaw = read("Line");
      const line = lineRaw || "Other";
      const rowErrors: string[] = [];
      const managerValue = readOptional("Manager_HR_ID");
      const nameFromExcel = readOptional("Name");
      const activeValue = read("Is Active");
      const hasAnyData = Boolean(
        hrId ||
          roleText ||
          lineRaw ||
          managerValue ||
          nameFromExcel ||
          activeValue,
      );
      const isTemplatePlaceholderRow =
        (hrId === "" || hrId.toUpperCase() === "NO_DATA") &&
        roleText === "Employee" &&
        lineRaw === "Other" &&
        managerValue === "" &&
        activeValue.toLowerCase() === "true" &&
        !nameFromExcel;

      if (!hasAnyData || isTemplatePlaceholderRow) {
        skipped += 1;
        continue;
      }

      if (!hrId) {
        rowErrors.push("Missing HR_ID");
      }
      if (hrId && !employeeHrIds.has(hrId.trim().toLowerCase())) {
        rowErrors.push(`HR_ID ${hrId} does not exist in employee directory`);
      }
      if (!phoenixRoles.some((item) => item.toLowerCase() === roleText.trim().toLowerCase())) {
        rowErrors.push(`Role "${roleText}" is invalid. Valid roles: ${phoenixRoles.join(", ")}`);
      }
      if (line && !phoenixLines.some((item) => item.toLowerCase() === line.trim().toLowerCase())) {
        rowErrors.push(`Line "${line}" is invalid. Valid lines: ${phoenixLines.join(", ")}`);
      }

      const employee = directoryEmployees.find(
        (e) => e.hrId.trim().toLowerCase() === hrId.trim().toLowerCase(),
      );
      const name = nameFromExcel || employee?.fullName || hrId || "Unnamed";
      const resolvedLine = line || employee?.lineName || "Other";

      if (rowErrors.length > 0) {
        skipped += 1;
        failed += 1;
        errors.push(`Row ${rowNumber}: ${rowErrors.join(" | ")}`);
        rowResults.push({
          action: "error",
          row: rowNumber,
          hrId,
          name,
          role: roleText,
          line: resolvedLine,
          errors: rowErrors,
        });
        continue;
      }

      parsedRows.push({
        row: rowNumber,
        hrId,
        roleText,
        role: parseRoleStrict(roleText),
        line: resolvedLine,
        name,
        managerHrId: readOptional("Manager_HR_ID") || employee?.managerHrId || "",
        isActive: read("Is Active"),
        email: readOptional("Email") || null,
      });
    }

    const inputLoginIds = Array.from(new Set(
      parsedRows.map((row) => row.hrId.trim().toLowerCase()).filter((id): id is string => Boolean(id)),
    ));

    let existingLoginIds = new Set<string>();
    if (inputLoginIds.length > 0) {
      const { data: existingUsers } = await supabase
        .from("app_auth_users")
        .select("login_id")
        .in("login_id", inputLoginIds);
      existingLoginIds = new Set(
        (existingUsers ?? [])
          .map((u: { login_id: string | null }) => u.login_id?.trim().toLowerCase())
          .filter((id): id is string => Boolean(id)),
      );
    }

    const seenInUpload = new Set<string>();

    for (const row of parsedRows) {
      const normalizedLoginId = row.hrId.trim().toLowerCase();
      if (seenInUpload.has(normalizedLoginId)) {
        skipped += 1;
        failed += 1;
        const message = "Duplicate HR_ID in upload file";
        errors.push(`Row ${row.row}: ${message}`);
        rowResults.push({
          action: "error",
          row: row.row,
          hrId: row.hrId,
          name: row.name,
          role: row.roleText,
          line: row.line,
          errors: [message],
        });
        continue;
      }

      seenInUpload.add(normalizedLoginId);

      try {
        await upsertAccessUser(
          {
            email: row.email,
            governanceReason: `Bulk user import row ${row.row}`,
            hrId: row.hrId,
            isActive: parseActive(row.isActive),
            line: row.line,
            loginId: row.hrId,
            managerHrId: row.managerHrId,
            name: row.name,
            role: row.role,
          },
          { loginId: access.loginId ?? null, role: access.role },
        );

        if (existingLoginIds.has(normalizedLoginId)) {
          updated += 1;
          rowResults.push({
            action: "updated",
            row: row.row,
            hrId: row.hrId,
            name: row.name,
            role: row.roleText,
            line: row.line,
            errors: [],
          });
        } else {
          created += 1;
          rowResults.push({
            action: "created",
            row: row.row,
            hrId: row.hrId,
            name: row.name,
            role: row.roleText,
            line: row.line,
            errors: [],
          });
        }

        existingLoginIds.add(normalizedLoginId);
      } catch (error) {
        failed += 1;
        const rowError = clientSafeErrorMessage(error, "Unknown error");
        const message = `Failed to create/update user: ${rowError}`;
        errors.push(`Row ${row.row}: ${message}`);
        rowResults.push({
          action: "error",
          row: row.row,
          hrId: row.hrId,
          name: row.name,
          role: row.roleText,
          line: row.line,
          errors: [message],
        });
      }
    }

    if (errors.length > 0) {
      return NextResponse.json({
        error: "bulk_validation_failed",
        errors,
        created,
        updated,
        skipped,
        failed,
        total,
        rowResults,
      }, { status: 400 });
    }

    return NextResponse.json({
      created,
      updated,
      skipped,
      failed: 0,
      total,
      rowResults,
      dashboard: await getAccessControlDashboard(),
    });
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Bulk user upload failed.");
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message }, { status: 403 });
    }
    return NextResponse.json({ error: "bulk_upload_failed", message }, { status: 500 });
  }
}
