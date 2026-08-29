/**
 * Automated Payroll — HR-owned monthly salary-sheet wizard.
 *
 * A brand-new, stepped Part 1 / Part 2 wizard that REUSES the existing payroll
 * business logic (policy.ts, proration.ts, the Copilot feeders) without editing
 * any existing payroll file. This module owns only its own staging state; the
 * canonical salary_batches/salary_records are written once, at publish.
 *
 * Types only — no logic, no imports of runtime code.
 */

/** Payroll period. Structurally identical to CopilotPeriod so it interops with the reused feeders. */
export type PayrollPeriod = { month: number; year: number };

/**
 * Run lifecycle:
 *  part1     — HR is working Part 1 steps.
 *  part2     — Part 1 confirmed (First Part frozen); HR is working Part 2 steps.
 *  ready     — Part 2 confirmed; full sheet assembled + notified, awaiting publish.
 *  published — the canonical salary_batch was created (payslips live).
 *  cancelled — run abandoned; frees the active-period slot.
 */
export type RunPhase = "part1" | "part2" | "ready" | "published" | "cancelled";

export type StepKey =
  | "p1_new_hires"
  | "p1_resignations"
  | "p1_fingerprint"
  | "p1_crm"
  | "p1_resignation_crm"
  | "p1_unpaid_vacation"
  | "p1_no_record"
  | "p1_other_deductions"
  | "p1_special_situations"
  | "p1_holds"
  | "p2_expenses"
  | "p2_vacation"
  | "p2_crm"
  | "p2_additions"
  | "p2_manual_deductions"
  | "p2_holds";

export const PART1_STEP_KEYS: readonly StepKey[] = [
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
] as const;

export const PART2_STEP_KEYS: readonly StepKey[] = [
  "p2_expenses",
  "p2_vacation",
  "p2_crm",
  "p2_additions",
  "p2_manual_deductions",
  "p2_holds",
] as const;

export const ALL_STEP_KEYS: readonly StepKey[] = [...PART1_STEP_KEYS, ...PART2_STEP_KEYS] as const;

export function isStepKey(value: string): value is StepKey {
  return (ALL_STEP_KEYS as readonly string[]).includes(value);
}

export function stepPhase(stepKey: StepKey): "part1" | "part2" {
  return (PART1_STEP_KEYS as readonly string[]).includes(stepKey) ? "part1" : "part2";
}

export type StepStatus = "pending" | "confirmed";
export type StepInputMode = "inline" | "xlsx";

export type MonthlySalaryRun = {
  id: string;
  month: number;
  year: number;
  monthKey: string;
  phase: RunPhase;
  part1ConfirmedAt: string | null;
  part1ConfirmedBy: string | null;
  part2ConfirmedAt: string | null;
  part2ConfirmedBy: string | null;
  publishedBatchId: string | null;
  publishedAt: string | null;
  publishedBy: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type StepState = {
  runId: string;
  stepKey: StepKey;
  status: StepStatus;
  inputMode: StepInputMode | null;
  summary: Record<string, unknown>;
  confirmedAt: string | null;
  confirmedBy: string | null;
  updatedAt: string;
};

/**
 * The wizard's per-employee editable projection for one run. `null` on a numeric
 * field means "no HR decision yet — accept the system recommendation at assembly
 * time". A confirmed step persists the accepted/edited value here so assembly is
 * a pure read of draft rows (no feeder re-run, no drift).
 */
export type DraftRow = {
  runId: string;
  employeeHrId: string;
  employeeHrIdCompact: string;
  // New-hire / resignation confirmed settlement (null = accept computed proration).
  baseForMonth: number | null;
  ecolPaid: number | null;
  fuelPaid: number | null;
  // Part 1 — fingerprint deduction (days + EGP value).
  fingerprintDays: number | null;
  fingerprintValue: number | null;
  // Part 2 — additions.
  expenses: number | null;
  /**
   * Optional HR note behind the outstation expense figure. Free text, never
   * money. Matters most for an employee HR ADDED BY HAND on the expenses step:
   * the payout-tagged feeder produced no trip for them, so this note is the only
   * record of why the amount is being reimbursed.
   */
  expensesNote: string | null;
  incentive: number | null;
  bonus: number | null;
  overtime: number | null;
  // Part 2 — deductions.
  unpaidVacations: number | null;
  crm: number | null;
  manualOtherDeductions: number | null;
  manualReason: string | null;
  /**
   * Resignations-step-only: the editable day count behind `crm` (CRM no-activity
   * days for the leaver's final settlement). Auto-calculates `crm` via Base/30 ×
   * days when edited — safe because the leaver's system-recommended `crm` value
   * already uses that exact formula (calculateDeductionAmountFromBaseSalary).
   * There is deliberately NO equivalent for `unpaidVacations`: that figure is a
   * composite of a balance-aware Phoenix-vacation amount plus a day-rate CRM-leave
   * amount, not a flat day-rate — auto-calculating it from a single day count
   * would silently produce a wrong number for a leaver's final settlement.
   */
  resignationCrmDays: number | null;
  // Part 1 — 4 manual deduction tabs (CRM, Unpaid Vacation, Day Without Record, and
  // Other deductions for Loan/Other), each category with its own optional days
  // (auto-calculates value via Base/30 × days), value (money — can be typed directly
  // instead of days), and reason (optional). Every tab is scoped in recommend.ts to
  // this month's resignations and one-part-salary employees only — continuing
  // two-part employees get CRM/Vacation handled automatically in Part 2 instead, so
  // showing them here too would double the deduction. Reduces the frozen First Part
  // for whichever employees actually get a value here.
  p1odCrmDays: number | null;
  p1odCrmValue: number | null;
  p1odCrmReason: string | null;
  p1odVacationDays: number | null;
  p1odVacationValue: number | null;
  p1odVacationReason: string | null;
  p1odNoRecordDays: number | null;
  p1odNoRecordValue: number | null;
  p1odNoRecordReason: string | null;
  p1odLoanDays: number | null;
  p1odLoanValue: number | null;
  p1odLoanReason: string | null;
  p1odOtherDays: number | null;
  p1odOtherValue: number | null;
  p1odOtherReason: string | null;
  // Part 1 — Special Situations tab. Shows every employee regardless of payment
  // mode (unlike the 4 tabs above). A day count auto-calculates its money value
  // (Base/30 × days), same formula as the other Part 1 day-rate fields. One
  // shared dropdown routes BOTH the deduction and the addition to whichever
  // installment HR picks — there is deliberately no separate addition-routing
  // field. Only "first" may be chosen before Part 1 is confirmed; once frozen,
  // routing to "first" would silently change money already paid out, so the UI
  // must stop offering that choice (see freezeFirstPart's "never recomputed"
  // invariant).
  specialDeductionDays: number | null;
  specialDeductionValue: number | null;
  specialAdditionDays: number | null;
  specialAdditionValue: number | null;
  specialSituationPart: "first" | "second" | null;
  // Frozen at Part 1 confirm — the first installment, never recomputed afterward.
  firstPartFrozen: number | null;
  // Hold — held employee still appears (red + flagged), excluded from publish.
  onHold: boolean;
  holdReason: string | null;
  /**
   * Run-scoped exclusion: this employee is dropped from THIS run's population
   * entirely — every step, the data-quality audit, and assembly/pre-flight —
   * without touching their master employee record or any other run. Distinct
   * from `onHold`, which still assembles and validates the row and only skips
   * it at publish. Reason is required by the service layer (excludeEmployeeFromRun)
   * so the decision is on the record.
   */
  excluded: boolean;
  excludedReason: string | null;
  source: StepInputMode;
  editedBy: string | null;
  updatedAt: string;
};

/** Partial write payload for a draft row (only the fields a step touches). */
export type DraftRowPatch = Partial<
  Omit<DraftRow, "runId" | "employeeHrId" | "employeeHrIdCompact" | "updatedAt">
> & {
  employeeHrId: string;
};

export type RowLifecycle = "regular" | "joiner" | "leaver";

/** One employee's edit for a step (from the inline grid or a re-uploaded xlsx). */
export type StepEditInput = {
  hrId: string;
  values?: Record<string, number>;
  /** Per-field free-text reasons, keyed by a "text"-kind field's key. */
  reasons?: Record<string, string>;
  /** Per-field dropdown choices, keyed by a "select"-kind field's key. */
  selects?: Record<string, string>;
  reason?: string | null;
  onHold?: boolean;
};

/**
 * A single editable row in a wizard step. Generic across all steps: `context`
 * holds read-only display columns (Hire Date, Days, …), `values` holds the
 * editable numeric fields, `recommended` is the system snapshot for diff/reset.
 */
export type StepRow = {
  hrId: string;
  fullName: string;
  jobTitle: string | null;
  line: string | null;
  context: Record<string, string | number | null>;
  values: Record<string, number>;
  recommended: Record<string, number>;
  /** Per-field free-text reasons, keyed by a "text"-kind field's key. Only used by steps with such fields. */
  reasons?: Record<string, string>;
  /** Per-field dropdown choices, keyed by a "select"-kind field's key. Only used by steps with such fields. */
  selects?: Record<string, string>;
  reason: string | null;
  onHold: boolean;
  lifecycle?: RowLifecycle;
  /**
   * Informational row — rendered but not editable, and carrying no values to
   * save. Used for employees serving notice into a FUTURE month: they belong on
   * the Resignations step visually (HR needs to know they are leaving) but must
   * never receive this month's settlement math, which would prorate their pay.
   */
  readOnly?: boolean;
  /** Short explanation shown beside a read-only row, e.g. "settles in August". */
  readOnlyNote?: string;
  /**
   * HR added this employee to the step by hand — no feeder produced them (owner
   * request 2026-08-03). Only steps declaring `allowsManualRows` can carry one.
   * Purely a display/label flag: a manual row saves through the exact same
   * draft-row path as a recommended one, so the money behaves identically.
   */
  manual?: boolean;
  /**
   * The source lines behind this row's single recommended figure — the trips
   * behind an expense total, the days behind a deduction — keyed by the step's
   * `detailColumns` (owner request 2026-08-01: "which days, where").
   *
   * Strictly READ-ONLY (owner decision, same date): HR still edits only the one
   * figure in `values`. Nothing here is persisted to a draft row and the
   * re-upload parser never reads it back, so a detail line can never become a
   * second, competing source of truth for the money.
   */
  details?: StepRowDetail[];
};

/** One line of a row's read-only breakdown, keyed by the step's `detailColumns`. */
export type StepRowDetail = Record<string, string | number | null>;

/**
 * One column of a step's read-only per-line breakdown. Mirrors `contextColumns`:
 * declared once on the step definition, keyed to whatever recommend.ts puts in
 * each `StepRow.details` entry, and consumed by BOTH the expandable grid panel
 * and the xlsx "Detail" sheet so the two can never drift apart.
 */
export type StepDetailColumn = {
  key: string;
  label: string;
  /** Right-align and currency-format in the grid and the xlsx Detail sheet. */
  money?: boolean;
};

/**
 * One read-only context column shown above a step's editable fields, keyed to
 * whatever recommend.ts puts in each `StepRow.context`.
 *
 * `money` exists because context values were previously stringified raw, so a
 * salary rendered as `4645.16` on a payroll screen. It is OPT-IN per column and
 * must stay that way — "Days Worked" and "Hire Date" are context columns too,
 * and currency-formatting either of them would be wrong.
 */
export type StepContextColumn = {
  key: string;
  label: string;
  /** Currency-format in the grid card and the xlsx template. */
  money?: boolean;
};

/**
 * A read-only live TOTAL of several of a step's own editable money fields,
 * rendered directly beneath them on the card and emitted as a matching
 * read-only column in the step's xlsx.
 *
 * Owner request 2026-08-29, on the New hires screen: the three figures a joiner
 * is actually paid this month (prorated Base, Extra Cost of Living and Fuel)
 * sat in three separate boxes with nothing adding them up, so checking a
 * revised figure meant adding them by hand.
 *
 * Deliberately NOT a context column. `StepRow.context` is computed once on the
 * server and never recomputed as HR types — `setValue` in the grid writes to
 * `StepRow.values` alone — so a context column showing this sum freezes at the
 * value it was loaded with and stops agreeing with the boxes the moment one is
 * edited. That is precisely the case this total exists to serve, so it is
 * summed on the client from the live `values`.
 */
export type StepFieldsTotal = {
  /** Column/row label, e.g. "Total (month)". Must not collide with a field label — the
   *  re-upload parser matches editable columns by header name. */
  label: string;
  /** `StepFieldSpec.key`s to sum. Money fields only; a missing value counts as 0. */
  fieldKeys: string[];
};

/** A field editable within a step (drives the grid + the xlsx template columns). */
export type StepFieldSpec = {
  key: string;
  label: string;
  kind: "money" | "days" | "text" | "select";
  /** When true the field is a per-employee reason string, not a number. */
  reason?: boolean;
  /**
   * For a "days" field: the key of the paired "money" field it auto-calculates
   * (via Base Salary/30 × days) whenever the days input changes. Direct edits to
   * the money field itself are left alone.
   */
  autoCalcMoneyKey?: string;
  /**
   * For a "days" field: names a context column holding the divisor to use
   * instead of the default 30. Deduction day-rates are Base/30 by owner rule,
   * but resignation proration is Base/actual-calendar-days-in-month — using 30
   * there would pay the wrong amount in any 31-day month.
   */
  autoCalcDivisorContextKey?: string;
  /**
   * For a "days" field: the key of ANOTHER "days" field on the same row that
   * this one complements to a fixed total (e.g. Working Days + Non-Working
   * Days = the month's calendar day count — owner request 2026-07-25).
   * Editing either field clamps it to [0, total] and sets the OTHER to
   * (total - value). The total is read from `complementTotalContextKey`.
   *
   * Deliberately a SEPARATE field from `autoCalcDivisorContextKey`: the money
   * formula's divisor must stay a fixed 30 regardless of the actual month
   * length (calculateDeductionAmountFromBaseSalary is hardcoded to /30), while
   * the complement CAP must be the real calendar day count (28–31) — conflating
   * the two would silently change the deduction amount in any 31-day month.
   */
  complementFieldKey?: string;
  /** For a "days" field with `complementFieldKey`: the context column holding the fixed total both fields sum to. */
  complementTotalContextKey?: string;
  /** For a "select" field: the dropdown's choices. */
  options?: { value: string; label: string }[];
};

export type StepDefinition = {
  key: StepKey;
  phase: "part1" | "part2";
  title: string;
  subtitle: string;
  /** Read-only context columns shown before the editable fields. */
  contextColumns: StepContextColumn[];
  fields: StepFieldSpec[];
  /**
   * Optional read-only live total of some of `fields`, shown under them on the
   * card and as an extra read-only column in the xlsx. See StepFieldsTotal for
   * why this is not a context column.
   */
  fieldsTotal?: StepFieldsTotal;
  /** Whether this step carries a per-employee free-text reason column. */
  hasReason: boolean;
  /** Whether this is a hold-review step (toggle + reason, no recommendation feeder). */
  isHoldStep: boolean;
  /**
   * Names a context column whose non-zero value means this employee's deduction is
   * ALREADY settled on a different step — currently the Resignations step, which
   * auto-computes a leaver's CRM + unpaid vacation from real CRM data into the
   * `crm` / `unpaidVacations` columns. The Part 1 manual tabs write DIFFERENT
   * columns (`p1od*`), and assemble.ts sums both, so filling in a value here on
   * top of that amount deducts the same thing twice.
   *
   * Owner decision 2026-07-25: warn, don't block — HR keeps the ability to enter a
   * manual figure for a leaver, but the wizard flags any row where this context
   * value and an editable money value are both non-zero.
   */
  conflictContextKey?: string;
  /**
   * Columns for the read-only per-line breakdown behind each row's figure —
   * rendered as an expandable panel under the row and as a second "Detail"
   * sheet in the step's xlsx. Omitted for steps whose figure has no underlying
   * line data (manual entry, additions, holds).
   */
  detailColumns?: StepDetailColumn[];
  /**
   * Singular noun for the row expander, e.g. "trip" renders "1 trip". Defaults
   * to "line". Only meaningful alongside `detailColumns`.
   */
  detailNoun?: string;
  /**
   * Plural of `detailNoun`. Required whenever adding "s" is wrong — "leave
   * entry" pluralised naively renders "3 leave entrys". Defaults to
   * `detailNoun` + "s".
   */
  detailNounPlural?: string;
  /**
   * HR may add an employee this step's feeder didn't produce, and type the
   * figure by hand (owner request 2026-08-03 for outstation expenses: a trip
   * that never reached the expense table still has to be reimbursed).
   *
   * Only safe on a step whose figure is a plain amount HR owns end-to-end. NOT
   * for a step whose number is derived from employment facts — a proration or a
   * day-rate deduction typed against an employee the feeder deliberately left
   * out would be a wrong number with no way to notice.
   */
  allowsManualRows?: boolean;
  /**
   * Plain-English statement of the exact date range this step draws from, shown
   * beside the step title. The three Part-2 feeder steps sit next to each other
   * but cover DIFFERENT windows — expenses by finance payout tag, vacation by
   * calendar month, CRM by the day-24 cycle — which is invisible otherwise and
   * makes a correct figure look wrong (owner request 2026-08-01).
   */
  windowNote?: string;
};

/** A dry-run diff line produced when an edited xlsx is re-uploaded. */
export type StepImportDiff = {
  hrId: string;
  fullName: string;
  field: string;
  from: number | string | null;
  to: number | string | null;
  status: "added" | "changed" | "unchanged" | "invalid";
  message?: string;
};

export type StepImportPreview = {
  mode: "preview";
  totalRows: number;
  changed: number;
  invalid: number;
  diffs: StepImportDiff[];
};

export type StepImportCommit = {
  mode: "commit";
  applied: number;
  invalid: number;
  diffs: StepImportDiff[];
};

/** Live reconciliation snapshot (accuracy booster). */
export type ReconciliationTotals = {
  headcount: number;
  joiners: number;
  leavers: number;
  held: number;
  oneParts: number;
  twoParts: number;
  totalFirstPart: number;
  totalSecondPart: number;
  totalMonthSalary: number;
  totalNet: number;
  totalAdditions: number;
  totalDeductions: number;
  /** Rows where firstPart + secondPart !== monthSalary (must always be empty). */
  splitMismatches: { hrId: string; firstPart: number; secondPart: number; monthSalary: number }[];
  /** Rows flagged part1_overpaid (Part-2 deductions exceeded the frozen first installment). */
  overpaid: { hrId: string; residual: number }[];
};

/**
 * Which installment a Non-Employees Payroll entry is paid with (owner request
 * 2026-08-03). "first" is the module's original — and still default — behaviour.
 */
export type NonEmployeePart = "first" | "second";

export const NON_EMPLOYEE_PARTS: readonly NonEmployeePart[] = ["first", "second"] as const;

export function isNonEmployeePart(value: unknown): value is NonEmployeePart {
  return value === "first" || value === "second";
}

/**
 * Non-Employees Payroll (owner rule 2026-07-25): people paid a monthly salary
 * with NO employee/HR_ID record at all. A free-form, HR-authored list per run —
 * added/removed manually each month, never derived from the employee
 * population. Flat total only, no deductions/additions, no lifecycle. Kept
 * deliberately separate from DraftRow/AssembledRow — these people must never
 * generate a real employee salary_record; they are appended only to the
 * exported sheets and the bank files, never to salary_records.
 *
 * `part` (owner request 2026-08-03) says which installment the amount is paid
 * with, and is the single input to all three places that used to assume "first":
 * which run phase the entry can still be edited in, which internal sheet lists
 * it, and which FAB/CIB bank file carries it.
 */
export type NonEmployeePayrollRow = {
  id: string;
  runId: string;
  part: NonEmployeePart;
  fullNameAr: string;
  fullNameEn: string;
  totalSalary: number;
  bankName: string | null;
  bankAccount: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NonEmployeePayrollInput = {
  fullNameAr: string;
  fullNameEn: string;
  totalSalary: number;
  bankName?: string | null;
  bankAccount?: string | null;
  /** Defaults to "first" — the behaviour every entry had before this field existed. */
  part?: NonEmployeePart;
};

/**
 * An employee HR may add by hand to a step that `allowsManualRows`, i.e. someone
 * in this run's payroll population who the step's feeder produced no row for.
 * Names only — enough to find the right person and label the row they create.
 */
export type ManualRowCandidate = {
  hrId: string;
  fullName: string;
  jobTitle: string | null;
  line: string | null;
};
