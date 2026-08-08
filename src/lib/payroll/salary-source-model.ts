import type { PayrollPaymentMode } from "./policy.ts";

export type PayrollSalarySource = {
  baseSalary: number | null;
  employmentIncomeTax: number | null;
  extraCostOfLiving: number | null;
  fuelAllowance: number | null;
  grossSalary: number | null;
  netSalary: number | null;
  paymentMode: PayrollPaymentMode | null;
  socialInsurance: number | null;
  /**
   * True when the employee record itself carries ANY raw compensation figure
   * (base, basic, gross, or net salary as originally entered — before the
   * base-salary derivation chain in policy.ts runs). Optional and populated
   * only by automated-payroll's builder (recommend.ts::buildSalarySource) for
   * data-quality.ts, which needs to tell "nothing entered at all" apart from
   * "a net salary was entered but nets to a zero base once standard
   * allowances are subtracted" — the two read identically once `baseSalary`
   * alone is checked (owner-reported 2026-08-08, real case: 6 August new
   * hires whose entered net salary exactly equals their title's standard
   * ECoL + fuel allowance, e.g. 2500 = 2000 + 500 for a Medical Rep).
   */
  hasAnyRawCompensationFigure?: boolean;
};

export function salarySourceLookupKeys(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw) return [];

  const lower = raw.toLowerCase();
  const compact = lower.replace(/[^a-z0-9]+/g, "");

  return Array.from(new Set([lower, compact].filter(Boolean)));
}
