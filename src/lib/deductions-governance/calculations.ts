import type { AccessContext } from "@/lib/auth/permissions";
import type {
  DeductionPayrollColumn,
  DeductionSourceModule,
  DeductionType,
} from "./types.ts";

export function isDeductionsGovernanceDecisionActor(
  access: Pick<AccessContext, "role">,
) {
  return access.role === "Super Admin";
}

export function assertDeductionsGovernanceDecisionActor(
  access: Pick<AccessContext, "role">,
) {
  if (!isDeductionsGovernanceDecisionActor(access)) {
    throw new Error("Forbidden: only Super Admin (HR governance) can approve, finalize, or import deductions.");
  }
}

export function calculateDeductionAmountFromBaseSalary(input: {
  baseSalary: number | null | undefined;
  deductionDays: number;
}) {
  const baseSalary = Number(input.baseSalary ?? 0);
  const deductionDays = Number(input.deductionDays ?? 0);
  if (!Number.isFinite(baseSalary) || baseSalary <= 0) return null;
  if (!Number.isFinite(deductionDays) || deductionDays < 0) return null;
  return Math.round((baseSalary / 30) * deductionDays * 100) / 100;
}

/**
 * Resolves a day-based deduction candidate's payroll amount: the decided
 * amount if one exists (`appliedAmount`, set on approval), otherwise an
 * ESTIMATE from base salary (base / 30 x days) using whichever day count is
 * authoritative (a possibly-edited `appliedDeductionValue`, else the
 * original `deductionValue`). Used to keep "what's shown on the review tab
 * / its xlsx export" and "what's actually deducted on the payroll sheet" in
 * agreement for MANDATORY deductions (e.g. no-activity) that count toward
 * payroll even before HR has explicitly decided them. Returns null only when
 * there is no decided amount AND no base salary to estimate from.
 */
export function resolveDayBasedDeductionAmount(input: {
  decision: { appliedDeductionValue?: number | null; appliedAmount?: number | null } | null | undefined;
  deductionValue: number;
  baseSalary: number | null | undefined;
}): number | null {
  if (input.decision?.appliedAmount != null) return input.decision.appliedAmount;
  const days = input.decision?.appliedDeductionValue ?? input.deductionValue;
  return calculateDeductionAmountFromBaseSalary({ baseSalary: input.baseSalary, deductionDays: days });
}

export function payrollColumnForDeduction(input: {
  deductionType: DeductionType;
  sourceModule: DeductionSourceModule;
}): DeductionPayrollColumn | null {
  if (input.sourceModule === "FIELD_WORKFORCE") return "crm";
  if (input.sourceModule === "ATTENDANCE_DEVICE") return "finger_print";
  // Super-Admin-decided Private Calendar "No Activity Recorded" days (company-wide,
  // not limited to field-force titles) — same payroll meaning as CRM no-activity,
  // so it lands on the same "crm" column rather than needing a new one.
  if (input.sourceModule === "MANUAL_HR" && input.deductionType === "no_activity") return "crm";
  if (
    input.sourceModule === "VACATION" ||
    input.deductionType === "unpaid_leave" ||
    input.deductionType === "leave_without_balance"
  ) {
    return "unpaid_vacations";
  }
  return null;
}

export function payrollColumnLabel(column: DeductionPayrollColumn) {
  if (column === "crm") return "CRM";
  if (column === "finger_print") return "Finger Print";
  return "Unpaid Vacations";
}
