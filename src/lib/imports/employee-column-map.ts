import type {
  EmployeeImportColumnDefinition,
  EmployeeImportField,
} from "@/lib/imports/employee-import-types";
import { normalizeHeaderName } from "@/lib/imports/employee-normalizers";

export const employeeColumnDefinitions: EmployeeImportColumnDefinition[] = [
  {
    field: "hrId",
    dbPath: "employees.hr_id",
    required: true,
    aliases: ["HR_ID", "HR ID", "Code", "Employee Code", "Employee ID", "hr_id"],
  },
  {
    field: "crmId",
    dbPath: "employees.crm_id",
    required: false,
    aliases: ["CRM_ID", "CRM ID", "CRM Code", "crm_id"],
  },
  {
    field: "fullName",
    dbPath: "employees.full_name",
    required: true,
    aliases: ["Full Name", "Name", "Employee Name", "full_name"],
  },
  {
    field: "nameAr",
    dbPath: "employees.name_ar",
    required: false,
    aliases: ["Arabic Name", "Name AR", "Name Arabic", "name_ar"],
  },
  {
    field: "workEmail",
    dbPath: "employees.work_email",
    required: false,
    aliases: ["Email", "Work Email", "Company Email", "E-mail"],
  },
  {
    field: "mobileNumber",
    dbPath: "employees.mobile_number",
    required: false,
    aliases: ["Mobile", "Mobile Number", "Phone", "Phone Number", "mobile_number"],
  },
  {
    field: "jobTitle",
    dbPath: "employees.job_title",
    required: false,
    aliases: ["Job Title", "Title", "job_title"],
  },
  {
    field: "hireDate",
    dbPath: "employees.hire_date",
    required: false,
    aliases: ["Hiring Date", "Hire Date", "Start Date", "hire_date"],
  },
  {
    field: "education",
    dbPath: "employees.education",
    required: false,
    aliases: ["Education", "Degree", "Qualification"],
  },
  {
    field: "managerHrId",
    dbPath: "employees.manager_hr_id",
    required: false,
    aliases: ["Manager HR_ID", "Manager HR ID", "Manager Code", "manager_hr_id"],
  },
  {
    field: "department",
    dbPath: "departments.name",
    required: false,
    aliases: ["Department", "Dept", "department"],
  },
  {
    field: "line",
    dbPath: "lines.name",
    required: false,
    aliases: ["Line", "Business Line", "line"],
  },
  {
    field: "area",
    dbPath: "areas.name",
    required: false,
    aliases: ["Area", "Region", "Territory", "area"],
  },
  {
    field: "team",
    dbPath: "teams.name",
    required: false,
    aliases: ["Team", "Unit", "Squad", "team"],
  },
  {
    field: "position",
    dbPath: "positions.title",
    required: false,
    aliases: ["Position", "Job Title", "Title", "position"],
  },
];

export const requiredEmployeeImportFields = employeeColumnDefinitions
  .filter((definition) => definition.required)
  .map((definition) => definition.field);

export function createEmployeeColumnLookup() {
  const lookup = new Map<string, EmployeeImportField>();

  for (const definition of employeeColumnDefinitions) {
    for (const alias of definition.aliases) {
      lookup.set(normalizeHeaderName(alias), definition.field);
    }
  }

  return lookup;
}
