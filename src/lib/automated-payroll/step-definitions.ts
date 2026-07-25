import type { StepDefinition, StepKey } from "./types.ts";

/**
 * Declarative config for every wizard step. Drives the generic recommendation
 * grid (UI), the per-step xlsx template, and the re-upload parser — one source of
 * truth so the three always agree on columns. `field.key` and `contextColumns.key`
 * match the keys produced by recommend.ts (StepRow.values / StepRow.context).
 */

export const STEP_DEFINITIONS: Record<StepKey, StepDefinition> = {
  p1_new_hires: {
    key: "p1_new_hires",
    phase: "part1",
    title: "New hires",
    subtitle: "Employees hired this month, with the recommended prorated salary. Edit or confirm.",
    contextColumns: [
      { key: "Hire Date", label: "Hire Date" },
      { key: "Days Worked", label: "Days Worked" },
      { key: "Net (month)", label: "Net (month)" },
    ],
    fields: [
      { key: "baseForMonth", label: "Base (month)", kind: "money" },
      { key: "ecolPaid", label: "Extra Cost of Living", kind: "money" },
      { key: "fuelPaid", label: "Fuel Allowance", kind: "money" },
    ],
    hasReason: false,
    isHoldStep: false,
  },
  p1_resignations: {
    key: "p1_resignations",
    phase: "part1",
    title: "Resignations",
    subtitle: "Leavers this month, with the recommended settlement (≤25th prorated, >25th full) plus their CRM no-activity and unpaid-vacation deductions — settled here since they won't be present for Part 2. CRM Days auto-calculates its Value (Base/30 × days); Unpaid Vacation Days is read-only reference only — its Value combines a balance-aware Phoenix-vacation amount with a separate CRM-leave amount, not a flat day rate, so edit the Value directly instead. Deducted from their own Second Part first, then First Part if Second isn't enough. Edit or confirm.",
    contextColumns: [
      { key: "Hire Date", label: "Hire Date" },
      { key: "Last Working Date", label: "Last Working Date" },
      { key: "Branch", label: "Rule" },
      { key: "Days Worked", label: "Days Worked" },
      { key: "Net Salary", label: "Net Salary" },
      { key: "Unpaid Vacation Days", label: "Unpaid Vacation Days" },
    ],
    fields: [
      { key: "baseForMonth", label: "Base (month)", kind: "money" },
      { key: "ecolPaid", label: "Extra Cost of Living", kind: "money" },
      { key: "fuelPaid", label: "Fuel Allowance", kind: "money" },
      { key: "resignationCrmDays", label: "CRM No-Activity Days", kind: "days", autoCalcMoneyKey: "crm" },
      { key: "crm", label: "CRM Deduction", kind: "money" },
      { key: "unpaidVacations", label: "Vacation Deduction", kind: "money" },
    ],
    hasReason: false,
    isHoldStep: false,
  },
  p1_fingerprint: {
    key: "p1_fingerprint",
    phase: "part1",
    title: "Fingerprint deductions",
    subtitle: "Attendance/fingerprint deductions (days × Base/30). These reduce Part 1. Edit or confirm.",
    contextColumns: [{ key: "Hire Date", label: "Hire Date" }],
    fields: [
      { key: "fingerprintDays", label: "Deduction Days", kind: "days" },
      { key: "fingerprintValue", label: "Deduction Value", kind: "money" },
    ],
    hasReason: false,
    isHoldStep: false,
  },
  p1_crm: {
    key: "p1_crm",
    phase: "part1",
    title: "CRM Deduction",
    subtitle:
      "CRM no-activity deduction for Part 1 — shown only for this month's resignations and one-part-salary employees (continuing two-part employees get this automatically via the Part 2 CRM step instead, so entering it here too would double it). Type days to auto-calculate the value (Base/30 × days), or leave days blank and type the value directly. Reason is optional.",
    contextColumns: [
      { key: "Hire Date", label: "Hire Date" },
      { key: "Net Salary", label: "Net Salary" },
      { key: "Resignation Date", label: "Resignation Date" },
      { key: "Settled in Resignations", label: "Settled in Resignations" },
    ],
    fields: [
      { key: "p1odCrmDays", label: "CRM Days", kind: "days", autoCalcMoneyKey: "p1odCrmValue" },
      { key: "p1odCrmValue", label: "CRM Value", kind: "money" },
      { key: "p1odCrmReason", label: "CRM Reason", kind: "text" },
    ],
    hasReason: false,
    isHoldStep: false,
    conflictContextKey: "Settled in Resignations",
  },
  p1_unpaid_vacation: {
    key: "p1_unpaid_vacation",
    phase: "part1",
    title: "Unpaid Vacation",
    subtitle:
      "Unpaid-vacation deduction for Part 1 — shown only for this month's resignations and one-part-salary employees (continuing two-part employees get this automatically via the Part 2 Vacation step instead, so entering it here too would double it). Type days to auto-calculate the value (Base/30 × days), or leave days blank and type the value directly. Reason is optional.",
    contextColumns: [
      { key: "Hire Date", label: "Hire Date" },
      { key: "Net Salary", label: "Net Salary" },
      { key: "Resignation Date", label: "Resignation Date" },
      { key: "Settled in Resignations", label: "Settled in Resignations" },
    ],
    fields: [
      { key: "p1odVacationDays", label: "Unpaid Vacation Days", kind: "days", autoCalcMoneyKey: "p1odVacationValue" },
      { key: "p1odVacationValue", label: "Unpaid Vacation Value", kind: "money" },
      { key: "p1odVacationReason", label: "Unpaid Vacation Reason", kind: "text" },
    ],
    hasReason: false,
    isHoldStep: false,
    conflictContextKey: "Settled in Resignations",
  },
  p1_no_record: {
    key: "p1_no_record",
    phase: "part1",
    title: "Day Without Record",
    subtitle:
      "Day-without-attendance-record deduction for Part 1 — shown only for this month's resignations and one-part-salary employees. Type days to auto-calculate the value (Base/30 × days), or leave days blank and type the value directly. Reason is optional.",
    contextColumns: [
      { key: "Hire Date", label: "Hire Date" },
      { key: "Net Salary", label: "Net Salary" },
      { key: "Resignation Date", label: "Resignation Date" },
    ],
    fields: [
      { key: "p1odNoRecordDays", label: "Day Without Record Days", kind: "days", autoCalcMoneyKey: "p1odNoRecordValue" },
      { key: "p1odNoRecordValue", label: "Day Without Record Value", kind: "money" },
      { key: "p1odNoRecordReason", label: "Day Without Record Reason", kind: "text" },
    ],
    hasReason: false,
    isHoldStep: false,
  },
  p1_other_deductions: {
    key: "p1_other_deductions",
    phase: "part1",
    title: "Other Deductions (Loan & Other)",
    subtitle:
      "Loan repayment or any other manual deduction for Part 1 — shown only for this month's resignations and one-part-salary employees. Type days to auto-calculate the value (Base/30 × days), or leave days blank and type the value directly. Reason is optional.",
    contextColumns: [
      { key: "Hire Date", label: "Hire Date" },
      { key: "Net Salary", label: "Net Salary" },
      { key: "Resignation Date", label: "Resignation Date" },
    ],
    fields: [
      { key: "p1odLoanDays", label: "Loan Days", kind: "days", autoCalcMoneyKey: "p1odLoanValue" },
      { key: "p1odLoanValue", label: "Loan Value", kind: "money" },
      { key: "p1odLoanReason", label: "Loan Reason", kind: "text" },
      { key: "p1odOtherDays", label: "Other Days", kind: "days", autoCalcMoneyKey: "p1odOtherValue" },
      { key: "p1odOtherValue", label: "Other Value", kind: "money" },
      { key: "p1odOtherReason", label: "Other Reason", kind: "text" },
    ],
    hasReason: false,
    isHoldStep: false,
  },
  p1_special_situations: {
    key: "p1_special_situations",
    phase: "part1",
    title: "Special Situations",
    subtitle:
      "Every employee, regardless of payment mode — for cases that fall outside the normal rules. Enter a deduction and/or addition (days auto-calculate the value at Base/30 × days, or type the value directly), then choose which installment it applies to. That choice applies to BOTH the deduction and the addition for this employee. Only available while Part 1 is still open — like every Part 1 step, this tab locks once Part 1 is confirmed.",
    contextColumns: [
      { key: "Hire Date", label: "Hire Date" },
      { key: "Net Salary", label: "Net Salary" },
      { key: "Resignation Date", label: "Resignation Date" },
    ],
    fields: [
      {
        key: "specialDeductionDays",
        label: "Deduction Days",
        kind: "days",
        autoCalcMoneyKey: "specialDeductionValue",
      },
      { key: "specialDeductionValue", label: "Deduction Value", kind: "money" },
      {
        key: "specialAdditionDays",
        label: "Addition Days",
        kind: "days",
        autoCalcMoneyKey: "specialAdditionValue",
      },
      { key: "specialAdditionValue", label: "Addition Value", kind: "money" },
      {
        key: "specialSituationPart",
        label: "Apply To",
        kind: "select",
        options: [
          { value: "first", label: "First Part" },
          { value: "second", label: "Second Part" },
        ],
      },
    ],
    hasReason: false,
    isHoldStep: false,
  },
  p1_holds: {
    key: "p1_holds",
    phase: "part1",
    title: "Hold review",
    subtitle: "Toggle HOLD on any employee. Held employees stay on the sheet in red and are excluded from payout until released.",
    contextColumns: [{ key: "Hire Date", label: "Hire Date" }],
    fields: [],
    hasReason: true,
    isHoldStep: true,
  },
  p2_expenses: {
    key: "p2_expenses",
    phase: "part2",
    title: "Outstation expenses",
    subtitle: "Approved outstation expenses to reimburse (added to pay, in Part 2). Edit or confirm.",
    contextColumns: [{ key: "Hire Date", label: "Hire Date" }, { key: "Trips", label: "Trips" }],
    fields: [{ key: "expenses", label: "Expenses", kind: "money" }],
    hasReason: false,
    isHoldStep: false,
  },
  p2_vacation: {
    key: "p2_vacation",
    phase: "part2",
    title: "Vacation (no balance)",
    subtitle: "Phoenix + CRM leave beyond the employee's balance, deducted from salary (balance covers the rest). Continuing two-part employees only — resignations and one-part-salary employees are settled in Part 1 instead. Edit or confirm.",
    contextColumns: [
      { key: "Hire Date", label: "Hire Date" },
      { key: "Unpaid Days (Phoenix)", label: "Unpaid Days (Phoenix)" },
      { key: "CRM Leave Days", label: "CRM Leave Days" },
      { key: "CRM Unpaid (no balance)", label: "CRM Unpaid (no balance)" },
    ],
    fields: [{ key: "unpaidVacations", label: "Deduction Value", kind: "money" }],
    hasReason: false,
    isHoldStep: false,
  },
  p2_crm: {
    key: "p2_crm",
    phase: "part2",
    title: "CRM (no activity)",
    subtitle: "Field CRM no-activity days (days × Base/30). Office days with a fingerprint punch are already excluded. Continuing two-part employees only — resignations and one-part-salary employees are settled in Part 1 instead. Edit or confirm.",
    contextColumns: [
      { key: "Hire Date", label: "Hire Date" },
      { key: "No-Activity Days", label: "No-Activity Days" },
      { key: "Office (punched)", label: "Office (punched)" },
    ],
    fields: [{ key: "crm", label: "Deduction Value", kind: "money" }],
    hasReason: false,
    isHoldStep: false,
  },
  p2_additions: {
    key: "p2_additions",
    phase: "part2",
    title: "Additions",
    subtitle: "Incentive, bonus, and overtime per employee (paid in Part 2). Enter or confirm.",
    contextColumns: [{ key: "Hire Date", label: "Hire Date" }],
    fields: [
      { key: "incentive", label: "Incentive", kind: "money" },
      { key: "bonus", label: "Bonus", kind: "money" },
      { key: "overtime", label: "Overtime", kind: "money" },
    ],
    hasReason: false,
    isHoldStep: false,
  },
  p2_manual_deductions: {
    key: "p2_manual_deductions",
    phase: "part2",
    title: "Any more deductions?",
    subtitle: "Add any other deduction per employee, with a reason. Leave 0 for none.",
    contextColumns: [{ key: "Hire Date", label: "Hire Date" }],
    fields: [{ key: "manualOtherDeductions", label: "Value", kind: "money" }],
    hasReason: true,
    isHoldStep: false,
  },
  p2_holds: {
    key: "p2_holds",
    phase: "part2",
    title: "Hold review",
    subtitle: "Final hold review before Part 2 confirm. Held employees are excluded from payout until released.",
    contextColumns: [{ key: "Hire Date", label: "Hire Date" }],
    fields: [],
    hasReason: true,
    isHoldStep: true,
  },
};

export function stepDefinition(stepKey: StepKey): StepDefinition {
  return STEP_DEFINITIONS[stepKey];
}

export const STEP_ORDER: StepKey[] = [
  "p1_new_hires",
  "p1_resignations",
  "p1_fingerprint",
  "p1_crm",
  "p1_unpaid_vacation",
  "p1_no_record",
  "p1_other_deductions",
  "p1_special_situations",
  "p1_holds",
  "p2_expenses",
  "p2_vacation",
  "p2_crm",
  "p2_additions",
  "p2_manual_deductions",
  "p2_holds",
];
