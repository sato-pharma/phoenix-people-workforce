// The insurance wage the hiring pack prints — «الأجر التأميني».
//
// OWNER RULE, 2026-08-31: the insurance wage is 1.3 from the BASE salary, and it stops at the legal
// ceiling. He gave the factor and asked which way round it went; he confirmed DIVIDE after seeing
// both figures on a real record. Divide, so the insurance wage sits below the base — base 11,000
// declares 8,462, not 14,300.
//
// This is a PRINTING rule, not a payroll one. Nothing here writes to `employees`, and the social
// insurance actually deducted on a payslip still comes from the stored `social_insurance_wage`
// column, which this deliberately does not touch. THE TWO DISAGREE TODAY and that is worth knowing
// before anyone reconciles a contract against a payslip: the stored column is 70% of base for 114
// of the 148 people who have one — that is the basic salary, not this rule — and it is already
// capped at the same ceiling for the 32 people who reach it. Under this rule those 114 declare
// about 77% of base instead. Reconciling the column to the rule is a payroll change and a data
// migration, and neither has been asked for.

/**
 * The divisor the owner's rule names. Base ÷ this = the declared insurance wage.
 *
 * Not derived from anything and not a payroll formula — it is the company's own declaration rule,
 * which is why it is a plain number here and not in `payroll/policy.ts`.
 */
export const INSURANCE_WAGE_DIVISOR = 1.3;

/**
 * The maximum insurance wage the Authority accepts, in EGP per month.
 *
 * MUST BE UPDATED WHEN THE LAW CHANGES — it is revised most years. 16,700 is the figure production
 * is already using: `social_insurance_wage` tops out at exactly 16,700.00 with 32 employees sitting
 * on it and none above (measured 2026-08-31). Without the cap a base of 90,000 would print 69,231
 * as an insurance wage, which the insurance office will not accept.
 */
export const INSURANCE_WAGE_CEILING = 16_700;

/**
 * The insurance wage to print for someone on this base salary.
 *
 * Returns null for a missing or unusable base, so the contract prints its dotted rule and the fill
 * screen's missing-field warning stands — a figure invented from a null base would be worse than a
 * blank one on a document the insurance office reads.
 *
 * Rounded to whole pounds. A declared insurance wage is a whole number; 8,461.54 is not a figure
 * anyone files, and `formatMoney` would print those piastres on the contract.
 */
export function insuranceWageFromBase(baseSalary: number | null): number | null {
  if (baseSalary === null || !Number.isFinite(baseSalary) || baseSalary <= 0) return null;
  return Math.min(Math.round(baseSalary / INSURANCE_WAGE_DIVISOR), INSURANCE_WAGE_CEILING);
}
