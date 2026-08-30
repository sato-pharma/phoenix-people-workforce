/**
 * Flat base-salary / 30 × days deduction amount.
 *
 * Ported VERBATIM from the retired `deductions-governance/calculations.ts` when
 * that module was removed (C6). Automated Payroll's CRM-leave / unpaid-vacation
 * settlement has always divided by a flat 30 — see the `/30` notes in `types.ts`
 * and `step-definitions.ts`. Keeping the exact function local to Automated Payroll
 * preserves every published amount byte-for-byte after the governance module's
 * deletion.
 *
 * ⚠ Do NOT replace this with `@/lib/deductions/calculations`'s same-named
 * `calculateDeductionAmountFromBaseSalary`: that one divides by the ACTUAL number
 * of days in the month (28-31) and requires month/year, so swapping it in would
 * silently change every non-30-day month (a February payslip would move). The two
 * functions deliberately disagree on the divisor — that drift is exactly what the
 * unified module's own comment warns about. This copy is the flat-30 side, on
 * purpose.
 */
export function calculateFlat30DeductionAmount(input: {
  baseSalary: number | null | undefined;
  deductionDays: number;
}): number | null {
  const baseSalary = Number(input.baseSalary ?? 0);
  const deductionDays = Number(input.deductionDays ?? 0);
  if (!Number.isFinite(baseSalary) || baseSalary <= 0) return null;
  if (!Number.isFinite(deductionDays) || deductionDays < 0) return null;
  return Math.round((baseSalary / 30) * deductionDays * 100) / 100;
}
