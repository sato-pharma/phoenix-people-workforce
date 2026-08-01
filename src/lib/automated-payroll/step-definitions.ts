import { PAYROLL_CYCLE_ANCHOR_DAY, resolveCycleWindow } from "@/lib/payroll/copilot/cycle-window.ts";

import type { PayrollPeriod, StepDefinition, StepKey } from "./types.ts";

/**
 * Declarative config for every wizard step. Drives the generic recommendation
 * grid (UI), the per-step xlsx template, and the re-upload parser — one source of
 * truth so the three always agree on columns. `field.key` and `contextColumns.key`
 * match the keys produced by recommend.ts (StepRow.values / StepRow.context).
 *
 * Imported by the CLIENT grid, so everything reachable from here must stay
 * client-safe. cycle-window.ts qualifies (pure UTC calendar arithmetic, no
 * imports at all) — do NOT reach for notify.ts's monthLabel here, it pulls in
 * getSupabaseAdmin.
 */

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** "August 2026". Shared with recommend.ts so the month spelling has one home. */
export function monthNameAndYear(month: number, year: number): string {
  return `${MONTH_NAMES[Math.max(0, Math.min(11, month - 1))]} ${year}`;
}

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
    subtitle: "Leavers this month, with the recommended Base/ECoL/Fuel settlement (≤25th prorated, >25th full). CRM no-activity and Unpaid Vacation deductions moved to their own dedicated tabs (owner request 2026-07-25) — edit them there; they still net against this leaver's own Second Part first, then First Part if Second isn't enough. Edit or confirm.",
    contextColumns: [
      { key: "Hire Date", label: "Hire Date" },
      { key: "Last Working Date", label: "Last Working Date" },
      { key: "Net Salary", label: "Net Salary" },
    ],
    fields: [
      // Days Worked is EDITABLE (owner 2026-07-25): the system can only count
      // CALENDAR days from the 1st to the last working date, which is routinely
      // wrong — a leaver hired and resigned the same day showed 7, someone who
      // actually worked 4.5 days showed 12. HR types the true figure and Base
      // (month) recalculates as Base / calendar-days-in-month × days, matching
      // the locked proration formula exactly (verified: 14000/31×9 = 4064.52).
      {
        key: "daysWorked",
        label: "Days Worked",
        kind: "days",
        autoCalcMoneyKey: "baseForMonth",
        autoCalcDivisorContextKey: "Days In Month",
      },
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
      "CRM no-activity deduction for Part 1 — shown only for this month's one-part-salary employees (continuing two-part employees get this automatically via the Part 2 CRM step instead, so entering it here too would double it; this month's resignations have their own dedicated Resignations CRM tab). Working Days and Non-Working Days always sum to the month's calendar days (owner request 2026-07-25) — edit either one and the other adjusts automatically; the deduction is always calculated from Non-Working Days at Base/30 × days. Reason is optional.",
    contextColumns: [
      { key: "Hire Date", label: "Hire Date" },
      { key: "Net Salary", label: "Net Salary" },
      { key: "Resignation Date", label: "Resignation Date" },
    ],
    fields: [
      // Working Days is purely derived/display — it has no DraftRow column of
      // its own and is never persisted. Editing it just recomputes Non-Working
      // Days (below) as the complement, which IS the persisted, money-driving
      // field. See StepFieldSpec.complementFieldKey.
      {
        key: "p1odCrmWorkingDays",
        label: "Working Days",
        kind: "days",
        complementFieldKey: "p1odCrmDays",
        complementTotalContextKey: "Days In Month",
      },
      {
        key: "p1odCrmDays",
        label: "Non-Working Days",
        kind: "days",
        // Money divisor stays the DEFAULT 30 (matches calculateDeductionAmountFromBaseSalary
        // server-side) — never autoCalcDivisorContextKey here, see that field's own doc.
        autoCalcMoneyKey: "p1odCrmValue",
        complementFieldKey: "p1odCrmWorkingDays",
        complementTotalContextKey: "Days In Month",
      },
      { key: "p1odCrmValue", label: "CRM Value", kind: "money" },
      { key: "p1odCrmReason", label: "CRM Reason", kind: "text" },
    ],
    hasReason: false,
    isHoldStep: false,
  },
  p1_resignation_crm: {
    key: "p1_resignation_crm",
    phase: "part1",
    title: "Resignations CRM",
    subtitle:
      "CRM no-activity deduction for this month's RESIGNATIONS only — dedicated to leavers so its rules never collide with the normal CRM tab (owner request 2026-07-26). Everything here uses the SAME daily rate as the resignation settlement: Base ÷ the month's ACTUAL calendar days (e.g. 14,000 ÷ 31 = 451.61 in July), NOT ÷30. Working Days + Non-Working Days always sum to the employee's DAYS WORKED this month (his employment span — 9 for someone who left on the 9th), never the whole month, so he can never be deducted for days after he left. Edit either day field and the other adjusts; the deduction is Base ÷ month-days × Non-Working Days. Value/days are pre-filled from his real CRM activity in the days he actually worked. Reason is optional.",
    contextColumns: [
      { key: "Hire Date", label: "Hire Date" },
      { key: "Net Salary", label: "Net Salary" },
      { key: "Resignation Date", label: "Resignation Date" },
      { key: "Days Worked", label: "Days Worked" },
    ],
    fields: [
      // Working Days is derived/display only (no DraftRow column). Editing it
      // recomputes Non-Working Days as the complement — capped at DAYS WORKED
      // (the employment span), NOT the month, so a leaver can never show more
      // non-working days than days he was actually employed.
      {
        key: "resigCrmWorkingDays",
        label: "Working Days",
        kind: "days",
        complementFieldKey: "resignationCrmDays",
        complementTotalContextKey: "Days Worked",
      },
      {
        key: "resignationCrmDays",
        label: "Non-Working Days",
        kind: "days",
        // Deduction divisor is the month's ACTUAL calendar days (unified with the
        // resignation settlement rate) — NOT the default /30. This is a DIFFERENT
        // context key from complementTotalContextKey ("Days Worked", the cap):
        // the cap bounds the day count, the divisor sets the money per day. The
        // key IS the DraftRow column, so the generic persist-loop writes it —
        // no run-service remap needed. See StepFieldSpec doc comments.
        autoCalcMoneyKey: "crm",
        autoCalcDivisorContextKey: "Days In Month",
        complementFieldKey: "resigCrmWorkingDays",
        complementTotalContextKey: "Days Worked",
      },
      { key: "crm", label: "CRM Value", kind: "money" },
      { key: "resigCrmReason", label: "CRM Reason", kind: "text" },
    ],
    hasReason: false,
    isHoldStep: false,
  },
  p1_unpaid_vacation: {
    key: "p1_unpaid_vacation",
    phase: "part1",
    title: "Unpaid Vacation",
    subtitle:
      "Unpaid-vacation deduction for Part 1 — shown only for this month's resignations and one-part-salary employees (continuing two-part employees get this automatically via the Part 2 Vacation step instead, so entering it here too would double it). For a resigning leaver, Value is pre-filled with their real settlement (owner request 2026-07-25 — moved here from the Resignations step) and still nets against their own Second Part first; \"Unpaid Vacation Days\" is read-only reference only — it combines a balance-aware Phoenix-vacation amount with a separate CRM-leave amount, not a flat day rate, so edit the Value directly instead of typing days for a leaver. For everyone else, type days to auto-calculate the value (Base/30 × days), or type the value directly. Reason is optional.",
    contextColumns: [
      { key: "Hire Date", label: "Hire Date" },
      { key: "Net Salary", label: "Net Salary" },
      { key: "Resignation Date", label: "Resignation Date" },
      { key: "Unpaid Vacation Days", label: "Unpaid Vacation Days" },
    ],
    fields: [
      { key: "p1odVacationDays", label: "Unpaid Vacation Days", kind: "days", autoCalcMoneyKey: "p1odVacationValue" },
      { key: "p1odVacationValue", label: "Unpaid Vacation Value", kind: "money" },
      { key: "p1odVacationReason", label: "Unpaid Vacation Reason", kind: "text" },
    ],
    hasReason: false,
    isHoldStep: false,
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
    subtitle:
      "Outstation expenses to reimburse (added to pay, in Part 2). Expand any employee to see each trip — dates, route, distance and the cost split that makes up their total. Rows still awaiting HR approval in the Expense Command Center are INCLUDED here, because this wizard is the approval point; the trip's \"HR Approved\" line tells you which ones. Edit or confirm.",
    contextColumns: [
      { key: "Hire Date", label: "Hire Date" },
      { key: "Trips", label: "Trips" },
      { key: "Trip Dates", label: "Trip Dates" },
    ],
    fields: [{ key: "expenses", label: "Expenses", kind: "money" }],
    hasReason: false,
    isHoldStep: false,
    detailNoun: "trip",
    detailColumns: [
      { key: "Dates", label: "Dates" },
      { key: "From", label: "From" },
      { key: "To", label: "To" },
      { key: "Trip Type", label: "Trip Type" },
      { key: "Transport", label: "Transport" },
      { key: "KM", label: "KM" },
      { key: "Travel", label: "Travel", money: true },
      { key: "Meeting", label: "Meeting", money: true },
      { key: "Allowance", label: "Allowance", money: true },
      { key: "Other", label: "Other", money: true },
      { key: "Total", label: "Total", money: true },
      { key: "HR Approved", label: "HR Approved" },
      { key: "Description", label: "Description" },
      { key: "Trip ID", label: "Trip ID" },
    ],
  },
  p2_vacation: {
    key: "p2_vacation",
    phase: "part2",
    title: "Vacation (no balance)",
    subtitle:
      "Leave beyond the employee's balance, deducted from salary. ONLY employees who actually owe something are listed — anyone whose leave their balance fully covered is left off, though their balance is still debited when you confirm. Highest deduction first. Continuing two-part employees only; resignations and one-part-salary employees are settled in Part 1 instead. Expand a row to see each leave day, which source it came from, and how much of it the balance absorbed. Edit or confirm.",
    contextColumns: [
      { key: "Hire Date", label: "Hire Date" },
      { key: "Unpaid Days (Phoenix)", label: "Unpaid Days (Phoenix)" },
      { key: "CRM Leave Days", label: "CRM Leave Days" },
      { key: "Balance Days Used", label: "Balance Days Used" },
      { key: "CRM Unpaid (no balance)", label: "CRM Unpaid (no balance)" },
    ],
    fields: [{ key: "unpaidVacations", label: "Deduction Value", kind: "money" }],
    hasReason: false,
    isHoldStep: false,
    detailNoun: "leave entry",
    detailNounPlural: "leave entries",
    // The two sources follow DIFFERENT rules, which is exactly why the breakdown
    // is worth showing: a Phoenix request already carries payment_status=unpaid,
    // so it deducts in full regardless of balance, while CRM-recorded leave is
    // balance-first and only the days beyond the balance cost money. The "Basis"
    // column states which rule produced each line so the two never look
    // inconsistent with each other.
    detailColumns: [
      { key: "Source", label: "Source" },
      { key: "Dates", label: "Dates" },
      { key: "Type", label: "Type" },
      { key: "Days", label: "Days" },
      { key: "Covered by Balance", label: "Covered by Balance" },
      { key: "Deducted Days", label: "Deducted Days" },
      { key: "Deduction", label: "Deduction", money: true },
      { key: "Basis", label: "Basis" },
    ],
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
      { key: "Explained", label: "Explained" },
    ],
    fields: [{ key: "crm", label: "Deduction Value", kind: "money" }],
    hasReason: false,
    isHoldStep: false,
    detailNoun: "day",
    // Lists the office-punch days too, not only the deducted ones — "3 days were
    // excluded" is unverifiable without seeing WHICH three. Employee Note / HR
    // Resolution come from the No Activity Days clarification workspace: an
    // employee may already have explained the day, and HR should not deduct it
    // blind (92 clarifications were filed for July 2026 with none decided).
    detailColumns: [
      { key: "Date", label: "Date" },
      { key: "Weekday", label: "Weekday" },
      { key: "Outcome", label: "Outcome" },
      { key: "Deduction", label: "Deduction", money: true },
      { key: "Employee Note", label: "Employee Note" },
      { key: "HR Resolution", label: "HR Resolution" },
    ],
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

/**
 * The real date range a step draws from, resolved for one run.
 *
 * The three Part-2 feeder steps sit next to each other and look like they cover
 * the same dates. They do not, and none of them said so:
 *  - expenses — a FINANCE TAG (payout_month/payout_year), not a date range at
 *    all. Verified in production 2026-08-01: rows tagged payout_month=7 carry
 *    expense_date in June, so the July sheet reimburses June trips.
 *  - vacation — the plain calendar month.
 *  - CRM      — the day-24 payroll cycle (24th of the previous month → 23rd of
 *    this one), so a late-June absence is deducted on the July sheet.
 *
 * Returns null for steps with no meaningful window (manual entry, holds).
 * Pure — safe to call from the client grid; unit-tested directly.
 */
export function stepWindowLabel(stepKey: StepKey, period: PayrollPeriod): string | null {
  const monthText = monthNameAndYear(period.month, period.year);
  if (stepKey === "p2_expenses") {
    return `Trips finance tagged for the ${monthText} payout. The trip dates themselves are often earlier — expand a row to see them.`;
  }
  if (stepKey === "p2_vacation") {
    const lastDay = new Date(Date.UTC(period.year, period.month, 0)).getUTCDate();
    const mm = String(period.month).padStart(2, "0");
    return `Leave dated ${period.year}-${mm}-01 to ${period.year}-${mm}-${String(lastDay).padStart(2, "0")} (the calendar month).`;
  }
  if (stepKey === "p2_crm") {
    const cycle = resolveCycleWindow(`${period.year}-${String(period.month).padStart(2, "0")}-01`);
    return `The day-${PAYROLL_CYCLE_ANCHOR_DAY} payroll cycle: ${cycle.startIso} to ${cycle.endIso} — not the calendar month.`;
  }
  return null;
}

export const STEP_ORDER: StepKey[] = [
  "p1_new_hires",
  "p1_resignations",
  "p1_fingerprint",
  "p1_crm",
  "p1_resignation_crm",
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
