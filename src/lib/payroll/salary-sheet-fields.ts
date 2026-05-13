import { payrollPaymentModeLabel, type PayrollPaymentMode } from "@/lib/payroll/policy";
import type { SalaryRecord } from "@/lib/payroll/types";

export const payrollSheetHeaders = [
  "#",
  "Month",
  "Year",
  "HR_ID",
  "Full Name",
  "Arabic Name",
  "Job Title",
  "Line",
  "Area",
  "Hire Date",
  "Base Salary",
  "Gross Salary",
  "Net Salary",
  "Expenses",
  "Incentive",
  "Overtime",
  "Bonus",
  "Extra Cost of Living",
  "Fuel Allowance",
  "Other Additions",
  "Total Additions",
  "Social Insurance",
  "Employment Income Tax",
  "Governmental Deductions",
  "CRM",
  "Finger Print",
  "Unpaid Vacations",
  "Medical Insurance",
  "Loans",
  "Other Deductions",
  "Total Deductions",
  "Month Salary",
  "First Part",
  "Second Part",
  "Payment Group",
  "Policy Comment",
] as const;

export type PayrollSheetHeader = (typeof payrollSheetHeaders)[number];

export type PayrollSheetSection = {
  end: number;
  label: string;
  start: number;
  tone: "employee" | "fixed" | "additions" | "governmental" | "deductions" | "payment";
};

export const payrollSheetSections: PayrollSheetSection[] = [
  { end: 10, label: "Employee Data", start: 1, tone: "employee" },
  { end: 13, label: "Fixed Salary", start: 11, tone: "fixed" },
  { end: 21, label: "Additions", start: 14, tone: "additions" },
  { end: 24, label: "Governmental Deductions", start: 22, tone: "governmental" },
  { end: 31, label: "Internal Deductions", start: 25, tone: "deductions" },
  { end: 36, label: "Payment Split", start: 32, tone: "payment" },
];

export const payrollMoneyHeaders = new Set<PayrollSheetHeader>([
  "Base Salary",
  "Gross Salary",
  "Net Salary",
  "Expenses",
  "Incentive",
  "Overtime",
  "Bonus",
  "Extra Cost of Living",
  "Fuel Allowance",
  "Other Additions",
  "Total Additions",
  "Social Insurance",
  "Employment Income Tax",
  "Governmental Deductions",
  "CRM",
  "Finger Print",
  "Unpaid Vacations",
  "Medical Insurance",
  "Loans",
  "Other Deductions",
  "Total Deductions",
  "Month Salary",
  "First Part",
  "Second Part",
]);

export function payrollSheetSectionForIndex(index: number) {
  const columnNumber = index + 1;
  return payrollSheetSections.find(
    (section) => columnNumber >= section.start && columnNumber <= section.end,
  ) ?? payrollSheetSections[0];
}

function paymentModeLabel(value: string | null | undefined) {
  const normalized = value === "one_part" || value === "two_parts" ? value : "two_parts";
  return payrollPaymentModeLabel(normalized as PayrollPaymentMode);
}

export function payrollSheetValue(
  record: SalaryRecord,
  month: number,
  year: number,
  index: number,
  header: PayrollSheetHeader,
) {
  switch (header) {
    case "#":
      return index;
    case "Month":
      return month;
    case "Year":
      return year;
    case "HR_ID":
      return record.employeeCode || record.hrId;
    case "Full Name":
      return record.fullName;
    case "Arabic Name":
      return record.nameAr ?? "";
    case "Job Title":
      return record.jobTitle;
    case "Line":
      return record.line;
    case "Area":
      return record.area;
    case "Hire Date":
      return record.hireDate ?? "";
    case "Base Salary":
      return record.baseSalary;
    case "Gross Salary":
      return record.grossSalary;
    case "Net Salary":
      return record.netSalary;
    case "Expenses":
      return record.expenses;
    case "Incentive":
      return record.incentive;
    case "Overtime":
      return record.overtime;
    case "Bonus":
      return record.bonus;
    case "Extra Cost of Living":
      return record.extraCostOfLiving;
    case "Fuel Allowance":
      return record.fuelAllowance;
    case "Other Additions":
      return record.otherAdditions;
    case "Total Additions":
      return record.totalAdditions;
    case "Social Insurance":
      return record.socialInsurance;
    case "Employment Income Tax":
      return record.employmentIncomeTax;
    case "Governmental Deductions":
      return record.governmentalDeductions;
    case "CRM":
      return record.crm;
    case "Finger Print":
      return record.fingerPrint;
    case "Unpaid Vacations":
      return record.unpaidVacations;
    case "Medical Insurance":
      return record.medicalInsurance;
    case "Loans":
      return record.loans;
    case "Other Deductions":
      return record.otherDeductions;
    case "Total Deductions":
      return record.totalDeductions;
    case "Month Salary":
      return record.monthSalary;
    case "First Part":
      return record.firstPart;
    case "Second Part":
      return record.secondPart;
    case "Payment Group":
      return paymentModeLabel(record.paymentMode);
    case "Policy Comment":
      return record.payrollComment ?? "";
  }
}
