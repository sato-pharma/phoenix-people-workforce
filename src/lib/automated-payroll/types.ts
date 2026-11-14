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

/** Defer Pay: when the deferred amount falls due, counted from the run's own month. */
export type PayDeferralMonth = "next" | "after_next";

/**
 * One employee's hold as it stood in the month before the run being edited —
 * the record a carried-forward reason is read from. `reason` is null when that
 * month held them and recorded nothing, which is a fact worth carrying too.
 */
export type PriorHold = {
  hrId: string;
  reason: string | null;
  month: number;
  year: number;
};

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
  | "p1_held_release"
  | "p1_pay_deferral"
  | "p1_holds"
  | "p2_expenses"
  | "p2_vacation"
  | "p2_crm"
  | "p2_additions"
  | "p2_manual_deductions"
  | "p2_held_release"
  | "p2_pay_deferral"
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
  "p1_held_release",
  "p1_pay_deferral",
  "p1_holds",
] as const;

export const PART2_STEP_KEYS: readonly StepKey[] = [
  "p2_expenses",
  "p2_vacation",
  "p2_crm",
  "p2_additions",
  "p2_manual_deductions",
  "p2_held_release",
  "p2_pay_deferral",
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
  /**
   * One transition at a time (audit finding 50). Set while a phase change holds the run and
   * cleared by the phase write itself; a claim older than TRANSITION_CLAIM_LAPSE_MINUTES was left
   * behind by a request that died and no longer holds anything.
   */
  transitionAction?: string | null;
  transitionStartedAt?: string | null;
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
  /**
   * Days worked this month as CONFIRMED by HR on the Resignations step — the
   * single source of truth for every Part 1 tab that needs a leaver's day count
   * (owner, 2026-08-30: "the rule must be synced everywhere in the module").
   *
   * It has a column of its own precisely so nothing re-derives it. Until
   * 2026-08-30 only `baseForMonth` persisted, and the two tabs that needed the
   * days each reconstructed them differently — the Resignations tab by dividing
   * the saved money back out, the Resignations CRM tab by recounting the
   * calendar — so confirming a correction on one screen changed nothing on the
   * other. Never reintroduce a derivation: read this, through resolveLeaverBasis.
   *
   * null = nobody has confirmed a figure; fall back to the computed settlement.
   */
  daysWorked: number | null;
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
  /**
   * Additions step -> Other additions. Recommended from a dispute refund falling due this month
   * (dispute-refunds.ts — owner, 2026-10-09: a deduction a reopened dispute cancels after its month
   * was paid is given back "in additions, other"). Paid in the Other Additions column beside the
   * Special Situations addition. Optional so a row read before the column existed still types.
   */
  otherAdditions?: number | null;
  /**
   * Held Salary Release step -> the part of an earlier month's withheld salary paid out in this
   * month's Part 2 (owner, 2026-10-26: a salary held in a published month was never paid later).
   * Paid in the Other Additions column; publish records it against the held balance so it is
   * released once. Optional so a row read before the column existed still types.
   */
  heldReleaseValue?: number | null;
  /**
   * Defer Pay step (owner, 2026-10-26: "I have the option to transfer this payment to the next month,
   * or to the month after") -> an amount taken off this month's Part 2 and owed again later. Clamped
   * to the row's Part 2 and worth nothing on a held row (assemble.ts). Publish records it and the
   * Held Salary Release step offers it once it is due. Optional so a row read before the column
   * existed still types.
   */
  payDeferralValue?: number | null;
  /** When the deferred amount falls due: the month after this run, or the one after that. */
  payDeferralMonth?: PayDeferralMonth | null;
  /**
   * Part 1 Held Salary Release (owner, 2026-10-26: "it should be also in part one. For example, if an
   * employee is resigned and his value of working days is only covered in the first part") -> an
   * earlier month's held salary paid in THIS month's Part 1. Part 2's release only pays what is
   * left. Worth nothing on a row withheld at Part 1. Optional so an older row still types.
   */
  heldReleaseP1Value?: number | null;
  /**
   * Part 1 Defer Pay -> an amount taken off this month's Part 1 and owed again later. Never above the
   * row's Part 1 and worth nothing on a row withheld at Part 1 (assemble.ts).
   */
  payDeferralP1Value?: number | null;
  /** When the Part 1 deferred amount falls due — its own month, apart from Part 2's. */
  payDeferralP1Month?: PayDeferralMonth | null;
  // Part 2 — deductions.
  unpaidVacations: number | null;
  crm: number | null;
  manualOtherDeductions: number | null;
  manualReason: string | null;
  /**
   * Why this employee is being paid an incentive, bonus or overtime this month.
   *
   * Additions is the ONLY step that adds money to a payslip, and it had no feeder, no source, no
   * reason and no limit — a typed figure reached the payslip with nothing recording who asked for
   * it. Deliberately NOT `manualReason`, which belongs to the Part 2 Manual Deductions step: one
   * shared column would let a deduction's reason read as an addition's.
   */
  additionsReason: string | null;
  /**
   * Resignations-step-only: the editable day count behind `crm` (CRM no-activity
   * days for the leaver's final settlement). Auto-calculates `crm` when edited, at
   * the leaver's NET ÷ the month's actual calendar days × days (owner rule
   * 2026-08-30; `resignationCrmDays` in step-definitions.ts carries the three
   * context keys). Since the owner's 2026-09-12 ruling every day-driven money
   * field on every step divides by the month's actual calendar days, so this is
   * no longer the exception it was written as.
   * There is deliberately NO equivalent for `unpaidVacations`: that figure is a
   * composite of a balance-aware Phoenix-vacation amount plus a day-rate CRM-leave
   * amount, not a flat day-rate — auto-calculating it from a single day count
   * would silently produce a wrong number for a leaver's final settlement.
   */
  resignationCrmDays: number | null;
  // Part 1 — 4 manual deduction tabs (CRM, Unpaid Vacation, Day Without Record, and
  // Other deductions for Loan/Other), each category with its own optional days
  // (auto-calculates value via Base ÷ the month's calendar days × days), value (money — can be typed directly
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
  // (Base ÷ the month's calendar days × days), same formula as the other Part 1 day-rate fields. One
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
  /**
   * THE PART 1 / PART 2 DEDUCTION ROUTING, frozen at Part 1 confirm in the same
   * write as `firstPartFrozen`.
   *
   * `isSettledInPart1` decides whether somebody's loan, CRM or unpaid vacation is
   * taken in Part 1 or Part 2, and it reads their payment mode and lifecycle LIVE
   * every time a step is opened. The columns it routes money into are permanent.
   * So correcting somebody from one-part to two-part between the two confirms left
   * their loan in the Part 1 column from before AND offered it again on the Part 2
   * step: charged twice. The mirror correction means it reaches no step at all and
   * is never taken.
   *
   * NULL means Part 1 is not confirmed yet, and the live rule is still the right
   * answer. That is also what every run predating this column reads, so nothing
   * already on the books moves. Cleared by `unconfirmPart1`, which re-freezes.
   */
  settledInPart1: boolean | null;
  /**
   * Frozen at Part 1 confirm, beside `firstPartFrozen`: was this person ON HOLD at that moment?
   *
   * The Part 1 bank files leave a held person out, so a hold at Part 1 means the first instalment was
   * never paid. Publish used to record every held person's Part 1 as "already paid", and someone held
   * at Part 1 but released at Part 2 lost their Part 1 for good (owner, 2026-10-26: "I should be able
   * to release their whole the previous salary"). NULL before Part 1 confirm, and on every run
   * confirmed before the column existed — readers then fall back to the live hold, as before.
   * Cleared by `unconfirmPart1`.
   */
  part1Withheld?: boolean | null;
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
  /**
   * Why this write happened, recorded beside every cell it changes in
   * automated_payroll_draft_cell_history (the trigger reads it off the row). Set by every writer; a
   * write without one is recorded as "unspecified" rather than inheriting the previous write's reason.
   */
  writeReason?: DraftWriteReason;
  /** The wizard step whose save or confirm made this write, when one did. */
  writeStepKey?: StepKey | null;
};

/** Every reason a draft row is written. Each one names the click or the job behind it. */
export type DraftWriteReason =
  | "step_saved"
  | "step_confirmed"
  | "part1_confirmed"
  | "part1_reopened"
  | "employee_excluded"
  | "employee_included"
  | "deduction_resync"
  | "expense_resync";

/** One change to one cell of a draft row, as automated_payroll_draft_cell_history recorded it. */
export type DraftCellChange = {
  employeeHrId: string;
  /** The draft column, e.g. "crm". */
  column: string;
  oldValue: string | null;
  newValue: string | null;
  /** HR id of whoever made the write; "system" for a resync. */
  changedBy: string | null;
  changedByName: string | null;
  writeReason: string | null;
  stepKey: string | null;
  inputMode: string | null;
  changedAt: string;
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
  /**
   * What the screen proposed for each field when the person saved. Lets the server tell a figure
   * somebody changed from one the grid merely carried, so a save writes only the first
   * (saved-figures.ts). Optional: an uploaded sheet sends none, and the server's proposal is used.
   */
  recommended?: Record<string, number>;
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
  /**
   * True when `reason` above was inherited from the previous month's run rather
   * than typed for this one. The stored text says so as well (hold-reason.ts's
   * "Carried forward from <month> — "); this flag is the machine-readable half,
   * so the UI can mark the field without parsing the prefix back out.
   */
  reasonCarriedForward?: boolean;
  /**
   * How this employee stood in the PREVIOUS month's run, when they were held in
   * it. Present whether or not this month has its own reason — a reviewer about
   * to publish needs "held last month too, and here is why" for every held row,
   * not only for the ones missing an explanation. Absent means the previous
   * month did not hold them (or had no run at all), which is what makes a hold
   * NEW.
   */
  priorHold?: PriorHold;
  lifecycle?: RowLifecycle;
  /**
   * On the step only to be paid an earlier month's held salary (releaseOnlyMember). Colour only — the
   * row is tinted as a resignation (owner, 2026-11-09). Never read it as `lifecycle`: saveStep treats a
   * "leaver" row's edits as a settlement.
   */
  releaseOnly?: boolean;
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
  /**
   * This employee's WHOLE-MONTH money, in components, so every screen can show
   * the four figures the owner asked for on 2026-08-30 — full month net,
   * working-days net, total deducted, and what is actually payable.
   *
   * Deliberately the components rather than the four totals. The totals have to
   * move as HR types, and a total computed on the server would freeze at the
   * figure it was loaded with — the same trap that retired the "This Month Net"
   * context column on the New hires step (see StepFieldsTotal). Shipping the
   * components instead lets the client overlay just the boxes on screen and add
   * up, with the other fifteen steps' saved figures read as-is.
   *
   * Absent for holds steps and for a manually-added row that has never been
   * saved: no basis means the summary is not rendered, rather than rendered as
   * a confident row of zeros.
   */
  settlement?: RowSettlementBasis;
};

/**
 * One employee's month, broken into the components that make up their pay —
 * built in assemble.ts beside the arithmetic it mirrors, consumed by
 * settlement-summary.ts on the client.
 *
 * `components` is keyed by the DraftRow column name, which is also the step
 * field key that edits it (`crm`, `baseForMonth`, `p1odLoanValue`, …). That
 * shared naming is the whole mechanism: it is what lets a live edit overlay
 * exactly one component with no mapping table to fall out of date. Keys with no
 * editable field anywhere (`medicalInsurance`, `carriedForwardApplied`) ride
 * along so the payable figure is the real one.
 */
export type RowSettlementBasis = {
  /** The contractual month net (Base + ECoL + Fuel), never prorated. */
  monthNet: number;
  /** Every money component of the month, keyed by its DraftRow column name. */
  components: Record<string, number>;
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
   * (via Base ÷ the month's calendar days × days) whenever the days input changes. Direct edits to
   * the money field itself are left alone.
   */
  autoCalcMoneyKey?: string;
  /**
   * For a "days" field: names a context column holding the divisor to use
   * instead of `dayDrivenMoney`'s own `monthDays` argument.
   *
   * Since the owner's 2026-09-12 ruling (audit finding 37) this changes nothing
   * on any live step: pay and deductions both divide by the month's actual
   * calendar days, so every column named here already holds that figure. It is
   * kept because the two Resignations tabs name it explicitly, and because a
   * future step could legitimately price off something other than the month.
   * There is deliberately no flat fallback anywhere — see dayDrivenMoney.
   */
  autoCalcDivisorContextKey?: string;
  /**
   * For a "days" field: the context column holding the MONTHLY amount the money
   * is a day-share of. Defaults to "Base Salary".
   *
   * Added 2026-08-30 because a leaver's CRM deduction must now be priced off the
   * NET, not the Base (owner: "in the CRM, it must prorate the net salary") —
   * one no-activity day has to cost exactly one day of the pay it cancels, and
   * that pay has been Net ÷ calendar days since 2026-08-29. Separate from
   * `autoCalcDivisorContextKey` for the same reason that key is separate from
   * `complementTotalContextKey`: WHAT is being divided, HOW MANY it is divided
   * by, and the CAP on the day count are three independent rules, and every time
   * two of them have been folded together here the money moved silently.
   */
  autoCalcAmountContextKey?: string;
  /**
   * For a "days" field: FURTHER money fields the same day count drives, each
   * from its own monthly amount. The field's own `autoCalcMoneyKey` covers the
   * first; these cover the rest.
   *
   * The Resignations step is the reason (owner-reported 2026-08-30). Its Days
   * Worked field recalculated Base and nothing else, so correcting the days left
   * Extra Cost of Living and Fuel at the figures belonging to the UNCORRECTED
   * count — silently reverting the owner's 2026-08-29 rule that a resignation
   * prorates the whole net. It is visible in the live August run: leavers whose
   * base matches a 3- and 12-day settlement carry hand-rounded allowances that
   * match neither. One edit must move all three, or the rule only holds while
   * nobody uses the field.
   */
  autoCalcCompanionMoneyKeys?: { key: string; amountContextKey: string }[];
  /**
   * For a "days" field: the key of ANOTHER "days" field on the same row that
   * this one complements to a fixed total (e.g. Working Days + Non-Working
   * Days = the month's calendar day count — owner request 2026-07-25).
   * Editing either field clamps it to [0, total] and sets the OTHER to
   * (total - value). The total is read from `complementTotalContextKey`.
   *
   * Deliberately a SEPARATE field from `autoCalcDivisorContextKey` even though
   * the two now hold the same number on every live step: this one is the CAP on
   * a day count, that one is the price of a day. They coincided before too — on
   * the Part 1 CRM tab the cap was the real calendar day count while the divisor
   * was a flat 30 — and the 2026-09-12 ruling closing that gap is not a reason
   * to fold them together. A future step can cap days at something that is not
   * the month (the Resignations CRM tab already caps at Days Worked).
   */
  complementFieldKey?: string;
  /** For a "days" field with `complementFieldKey`: the context column holding the fixed total both fields sum to. */
  complementTotalContextKey?: string;
  /** For a "select" field: the dropdown's choices. */
  options?: { value: string; label: string }[];
  /**
   * True for a field with no draft column of its own: a day count shown so HR can type a figure
   * the grid turns into money, or the derived complement of one that IS stored. The grid still
   * edits it; the xlsx template ships it READ-ONLY and the re-upload parser never reads it back.
   *
   * Audit finding 31: five such day columns shipped editable, so a sheet changing one from 2 to 6
   * previewed "2 to 6 (changed)" and then saved nothing, because `stepEditToPatch` has no column to
   * put it in. Kept in step with run-service.ts's NUMERIC_FIELDS by a drift test, so a field cannot
   * be both unflagged and unstored, or flagged and stored.
   */
  notPersisted?: boolean;
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
  /**
   * Rows where the SPLIT disagrees with what the locked engine says the month owes — i.e.
   * `firstPart + secondPart - overpaidResidual !== totalPayable`. Must always be empty.
   *
   * This used to compare `firstPart + secondPart` against `monthSalary`, which assembleParts
   * defines AS `firstPart + secondPart`. That comparison could not fail, so the one hard gate
   * before Part 2 passed unconditionally on every run this module has ever done.
   */
  splitMismatches: {
    hrId: string;
    firstPart: number;
    secondPart: number;
    monthSalary: number;
    overpaidResidual: number;
    totalPayable: number;
  }[];
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
  /** The standing-roster entry this row was copied from, or null when HR typed it in for this month only. */
  recurringId: string | null;
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
 * One person on the STANDING Non-Employees Payroll roster (owner request
 * 2026-08-30: "add them to be fixed every month without me adding them manual").
 *
 * This is the register, not the payment. Every new run copies the `active`
 * entries into its own NonEmployeePayrollRow list, and from that moment the
 * run's COPY is what every sheet, total and bank file reads — so editing an
 * amount here never reaches back into a month already built. Someone paid with
 * both installments is two entries, one per `part`, because they are two
 * different payments on two different dates.
 */
export type RecurringNonEmployeeRow = {
  id: string;
  part: NonEmployeePart;
  fullNameAr: string;
  fullNameEn: string;
  totalSalary: number;
  bankName: string | null;
  bankAccount: string | null;
  /** Inactive entries stay for history but are not copied into new runs. */
  active: boolean;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RecurringNonEmployeeInput = {
  fullNameAr: string;
  fullNameEn: string;
  totalSalary: number;
  bankName?: string | null;
  bankAccount?: string | null;
  part?: NonEmployeePart;
  active?: boolean;
  note?: string | null;
};

/** What one seed/sync of the standing roster into a run actually did. */
export type RecurringSeedResult = {
  /** Entries copied in by this call. */
  inserted: number;
  /** Active entries already present on the run (matched by recurring_id), left untouched. */
  skipped: number;
  /**
   * People already on the run for that same part under a DIFFERENT provenance — typed in by hand,
   * or seeded from a roster entry that has since been replaced. Named, because the alternative is
   * paying them twice: both rows reach the bank file.
   *
   * Scoped to the part on purpose. One person legitimately appears once in each part when their
   * salary is split across the two instalments, and production carries exactly that case.
   */
  skippedAsDuplicate: string[];
  /**
   * People the sync refused to add because the money for their part has already been executed.
   * Adding to a confirmed Part 1 puts money on an instalment finance has paid, onto a row that can
   * then never be edited or removed.
   */
  heldBackPartClosed: string[];
  /**
   * Paid entries the sync left out because they name no bank or no account (payroll audit 2026-11-14,
   * finding 11): copied in, the sheet would count them as paid while no bank file carried them.
   */
  heldBackNoBank: string[];
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
  /** employment_status — set on the Held Salary Release steps, which list leavers too, so the picker can say "(resigned)". */
  status?: string | null;
  /**
   * Held Salary Release only: the Part 1 the previous published month confirmed for them (0 when they were
   * not on it). "Part 1 Not Paid" can never exceed it, so the picker offers that choice only when it is above 0.
   */
  lastMonthPart1?: number;
};
