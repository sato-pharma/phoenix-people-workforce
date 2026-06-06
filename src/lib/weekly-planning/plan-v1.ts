import type { PhoenixRole } from "@/lib/auth/permissions";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";

export type EmployeePlanKind = "weekly" | "monthly";

export type EmployeePlanStatus =
  | "draft"
  | "submitted"
  | "manager_approved"
  | "manager_rejected"
  | "manager_returned"
  | "ceo_approved"
  | "ceo_rejected"
  | "ceo_returned"
  | "final_approved"
  | "hr_acknowledged"
  | "cancelled";

export type EmployeePlanAction =
  | "submit"
  | "manager_approve"
  | "manager_reject"
  | "manager_return"
  | "ceo_approve"
  | "ceo_reject"
  | "ceo_return"
  | "hr_acknowledge"
  | "revise"
  | "cancel";

export type EmployeePlanCalendarSyncStatus = "not_ready" | "pending" | "synced" | "blocked" | "failed";

export const employeePlanStatuses = [
  "draft",
  "submitted",
  "manager_approved",
  "manager_rejected",
  "manager_returned",
  "ceo_approved",
  "ceo_rejected",
  "ceo_returned",
  "final_approved",
  "hr_acknowledged",
  "cancelled",
] as const satisfies readonly EmployeePlanStatus[];

export const employeePlanActivityTypes = [
  "Office",
  "Field",
  "Double Visit",
  "Training",
  "Meeting",
  "Event",
  "Travel",
  "Admin",
  "Remote",
  "Vacation",
  "Other",
] as const;

export type EmployeePlanActivityType = (typeof employeePlanActivityTypes)[number];

export const WEEKLY_MONTHLY_PLAN_ELIGIBLE_JOB_TITLES = [
  "Product Manager",
  "Group Product Manager",
  "Training Manager",
  "National Sales Manager",
] as const;

const eligibleRoleSet = new Set<PhoenixRole>(WEEKLY_MONTHLY_PLAN_ELIGIBLE_JOB_TITLES);
const editableStatuses = new Set<EmployeePlanStatus>(["draft", "manager_returned", "ceo_returned"]);
const closedStatuses = new Set<EmployeePlanStatus>([
  "manager_rejected",
  "ceo_rejected",
  "final_approved",
  "hr_acknowledged",
  "cancelled",
]);

type TransitionDefinition = {
  from: EmployeePlanStatus[];
  requiresComment?: boolean;
  to: EmployeePlanStatus;
};

export const EMPLOYEE_PLAN_TRANSITIONS: Record<EmployeePlanAction, TransitionDefinition> = {
  submit: {
    from: ["draft", "manager_returned", "ceo_returned"],
    to: "submitted",
  },
  manager_approve: {
    from: ["submitted"],
    to: "manager_approved",
  },
  manager_reject: {
    from: ["submitted"],
    requiresComment: true,
    to: "manager_rejected",
  },
  manager_return: {
    from: ["submitted"],
    requiresComment: true,
    to: "manager_returned",
  },
  ceo_approve: {
    from: ["manager_approved"],
    to: "final_approved",
  },
  ceo_reject: {
    from: ["manager_approved"],
    requiresComment: true,
    to: "ceo_rejected",
  },
  ceo_return: {
    from: ["manager_approved"],
    requiresComment: true,
    to: "ceo_returned",
  },
  hr_acknowledge: {
    from: ["final_approved", "hr_acknowledged"],
    to: "hr_acknowledged",
  },
  revise: {
    from: ["final_approved", "hr_acknowledged"],
    to: "draft",
  },
  cancel: {
    from: ["draft", "submitted", "manager_returned", "ceo_returned"],
    to: "cancelled",
  },
};

export class EmployeePlanWorkflowError extends Error {
  code: "CLOSED_STATUS" | "INVALID_TRANSITION" | "COMMENT_REQUIRED";

  constructor(code: EmployeePlanWorkflowError["code"], message: string) {
    super(message);
    this.name = "EmployeePlanWorkflowError";
    this.code = code;
  }
}

export function isWeeklyMonthlyPlanEligibleTitle(
  title: string | null | undefined,
  fallbackRole?: PhoenixRole | null,
): boolean {
  const resolved = resolveJobFunctionRole(title);
  if (eligibleRoleSet.has(resolved)) return true;
  return fallbackRole ? eligibleRoleSet.has(fallbackRole) : false;
}

export function canEditEmployeePlanStatus(status: EmployeePlanStatus): boolean {
  return editableStatuses.has(status);
}

export function isClosedEmployeePlanStatus(status: EmployeePlanStatus): boolean {
  return closedStatuses.has(status);
}

export function getNextEmployeePlanStatus(
  currentStatus: EmployeePlanStatus,
  action: EmployeePlanAction,
  options?: { comment?: string | null },
): EmployeePlanStatus {
  const transition = EMPLOYEE_PLAN_TRANSITIONS[action];
  if (!transition.from.includes(currentStatus)) {
    const closed = isClosedEmployeePlanStatus(currentStatus) && action !== "revise" && action !== "hr_acknowledge";
    throw new EmployeePlanWorkflowError(
      closed ? "CLOSED_STATUS" : "INVALID_TRANSITION",
      `Action '${action}' is not allowed from status '${currentStatus}'.`,
    );
  }

  if (transition.requiresComment && !String(options?.comment ?? "").trim()) {
    throw new EmployeePlanWorkflowError("COMMENT_REQUIRED", `Action '${action}' requires a comment.`);
  }

  return transition.to;
}

function toDateOnly(value: Date | string) {
  if (typeof value === "string") {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day));
  }
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function dateString(value: Date) {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}

function sundayOnOrBefore(value: Date) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() - date.getUTCDay());
  return date;
}

function isoWeek(value: Date) {
  const date = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  const dayIndex = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayIndex + 3);
  const year = date.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Monday = new Date(Date.UTC(year, 0, 4 - ((jan4.getUTCDay() + 6) % 7)));
  const week = Math.round((date.getTime() - jan4Monday.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1;
  return { week, year };
}

export function buildEmployeePlanPeriod(kind: EmployeePlanKind, anchor: Date | string) {
  const date = toDateOnly(anchor);
  if (kind === "weekly") {
    const start = sundayOnOrBefore(date);
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 4);
    const { week, year } = isoWeek(start);
    return {
      periodEndDate: dateString(end),
      periodKey: `${year}-W${String(week).padStart(2, "0")}`,
      periodStartDate: dateString(start),
    };
  }

  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  return {
    periodEndDate: dateString(end),
    periodKey: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`,
    periodStartDate: dateString(start),
  };
}

export function employeePlanActionLabel(action: EmployeePlanAction) {
  return action.replace(/_/g, " ");
}
