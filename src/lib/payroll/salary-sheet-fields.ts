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
  "Working Days",
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

/**
 * Positional bands over `payrollSheetHeaders` — `start`/`end` are 1-based COLUMN
 * numbers, so inserting a header shifts every band after it. "Working Days" was
 * added at column 11 on 2026-09-04; the counts below (11/3/8/3/7/5 = 37) are
 * pinned by tests/payroll-sheet-sections.test.ts so a future insert cannot
 * silently leave a band pointing at the wrong columns.
 */
export const payrollSheetSections: PayrollSheetSection[] = [
  { end: 11, label: "Employee Data", start: 1, tone: "employee" },
  { end: 14, label: "Fixed Salary", start: 12, tone: "fixed" },
  { end: 22, label: "Additions", start: 15, tone: "additions" },
  { end: 25, label: "Governmental Deductions", start: 23, tone: "governmental" },
  { end: 32, label: "Internal Deductions", start: 26, tone: "deductions" },
  { end: 37, label: "Payment Split", start: 33, tone: "payment" },
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

/**
 * Columns holding a plain COUNT rather than money. They are right-aligned like
 * money so a numeric column never sits ragged in a wall of figures, but they are
 * deliberately NOT in `payrollMoneyHeaders`: that set drives the currency format
 * and the TOTALS row, and a sum of day counts across the company is meaningless.
 */
export const payrollCountHeaders = new Set<PayrollSheetHeader>(["Working Days"]);

/** True when the column should be right-aligned — money, or a plain count. */
export function isPayrollNumericHeader(header: PayrollSheetHeader) {
  return payrollMoneyHeaders.has(header) || payrollCountHeaders.has(header);
}

/**
 * The Working Days column as a person reads it: "26 of 31".
 *
 * The denominator is what makes the numerator mean anything — 26 days is a full
 * month in February and five days short in March — and a payslip has room for
 * both where a spreadsheet column does not. Returns EMPTY, never "0", for a row
 * written before the column existed: such a row genuinely does not know, and a
 * zero there would read as "worked no days".
 */
export function formatWorkingDays(
  record: Pick<SalaryRecord, "calendarDays" | "workingDays">,
) {
  if (!record.workingDays) return "";
  if (!record.calendarDays) return String(record.workingDays);
  return `${record.workingDays} of ${record.calendarDays}`;
}

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
    // Owner rule 2026-09-04: the salary columns show the FULL contract, and this
    // column is what explains a joiner/leaver being PAID less than it. The money
    // itself lives in Month Salary / First Part / Second Part and is unchanged.
    case "Working Days":
      return record.workingDays;
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
