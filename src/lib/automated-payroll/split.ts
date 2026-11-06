import { roundCurrency } from "@/lib/payroll/money";
import {
  calculateBasicSalary,
  calculatePayrollParts,
  normalizePayrollPaymentMode,
  resolveFixedSalaryAmounts,
  type PayrollPaymentMode,
} from "@/lib/payroll/policy";
import {
  calendarDaysInMonth,
  computeJoinerPay,
  computeResignationSettlement,
} from "@/lib/payroll/copilot/proration.ts";

import type { PayrollPeriod, RowLifecycle } from "./types.ts";

/**
 * The two-phase payroll split for the Automated Payroll wizard.
 *
 * Design (owner-confirmed this session):
 *  - Part 1 anchors the FIRST installment to Basic (= Base × 70%) for two-part
 *    employees, or the full Net for one-part employees, and REDUCES it by the
 *    Part-1 fingerprint deduction. This value is frozen when HR confirms Part 1
 *    (finance pays it before Part 2 data is entered), so it never moves again.
 *  - Part 2 computes totalPayable from the full month (Net + all additions − all
 *    deductions, fingerprint included exactly once) via the LOCKED engine
 *    (calculatePayrollParts), then Second Part = totalPayable − frozen First Part.
 *
 * All money math is delegated to the locked policy.ts / proration.ts. Only the
 * final First/Second assignment is the wizard's own rule. Pure + I/O-free so the
 * whole thing is unit-tested in tests/automated-payroll-split.test.ts.
 */

export type EffectiveSalary = {
  base: number;
  ecol: number;
  fuel: number;
  /** This month's Net (Base + ECoL + Fuel), prorated for joiners/leavers. */
  net: number;
  lifecycle: RowLifecycle;
  /**
   * Days of the period this person was on payroll — the numerator of the
   * proration, and the "Working Days" column on the payroll sheet (owner rule
   * 2026-09-04: the sheet shows the FULL contractual salary, and this column is
   * what explains why a joiner/leaver is paid less than it).
   *
   * Always the date-derived count, so it answers "how many days was he here",
   * not "what did HR settle him at". Two consequences worth knowing:
   *  - a leaver after the 25th reads e.g. 28 while being paid the full month,
   *    because the >25 full-pay waiver is a rule, not a day count;
   *  - an HR settlement override does not move it, for the same reason.
   * Equals `calendarDays` for a regular employee, so the factor is exactly 1.
   */
  workingDays: number;
  /** Calendar days in the period — the proration denominator (28-31). */
  calendarDays: number;
};

export type EffectiveSalaryInput = {
  baseSalary: number;
  extraCostOfLiving: number;
  fuelAllowance: number;
  netSalary: number;
  period: PayrollPeriod;
  lifecycle: RowLifecycle;
  /** Required when lifecycle === "joiner". */
  hireDate?: string | null;
  /** Required when lifecycle === "leaver". */
  lastWorkingDate?: string | null;
  /** HR settlement overrides (from step 1/2 edits); when set they win over the computed proration. */
  overrideBase?: number | null;
  overrideEcol?: number | null;
  overrideFuel?: number | null;
  /**
   * True only for a genuine resignation — see `isResignationEmploymentStatus`.
   *
   * Optional in the TYPE and mandatory in PRACTICE: a leaver without it throws (below). Requiring
   * it outright would force a meaningless answer onto every regular and joiner row, and a field
   * that is noise four times out of five stops being read. Defaulting it would be worse still —
   * the default would have to be "resignation", which is exactly the bug: a dismissal settled as a
   * resignation with nothing to notice it by. So: absent is fine unless it matters, and when it
   * matters, absent is an error.
   */
  isResignation?: boolean;
};

/**
 * This month's effective Base/ECoL/Fuel/Net, applying joiner/leaver proration
 * (reusing the owner-confirmed proration.ts) and any HR settlement override.
 */
export function effectiveSalary(input: EffectiveSalaryInput): EffectiveSalary {
  const base = roundCurrency(input.baseSalary);
  const ecol = roundCurrency(input.extraCostOfLiving);
  const fuel = roundCurrency(input.fuelAllowance);
  const net = roundCurrency(input.netSalary);

  let effBase = base;
  let effEcol = ecol;
  let effFuel = fuel;
  let effNet = net;
  let lifecycle: RowLifecycle = "regular";
  const calendarDays = calendarDaysInMonth(input.period);
  let workingDays = calendarDays;

  if (input.lifecycle === "leaver" && input.lastWorkingDate) {
    if (input.isResignation === undefined) {
      throw new Error(
        "effectiveSalary: a leaver needs isResignation. The exit workflow records dismissals too, " +
          "so the last working date cannot say which kind of departure this is — only the " +
          "employee's own employment status can, and a dismissal keeps neither allowance and gets " +
          "no >25th waiver.",
      );
    }
    const settlement = computeResignationSettlement({
      baseSalary: base,
      extraCostOfLiving: ecol,
      fuelAllowance: fuel,
      lastWorkingDate: input.lastWorkingDate,
      isResignation: input.isResignation,
      period: input.period,
      // A JOINER WHO ALSO LEFT THIS MONTH IS STILL A LEAVER HERE — this branch returns before the
      // joiner branch below is ever reached — so without the hire date the settlement counted from
      // the 1st and paid for days before the person was hired. The date was already in scope and
      // simply discarded. Ignored when the hire is in an earlier month, which is every other leaver.
      hireDate: input.hireDate,
      otherAdditions: 0,
      otherDeductions: 0,
    });
    if (settlement) {
      effBase = settlement.baseForMonth;
      effEcol = settlement.ecolPaid;
      effFuel = settlement.fuelPaid;
      effNet = settlement.netForMonth;
      lifecycle = "leaver";
      workingDays = settlement.daysWorked;
    }
  } else if (input.lifecycle === "joiner" && input.hireDate) {
    const joiner = computeJoinerPay({
      baseSalary: base,
      extraCostOfLiving: ecol,
      fuelAllowance: fuel,
      hireDate: input.hireDate,
      period: input.period,
    });
    if (joiner) {
      effBase = joiner.baseForMonth;
      effEcol = joiner.ecolPaid;
      effFuel = joiner.fuelPaid;
      effNet = joiner.netForMonth;
      lifecycle = "joiner";
      workingDays = joiner.daysWorked;
    }
  }

  // HR settlement override (step 1/2 edits) wins over the computed proration.
  let overridden = false;
  if (input.overrideBase != null) {
    effBase = roundCurrency(input.overrideBase);
    overridden = true;
  }
  if (input.overrideEcol != null) {
    effEcol = roundCurrency(input.overrideEcol);
    overridden = true;
  }
  if (input.overrideFuel != null) {
    effFuel = roundCurrency(input.overrideFuel);
    overridden = true;
  }
  if (overridden) {
    effNet = roundCurrency(effBase + effEcol + effFuel);
  }

  return { base: effBase, ecol: effEcol, fuel: effFuel, net: effNet, lifecycle, workingDays, calendarDays };
}

export type FreezeFirstPartInput = {
  effective: EffectiveSalary;
  /**
   * Full master Base — the Basic anchor for the min(Basic, effNet) two_parts
   * split, for every lifecycle. A leaver already used the full base (owner
   * Rule 2); a joiner must too (bug fixed 2026-07-26, Ahmed Nagy PD-0006
   * case): anchoring on the PRORATED mid-month base instead scaled 70% down
   * twice — once from the anchor, once from effNet already being prorated —
   * so a joiner whose prorated net fell below 70% of their real monthly base
   * got an incorrectly-shrunk split instead of everything landing in First
   * Part as intended.
   */
  fullBaseSalary: number;
  paymentMode: PayrollPaymentMode | string | null;
  /** Confirmed Part-1 fingerprint deduction (EGP). */
  fingerprint: number;
  /** Confirmed Part-1 "Other deductions" step total (EGP) — reduces First Part for every employee. */
  otherPart1Deductions?: number;
  /**
   * Special Situations step (owner rule 2026-07-25): a manual addition HR has
   * explicitly routed to the First Part (only offered before Part 1 is
   * confirmed — once frozen, First Part is never recomputed, so routing to
   * "first" after confirm would silently change money already disbursed).
   * The paired deduction, when routed to "first", is folded into
   * `otherPart1Deductions` above instead — same treatment as the 4 other Part 1
   * manual-deduction tabs. Anything routed to "second" instead flows through
   * PartsAdditions.otherAdditions / PartsDeductions.otherDeductions in
   * assembleParts, never here.
   */
  otherPart1Additions?: number;
  /**
   * One-part employees only (owner rule 2026-07-24): they have no Second Part to
   * net medical insurance against, so it must come out of Part 1 directly.
   * Continuing (non-leaver) two-part employees are unaffected — their medical
   * insurance stays netted against a real future Second Part exactly as before.
   * A two-part LEAVER gets a THIRD treatment (owner rule 2026-07-26): folded
   * into the `leaverDeduction` shortfall-netting below instead of subtracted
   * here directly, because at this point in the function a two-part leaver's
   * eventual Second Part isn't known yet — it might still be large enough to
   * absorb medical insurance normally, or (Amany/Eman's case) the whole
   * settlement collapses into First Part, leaving no Second Part to net
   * against and no next month to carry an unrecovered residual to.
   */
  medicalInsurance?: number;
  /**
   * Leaver only (owner rule 2026-07-20, extended 2026-07-26 to include medical
   * insurance for two-part leavers — see medicalInsurance's own doc comment):
   * their CRM no-activity + unpaid-vacation deduction, computed and confirmed
   * at resignation time — a leaver won't be present for the whole-company
   * Part-2 CRM/Vacation steps, so it's settled here instead. Netted against
   * their own remaining Second Part first; any shortfall spills into First
   * Part, since — unlike a continuing employee — a leaver has no next month to
   * carry an unresolved residual to. Ignored for non-leavers.
   */
  leaverDeduction?: number;
};

/**
 * The frozen First Part (first installment), computed at Part-1 confirm.
 *  two_parts: min(Basic, effNet) − fingerprint   (Basic anchor: always the full master base, regardless of lifecycle)
 *  one_part:  effNet − fingerprint − medical insurance (full net in Part 1, per owner rule)
 * Clamped to ≥ 0, then — leavers only — reduced further by whatever part of
 * `leaverDeduction` (CRM/vacation, plus medical insurance for a two-part
 * leaver) their own Second Part can't absorb.
 */
export function freezeFirstPart(input: FreezeFirstPartInput): number {
  const mode = normalizePayrollPaymentMode(input.paymentMode);
  const fp = Math.max(0, roundCurrency(input.fingerprint));
  const otherP1 = Math.max(0, roundCurrency(input.otherPart1Deductions ?? 0));
  const otherP1Additions = Math.max(0, roundCurrency(input.otherPart1Additions ?? 0));
  const medicalInsurance = Math.max(0, roundCurrency(input.medicalInsurance ?? 0));
  // One-part employees only — see FreezeFirstPartInput.medicalInsurance doc comment.
  // Two-part employees (leaver or not) skip this; a two-part leaver's medical
  // insurance is instead folded into the leaverDeduction shortfall below.
  const medicalDirect = mode === "two_parts" ? 0 : medicalInsurance;
  const effNet = input.effective.net;
  const isLeaver = input.effective.lifecycle === "leaver";

  let firstBeforeFp: number;
  if (mode === "two_parts") {
    const basic = calculateBasicSalary({ baseSalary: input.fullBaseSalary });
    firstBeforeFp = Math.min(basic, effNet);
  } else {
    firstBeforeFp = effNet;
  }

  const firstAfterFp = Math.max(0, roundCurrency(firstBeforeFp - fp - otherP1 - medicalDirect + otherP1Additions));
  if (!isLeaver) return firstAfterFp;

  // A two-part leaver's medical insurance was deliberately skipped above
  // (medicalDirect === 0 for two_parts) — fold it in here instead, alongside
  // CRM/vacation, so ALL of a leaver's own deductions net against their
  // remaining Second Part first, with any shortfall — including medical
  // insurance the collapsed settlement leaves no Second Part to absorb —
  // coming out of First Part now instead of a next month that never comes.
  const medicalForLeaverNetting = mode === "two_parts" ? medicalInsurance : 0;
  const leaverDeduction = Math.max(0, roundCurrency((input.leaverDeduction ?? 0) + medicalForLeaverNetting));
  if (leaverDeduction === 0) return firstAfterFp;

  // HOW MUCH SECOND PART THIS LEAVER ACTUALLY HAS, measured from the Part-1 ANCHOR — not from the
  // anchor after his own Part-1 deductions have already come off it.
  //
  // This was `effNet - firstAfterFp`, and firstAfterFp has already had fingerprint, the Part-1
  // other-deduction tabs and (one-part only) medical insurance subtracted. So the remainder it
  // measured WAS those deductions, counted as though they were spare Second Part still available to
  // absorb the leaver's final CRM and vacation charge. The shortfall came out too small, too little
  // was taken off the frozen First Part, and the leaver was paid more than the month owes.
  //
  // Worked, a one-part leaver on 12,000 net with 400 fingerprint, 600 loan, 300 medical and 1,500
  // of final CRM/vacation. A one-part employee has NO second part at all:
  //
  //   before:  firstAfterFp 10,700; provisionalSecond 12,000 - 10,700 = 1,300 (which is exactly the
  //            400 + 600 + 300 already deducted); shortfall 1,500 - 1,300 = 200; frozen 10,500.
  //   after:   provisionalSecond 12,000 - 12,000 = 0; shortfall 1,500; frozen 9,200.
  //
  // The month owes 12,000 - 400 - 600 - 300 - 1,500 = 9,200. The old answer overpaid by 1,300.
  //
  // The overpayment did not even show up as one: assembleParts clamps Second Part to 0 and books the
  // excess as an overpaidResidual to recover next month — from a leaver who has no next month. So it
  // read as a recoverable debt and was neither recoverable nor a debt.
  //
  // For a two-part leaver whose Second Part is genuinely large enough, both forms give the same
  // answer; this only bites where the settlement has collapsed, which is exactly the case the
  // spill-into-First-Part rule exists for.
  const provisionalSecond = Math.max(0, roundCurrency(effNet - firstBeforeFp));
  const shortfall = Math.max(0, roundCurrency(leaverDeduction - provisionalSecond));
  return roundCurrency(Math.max(0, firstAfterFp - shortfall));
}

export type PartsAdditions = {
  expenses: number;
  incentive: number;
  overtime: number;
  bonus: number;
  otherAdditions: number;
};

export type PartsDeductions = {
  fingerprint: number;
  crm: number;
  unpaidVacations: number;
  medicalInsurance: number;
  loans: number;
  otherDeductions: number;
};

export type AssembledParts = {
  firstPart: number;
  secondPart: number;
  monthSalary: number;
  totalPayable: number;
  /** > 0 when Part-2 deductions pushed totalPayable below the frozen First Part (Part-1 overpaid). */
  overpaidResidual: number;
};

/**
 * Given the frozen First Part and the full month's additions/deductions, compute
 * Second Part and Month Salary. totalPayable is taken from the LOCKED engine so
 * the wizard stays byte-consistent with the rest of payroll; only the split is
 * the wizard's rule.
 */
export function assembleParts(input: {
  effective: EffectiveSalary;
  paymentMode: PayrollPaymentMode | string | null;
  firstPartFrozen: number;
  additions: PartsAdditions;
  deductions: PartsDeductions;
}): AssembledParts {
  const mode = normalizePayrollPaymentMode(input.paymentMode);
  const sumAdditions = roundCurrency(
    input.additions.expenses +
      input.additions.incentive +
      input.additions.overtime +
      input.additions.bonus +
      input.additions.otherAdditions,
  );
  const sumDeductions = roundCurrency(
    input.deductions.fingerprint +
      input.deductions.crm +
      input.deductions.unpaidVacations +
      input.deductions.medicalInsurance +
      input.deductions.loans +
      input.deductions.otherDeductions,
  );

  // totalPayable via the locked engine (its own First/Second split is discarded).
  const engineInput = {
    additions: sumAdditions,
    baseSalary: input.effective.base,
    deductions: sumDeductions,
    extraCostOfLiving: input.effective.ecol,
    fuelAllowance: input.effective.fuel,
    netSalary: input.effective.net,
    paymentMode: mode,
    previousExpenses: 0,
    secondPartAdditions: input.additions.expenses + input.additions.incentive,
  };
  const parts = calculatePayrollParts(engineInput);
  const totalPayable = parts.totalPayable;
  // The locked engine floors totalPayable at zero, so deductions larger than the whole month
  // vanished: the residual below was measured from the floor, and anything under it was carried
  // nowhere (audit 2026-11-07, owner: fix it). The same sum, unfloored, on the engine's own net —
  // computed here so the protected policy file is not touched.
  const uncappedPayable = roundCurrency(
    resolveFixedSalaryAmounts(engineInput).netSalary + sumAdditions - sumDeductions,
  );
  const owedBeyondMonth = totalPayable > 0 ? 0 : roundCurrency(Math.max(0, -uncappedPayable));

  const firstPart = roundCurrency(Math.max(0, input.firstPartFrozen));
  let secondPart = roundCurrency(Math.max(0, totalPayable - firstPart));
  let overpaidResidual = 0;
  if (totalPayable + 0.001 < firstPart || owedBeyondMonth > 0) {
    // Part-2 deductions exceeded the already-paid first installment — and, when they exceeded the
    // whole month, by the part the floor hid as well.
    overpaidResidual = roundCurrency(Math.max(0, firstPart - totalPayable) + owedBeyondMonth);
    secondPart = 0;
  }

  const monthSalary = roundCurrency(firstPart + secondPart);
  return { firstPart, secondPart, monthSalary, totalPayable, overpaidResidual };
}
