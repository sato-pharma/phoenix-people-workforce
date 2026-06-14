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

export function payrollColumnForDeduction(input: {
  deductionType: DeductionType;
  sourceModule: DeductionSourceModule;
}): DeductionPayrollColumn | null {
  if (input.sourceModule === "FIELD_WORKFORCE") return "crm";
  if (input.sourceModule === "ATTENDANCE_DEVICE") return "finger_print";
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
