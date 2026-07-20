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
    subtitle: "Leavers this month, with the recommended settlement (≤25th prorated, >25th full). Edit or confirm.",
    contextColumns: [
      { key: "Last Working Date", label: "Last Working Date" },
      { key: "Branch", label: "Rule" },
      { key: "Days Worked", label: "Days Worked" },
    ],
    fields: [
      { key: "baseForMonth", label: "Base (month)", kind: "money" },
      { key: "ecolPaid", label: "Extra Cost of Living", kind: "money" },
      { key: "fuelPaid", label: "Fuel Allowance", kind: "money" },
    ],
    hasReason: false,
    isHoldStep: false,
  },
  p1_fingerprint: {
    key: "p1_fingerprint",
    phase: "part1",
    title: "Fingerprint deductions",
    subtitle: "Attendance/fingerprint deductions (days × Base/30). These reduce Part 1. Edit or confirm.",
    contextColumns: [],
    fields: [
      { key: "fingerprintDays", label: "Deduction Days", kind: "days" },
      { key: "fingerprintValue", label: "Deduction Value", kind: "money" },
    ],
    hasReason: false,
    isHoldStep: false,
  },
  p1_holds: {
    key: "p1_holds",
    phase: "part1",
    title: "Hold review",
    subtitle: "Toggle HOLD on any employee. Held employees stay on the sheet in red and are excluded from payout until released.",
    contextColumns: [],
    fields: [],
    hasReason: true,
    isHoldStep: true,
  },
  p2_expenses: {
    key: "p2_expenses",
    phase: "part2",
    title: "Outstation expenses",
    subtitle: "Approved outstation expenses to reimburse (added to pay, in Part 2). Edit or confirm.",
    contextColumns: [{ key: "Trips", label: "Trips" }],
    fields: [{ key: "expenses", label: "Expenses", kind: "money" }],
    hasReason: false,
    isHoldStep: false,
  },
  p2_vacation: {
    key: "p2_vacation",
    phase: "part2",
    title: "Vacation (no balance)",
    subtitle: "Phoenix + CRM leave beyond the employee's balance, deducted from salary (balance covers the rest). Edit or confirm.",
    contextColumns: [
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
    subtitle: "Field CRM no-activity days (days × Base/30). Office days with a fingerprint punch are already excluded. Edit or confirm.",
    contextColumns: [
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
    contextColumns: [],
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
    contextColumns: [],
    fields: [{ key: "manualOtherDeductions", label: "Value", kind: "money" }],
    hasReason: true,
    isHoldStep: false,
  },
  p2_holds: {
    key: "p2_holds",
    phase: "part2",
    title: "Hold review",
    subtitle: "Final hold review before Part 2 confirm. Held employees are excluded from payout until released.",
    contextColumns: [],
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
  "p1_holds",
  "p2_expenses",
  "p2_vacation",
  "p2_crm",
  "p2_additions",
  "p2_manual_deductions",
  "p2_holds",
];
