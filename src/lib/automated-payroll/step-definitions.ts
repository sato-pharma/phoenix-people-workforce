import type { PayrollPeriod, StepDefinition, StepDetailColumn, StepFieldSpec, StepKey } from "./types.ts";

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

/**
 * The shared breakdown behind any figure sourced from the Deductions module
 * (owner request 2026-08-03). One shape for every deduction step, because they
 * all now explain themselves the same way: which approved candidate, which days,
 * how much, and what state the reviewer left it in. Declared once so a step's
 * panel and its xlsx Detail sheet can never drift apart.
 */
export const DEDUCTION_DETAIL_COLUMNS: StepDetailColumn[] = [
  { key: "Category", label: "Category" },
  { key: "Dates", label: "Dates" },
  { key: "Days", label: "Days" },
  { key: "Amount", label: "Amount", money: true },
  { key: "Status", label: "Status" },
  { key: "Reason", label: "Reason" },
];

/**
 * The value behind a step's `fieldsTotal` column: the sum of the named editable
 * fields, rounded to cents.
 *
 * Lives here, beside the declaration it reads, so the grid card and the xlsx
 * template can never disagree about what the total is — the same reason
 * `contextColumns` and `fields` are declared once for all three consumers.
 * A field with no value counts as 0, matching how the grid renders an empty
 * money box. Returns 0 when the step declares no total.
 */
export function stepFieldsTotal(
  definition: StepDefinition,
  values: Record<string, number> | undefined,
): number {
  const spec = definition.fieldsTotal;
  if (!spec) return 0;
  let sum = 0;
  for (const key of spec.fieldKeys) sum += values?.[key] ?? 0;
  // Cents, not raw float: three prorated amounts summed straight would print
  // 4645.159999999999 on a payroll screen.
  return Math.round(sum * 100) / 100;
}

/**
 * What a day count is worth, for each money field a "days" field drives.
 *
 * ONE definition, used by the grid while HR types and by the xlsx re-upload on the server, so a
 * correction made in the sheet moves the same money by the same amount as the same correction made
 * on screen (audit finding 32: the sheet used to move the days and leave the money behind).
 *
 *   amount  — the context column `autoCalcAmountContextKey` names, default "Base Salary".
 *   divisor — THE MONTH'S OWN CALENDAR DAYS (`monthDays`), or the context column
 *             `autoCalcDivisorContextKey` names when the step supplies one. Both are the same
 *             number now — see below.
 *
 * ONE DIVISOR FOR PAY AND FOR DEDUCTIONS (owner ruling 2026-09-12, audit finding 37). Until that
 * ruling eleven of the thirteen day-driven money fields divided by a flat 30 while joiner/leaver
 * pay divided by the month's real length, so a day was worth one amount when it was PAID and a
 * different amount when it was TAKEN AWAY. In a 31-day month the flat 30 deducted MORE than the day
 * it cancelled; in February it deducted less. Wrong in both directions, and invisible on a payslip
 * — and in a 30-day month the two divisors agree exactly, so a spot check never catches it.
 * Effective from September 2026 forward: August 2026 was published and announced, and a published
 * month is never re-opened.
 *
 * `monthDays` is REQUIRED, deliberately. It replaced a `|| 30` fallback, which is precisely how
 * eleven fields ended up on the retired rate without anyone choosing it: a caller that forgot simply
 * got the old behaviour, silently. Now a caller that cannot say how long the month is prices
 * NOTHING and leaves the money field for a human to type. A missing divisor must never quietly
 * become a number.
 *
 * Rounded to cents with an epsilon, exactly as the grid always did. A money field whose amount is not
 * a number (a "—" for missing compensation) is left out rather than priced at NaN.
 */
export function dayDrivenMoney(
  spec: StepFieldSpec | undefined,
  context: Record<string, string | number | null>,
  days: number,
  monthDays: number,
): Record<string, number> {
  const money: Record<string, number> = {};
  if (!spec?.autoCalcMoneyKey) return money;
  const divisorKey = spec.autoCalcDivisorContextKey;
  const named = divisorKey ? Number(context[divisorKey] ?? 0) : 0;
  const divisor = Number.isFinite(named) && named > 0 ? named : monthDays;
  // Fail closed rather than fall back to a flat 30 — see the note above.
  if (!Number.isFinite(divisor) || divisor <= 0) return money;
  const share = (moneyKey: string, amountContextKey: string) => {
    const amount = Number(context[amountContextKey] ?? 0);
    if (!Number.isFinite(amount)) return;
    money[moneyKey] = Math.round(((amount / divisor) * days + Number.EPSILON) * 100) / 100;
  };
  share(spec.autoCalcMoneyKey, spec.autoCalcAmountContextKey ?? "Base Salary");
  for (const companion of spec.autoCalcCompanionMoneyKeys ?? []) share(companion.key, companion.amountContextKey);
  return money;
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
      // Owner request 2026-08-29: show the FULL month's net beside the prorated
      // figures. A joiner's card previously showed only what he is paid THIS
      // month, so there was nothing on screen to check it against — now the
      // arithmetic is visible: Full Month Net / calendar days x Days Worked =
      // the Total (month) below. "Net Salary" is the same key the other seven
      // steps already use for a full month's net; only the LABEL is specialised
      // here, so recommend.ts, the xlsx template and this grid keep one name per
      // number.
      { key: "Net Salary", label: "Full Month Net", money: true },
      // There was a second context column here, "This Month Net" (key
      // "Net (month)"), showing the prorated total. The owner had it removed the
      // same day the live total below replaced it, and it must NOT come back:
      // it was a CONTEXT value, computed once on the server, while the grid's
      // setValue writes only to StepRow.values — so it froze at the figure it
      // was loaded with and stopped agreeing with the boxes the moment one was
      // edited. Two lines showing the same quantity, one of them silently stale,
      // is worse on a payroll screen than one line that is always right.
    ],
    fields: [
      { key: "baseForMonth", label: "Base (month)", kind: "money" },
      { key: "ecolPaid", label: "Extra Cost of Living", kind: "money" },
      { key: "fuelPaid", label: "Fuel Allowance", kind: "money" },
    ],
    // Owner request 2026-08-29: "add the total of the working days net ...
    // instead of me [having] to revise [it] manual[ly]". The three figures above
    // are what the joiner is actually paid this month; nothing on the card added
    // them up, so a revised set had to be totalled by hand.
    //
    // It is a live sum of the three boxes, NOT a context column, and that is the
    // whole point: context is computed once on the server and never recomputed
    // as HR types, so a context total would freeze at the loaded figure and stop
    // agreeing with the boxes exactly when someone is revising them. That is why
    // the retired "This Month Net" column above is not coming back.
    fieldsTotal: { label: "Total (month)", fieldKeys: ["baseForMonth", "ecolPaid", "fuelPaid"] },
    hasReason: false,
    isHoldStep: false,
  },
  p1_resignations: {
    key: "p1_resignations",
    phase: "part1",
    title: "Resignations",
    subtitle: "Leavers this month, with the recommended Base/ECoL/Fuel settlement. Last working day on or before the 25th: the whole NET salary is prorated to the days worked — base, cost of living and fuel all at the same day share (owner rule 2026-08-29). After the 25th: everything paid in full. Days Worked is the ONE figure: correct it here and Base, Cost of Living and Fuel all re-prorate together, and the Resignations CRM tab reads the very same number (owner rule 2026-08-30 — the rule is set once, not per tab). CRM no-activity and Unpaid Vacation deductions moved to their own dedicated tabs (owner request 2026-07-25) — edit them there; they still net against this leaver's own Second Part first, then First Part if Second isn't enough. Edit or confirm.",
    contextColumns: [
      { key: "Hire Date", label: "Hire Date" },
      { key: "Last Working Date", label: "Last Working Date" },
      // Relabelled with the rule change, because the rule change is what made
      // the old label ambiguous. While ECoL and Fuel showed 0, a bare "Net
      // Salary" beside them was obviously the contractual monthly figure; now
      // that all three fields carry PRORATED amounts it reads as this month's,
      // which is exactly the confusion the owner raised on the New hires screen
      // the same day. The key is unchanged, so nothing downstream moves.
      { key: "Net Salary", label: "Full Month Net", money: true },
    ],
    fields: [
      // Days Worked is EDITABLE (owner 2026-07-25): the system can only count
      // CALENDAR days from the 1st to the last working date, which is routinely
      // wrong — a leaver hired and resigned the same day showed 7, someone who
      // actually worked 4.5 days showed 12. HR types the true figure and all
      // three paid components recalculate at Amount / calendar-days-in-month ×
      // days, matching the locked proration formula exactly (verified:
      // 14000/31×9 = 4064.52).
      //
      // IT DRIVES ALL THREE since 2026-08-30, not just Base. The owner ruled on
      // 2026-08-29 that a resignation prorates the whole NET, but this field
      // still recalculated Base alone — so the moment anyone used it, Extra Cost
      // of Living and Fuel silently kept the figures belonging to the wrong day
      // count and the new rule stopped applying. It is also now a PERSISTED
      // column of its own (DraftRow.daysWorked), which is what lets the
      // Resignations CRM tab read the very same number instead of recounting the
      // calendar and disagreeing with this screen.
      {
        key: "daysWorked",
        label: "Days Worked",
        kind: "days",
        autoCalcMoneyKey: "baseForMonth",
        autoCalcAmountContextKey: "Base Salary",
        autoCalcDivisorContextKey: "Days In Month",
        autoCalcCompanionMoneyKeys: [
          { key: "ecolPaid", amountContextKey: "Extra Cost Of Living" },
          { key: "fuelPaid", amountContextKey: "Fuel Allowance" },
        ],
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
    subtitle:
      "Attendance/fingerprint deductions confirmed in the Deductions module — this step no longer recalculates them, it pays what you approved there (owner request 2026-08-03). Fingerprint needs an explicit \"Approved for Payroll\" on that page: anything still Pending shows 0.00 here until you decide it. Expand a row to see each approved deduction behind the figure. These reduce Part 1. Edit or confirm.",
    contextColumns: [{ key: "Hire Date", label: "Hire Date" }],
    fields: [
      { key: "fingerprintDays", label: "Deduction Days", kind: "days", autoCalcMoneyKey: "fingerprintValue" },
      { key: "fingerprintValue", label: "Deduction Value", kind: "money" },
    ],
    hasReason: false,
    isHoldStep: false,
    detailNoun: "approved deduction",
    detailColumns: DEDUCTION_DETAIL_COLUMNS,
  },
  p1_crm: {
    key: "p1_crm",
    phase: "part1",
    title: "CRM Deduction",
    subtitle:
      "CRM no-activity deduction for Part 1 — shown only for this month's one-part-salary employees (continuing two-part employees get this automatically via the Part 2 CRM step instead, so entering it here too would double it; this month's resignations have their own dedicated Resignations CRM tab). Working Days and Non-Working Days always sum to the month's calendar days (owner request 2026-07-25) — edit either one and the other adjusts automatically; the deduction is always calculated from Non-Working Days at Base ÷ the month's calendar days × days. Reason is optional.",
    contextColumns: [
      { key: "Hire Date", label: "Hire Date" },
      { key: "Net Salary", label: "Net Salary" },
      { key: "Last Working Date", label: "Last Working Date" },
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
        notPersisted: true,
        complementFieldKey: "p1odCrmDays",
        complementTotalContextKey: "Days In Month",
      },
      {
        key: "p1odCrmDays",
        label: "Non-Working Days",
        kind: "days",
        // Money divisor is the month's own calendar days, like every day-rate in the system
        // (owner ruling 2026-09-12, audit finding 37). This tab was the last flat-30 holdout: the
        // owner's 2026-07-25 ÷30 rate is retired, because a deducted day must be worth exactly what
        // the day it cancels is worth, and that day has been paid at Net ÷ real calendar days since
        // 2026-08-29. No autoCalcDivisorContextKey is needed — dayDrivenMoney's own monthDays
        // argument IS the month's length; naming "Days In Month" here would be the same number.
        // Keep it distinct from complementTotalContextKey below all the same: that key is the CAP
        // on the day count, a separate rule that merely happens to share the figure.
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
      "CRM no-activity deduction for this month's RESIGNATIONS only — dedicated to leavers so its rules never collide with the normal CRM tab (owner request 2026-07-26). Everything here uses the SAME daily rate as the resignation settlement: NET (Base + Cost of Living + Fuel) ÷ the month's ACTUAL calendar days, NOT the Base and NOT ÷30 — so one no-activity day costs exactly one day of the pay it cancels (owner rule 2026-08-30). Working Days + Non-Working Days sum to the DAYS WORKED you confirmed on the Resignations step — that same number, never a fresh count of the calendar — so they can never be deducted for a day they were not employed, nor for a day you already said they did not work. Edit either day field and the other adjusts. Days and value are pre-filled from the deductions you have marked \"Approved for Payroll\" in the Deductions module, pushed or not; anything still awaiting your decision there is worth 0.00 here and is listed in the row's breakdown so you can see what is being held back. Reason is optional.",
    contextColumns: [
      { key: "Hire Date", label: "Hire Date" },
      { key: "Net Salary", label: "Net Salary" },
      { key: "Last Working Date", label: "Last Working Date" },
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
        notPersisted: true,
        complementFieldKey: "resignationCrmDays",
        complementTotalContextKey: "Days Worked",
      },
      {
        key: "resignationCrmDays",
        label: "Non-Working Days",
        kind: "days",
        // THREE separate context keys, and they must stay separate:
        //   autoCalcAmountContextKey  — WHAT is prorated: the month's NET.
        //   autoCalcDivisorContextKey — the month's ACTUAL calendar days, not /30.
        //   complementTotalContextKey — the CAP on the day count: days worked.
        // Every time two of these have been folded together in this module the
        // money moved without anyone noticing. See StepFieldSpec's doc comments.
        //
        // The amount became NET on 2026-08-30 (owner: "in the CRM, it must
        // prorate the net salary"). It was the Base, which since the 2026-08-29
        // net-proration rule meant a no-activity day was charged LESS than the
        // day of pay it cancels — the two halves of one day valued differently.
        //
        // The key IS the DraftRow column, so the generic persist-loop writes it —
        // no run-service remap needed.
        autoCalcMoneyKey: "crm",
        autoCalcAmountContextKey: "Net Salary",
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
      "Unpaid-vacation deduction for Part 1 — shown only for this month's resignations and one-part-salary employees (continuing two-part employees get this automatically via the Part 2 Vacation step instead, so entering it here too would double it). For a resigning leaver, Value is pre-filled with their real settlement (owner request 2026-07-25 — moved here from the Resignations step) and still nets against their own Second Part first; \"Unpaid Vacation Days\" is read-only reference only — it combines a balance-aware Phoenix-vacation amount with a separate CRM-leave amount, not a flat day rate, so edit the Value directly instead of typing days for a leaver. For everyone else, type days to auto-calculate the value (Base ÷ the month's calendar days × days), or type the value directly. Reason is optional.",
    contextColumns: [
      { key: "Hire Date", label: "Hire Date" },
      { key: "Net Salary", label: "Net Salary" },
      { key: "Last Working Date", label: "Last Working Date" },
      // LABELLED DISTINCTLY FROM THE EDITABLE FIELD BELOW, which carried the identical heading.
      // The xlsx template emits both columns, and `pickCell` in step-parser.ts matches the FIRST
      // header whose normalised text matches — the context column, emitted first. So a re-upload
      // read this read-only reference and wrote it into `p1odVacationDays`, which auto-calculates
      // the money from a day count. For a leaver that replaced a balance-aware settlement with a
      // flat day rate, and the edit HR actually typed was discarded. The key is unchanged because
      // recommend.ts writes `row.context["Unpaid Vacation Days"]`; only the HEADING moves.
      { key: "Unpaid Vacation Days", label: "Unpaid Vacation Days (reference)" },
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
      "Day-without-attendance-record deduction for Part 1 — shown only for this month's resignations and one-part-salary employees. Type days to auto-calculate the value (Base ÷ the month's calendar days × days), or leave days blank and type the value directly. Reason is optional.",
    contextColumns: [
      { key: "Hire Date", label: "Hire Date" },
      { key: "Net Salary", label: "Net Salary" },
      { key: "Last Working Date", label: "Last Working Date" },
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
      "Loan repayment or any other manual deduction for Part 1 — shown only for this month's resignations and one-part-salary employees. Pre-filled with the Loan and Other deductions you marked \"Approved for Payroll\" in the Deductions module (owner request 2026-08-03); continuing two-part employees take theirs on the Part 2 \"Any more deductions?\" step instead. Expand a row to see what made up the figure. Type days to auto-calculate the value (Base ÷ the month's calendar days × days), or leave days blank and type the value directly. Reason is optional.",
    contextColumns: [
      { key: "Hire Date", label: "Hire Date" },
      { key: "Net Salary", label: "Net Salary" },
      { key: "Last Working Date", label: "Last Working Date" },
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
      "Every employee, regardless of payment mode — for cases that fall outside the normal rules. Enter a deduction and/or addition (days auto-calculate the value at Base ÷ the month's calendar days × days, or type the value directly), then choose which installment it applies to. That choice applies to BOTH the deduction and the addition for this employee. Only available while Part 1 is still open — like every Part 1 step, this tab locks once Part 1 is confirmed.",
    contextColumns: [
      { key: "Hire Date", label: "Hire Date" },
      { key: "Net Salary", label: "Net Salary" },
      { key: "Last Working Date", label: "Last Working Date" },
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
  p1_held_release: {
    key: "p1_held_release",
    phase: "part1",
    title: "Held Salary Release",
    subtitle:
      "Salary an earlier published month withheld and has not paid since — Part 2 withheld, Part 1 when it was never paid, and pay deferred to this month — less anything already settled by hand. Released here, it is paid in THIS month's Part 1 and its bank file — for someone who resigned and whose last pay is only in Part 1, this is where their held salary goes. Nobody is released unless you enter an amount — except a held amount you added for someone while working in this month, which starts filled in: Due Now shows what is owed now. Enter it to pay it all, less to pay part, or leave 0 and Part 2's Held Salary Release offers whatever is left. It can never be raised above what is owed. Someone held at Part 1 is not released. If last month's Part 1 was not paid to someone, enter it under Part 1 Not Paid — add them with Add employee if they are not listed. Confirming Part 1 reserves the release against the held month, so it is released once.",
    contextColumns: [
      { key: "Held Month", label: "Held Month" },
      { key: "Part 1 Already Paid", label: "Part 1 Already Paid", money: true },
      { key: "Part 1 Withheld", label: "Part 1 Withheld", money: true },
      { key: "Part 2 Withheld", label: "Part 2 Withheld", money: true },
      { key: "Deferred", label: "Deferred", money: true },
      { key: "Settled By Hand", label: "Settled By Hand", money: true },
      { key: "Released In Payroll", label: "Released In Payroll", money: true },
      { key: "Outstanding", label: "Outstanding", money: true },
      { key: "Not Yet Due", label: "Not Yet Due", money: true },
      { key: "Due Now", label: "Due Now", money: true },
    ],
    fields: [
      // Saved to its own ledger against last month's run, not to this run's draft row (run-service saveStep).
      { key: "part1NotPaid", label: "Part 1 Not Paid (previous month)", kind: "money", notPersisted: true },
      { key: "heldReleaseP1Value", label: "Release In Part 1", kind: "money" },
    ],
    hasReason: false,
    isHoldStep: false,
    allowsManualRows: true,
  },
  p1_pay_deferral: {
    key: "p1_pay_deferral",
    phase: "part1",
    title: "Defer Pay",
    subtitle:
      "Move part of this month's Part 1 to a later month. The amount comes off this month's Part 1 and its bank file and is owed again next month or the month after, where Held Salary Release offers it once it is due. It can never be more than the person's Part 1. Leave 0 for nobody. Someone held at Part 1 is not paid Part 1 at all, so their deferral does nothing. Part 2 has its own Defer Pay for the rest of the month.",
    contextColumns: [
      { key: "Hire Date", label: "Hire Date" },
      { key: "Part 1", label: "Part 1", money: true },
    ],
    fields: [
      { key: "payDeferralP1Value", label: "Amount To Defer", kind: "money" },
      {
        key: "payDeferralP1Month",
        label: "Pay It In",
        kind: "select",
        options: [
          { value: "next", label: "Next month" },
          { value: "after_next", label: "The month after" },
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
      "Outstation expenses to reimburse (added to pay, in Part 2). The figure is what you APPROVED on the Expense Approvals page — trips nobody has decided yet are NOT in it, and their value is shown separately as \"Awaiting Decision\". A trip claimed twice in the same run — same day, same destination, same amount — is held out of the figure and shown as \"On Hold — Duplicate\", with the reason on the trip line; it is not refused, so approving it or typing the amount still pays it. Expand any employee to see every trip, decided or not, with dates, route, distance, the cost split and its \"HR Approved\" line. To pay a waiting trip, approve it on the Expense Approvals page and reopen this step, or type the amount here with a note. Someone whose trip never reached the expense table at all won't be listed — use \"Add employee\" to put them on the sheet. Edit or confirm.",
    contextColumns: [
      { key: "Hire Date", label: "Hire Date" },
      { key: "Trips", label: "Trips" },
      { key: "Trip Dates", label: "Trip Dates" },
      // Money, so the grid card and the xlsx both currency-format it. Reads 0 for an employee
      // whose trips are all decided — which is the state this column exists to drive towards.
      { key: "Awaiting Decision", label: "Awaiting Decision", money: true },
      // Extra copies of a trip already counted in the figure — the same day, the same destination
      // and the same amount as another trip in this very run. Reads 0 for everyone in every payout
      // run Phoenix has had but one (May 2026, 351.00 paid twice), so a non-zero is worth opening.
      { key: "On Hold — Duplicate", label: "On Hold — Duplicate", money: true },
    ],
    fields: [
      { key: "expenses", label: "Expenses", kind: "money" },
      { key: "expensesNote", label: "Note", kind: "text" },
    ],
    hasReason: false,
    isHoldStep: false,
    // The one step where the figure is a plain amount HR owns end-to-end, so a
    // hand-added employee can't produce a silently wrong derived number.
    allowsManualRows: true,
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
      // Reads "—" on an ordinary trip and names the other copy on a held one, so the column is
      // part of the breakdown rather than something that only appears when there is bad news.
      { key: "On Hold", label: "On Hold" },
    ],
  },
  p2_vacation: {
    key: "p2_vacation",
    phase: "part2",
    title: "Vacation (no balance)",
    subtitle:
      "Unpaid-vacation deductions you have marked \"Approved for Payroll\" in the Deductions module — this step no longer recalculates them, it pays what you approved there. Covers both vacation categories; the approval is what releases it, and a push is not needed for payroll. ONLY employees who actually owe something are listed. Highest deduction first. Continuing two-part employees only; resignations and one-part-salary employees are settled in Part 1 instead. Confirming this step still debits leave balances exactly as before — that bookkeeping is separate from the money. Expand a row to see each approved deduction behind the figure. Edit or confirm.",
    contextColumns: [
      { key: "Hire Date", label: "Hire Date" },
      { key: "Confirmed Lines", label: "Confirmed Lines" },
    ],
    fields: [
      { key: "p2VacationDays", label: "Deduction Days", kind: "days", autoCalcMoneyKey: "unpaidVacations", notPersisted: true },
      { key: "unpaidVacations", label: "Deduction Value", kind: "money" },
    ],
    hasReason: false,
    isHoldStep: false,
    detailNoun: "approved deduction",
    detailColumns: DEDUCTION_DETAIL_COLUMNS,
  },
  p2_crm: {
    key: "p2_crm",
    phase: "part2",
    title: "CRM (no activity)",
    subtitle:
      "CRM no-activity deductions you have marked \"Approved for Payroll\" in the Deductions module, pushed or not — this step no longer recalculates them, and nothing you have not approved is deducted. A flagged day pays 0.00 here until it is approved, so this total can be lower than the Deductions Overview for the same month — the gap is exactly the rows still awaiting a decision. Continuing two-part employees only — resignations and one-part-salary employees are settled in Part 1 instead. Expand a row to see each confirmed deduction behind the figure. Edit or confirm.",
    contextColumns: [
      { key: "Hire Date", label: "Hire Date" },
      { key: "Confirmed Lines", label: "Confirmed Lines" },
    ],
    fields: [
      { key: "p2CrmDays", label: "Deduction Days", kind: "days", autoCalcMoneyKey: "crm", notPersisted: true },
      { key: "crm", label: "Deduction Value", kind: "money" },
    ],
    hasReason: false,
    isHoldStep: false,
    detailNoun: "confirmed deduction",
    detailColumns: DEDUCTION_DETAIL_COLUMNS,
  },
  p2_additions: {
    key: "p2_additions",
    phase: "part2",
    title: "Additions",
    subtitle:
      "Incentive, bonus, overtime and other additions per employee (paid in Part 2). Other additions is pre-filled with any deduction a reopened dispute gave back after its own month was already paid, with its reason. Enter or confirm.",
    contextColumns: [{ key: "Hire Date", label: "Hire Date" }],
    fields: [
      { key: "incentive", label: "Incentive", kind: "money" },
      { key: "bonus", label: "Bonus", kind: "money" },
      { key: "overtime", label: "Overtime", kind: "money" },
      { key: "otherAdditions", label: "Other additions", kind: "money" },
    ],
    // The only step that ADDS money, so the only one whose figures have no feeder behind them to
    // explain themselves. Required whenever any of the four is non-zero — see confirmStep.
    hasReason: true,
    isHoldStep: false,
  },
  p2_manual_deductions: {
    key: "p2_manual_deductions",
    phase: "part2",
    title: "Any more deductions?",
    subtitle:
      "Add any other deduction per employee, with a reason. Pre-filled with the Loan and Other deductions you have marked \"Approved for Payroll\" in the Deductions module for continuing two-part employees, pushed or not — resignations and one-part-salary employees take theirs on the Part 1 Other Deductions tab instead, so nobody is charged twice. Expand a row to see what made up the figure. Edit freely, or leave 0 for none.",
    contextColumns: [{ key: "Hire Date", label: "Hire Date" }],
    fields: [
      { key: "p2ManualDeductionDays", label: "Days", kind: "days", autoCalcMoneyKey: "manualOtherDeductions", notPersisted: true },
      { key: "manualOtherDeductions", label: "Value", kind: "money" },
    ],
    hasReason: true,
    isHoldStep: false,
    detailNoun: "confirmed deduction",
    detailColumns: DEDUCTION_DETAIL_COLUMNS,
  },
  p2_held_release: {
    key: "p2_held_release",
    phase: "part2",
    title: "Held Salary Release",
    subtitle:
      "Salary an earlier published month withheld and has not paid since — Part 2 withheld, Part 1 when it was never paid, and pay deferred to this month — less anything already settled by hand, and less what this month's Part 1 already released. It is paid in this month's Part 2, in Other Additions, including for people who have since left. Nobody is released unless you enter an amount — except a held amount you added for someone while working in this month, which starts filled in: Due Now shows what is owed now, leaving out deferred pay not due until a later month. Enter it to pay it all, less to pay part, or leave 0 to keep holding; it can never be raised above what is owed. Someone held again this month is not released. If last month's Part 1 was not paid to someone (they were held when it was confirmed), enter it under Part 1 Not Paid — add them with Add employee if they are not listed — and it joins what they are owed. Confirming Part 2 reserves the release against the held month and publishing records it, so it is released once.",
    contextColumns: [
      { key: "Held Month", label: "Held Month" },
      { key: "Part 1 Already Paid", label: "Part 1 Already Paid", money: true },
      { key: "Part 1 Withheld", label: "Part 1 Withheld", money: true },
      { key: "Part 2 Withheld", label: "Part 2 Withheld", money: true },
      { key: "Deferred", label: "Deferred", money: true },
      { key: "Settled By Hand", label: "Settled By Hand", money: true },
      { key: "Released In Payroll", label: "Released In Payroll", money: true },
      { key: "Released In Part 1", label: "Released In Part 1", money: true },
      { key: "Outstanding", label: "Outstanding", money: true },
      { key: "Not Yet Due", label: "Not Yet Due", money: true },
      { key: "Due Now", label: "Due Now", money: true },
    ],
    fields: [
      // Saved to its own ledger against last month's run, not to this run's draft row (run-service saveStep).
      { key: "part1NotPaid", label: "Part 1 Not Paid (previous month)", kind: "money", notPersisted: true },
      { key: "heldReleaseValue", label: "Release Amount", kind: "money" },
    ],
    hasReason: false,
    isHoldStep: false,
    // Someone held at Part 1 but released at Part 2 last month is not on the held list at all — HR adds
    // them here to record the Part 1 they were never paid.
    allowsManualRows: true,
  },
  p2_pay_deferral: {
    key: "p2_pay_deferral",
    phase: "part2",
    title: "Defer Pay",
    subtitle:
      "Move part of this month's pay to a later month (owner, 2026-10-26). The amount comes off this month's Part 2 and is owed again next month or the month after, where Held Salary Release offers it once it is due. It can never be more than the person's Part 2. Leave 0 for nobody. A held person's deferral does nothing — their whole month is already withheld.",
    contextColumns: [
      { key: "Hire Date", label: "Hire Date" },
      { key: "Part 2", label: "Part 2", money: true },
    ],
    fields: [
      { key: "payDeferralValue", label: "Amount To Defer", kind: "money" },
      {
        key: "payDeferralMonth",
        label: "Pay It In",
        kind: "select",
        options: [
          { value: "next", label: "Next month" },
          { value: "after_next", label: "The month after" },
        ],
      },
    ],
    hasReason: false,
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
 * These steps sit next to each other and look like they cover the same dates.
 * They do not, and none of them said so:
 *  - expenses — a FINANCE TAG (payout_month/payout_year), not a date range at
 *    all. Verified in production 2026-08-01: rows tagged payout_month=7 carry
 *    expense_date in June, so the July sheet reimburses June trips.
 *  - fingerprint / CRM / vacation — the Deductions module's own `month_key`,
 *    i.e. the plain calendar month.
 *
 * CRM used to name the day-24 payroll cycle here, and that is now WRONG: since
 * 2026-08-03 the CRM figure is whatever the Deductions module holds for this
 * month_key, not a cycle-windowed recomputation. Leaving the old label would
 * describe a window the number no longer comes from — which is exactly the
 * "correct figure looks wrong" problem this function exists to prevent.
 *
 * Returns null for steps with no meaningful window (manual entry, holds).
 * Pure — safe to call from the client grid; unit-tested directly.
 */
export function stepWindowLabel(stepKey: StepKey, period: PayrollPeriod): string | null {
  const monthText = monthNameAndYear(period.month, period.year);
  if (stepKey === "p2_expenses") {
    return `Trips finance tagged for the ${monthText} payout. The trip dates themselves are often earlier — expand a row to see them.`;
  }
  if (stepKey === "p1_fingerprint" || stepKey === "p2_crm" || stepKey === "p2_vacation") {
    // SAYS "APPROVED", AND THAT A PUSH IS NOT NEEDED. For a fortnight (owner rule 2026-09-22) the
    // gate was the push and this sentence said "PUSHED"; the owner retired that gate on 2026-10-07,
    // after three of four approved September unpaid-vacation rows never reached this step. The
    // decision is the gate again, in every month — see loadConfirmedDeductions.
    return `Only the ${monthText} deductions you have marked "Approved for Payroll" in the Deductions module — pushed or not. Anything still Pending, Needs Follow-up, Disputed or Do Not Take Action pays nothing here.`;
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
  "p1_held_release",
  "p1_pay_deferral",
  "p1_holds",
  "p2_expenses",
  "p2_vacation",
  "p2_crm",
  "p2_additions",
  "p2_manual_deductions",
  "p2_held_release",
  "p2_pay_deferral",
  "p2_holds",
];
