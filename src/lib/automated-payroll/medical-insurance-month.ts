// ─────────────────────────────────────────────────────────────────────────────────────────────
// Where a payroll month's MEDICAL INSURANCE deduction comes from (owner, 2026-11-24: "in nov payroll remove
// med ins deductions and in december implement everyone med ins deductions from medical insurance module").
//
//   * Up to October 2026: the Employee Master's `medical_insurance` figure, exactly as before (October's own
//     two-part Part 2 waiver stays in assemble.ts, `part2MedicalInsurance`).
//   * November 2026: NOBODY is charged — one-part or two-part, Part 1 or Part 2. The Libano-Suisse policy
//     began on 22 November and the MetLife cover the master's figure priced was cancelled.
//   * December 2026 on: the Medical Insurance module's monthly split, `employeePays` of the employee's own
//     row (their share of their own cover, their spouse and children in full, EGP 85 life insurance a person).
//     Someone not on the register — excluded, or never added — is charged nothing. The master's figure is no
//     longer read and is not edited.
//
// Pure, so one test pins it; recommend.ts is the one caller, and it rewrites each population member's
// `employee.medicalInsurance` here, so Part 1's freeze, Part 2's assembly and the on-screen summary all read
// the same figure.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import type { PayrollMedicalInsuranceCharge } from "@/lib/medical-insurance/monthly-split";
import type { PayrollPeriod } from "@/lib/payroll/period";

/** Payroll months that charge nobody medical insurance (owner, 2026-11-24). */
const MEDICAL_INSURANCE_WAIVED_MONTHS: ReadonlySet<string> = new Set(["2026-11"]);
/** The first payroll month whose medical insurance is the Medical Insurance module's (owner, 2026-11-24). */
export const MEDICAL_INSURANCE_FROM_MODULE_SINCE = "2026-12";

export type PayrollMedicalInsuranceSource = "employee_master" | "waived" | "module";

function monthKey(period: PayrollPeriod): string {
  return `${period.year}-${String(period.month).padStart(2, "0")}`;
}

export function payrollMedicalInsuranceSource(period: PayrollPeriod): PayrollMedicalInsuranceSource {
  const key = monthKey(period);
  if (MEDICAL_INSURANCE_WAIVED_MONTHS.has(key)) return "waived";
  return key >= MEDICAL_INSURANCE_FROM_MODULE_SINCE ? "module" : "employee_master";
}

/** The calendar month whose cover the payroll month charges: its first and last day. */
export function payrollMonthCoverWindow(period: PayrollPeriod): { from: string; to: string } {
  const lastDay = new Date(Date.UTC(period.year, period.month, 0)).getUTCDate();
  const key = monthKey(period);
  return { from: `${key}-01`, to: `${key}-${String(lastDay).padStart(2, "0")}` };
}

export class PayrollMedicalInsuranceError extends Error {}

/**
 * Each employee's medical insurance for the month, by compact HR id, from the module's charges. A covered
 * employee whose row cannot be fully priced (a missing date of birth, an unquoted age) is REFUSED by name:
 * charging the priced part would take too little and say nothing.
 */
export function moduleChargesByCompact(
  charges: readonly PayrollMedicalInsuranceCharge[],
  compact: (hrId: string) => string,
): Map<string, number> {
  const short = charges.filter((charge) => charge.unpriced > 0);
  if (short.length > 0) {
    throw new PayrollMedicalInsuranceError(
      `Medical insurance cannot be priced for ${short.map((charge) => charge.name).join(", ")} — complete them on the Medical Insurance page (date of birth and plan) before this payroll can charge them.`,
    );
  }
  const byCompact = new Map<string, number>();
  for (const charge of charges) {
    const key = compact(charge.hrId);
    if (!key) continue;
    byCompact.set(key, Math.round(((byCompact.get(key) ?? 0) + charge.amount) * 100) / 100);
  }
  return byCompact;
}

/**
 * The medical insurance a population member is charged this month. `masterFigure` is the Employee Master's
 * figure; `moduleCharges` is required for a module month and ignored otherwise.
 */
export function payrollMedicalInsuranceFor(input: {
  source: PayrollMedicalInsuranceSource;
  compact: string;
  masterFigure: number | null;
  moduleCharges: ReadonlyMap<string, number> | null;
}): number | null {
  if (input.source === "employee_master") return input.masterFigure;
  if (input.source === "waived") return 0;
  if (!input.moduleCharges) throw new PayrollMedicalInsuranceError("The Medical Insurance module's charges were not read for this payroll month.");
  return input.moduleCharges.get(input.compact) ?? 0;
}
