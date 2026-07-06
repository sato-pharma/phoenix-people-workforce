import { roundCurrency } from "@/lib/payroll/money";

import type {
  SocialInsuranceResult,
  StatutoryConfig,
  StatutoryResult,
  TaxBracket,
} from "./types.ts";

/**
 * Pure Egyptian statutory calculator (income tax + social insurance).
 *
 * Deterministic and I/O-free so it is trivially unit-testable. All money math
 * for the Payroll Copilot's statutory amounts lives here; the config
 * (rates/brackets/caps) is supplied by the caller from the effective-dated
 * payroll_statutory_config table (see config.ts).
 *
 * Phase 2 scope: standard brackets + personal exemption. The high-earner
 * phase-out (>EGP 600k/yr, where the lower bands are progressively removed) is
 * intentionally NOT applied yet — that is a later, separately-verified step.
 */

/** Clamp an insurance/subject wage to the statutory monthly min/max. */
export function clampInsuranceWage(insuranceWage: number, config: StatutoryConfig): number {
  const wage = Number.isFinite(insuranceWage) ? insuranceWage : 0;
  return Math.min(Math.max(wage, config.siMinMonthlyWage), config.siMaxMonthlyWage);
}

/** Employee + employer monthly social-insurance contributions. */
export function computeSocialInsurance(
  insuranceWage: number,
  config: StatutoryConfig,
): SocialInsuranceResult {
  const subjectWage = clampInsuranceWage(insuranceWage, config);
  return {
    subjectWage,
    employee: roundCurrency(subjectWage * config.siEmployeeRate),
    employer: roundCurrency(subjectWage * config.siEmployerRate),
  };
}

/** Apply ordered marginal brackets to an annual taxable amount. */
export function computeAnnualTaxFromBrackets(annualTaxable: number, brackets: TaxBracket[]): number {
  if (annualTaxable <= 0) return 0;
  let tax = 0;
  let lower = 0;
  for (const bracket of brackets) {
    const upper = bracket.upTo ?? Number.POSITIVE_INFINITY;
    const slice = Math.min(annualTaxable, upper) - lower;
    if (slice > 0) tax += slice * bracket.rate;
    lower = upper;
    if (annualTaxable <= upper) break;
  }
  return tax;
}

/**
 * Monthly income tax.
 *
 * annual taxable = (monthlyGross − monthlyEmployeeSI) × 12 − personal exemption,
 * floored at 0 and rounded down to the configured step; brackets applied
 * annually, then divided back to a monthly figure.
 */
export function computeIncomeTax(
  monthlyGross: number,
  monthlyEmployeeSocialInsurance: number,
  config: StatutoryConfig,
  options: { disabled?: boolean } = {},
): number {
  const exemption = options.disabled ? config.disabledExemptionAnnual : config.personalExemptionAnnual;
  const annualNet = (monthlyGross - monthlyEmployeeSocialInsurance) * 12;
  let annualTaxable = annualNet - exemption;
  if (annualTaxable <= 0) return 0;
  if (config.taxableRoundingStep > 0) {
    annualTaxable = Math.floor(annualTaxable / config.taxableRoundingStep) * config.taxableRoundingStep;
  }
  const annualTax = computeAnnualTaxFromBrackets(annualTaxable, config.taxBrackets);
  return roundCurrency(annualTax / 12);
}

/** Combined statutory result for one employee for one month. */
export function computeStatutory(
  input: { monthlyGross: number; insuranceWage: number; disabled?: boolean },
  config: StatutoryConfig,
): StatutoryResult {
  const si = computeSocialInsurance(input.insuranceWage, config);
  const incomeTax = computeIncomeTax(input.monthlyGross, si.employee, config, { disabled: input.disabled });
  return {
    socialInsurance: si.employee,
    employerSocialInsurance: si.employer,
    incomeTax,
    subjectWage: si.subjectWage,
  };
}
