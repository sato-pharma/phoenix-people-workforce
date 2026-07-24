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
  | "p1_other_deductions"
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
  "p1_other_deductions",
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
  incentive: number | null;
  bonus: number | null;
  overtime: number | null;
  // Part 2 — deductions.
  unpaidVacations: number | null;
  crm: number | null;
  manualOtherDeductions: number | null;
  manualReason: string | null;
  // Part 1 — "Other deductions" step: HR may flag any of 5 categories per employee,
  // each with its own optional days (auto-calculates value via Base/30 × days),
  // value (money — can be typed directly instead of days), and reason (optional).
  // These reduce the frozen First Part for EVERY employee (not just one-part).
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
  // Frozen at Part 1 confirm — the first installment, never recomputed afterward.
  firstPartFrozen: number | null;
  // Hold — held employee still appears (red + flagged), excluded from publish.
  onHold: boolean;
  holdReason: string | null;
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
  reason: string | null;
  onHold: boolean;
  lifecycle?: RowLifecycle;
};

/** A field editable within a step (drives the grid + the xlsx template columns). */
export type StepFieldSpec = {
  key: string;
  label: string;
  kind: "money" | "days" | "text";
  /** When true the field is a per-employee reason string, not a number. */
  reason?: boolean;
  /**
   * For a "days" field: the key of the paired "money" field it auto-calculates
   * (via Base Salary/30 × days) whenever the days input changes. Direct edits to
   * the money field itself are left alone.
   */
  autoCalcMoneyKey?: string;
};

export type StepDefinition = {
  key: StepKey;
  phase: "part1" | "part2";
  title: string;
  subtitle: string;
  /** Read-only context columns shown before the editable fields. */
  contextColumns: { key: string; label: string }[];
  fields: StepFieldSpec[];
  /** Whether this step carries a per-employee free-text reason column. */
  hasReason: boolean;
  /** Whether this is a hold-review step (toggle + reason, no recommendation feeder). */
  isHoldStep: boolean;
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
