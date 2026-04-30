import type {
  EmployeeImportColumnDefinition,
  EmployeeImportField,
} from "@/lib/imports/employee-import-types";
import { normalizeHeaderName } from "@/lib/imports/employee-normalizers";

export const employeeColumnDefinitions: EmployeeImportColumnDefinition[] = [
  {
    field: "hrId",
    dbPath: "employees.hr_id",
    required: false,
    aliases: ["HR_ID", "HR ID", "Code", "Employee Code", "Employee ID", "hr_id"],
  },
  {
    field: "crmId",
    dbPath: "employees.crm_id",
    required: false,
    aliases: ["CRM_ID", "CRM ID", "CRM Code", "crm_id"],
  },
  {
    field: "crmUsername",
    dbPath: "employees.crm_username",
    required: false,
    aliases: ["CRM Username", "CRM User", "crm_username"],
  },
  {
    field: "fullName",
    dbPath: "employees.full_name",
    required: false,
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
    field: "birthDate",
    dbPath: "employees.birth_date",
    required: false,
    aliases: ["Birth Date", "Birthday", "Date Of Birth", "DOB", "birth_date"],
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
    field: "managerName",
    dbPath: "position_vacancies.manager_name",
    required: false,
    aliases: ["Manager Name", "Manager", "manager_name"],
  },
  {
    field: "netSalary",
    dbPath: "employee_compensation.net_salary",
    required: false,
    aliases: ["net_salary", "Net Salary", "Net"],
  },
  {
    field: "socialInsurance",
    dbPath: "employee_compensation.social_insurance",
    required: false,
    aliases: ["social_insurance", "Social Insurance"],
  },
  {
    field: "taxes",
    dbPath: "employee_compensation.taxes",
    required: false,
    aliases: ["taxes", "Tax", "Taxes"],
  },
  {
    field: "medicalInsurance",
    dbPath: "employee_compensation.medical_insurance",
    required: false,
    aliases: ["medical_insurance", "Medical Insurance"],
  },
  {
    field: "comprehensiveWage",
    dbPath: "employee_compensation.comprehensive_wage",
    required: false,
    aliases: ["Ø§Ù„Ø§Ø¬Ø±_Ø§Ù„Ø´Ø§Ù…Ù„", "Ø§Ù„Ø£Ø¬Ø± Ø§Ù„Ø´Ø§Ù…Ù„", "Comprehensive Wage"],
  },
  {
    field: "subscriptionWage",
    dbPath: "employee_compensation.subscription_wage",
    required: false,
    aliases: ["Ø§Ø¬Ø±_Ø§Ù„Ø§Ø´ØªØ±Ø§Ùƒ", "Ø£Ø¬Ø± Ø§Ù„Ø§Ø´ØªØ±Ø§Ùƒ", "Subscription Wage"],
  },
  {
    field: "fuelAllowance",
    dbPath: "employee_compensation.fuel_allowance",
    required: false,
    aliases: ["fuel_allowance", "Fuel Allowance"],
  },
  {
    field: "extraCostOfLiving",
    dbPath: "employee_compensation.extra_cost_of_living",
    required: false,
    aliases: ["extra_cost_of_living", "Extra Cost Of Living"],
  },
  {
    field: "grossSalary",
    dbPath: "employee_compensation.gross_salary",
    required: false,
    aliases: ["gross_salary", "Gross Salary"],
  },
  {
    field: "paymentMode",
    dbPath: "employee_compensation.payment_mode",
    required: false,
    aliases: [
      "payment_mode",
      "Payment Mode",
      "Pay Schedule",
      "Salary Payment Mode",
      "Payroll Split",
      "Salary Split",
    ],
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
    field: "region",
    dbPath: "position_vacancies.region_name",
    required: false,
    aliases: ["Region", "Zone", "region"],
  },
  {
    field: "area",
    dbPath: "areas.name",
    required: false,
    aliases: ["Area", "Territory", "area"],
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
