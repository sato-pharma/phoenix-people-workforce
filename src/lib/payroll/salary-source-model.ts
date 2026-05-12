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
};

export function salarySourceLookupKeys(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw) return [];

  const lower = raw.toLowerCase();
  const compact = lower.replace(/[^a-z0-9]+/g, "");

  return Array.from(new Set([lower, compact].filter(Boolean)));
}
