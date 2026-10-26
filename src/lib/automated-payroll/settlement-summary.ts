import type { RowSettlementBasis, StepDefinition } from "./types.ts";

/**
 * THE FOUR FIGURES (owner request 2026-08-30).
 *
 * His words: "In every screen of the automated payroll sheet, I should know the
 * total month's net salary, the total working days net salary, the total
 * deducted from the net salary, and the total she will be payable of. Once I
 * edit anything, everything automatically calculates."
 *
 * He sent a screenshot of the Windows calculator showing 612.9032258064516 x 5
 * to make the point: the sheet showed him the pieces and left him doing the
 * arithmetic by hand, on a payroll that pays real people. Every screen showed a
 * fragment — this step's own boxes — and nothing anywhere showed what the
 * employee actually ends the month with, so checking a figure meant holding the
 * other fifteen screens in his head.
 *
 * WHY THE MATH IS NOT REDONE HERE. Payable is not "net minus what is on this
 * screen": it is the whole month, across all sixteen steps, and that arithmetic
 * already exists in assemble.ts / split.ts and ends in the LOCKED engine
 * (calculatePayrollParts). A second implementation would be a second source of
 * truth for a number HR reads before paying someone, and the two would drift.
 * So the server sends the per-employee COMPONENTS it already computed
 * (`RowSettlementBasis`, built in assemble.ts beside the arithmetic it mirrors)
 * and this module only OVERLAYS the boxes on the current screen and adds up.
 * tests/automated-payroll-settlement-summary.test.ts pins the reconciliation
 * against assembleRows itself, so the two cannot drift apart silently.
 *
 * Client-safe on purpose (types-only import): it runs on every keystroke.
 */

/**
 * What this month's pay is EARNED from — Net = Base + Extra Cost of Living +
 * Fuel, by definition (split.ts EffectiveSalary.net, and every branch of
 * proration.ts returns netForMonth as the sum of exactly these three ROUNDED
 * components). For a full-month employee these are the contractual figures, so
 * Working Days Net equals Full Month Net; for a joiner or leaver they are the
 * prorated ones, which is where the two lines diverge and the screen earns its
 * keep.
 */
export const WORKED_NET_COMPONENT_KEYS = ["baseForMonth", "ecolPaid", "fuelPaid"] as const;

/** Paid ON TOP of the worked net. Mirrors assembleParts' `sumAdditions` exactly. */
export const ADDITION_COMPONENT_KEYS = [
  "expenses",
  "incentive",
  "bonus",
  "overtime",
  // Special Situations' addition — `otherAdditions` in assembleParts. Counted
  // once for the month whichever installment HR routed it to.
  "specialAdditionValue",
  // The Additions step's Other additions cell (a dispute refund, 2026-10-09) — also part of
  // `otherAdditions` in assembleParts, beside the Special Situations addition.
  "otherAdditions",
  // Held Salary Release (2026-10-26): an earlier month's withheld salary paid now — also part of
  // `otherAdditions` in assembleParts.
  "heldReleaseValue",
] as const;

/**
 * Taken OFF. Mirrors assembleParts' `sumDeductions` flattened out — i.e.
 * assemble.ts's `totalDeductions`, with `otherDeductionsTotal` expanded into
 * the five Part-1 manual categories, the Part-2 manual value, Special
 * Situations and the carry-forward recovery.
 *
 * Flattened DELIBERATELY, not summed server-side into one "deductions" figure:
 * a live edit has to move exactly one component, and it can only do that if
 * each component is addressable by the same key the step field writes. There is no
 * `loans` key because the Loans column IS `p1odLoanValue` — assemble.ts reads the
 * Part-1 loan straight into it (owner, 2026-10-09), so the component is already
 * in this list under the name the step writes.
 */
export const DEDUCTION_COMPONENT_KEYS = [
  "fingerprintValue",
  "crm",
  "unpaidVacations",
  // Never editable on any step — carried so the payable line is the real one.
  "medicalInsurance",
  "p1odCrmValue",
  "p1odVacationValue",
  "p1odNoRecordValue",
  "p1odLoanValue",
  "p1odOtherValue",
  "manualOtherDeductions",
  "specialDeductionValue",
  // A PREVIOUS run's overpayment being recovered this month. Also never
  // editable, and easy to forget: leaving it out overstates take-home for
  // exactly the people whose pay was already wrong once.
  "carriedForwardApplied",
  // Defer Pay (2026-10-26): moved off this month's Part 2 to a later month — part of `otherDeductions`.
  "payDeferralValue",
] as const;

export type SettlementSummary = {
  /** The contractual month, never prorated. */
  monthNet: number;
  /** Earned for the days actually worked (Base + ECoL + Fuel, live). */
  workedNet: number;
  /** Paid on top — expenses, incentive, bonus, overtime, special addition. */
  additions: number;
  /** Everything taken off, across all sixteen steps. */
  deductions: number;
  /** What the employee ends the month with. Floored at zero. */
  payable: number;
};

function cents(value: number): number {
  // Cents, not raw float. Summing a dozen prorated components straight prints
  // 4645.159999999999, and this is a payroll screen.
  return Math.round(value * 100) / 100;
}

function finite(value: number | null | undefined): number {
  return value == null || !Number.isFinite(value) ? 0 : value;
}

/**
 * The four figures for one row, with the CURRENT screen's boxes overlaid on the
 * server's saved components.
 *
 * The overlay is by KEY and is scoped to money fields this step actually
 * declares, which is what makes it exact rather than approximate: every
 * editable money field in step-definitions.ts is named for the DraftRow column
 * it writes, so `values["crm"]` and the basis component `crm` are the same
 * quantity by construction. A step that does not declare a field never overlays
 * it, so the other fifteen screens' saved figures are read as-is.
 *
 * Returns null when the row carries no basis — a manually-added row that has
 * never been saved, and holds steps, where there is no money to total. The
 * caller renders nothing rather than a confident row of zeros.
 */
export function computeSettlementSummary(
  basis: RowSettlementBasis | null | undefined,
  definition: StepDefinition,
  values: Record<string, number> | undefined,
): SettlementSummary | null {
  if (!basis) return null;

  const editableHere = new Set(
    definition.fields.filter((field) => field.kind === "money").map((field) => field.key),
  );
  const read = (key: string): number => {
    if (editableHere.has(key)) {
      const live = values?.[key];
      if (live != null && Number.isFinite(live)) return live;
    }
    return finite(basis.components[key]);
  };
  const total = (keys: readonly string[]): number => cents(keys.reduce((sum, key) => sum + read(key), 0));

  const workedNet = total(WORKED_NET_COMPONENT_KEYS);
  const additions = total(ADDITION_COMPONENT_KEYS);
  const deductions = total(DEDUCTION_COMPONENT_KEYS);

  return {
    monthNet: cents(finite(basis.monthNet)),
    workedNet,
    additions,
    deductions,
    // Same shape as the locked engine's totalPayable:
    // nonNegativeMoney(netSalary + additions - deductions). A payslip never
    // goes negative — an excess is carried to the next run, not billed.
    payable: Math.max(0, cents(workedNet + additions - deductions)),
  };
}
