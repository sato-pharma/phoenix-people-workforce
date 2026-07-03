import type { PhoenixRole } from "@/lib/auth/permissions";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";

export type EmployeePlanKind = "weekly" | "monthly";

export type EmployeePlanStatus =
  | "draft"
  | "submitted"
  | "edit_requested"
  | "details_requested"
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
  | "request_edit"
  | "approve_edit_request"
  | "reject_edit_request"
  | "request_visit_details"
  | "submit_visit_details"
  | "manager_approve"
  | "manager_reject"
  | "manager_return"
  | "ceo_approve"
  | "ceo_reject"
  | "ceo_return"
  | "hr_acknowledge"
  | "revise"
  | "cancel";

export const employeePlanStatuses = [
  "draft",
  "submitted",
  "edit_requested",
  "details_requested",
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
  "National Vacation",
  "Excuse",
  "Other",
] as const;

export type EmployeePlanActivityType = (typeof employeePlanActivityTypes)[number];

// ---------------------------------------------------------------------------
// Role-aware workweek model
//
// In the Egyptian pharma context the official weekend is Friday + Saturday for
// Head Office, but the Field Force (sales) work a Saturday-anchored week:
//   - Field Force (Medical Rep / District / Regional / National Sales Manager):
//       Saturday → Wednesday = full days, Thursday = AM only, Fri off.
//   - Head Office (everyone else: PM / GPM / Marketing / Training / HR …):
//       Sunday → Thursday = full days, Fri + Sat off.
// A plan day is "complete" when every required slot is filled. A `full` day
// needs a full-day entry OR both AM + PM; an `am` day (Field Thursday) needs
// only the AM slot. Days with no requirement are off and never block submit.
// ---------------------------------------------------------------------------
export type PlanSlot = "full" | "am" | "pm";
export type PlanWorkweekCategory = "field" | "head_office";

export type PlanWorkweek = {
  category: PlanWorkweekCategory;
  // ISO day-of-week (0=Sun … 6=Sat) → the requirement for that working day.
  // "full" needs a whole day (full entry or AM+PM); "am" needs only the morning.
  requiredDays: Record<number, "full" | "am">;
  // Day-of-week the planning week is anchored to (6=Saturday, 0=Sunday).
  weekStartDay: number;
};

// Field Force: Sat(6) Sun(0) Mon(1) Tue(2) Wed(3) full, Thu(4) AM only.
export const FIELD_WORKWEEK: PlanWorkweek = {
  category: "field",
  requiredDays: { 0: "full", 1: "full", 2: "full", 3: "full", 4: "am", 6: "full" },
  weekStartDay: 6,
};

// Head Office: Sun(0) Mon(1) Tue(2) Wed(3) Thu(4) full.
export const HEAD_OFFICE_WORKWEEK: PlanWorkweek = {
  category: "head_office",
  requiredDays: { 0: "full", 1: "full", 2: "full", 3: "full", 4: "full" },
  weekStartDay: 0,
};

// Job-function roles that follow the Saturday-anchored Field Force week.
// Only the field-based sales roles: Medical Rep, District Manager (DSM),
// Regional Manager (RM). National Sales Manager is Head Office (Sun–Thu),
// alongside Product Manager / Group Product Manager / Marketing / Training.
const fieldForceRoleSet = new Set<PhoenixRole>([
  "Medical Rep",
  "District Manager",
  "Regional Manager",
]);

/**
 * Classify an employee's planning workweek from their role / job title.
 * Defaults to Head Office (the safe, narrower Sun–Thu week) when unknown.
 */
export function resolvePlanWorkweek(input: {
  jobTitle?: string | null;
  role?: PhoenixRole | null;
}): PlanWorkweek {
  if (input.role && fieldForceRoleSet.has(input.role)) return FIELD_WORKWEEK;
  const resolved = resolveJobFunctionRole(input.jobTitle);
  if (fieldForceRoleSet.has(resolved)) return FIELD_WORKWEEK;
  return HEAD_OFFICE_WORKWEEK;
}

export const WEEKLY_MONTHLY_PLAN_ELIGIBLE_JOB_TITLES = [
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
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
  request_edit: {
    from: ["submitted"],
    to: "edit_requested",
  },
  approve_edit_request: {
    from: ["edit_requested"],
    to: "draft",
  },
  reject_edit_request: {
    from: ["edit_requested"],
    to: "submitted",
  },
  request_visit_details: {
    from: ["submitted"],
    to: "details_requested",
  },
  submit_visit_details: {
    from: ["details_requested"],
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
    from: ["draft", "submitted", "edit_requested", "details_requested", "manager_returned", "ceo_returned"],
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
  const normalizedTitle = String(title ?? "").trim().toLowerCase();
  if (normalizedTitle.includes("admin hr") || normalizedTitle.includes("hr manager")) return true;
  if (fallbackRole === "Super Admin") return true;
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

// Most recent occurrence of `startDay` (0=Sun … 6=Sat) on or before `value`.
function weekStartOnOrBefore(value: Date, startDay: number) {
  const date = new Date(value);
  const delta = (date.getUTCDay() - startDay + 7) % 7;
  date.setUTCDate(date.getUTCDate() - delta);
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

export function buildEmployeePlanPeriod(
  kind: EmployeePlanKind,
  anchor: Date | string,
  // Optional: when omitted, behaves exactly as the legacy Sunday-anchored week
  // (Head Office). Field Force callers pass FIELD_WORKWEEK to anchor on Saturday.
  workweek: PlanWorkweek = HEAD_OFFICE_WORKWEEK,
) {
  const date = toDateOnly(anchor);
  if (kind === "weekly") {
    const start = weekStartOnOrBefore(date, workweek.weekStartDay);
    // Span from the week start through Thursday (4) inclusive.
    const span = (4 - workweek.weekStartDay + 7) % 7;
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + span);
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

/**
 * The required working slot for each date in a period, per the workweek.
 * Returns a Map<YYYY-MM-DD, "full" | "am"> covering only the days that must be
 * planned. Days not present are off (Fri/Sat for Head Office, Fri for Field).
 */
export function planRequiredSlotsByDate(
  periodStartDate: string,
  periodEndDate: string,
  workweek: PlanWorkweek,
): Map<string, "full" | "am"> {
  const required = new Map<string, "full" | "am">();
  const cursor = new Date(`${periodStartDate}T00:00:00Z`);
  const end = new Date(`${periodEndDate}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    const requirement = workweek.requiredDays[cursor.getUTCDay()];
    if (requirement) required.set(cursor.toISOString().slice(0, 10), requirement);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return required;
}

export function employeePlanActionLabel(action: EmployeePlanAction) {
  return action.replace(/_/g, " ");
}
