export const accessBulkTemplateFileName = "users_access_template_v1.xlsx";

export const accessBulkPhoenixRoles = [
  "Employee",
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "Regional Sales Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "SFE Manager",
  "Training Manager",
  "Marketing Manager",
  "Finance Manager",
  "HR Specialist",
  "Manager",
  "CEO",
  "Super Admin",
] as const;
export type AccessBulkPhoenixRole = (typeof accessBulkPhoenixRoles)[number];

export const accessBulkLineOptions = ["CNS", "Pedia", "Anti-Infective", "Office", "Other"] as const;
export type AccessBulkBusinessScope = "SELF" | "TEAM" | "HIERARCHY" | "LINE" | "COMPANY" | "NONE";

export const accessBulkCanonicalHeaders = [
  "HR_ID",
  "Name",
  "Email",
  "Role",
  "Line",
  "Manager_HR_ID",
  "Sales_Scope",
  "Active",
  "Notes",
] as const;

export type AccessBulkHeader = (typeof accessBulkCanonicalHeaders)[number];

export const accessBulkRequiredHeaders = ["HR_ID", "Role", "Line", "Active"] as const;

const businessScopes: AccessBulkBusinessScope[] = ["SELF", "TEAM", "HIERARCHY", "LINE", "COMPANY", "NONE"];
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const hrIdPattern = /^[A-Z0-9][A-Z0-9_-]{0,63}$/i;
const formulaInjectionPattern = /^[=+\-@]/;

const headerAliases: Record<AccessBulkHeader, readonly string[]> = {
  Active: ["Is Active", "Is_Active", "Status", "Enabled"],
  Email: ["Work Email", "Work_Email", "Auth Email"],
  HR_ID: ["HR ID", "HrId", "Employee ID", "Employee_ID", "Login ID", "Login_ID"],
  Line: ["Sales Line", "Business Line"],
  Manager_HR_ID: ["Manager HR_ID", "Manager HR ID", "Manager_HrId", "Manager ID"],
  Name: ["Full Name", "Employee Name"],
  Notes: ["Comment", "Comments", "Governance Notes", "Reason"],
  Role: ["Access Role", "Phoenix Role"],
  Sales_Scope: ["Sales Scope", "Scope Override", "Sales_Scope_Override", "salesScopeOverride"],
};

export type AccessBulkRowError = {
  code: string;
  field: AccessBulkHeader | "Workbook";
  message: string;
  recommendation?: string;
};

export type AccessBulkValidatedRow = {
  active: boolean;
  email: string | null;
  hrId: string;
  line: string;
  managerHrId: string;
  name: string;
  notes: string | null;
  role: AccessBulkPhoenixRole;
  roleText: string;
  row: number;
  salesScopeOverride: AccessBulkBusinessScope | null;
};

export type AccessBulkDirectoryEmployee = {
  fullName: string;
  hrId: string;
  lineName: string | null;
  managerHrId: string | null;
  workEmail?: string | null;
};

export type AccessBulkRawRow = {
  row: number;
  values: Partial<Record<AccessBulkHeader, string>>;
};

export type AccessBulkHeaderMapResult = {
  columns: Map<AccessBulkHeader, number>;
  duplicateHeaders: string[];
  missingRequiredHeaders: AccessBulkHeader[];
  unknownHeaders: string[];
};

export type AccessBulkValidationResult = {
  errorsByRow: Map<number, AccessBulkRowError[]>;
  rows: AccessBulkValidatedRow[];
};

export function normalizeAccessBulkHeader(value: string) {
  return value.trim().toLowerCase().replace(/\*/g, "").replace(/[\s_-]+/g, "");
}

export function resolveAccessBulkHeader(value: string): AccessBulkHeader | null {
  const normalized = normalizeAccessBulkHeader(value);
  if (!normalized) return null;
  for (const header of accessBulkCanonicalHeaders) {
    const candidates = [header, ...headerAliases[header]];
    if (candidates.some((candidate) => normalizeAccessBulkHeader(candidate) === normalized)) {
      return header;
    }
  }
  return null;
}

export function buildAccessBulkHeaderMap(headers: string[]): AccessBulkHeaderMapResult {
  const columns = new Map<AccessBulkHeader, number>();
  const duplicateHeaders: string[] = [];
  const unknownHeaders: string[] = [];

  headers.forEach((header, index) => {
    const trimmed = header.trim();
    if (!trimmed) return;
    const resolved = resolveAccessBulkHeader(trimmed);
    if (!resolved) {
      unknownHeaders.push(trimmed);
      return;
    }
    if (columns.has(resolved)) {
      duplicateHeaders.push(trimmed);
      return;
    }
    columns.set(resolved, index + 1);
  });

  return {
    columns,
    duplicateHeaders,
    missingRequiredHeaders: accessBulkRequiredHeaders.filter((header) => !columns.has(header)),
    unknownHeaders,
  };
}

export function isAccessBulkRowEmpty(values: Partial<Record<AccessBulkHeader, string>>) {
  return accessBulkCanonicalHeaders.every((header) => !values[header]?.trim());
}

export function isAccessBulkTemplatePlaceholder(values: Partial<Record<AccessBulkHeader, string>>) {
  return (
    !values.HR_ID?.trim() &&
    !values.Name?.trim() &&
    !values.Email?.trim() &&
    values.Role?.trim().toLowerCase() === "employee" &&
    values.Line?.trim().toLowerCase() === "other" &&
    !values.Manager_HR_ID?.trim() &&
    !values.Sales_Scope?.trim() &&
    values.Active?.trim().toLowerCase() === "true" &&
    !values.Notes?.trim()
  );
}

export function parseAccessBulkActive(value: string) {
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "active", "enabled"].includes(normalized)) return true;
  if (["false", "0", "no", "inactive", "disabled"].includes(normalized)) return false;
  return null;
}

export function normalizeAccessBulkRole(value: string) {
  return accessBulkPhoenixRoles.find((role) => role.toLowerCase() === value.trim().toLowerCase()) ?? null;
}

export function normalizeAccessBulkLine(value: string) {
  return accessBulkLineOptions.find((line) => line.toLowerCase() === value.trim().toLowerCase()) ?? null;
}

export function normalizeAccessBulkScope(value: string) {
  const normalized = value.trim().toUpperCase();
  if (!normalized) return null;
  return businessScopes.includes(normalized as AccessBulkBusinessScope) ? normalized as AccessBulkBusinessScope : undefined;
}

export function hasUnsafeSpreadsheetText(value: string) {
  return formulaInjectionPattern.test(value.trim());
}

function rowError(
  field: AccessBulkRowError["field"],
  code: string,
  message: string,
  recommendation?: string,
): AccessBulkRowError {
  return { code, field, message, recommendation };
}

export function validateAccessBulkRows(input: {
  actorRole: AccessBulkPhoenixRole;
  directoryEmployees: AccessBulkDirectoryEmployee[];
  rows: AccessBulkRawRow[];
}): AccessBulkValidationResult {
  const employeeMap = new Map(
    input.directoryEmployees.map((employee) => [employee.hrId.trim().toLowerCase(), employee]),
  );
  const hrIdRows = new Map<string, number[]>();
  const emailRows = new Map<string, number[]>();
  const errorsByRow = new Map<number, AccessBulkRowError[]>();
  const rows: AccessBulkValidatedRow[] = [];

  for (const rawRow of input.rows) {
    const hrId = rawRow.values.HR_ID?.trim().toLowerCase();
    if (hrId) hrIdRows.set(hrId, [...(hrIdRows.get(hrId) ?? []), rawRow.row]);
    const email = rawRow.values.Email?.trim().toLowerCase();
    if (email) emailRows.set(email, [...(emailRows.get(email) ?? []), rawRow.row]);
  }

  for (const rawRow of input.rows) {
    const values = rawRow.values;
    const errors: AccessBulkRowError[] = [];
    const addError = (error: AccessBulkRowError) => errors.push(error);
    const hrId = values.HR_ID?.trim() ?? "";
    const roleText = values.Role?.trim() ?? "";
    const lineText = values.Line?.trim() ?? "";
    const activeText = values.Active?.trim() ?? "";
    const managerHrId = values.Manager_HR_ID?.trim() ?? "";
    const nameText = values.Name?.trim() ?? "";
    const emailText = values.Email?.trim().toLowerCase() ?? "";
    const notesText = values.Notes?.trim() ?? "";
    const salesScopeText = values.Sales_Scope?.trim() ?? "";

    for (const header of accessBulkCanonicalHeaders) {
      const value = values[header]?.trim() ?? "";
      if (value && hasUnsafeSpreadsheetText(value)) {
        addError(rowError(header, "unsafe_spreadsheet_text", `${header} cannot start with =, +, -, or @.`, "Paste plain text without spreadsheet formulas."));
      }
    }

    if (!hrId) {
      addError(rowError("HR_ID", "missing_hr_id", "HR_ID is required.", "Use a valid active employee HR_ID from the Employees Directory sheet."));
    } else if (!hrIdPattern.test(hrId)) {
      addError(rowError("HR_ID", "invalid_hr_id", "HR_ID format is invalid.", "Use letters, numbers, underscore, or hyphen, starting with a letter or number."));
    }

    const employee = employeeMap.get(hrId.toLowerCase());
    if (hrId && !employee) {
      addError(rowError("HR_ID", "employee_not_active", `HR_ID ${hrId} is not an active employee in the master directory.`, "Activate the employee in Employees first, or do not provision access."));
    }

    if (hrId) {
      const duplicateRows = hrIdRows.get(hrId.toLowerCase()) ?? [];
      if (duplicateRows.length > 1) {
        addError(rowError("HR_ID", "duplicate_hr_id", `Duplicate HR_ID appears on rows ${duplicateRows.join(", ")}.`, "Keep one row per HR_ID."));
      }
    }

    const role = normalizeAccessBulkRole(roleText);
    if (!role) {
      addError(rowError("Role", "invalid_role", `Role "${roleText || "(blank)"}" is invalid.`, `Use one of: ${accessBulkPhoenixRoles.join(", ")}.`));
    } else if (role === "Super Admin" && input.actorRole !== "Super Admin") {
      addError(rowError("Role", "unauthorized_super_admin_import", "Only Super Admin can import Super Admin access.", "Remove the Super Admin role or ask a Super Admin to perform this governed change."));
    }

    const line = normalizeAccessBulkLine(lineText);
    if (!line) {
      addError(rowError("Line", "invalid_line", `Line "${lineText || "(blank)"}" is invalid.`, `Use one of: ${accessBulkLineOptions.join(", ")}.`));
    }

    const active = parseAccessBulkActive(activeText);
    if (active === null) {
      addError(rowError("Active", "invalid_active", `Active "${activeText || "(blank)"}" is invalid.`, "Use TRUE/FALSE, Active/Inactive, Yes/No, or 1/0."));
    }

    if (emailText && !emailPattern.test(emailText)) {
      addError(rowError("Email", "invalid_email", "Email format is invalid.", "Use a valid mailbox such as user@company.com."));
    }
    if (emailText) {
      const duplicateEmailRows = emailRows.get(emailText) ?? [];
      if (duplicateEmailRows.length > 1) {
        addError(rowError("Email", "duplicate_email", `Duplicate email appears on rows ${duplicateEmailRows.join(", ")}.`, "Use one auth email per imported user."));
      }
    }

    if (managerHrId) {
      if (!hrIdPattern.test(managerHrId)) {
        addError(rowError("Manager_HR_ID", "invalid_manager_hr_id", "Manager_HR_ID format is invalid.", "Use a valid active manager HR_ID."));
      } else if (!employeeMap.has(managerHrId.toLowerCase())) {
        addError(rowError("Manager_HR_ID", "manager_not_active", `Manager_HR_ID ${managerHrId} is not an active employee.`, "Choose an active manager from the Employees Directory sheet."));
      }
    }

    const salesScopeOverride = normalizeAccessBulkScope(salesScopeText);
    if (typeof salesScopeOverride === "undefined") {
      addError(rowError("Sales_Scope", "invalid_sales_scope", `Sales_Scope "${salesScopeText}" is invalid.`, `Leave blank or use one of: ${businessScopes.join(", ")}.`));
    }

    if (errors.length > 0 || !role || !line || active === null) {
      errorsByRow.set(rawRow.row, errors);
      continue;
    }

    rows.push({
      active,
      email: emailText || null,
      hrId,
      line,
      managerHrId: managerHrId || employee?.managerHrId || "",
      name: nameText || employee?.fullName || hrId,
      notes: notesText || null,
      role,
      roleText,
      row: rawRow.row,
      salesScopeOverride: salesScopeOverride ?? null,
    });
  }

  return { errorsByRow, rows };
}
