import type { AccessContext } from "@/lib/auth/permissions";
import { normalizeHrIdForAccess } from "@/lib/auth/permissions";
import type {
  DeductionPayrollColumn,
  DeductionSourceModule,
  DeductionType,
} from "./types.ts";

const allowedDecisionActorIds = new Set(["adminhr", "b10"]);

function normalizeDecisionActor(value: string | null | undefined) {
  const compact = normalizeHrIdForAccess(value);
  if (compact) return compact;
  const raw = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  return raw || null;
}

export function isDeductionsGovernanceDecisionActor(
  access: Pick<AccessContext, "hrId" | "loginId">,
) {
  const hrId = normalizeDecisionActor(access.hrId);
  const loginId = normalizeDecisionActor(access.loginId);
  return Boolean(
    (hrId && allowedDecisionActorIds.has(hrId)) ||
      (loginId && allowedDecisionActorIds.has(loginId)),
  );
}

export function assertDeductionsGovernanceDecisionActor(
  access: Pick<AccessContext, "hrId" | "loginId">,
) {
  if (!isDeductionsGovernanceDecisionActor(access)) {
    throw new Error("Forbidden: only Admin HR or HR Manager B-10 can approve, finalize, or import deductions.");
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
