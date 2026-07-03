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
    field: "nickname",
    dbPath: "employees.nickname",
    required: false,
    aliases: ["Nickname", "Nick Name", "Display Name", "nickname"],
  },
  {
    field: "nameAr",
    dbPath: "employees.name_ar",
    required: false,
    aliases: ["Arabic Name", "Name AR", "Name Arabic", "name_ar"],
  },
  {
    field: "nationalId",
    dbPath: "employees.national_id",
    required: false,
    aliases: ["National ID", "National ID Number", "national_id"],
  },
  {
    field: "gender",
    dbPath: "employees.gender",
    required: false,
    aliases: ["Gender", "Sex", "gender"],
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
    field: "employmentStatus",
    dbPath: "employees.employment_status",
    required: false,
    aliases: ["Employment Status", "Lifecycle Status", "Status", "employment_status"],
  },
  {
    field: "payrollEligible",
    dbPath: "employees.payroll_eligible",
    required: false,
    aliases: ["Payroll Eligible", "Payroll Eligibility", "payroll_eligible"],
  },
  {
    field: "organogramVisible",
    dbPath: "employees.organogram_visible",
    required: false,
    aliases: ["Organogram Visible", "Workforce Visible", "organogram_visible"],
  },
  {
    field: "managerHrId",
    dbPath: "employees.manager_hr_id",
    required: false,
    aliases: ["Manager HR_ID", "Manager HR ID", "Manager Code", "Direct Manager ID", "manager_hr_id"],
  },
  {
    field: "managerName",
    dbPath: "position_vacancies.manager_name",
    required: false,
    aliases: ["Manager Name", "Manager", "Direct Manager", "manager_name"],
  },
  {
    field: "contractType",
    dbPath: "employees.contract_type",
    required: false,
    aliases: ["Contract Type", "Employment Contract Type", "contract_type"],
  },
  {
    field: "hasBankAccount",
    dbPath: "employees.has_bank_account",
    required: false,
    aliases: ["Has Bank Account", "Have Bank Account", "Bank Account Available", "has_bank_account"],
  },
  {
    field: "bankName",
    dbPath: "employees.bank_name",
    required: false,
    aliases: ["Bank Name", "Bank", "Payroll Bank", "bank_name"],
  },
  {
    field: "bankAccount",
    dbPath: "employees.bank_account",
    required: false,
    aliases: ["Bank Account", "Bank Account Number", "IBAN", "bank_account"],
  },
  {
    field: "socialInsuranceStatus",
    dbPath: "employees.social_insurance_status",
    required: false,
    aliases: ["In Social Insurance", "Social Insurance Status", "social_insurance_status"],
  },
  {
    field: "socialInsuranceNumber",
    dbPath: "employees.social_insurance_number",
    required: false,
    aliases: ["Social Insurance Number", "Social Insurance ID", "social_insurance_number"],
  },
  {
    field: "medicalInsuranceStatus",
    dbPath: "employees.medical_insurance_status",
    required: false,
    aliases: ["In Medical Insurance", "Medical Insurance Status", "medical_insurance_status"],
  },
  {
    field: "medicalInsuranceNumber",
    dbPath: "employees.medical_insurance_number",
    required: false,
    aliases: ["Medical Insurance Number", "Medical Insurance ID", "medical_insurance_number"],
  },
  {
    field: "basicSalary",
    dbPath: "employees.basic_salary",
    required: false,
    aliases: ["Basic Salary", "basic_salary"],
  },
  {
    field: "baseSalary",
    dbPath: "employees.base_salary",
    required: false,
    aliases: ["Base Salary", "base_salary"],
  },
  {
    field: "netSalary",
    dbPath: "employees.net_salary",
    required: false,
    aliases: ["net_salary", "Net Salary", "Net"],
  },
  {
    field: "socialInsurance",
    dbPath: "employees.social_insurance",
    required: false,
    aliases: ["social_insurance", "Social Insurance"],
  },
  {
    field: "taxes",
    dbPath: "employees.taxes",
    required: false,
    aliases: ["taxes", "Tax", "Taxes"],
  },
  {
    field: "medicalInsurance",
    dbPath: "employees.medical_insurance",
    required: false,
    aliases: ["medical_insurance", "Medical Insurance"],
  },
  {
    field: "fuelAllowance",
    dbPath: "employees.fuel_allowance",
    required: false,
    aliases: ["fuel_allowance", "Fuel Allowance"],
  },
  {
    field: "extraCostOfLiving",
    dbPath: "employees.extra_cost_of_living",
    required: false,
    aliases: ["extra_cost_of_living", "Extra Cost Of Living"],
  },
  {
    field: "grossSalary",
    dbPath: "employees.gross_salary",
    required: false,
    aliases: ["gross_salary", "Gross Salary"],
  },
  {
    field: "paymentMode",
    dbPath: "employees.payment_mode",
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
    aliases: ["Position", "Position Title", "position"],
  },
  {
    field: "residenceAddress",
    dbPath: "employees.residence_address",
    required: false,
    aliases: ["Residence Address", "Home Address", "Address", "residence_address"],
  },
  {
    field: "residenceCity",
    dbPath: "employees.residence_city",
    required: false,
    aliases: ["Residence City", "Home City", "City", "residence_city"],
  },
  {
    field: "residenceArea",
    dbPath: "employees.residence_area",
    required: false,
    aliases: ["Residence Area", "Home Area", "District", "residence_area"],
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
