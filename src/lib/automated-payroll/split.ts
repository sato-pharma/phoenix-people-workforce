import { roundCurrency } from "@/lib/payroll/money";
import {
  calculateBasicSalary,
  calculatePayrollParts,
  normalizePayrollPaymentMode,
  type PayrollPaymentMode,
} from "@/lib/payroll/policy";
import {
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
  /** Unpaid-leave days inside the leaver's settlement span (resignation Rule 1). */
  unpaidDaysInSpan?: number;
  /** HR settlement overrides (from step 1/2 edits); when set they win over the computed proration. */
  overrideBase?: number | null;
  overrideEcol?: number | null;
  overrideFuel?: number | null;
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

  if (input.lifecycle === "leaver" && input.lastWorkingDate) {
    const settlement = computeResignationSettlement({
      baseSalary: base,
      extraCostOfLiving: ecol,
      fuelAllowance: fuel,
      lastWorkingDate: input.lastWorkingDate,
      period: input.period,
      unpaidDaysInSpan: Math.max(0, input.unpaidDaysInSpan ?? 0),
      otherAdditions: 0,
      otherDeductions: 0,
    });
    if (settlement) {
      effBase = settlement.baseForMonth;
      effEcol = settlement.ecolPaid;
      effFuel = settlement.fuelPaid;
      effNet = settlement.netForMonth;
      lifecycle = "leaver";
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

  return { base: effBase, ecol: effEcol, fuel: effFuel, net: effNet, lifecycle };
}

export type FreezeFirstPartInput = {
  effective: EffectiveSalary;
  /** Full master Base — the Basic anchor for a leaver uses the full base (owner Rule 2). */
  fullBaseSalary: number;
  paymentMode: PayrollPaymentMode | string | null;
  /** Confirmed Part-1 fingerprint deduction (EGP). */
  fingerprint: number;
};

/**
 * The frozen First Part (first installment), computed at Part-1 confirm.
 *  two_parts: min(Basic, effNet) − fingerprint   (Basic anchor: leaver → full base, else effective base)
 *  one_part:  effNet − fingerprint                (full net in Part 1, per owner rule)
 * Clamped to ≥ 0.
 */
export function freezeFirstPart(input: FreezeFirstPartInput): number {
  const mode = normalizePayrollPaymentMode(input.paymentMode);
  const fp = Math.max(0, roundCurrency(input.fingerprint));
  const effNet = input.effective.net;

  let firstBeforeFp: number;
  if (mode === "two_parts") {
    const anchorBase =
      input.effective.lifecycle === "leaver" ? input.fullBaseSalary : input.effective.base;
    const basic = calculateBasicSalary({ baseSalary: anchorBase });
    firstBeforeFp = Math.min(basic, effNet);
  } else {
    firstBeforeFp = effNet;
  }

  return roundCurrency(Math.max(0, firstBeforeFp - fp));
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
  const parts = calculatePayrollParts({
    additions: sumAdditions,
    baseSalary: input.effective.base,
    deductions: sumDeductions,
    extraCostOfLiving: input.effective.ecol,
    fuelAllowance: input.effective.fuel,
    netSalary: input.effective.net,
    paymentMode: mode,
    previousExpenses: 0,
    secondPartAdditions: input.additions.expenses + input.additions.incentive,
  });
  const totalPayable = parts.totalPayable;

  const firstPart = roundCurrency(Math.max(0, input.firstPartFrozen));
  let secondPart = roundCurrency(Math.max(0, totalPayable - firstPart));
  let overpaidResidual = 0;
  if (totalPayable + 0.001 < firstPart) {
    // Part-2 deductions exceeded the already-paid first installment.
    overpaidResidual = roundCurrency(firstPart - totalPayable);
    secondPart = 0;
  }

  const monthSalary = roundCurrency(firstPart + secondPart);
  return { firstPart, secondPart, monthSalary, totalPayable, overpaidResidual };
}
