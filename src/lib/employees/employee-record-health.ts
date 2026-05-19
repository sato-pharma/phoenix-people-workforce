import type { EmployeeDirectoryRow } from "./employee-directory";

type MissingFieldRule = {
  isMissing: (employee: EmployeeDirectoryRow) => boolean;
  label: string;
};

function isBlank(value: unknown) {
  return value === null || value === undefined || String(value).trim() === "";
}

const missingFieldRules: MissingFieldRule[] = [
  { label: "Employee ID", isMissing: (employee) => isBlank(employee.hrId) },
  { label: "Full Name", isMissing: (employee) => isBlank(employee.fullName) },
  { label: "Arabic Name", isMissing: (employee) => isBlank(employee.nameAr) },
  { label: "National ID", isMissing: (employee) => isBlank(employee.nationalId) },
  { label: "Gender", isMissing: (employee) => isBlank(employee.gender) },
  { label: "Birth Date", isMissing: (employee) => isBlank(employee.birthDate) },
  { label: "Education", isMissing: (employee) => isBlank(employee.education) },
  { label: "Hire Date", isMissing: (employee) => isBlank(employee.hireDate) },
  { label: "Contract Type", isMissing: (employee) => isBlank(employee.contractType) },
  {
    label: "Job Position",
    isMissing: (employee) => isBlank(employee.positionTitle) && isBlank(employee.jobTitle),
  },
  {
    label: "Department",
    isMissing: (employee) => isBlank(employee.departmentId) && isBlank(employee.departmentName),
  },
  {
    label: "Business Line",
    isMissing: (employee) => isBlank(employee.lineId) && isBlank(employee.lineName),
  },
  {
    label: "Operating Area",
    isMissing: (employee) => isBlank(employee.areaId) && isBlank(employee.areaName),
  },
  {
    label: "Team",
    isMissing: (employee) => isBlank(employee.teamId) && isBlank(employee.teamName),
  },
  { label: "Direct Manager", isMissing: (employee) => isBlank(employee.managerHrId) },
  { label: "Region", isMissing: (employee) => isBlank(employee.regionName) },
  { label: "Work Email", isMissing: (employee) => isBlank(employee.workEmail) },
  { label: "Mobile Number", isMissing: (employee) => isBlank(employee.mobileNumber) },
  { label: "CRM Username", isMissing: (employee) => isBlank(employee.crmUsername) },
  { label: "CRM System ID", isMissing: (employee) => isBlank(employee.crmId) },
  { label: "Residence Address", isMissing: (employee) => isBlank(employee.residenceAddress) },
  { label: "Residence City", isMissing: (employee) => isBlank(employee.residenceCity) },
  { label: "Residence Area", isMissing: (employee) => isBlank(employee.residenceArea) },
  { label: "Basic Salary", isMissing: (employee) => isBlank(employee.basicSalary) },
  { label: "Base Salary", isMissing: (employee) => isBlank(employee.baseSalary) },
  { label: "Gross Salary", isMissing: (employee) => isBlank(employee.grossSalary) },
  { label: "Net Salary", isMissing: (employee) => isBlank(employee.netSalary) },
  { label: "Fuel Allowance", isMissing: (employee) => isBlank(employee.fuelAllowance) },
  {
    label: "Extra Cost of Living",
    isMissing: (employee) => isBlank(employee.extraCostOfLiving),
  },
  { label: "Medical Insurance", isMissing: (employee) => isBlank(employee.medicalInsurance) },
  { label: "Social Insurance", isMissing: (employee) => isBlank(employee.socialInsurance) },
  { label: "Taxes", isMissing: (employee) => isBlank(employee.taxes) },
  {
    label: "Bank Account Status",
    isMissing: (employee) => employee.hasBankAccount !== "yes" && employee.hasBankAccount !== "no",
  },
  {
    label: "Bank Name",
    isMissing: (employee) => employee.hasBankAccount === "yes" && isBlank(employee.bankName),
  },
  {
    label: "Bank Account",
    isMissing: (employee) => employee.hasBankAccount === "yes" && isBlank(employee.bankAccount),
  },
  {
    label: "Medical Insurance Status",
    isMissing: (employee) =>
      !["yes", "no", "pending"].includes(String(employee.medicalInsuranceStatus ?? "")),
  },
  {
    label: "Medical Insurance Number",
    isMissing: (employee) =>
      employee.medicalInsuranceStatus === "yes" && isBlank(employee.medicalInsuranceNumber),
  },
  {
    label: "Social Insurance Status",
    isMissing: (employee) =>
      !["yes", "no", "pending"].includes(String(employee.socialInsuranceStatus ?? "")),
  },
  {
    label: "Social Insurance Number",
    isMissing: (employee) =>
      employee.socialInsuranceStatus === "yes" && isBlank(employee.socialInsuranceNumber),
  },
  {
    label: "Salary Payout Mode",
    isMissing: (employee) => !["one_part", "two_parts"].includes(String(employee.salaryPaymentMode ?? "")),
  },
  {
    label: "Payroll Eligibility",
    isMissing: (employee) => typeof employee.payrollEligible !== "boolean",
  },
  {
    label: "Organogram Visibility",
    isMissing: (employee) => typeof employee.organogramVisible !== "boolean",
  },
];

export function getMissingEmployeeRecordFields(employee: EmployeeDirectoryRow) {
  return missingFieldRules
    .filter((rule) => rule.isMissing(employee))
    .map((rule) => rule.label);
}

export function hasMissingEmployeeRecordData(employee: EmployeeDirectoryRow) {
  return getMissingEmployeeRecordFields(employee).length > 0;
}

export function missingEmployeeRecordSummary(employee: EmployeeDirectoryRow, limit = 3) {
  const fields = getMissingEmployeeRecordFields(employee);

  if (fields.length === 0) {
    return "Complete";
  }

  const visibleFields = fields.slice(0, limit).join(", ");
  const remaining = fields.length - limit;

  return remaining > 0 ? `${visibleFields} +${remaining} more` : visibleFields;
}
