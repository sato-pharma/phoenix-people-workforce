import { roundCurrency } from "@/lib/payroll/money";
import { calculateBaseSalary, calculateBasicSalary } from "@/lib/payroll/policy";
import { computeStatutory } from "@/lib/payroll/statutory/calculator";
import { DEFAULT_STATUTORY_CONFIG } from "@/lib/payroll/statutory/defaults";
import type { StatutoryConfig } from "@/lib/payroll/statutory/types";

/**
 * Employee Master salary auto-fill: you type the NET, everything else follows.
 *
 * The chain, and which half of it the law can touch:
 *
 *   net (typed)  -> cost of living + fuel (by job title)
 *                -> BASE  = net - cost of living - fuel      <- policy.ts, frozen
 *                -> BASIC = base x 70%                       <- policy.ts, frozen
 *                -> insurance wage / social insurance / tax  <- statutory
 *                -> GROSS = base + social insurance + tax    <- policy.ts identity
 *
 * Base, basic and net are pure arithmetic on what the owner typed. No statutory
 * input reaches them, so a change in the law cannot move them. Neither can the
 * TAX: the taxable amount is (gross - employee SI) x 12 - exemption, and
 * gross - SI is identically base + tax, so the taxable base depends on the BASE
 * alone and the insurance wage cancels out of it entirely.
 *
 * What the correct statutory treatment does move is the insurance wage. Law
 * 148/2019 abolished the old basic/variable split in 2020: the insured wage is
 * the whole wage clamped to the monthly floor and ceiling, not a fraction of it.
 * Everything downstream of the wage (the 11% employee share, and therefore the
 * gross) moves with it.
 *
 * Deliberately NOT done here: cost of living and fuel are left OUTSIDE the
 * insured and taxable wage, matching how this payroll has always been run. That
 * is the owner's standing instruction, not an oversight.
 *
 * Pure and I/O-free, because it runs in the browser as the form is typed: it
 * takes its parameters as an argument rather than reading payroll_statutory_config.
 */

/** Every role carries the same fuel allowance. */
export const DEFAULT_FUEL_ALLOWANCE = 500;

/** Roles with no explicit entry below - office staff, all on the same figure. */
export const DEFAULT_EXTRA_COST_OF_LIVING = 1500;

/**
 * Extra cost of living by job title. Derived from the live employee master, where
 * every one of these titles carries exactly one distinct value - this is what the
 * company already pays, not a new scheme. Titles absent here (Admin Assistant,
 * CEO, the HR and Finance roles, QPPV, R&D, SFE, Buffet) all sit on the 1,500
 * default, so the fallback is measured rather than assumed.
 */
export const EXTRA_COST_OF_LIVING_BY_TITLE: Readonly<Record<string, number>> = {
  "medical representative": 2000,
  "district sales manager": 3000,
  "product manager": 3000,
  "group product manager": 3000,
  "marketing manager": 3000,
  "regional sales manager": 3000,
  "training manager": 3000,
  "national sales manager": 5000,
};

function normalizeTitle(jobTitle: string | null | undefined): string {
  return String(jobTitle ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export type TitleAllowances = {
  extraCostOfLiving: number;
  fuelAllowance: number;
};

/** The allowances a job title carries. Unknown titles get the office default. */
export function resolveTitleAllowances(jobTitle: string | null | undefined): TitleAllowances {
  const key = normalizeTitle(jobTitle);
  return {
    extraCostOfLiving: EXTRA_COST_OF_LIVING_BY_TITLE[key] ?? DEFAULT_EXTRA_COST_OF_LIVING,
    fuelAllowance: DEFAULT_FUEL_ALLOWANCE,
  };
}

export type StatutoryBreakdown = {
  /** Wage the contributions are levied on: the gross, clamped to floor/ceiling. */
  insuranceWage: number;
  /** Employee's 11%, a deduction from the gross. */
  socialInsurance: number;
  /** Employer's 18.75%, a company cost that is never part of net pay. */
  employerSocialInsurance: number;
  /** Monthly income tax. */
  taxes: number;
  /** base + socialInsurance + taxes, exactly as policy.ts defines it. */
  grossSalary: number;
};

function netFromGross(gross: number, config: StatutoryConfig) {
  // The insured wage IS the gross (clamped inside computeStatutory), per Law
  // 148/2019 - not gross / 1.3, which is the pre-2020 split this replaces.
  const statutory = computeStatutory({ insuranceWage: gross, monthlyGross: gross }, config);
  return {
    net: gross - statutory.socialInsurance - statutory.incomeTax,
    statutory,
  };
}

/**
 * Invert the deductions: find the gross whose net-of-insurance-and-tax equals
 * `baseSalary`. Bisection rather than algebra because the tax ladder is a step
 * function (the taxable amount is floored to `taxableRoundingStep`), and because
 * bisecting over the real `computeStatutory` guarantees the form can never drift
 * from the payroll engine's own arithmetic.
 */
export function grossUpFromBase(
  baseSalary: number,
  config: StatutoryConfig = DEFAULT_STATUTORY_CONFIG,
): StatutoryBreakdown {
  const base = Number.isFinite(baseSalary) && baseSalary > 0 ? baseSalary : 0;
  if (base <= 0) {
    return {
      insuranceWage: 0,
      socialInsurance: 0,
      employerSocialInsurance: 0,
      taxes: 0,
      grossSalary: 0,
    };
  }

  let low = base;
  let high = base * 2;
  // Grow the bracket rather than assuming one: a future rate change must not
  // silently push the answer outside a hardcoded ceiling.
  for (let i = 0; i < 60 && netFromGross(high, config).net < base; i += 1) {
    low = high;
    high *= 2;
  }

  for (let i = 0; i < 200; i += 1) {
    const mid = (low + high) / 2;
    if (netFromGross(mid, config).net < base) low = mid;
    else high = mid;
  }

  const { statutory } = netFromGross((low + high) / 2, config);

  return {
    insuranceWage: statutory.subjectWage,
    socialInsurance: statutory.socialInsurance,
    employerSocialInsurance: statutory.employerSocialInsurance,
    taxes: statutory.incomeTax,
    // Built forward from the base, never read back off the solver, so that
    // gross - insurance - tax returns the typed base to the cent.
    grossSalary: roundCurrency(base + statutory.socialInsurance + statutory.incomeTax),
  };
}

export type SalaryAutofillInput = {
  netSalary: number;
  jobTitle?: string | null;
  /** Supplied only when the owner has overridden the title's default. */
  extraCostOfLiving?: number | null;
  fuelAllowance?: number | null;
};

export type SalaryAutofillResult = StatutoryBreakdown & {
  extraCostOfLiving: number;
  fuelAllowance: number;
  baseSalary: number;
  basicSalary: number;
  netSalary: number;
};

/** The whole chain, from the one number the owner types. */
export function deriveSalaryFromNet(
  input: SalaryAutofillInput,
  config: StatutoryConfig = DEFAULT_STATUTORY_CONFIG,
): SalaryAutofillResult | null {
  const netSalary = Number(input.netSalary);
  if (!Number.isFinite(netSalary) || netSalary <= 0) return null;

  const defaults = resolveTitleAllowances(input.jobTitle);
  const extraCostOfLiving = Number.isFinite(Number(input.extraCostOfLiving))
    ? Number(input.extraCostOfLiving)
    : defaults.extraCostOfLiving;
  const fuelAllowance = Number.isFinite(Number(input.fuelAllowance))
    ? Number(input.fuelAllowance)
    : defaults.fuelAllowance;

  // policy.ts owns base and basic - this file must never restate those formulas.
  const baseSalary = calculateBaseSalary({ extraCostOfLiving, fuelAllowance, netSalary });
  const basicSalary = calculateBasicSalary({ baseSalary });

  return {
    ...grossUpFromBase(baseSalary, config),
    baseSalary,
    basicSalary,
    extraCostOfLiving: roundCurrency(extraCostOfLiving),
    fuelAllowance: roundCurrency(fuelAllowance),
    netSalary: roundCurrency(netSalary),
  };
}
