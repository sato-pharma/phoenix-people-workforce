import type { PhoenixRole } from "@/lib/auth/permissions";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import { hrIdsMatch } from "@/lib/hr-id";
import { secondApproverHrIdForManager } from "@/lib/weekly-planning/second-approver";

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
  "Meeting with Team",
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
// only the AM slot; a `half` day (the Group Product Manager's) needs AM OR PM
// OR a full day. Days with no requirement are off and never block submit.
// ---------------------------------------------------------------------------
export type PlanSlot = "full" | "am" | "pm";
export type PlanWorkweekCategory = "field" | "head_office";
export type PlanDayRequirement = "full" | "am" | "half";

export type PlanWorkweek = {
  category: PlanWorkweekCategory;
  // ISO day-of-week (0=Sun … 6=Sat) → the requirement for that working day.
  // "full" needs a whole day (full entry or AM+PM); "am" needs only the morning;
  // "half" needs one half of the day, either one.
  requiredDays: Record<number, PlanDayRequirement>;
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

// 🔴 The Group Product Manager — and ONLY the Group Product Manager — may plan a working day as AM
// only or PM only; she never has to submit a full day (owner, 2026-10-18: "only the group product
// manager make her okay to work only AM or only PM … doesn't have to submit a full day"). Same
// Sunday–Thursday Head Office week; every working day still needs one half. A Product Manager,
// the Marketing Manager and everyone else keep HEAD_OFFICE_WORKWEEK's full days.
export const GROUP_PRODUCT_MANAGER_WORKWEEK: PlanWorkweek = {
  category: "head_office",
  requiredDays: { 0: "half", 1: "half", 2: "half", 3: "half", 4: "half" },
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
  if (input.role === "Group Product Manager") return GROUP_PRODUCT_MANAGER_WORKWEEK;
  const resolved = resolveJobFunctionRole(input.jobTitle);
  if (fieldForceRoleSet.has(resolved)) return FIELD_WORKWEEK;
  if (resolved === "Group Product Manager") return GROUP_PRODUCT_MANAGER_WORKWEEK;
  return HEAD_OFFICE_WORKWEEK;
}

/** Whether this workweek lets a working day be planned as one half only (AM only or PM only). */
export function planWorkweekAllowsHalfDays(workweek: PlanWorkweek): boolean {
  return Object.values(workweek.requiredDays).includes("half");
}

/**
 * What a working day still lacks, as the suffix the incomplete-day list shows after the day's name:
 * null when the day is complete, "" when nothing is planned on it, " (morning)" for a Field
 * Thursday with no morning, and " (morning missing)" / " (afternoon missing)" for a full day with
 * one half. The editor's banner and the server's submit check both read it, so they cannot drift.
 */
export function planDayGapText(requirement: PlanDayRequirement, present: ReadonlySet<PlanSlot>): string | null {
  if (present.has("full")) return null;
  const hasAm = present.has("am");
  const hasPm = present.has("pm");
  if (requirement === "am") return hasAm ? null : " (morning)";
  if (requirement === "half") return hasAm || hasPm ? null : "";
  if (hasAm && hasPm) return null;
  if (!hasAm && !hasPm) return "";
  return hasAm ? " (afternoon missing)" : " (morning missing)";
}

// Positions that OWN and submit a weekly/monthly plan. Note this is a separate gate from both the
// sidebar flag (showPlansTab) and the `weekly_plans` permission row — a role can hold those two and
// still be rejected here, which is exactly what happened to Regional Manager (owner fix 2026-07-30:
// the RM saw the builder link but got "Forbidden" on submit).
export const WEEKLY_MONTHLY_PLAN_ELIGIBLE_JOB_TITLES = [
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
  "Training Manager",
  "National Sales Manager",
  "Regional Manager",
  "District Manager",
] as const;

const eligibleRoleSet = new Set<PhoenixRole>(WEEKLY_MONTHLY_PLAN_ELIGIBLE_JOB_TITLES);

export function isDistrictManagerPlanTitle(jobTitle: string | null): boolean {
  if (!jobTitle) return false;
  return resolveJobFunctionRole(jobTitle) === "District Manager";
}

/**
 * Whether a plan's approval follows the District Manager pipeline: submit → NSM (or RSM) → HR
 * acknowledge, with no CEO stage.
 *
 * The job title is what someone IS; the app role is what they MAY DO. An acting District Manager
 * keeps her Medical Representative title and holds the District Manager app role (owner rule,
 * 2026-08-22), so the title alone sent Nosiba Salah's plans through a CEO stage DM plans do not
 * have. Either signal is enough. An unknown role (no login row, failed lookup) falls back to the
 * title, which is exactly the rule before 2026-09-13.
 */
export function isDistrictManagerPlanSubmitter(
  jobTitle: string | null,
  submitterAppRole: string | null | undefined,
): boolean {
  if (submitterAppRole === "District Manager") return true;
  return isDistrictManagerPlanTitle(jobTitle);
}

/**
 * The CEO decision a read path may DISPLAY for a plan — `null` whenever that plan kind has no
 * CEO stage at all.
 *
 * A District Manager plan is submit → NSM (or RSM if applicable) → HR acknowledge, with no CEO
 * stage (AGENTS.md §4, owner 2026-09-05). `employee_plan_headers` nevertheless carries a
 * denormalised `ceo_decision_*` copy of what was written to `employee_plan_decisions`, and the
 * two can disagree: every DM `ceo_approve` decision row was deleted on the owner's instruction
 * (42 machine-written rows on 2026-09-05, then the 8 genuine human ones on 2026-09-06) while
 * that header copy stayed behind, so for eight DM plans the audit trail said the CEO approval
 * never happened and the decision-history screens still attributed it to the CEO. Those stamps
 * were cleared in production on 2026-09-06 — but no read path may DEPEND on that having been
 * done, which is the whole point of routing through here.
 *
 * One exception, from 2026-09-20: a District Manager plan whose manager has a configured second
 * approver (second-approver.ts — the DMs reporting to Hany Saad, decided by Ali Mohamed Ali) DOES
 * carry a real second-stage decision in those columns. It is shown only when the stamp was written
 * BY that approver, so a stale stamp from before the rule can never be attributed to him.
 *
 * Ask this helper; never read `row.ceo_decision_at` directly to attribute a decision.
 */
export function resolvePlanCeoDecision(
  employeeJobTitle: unknown,
  ceoDecisionAt: unknown,
  ceoDecisionByHrId: unknown,
  managerHrId?: unknown,
): { decidedAt: string; byHrId: string } | null {
  if (isDistrictManagerPlanTitle(String(employeeJobTitle ?? ""))) {
    const approverHrId = secondApproverHrIdForManager(managerHrId ? String(managerHrId) : null);
    if (!approverHrId || !hrIdsMatch(approverHrId, ceoDecisionByHrId ? String(ceoDecisionByHrId) : null)) {
      return null;
    }
  }
  const decidedAt = ceoDecisionAt ? String(ceoDecisionAt) : "";
  if (!decidedAt) return null;
  return { decidedAt, byHrId: ceoDecisionByHrId ? String(ceoDecisionByHrId) : "" };
}

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
  options?: { comment?: string | null; bypassCeo?: boolean },
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

  // District Manager plans have no CEO stage: their single manager approval IS the final
  // approval, so it jumps straight to final_approved rather than resting at manager_approved
  // and requiring a second, fabricated ceo_approve. Mirrors phx_weekly_plan_next_status's
  // bypass_ceo parameter (migration 20260905183000), the server-side source of truth.
  if (options?.bypassCeo && action === "manager_approve") {
    return "final_approved";
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
 * Whether a chosen WEEKLY plan period starts before the week that contains `todayIso` — i.e. the
 * planner is filing for a week that has already begun or fully elapsed. This is the "off-window"
 * signal behind the wrong-week guard (owner, 2026-09-26): the Plan-week dropdown no longer
 * auto-selects a week, and if the person deliberately picks a past week the builder asks once and
 * the plan is FLAGGED — never blocked.
 *
 * Both sides are week START dates derived through buildEmployeePlanPeriod for the SAME workweek, so
 * a plan for the current week — even one filed on its last working day — is never off-window; only
 * a strictly earlier week is. Monthly plans have no such notion; callers guard on kind before
 * asking. Pure and date-only (UTC arithmetic), so no timezone enters the comparison.
 */
export function isPastPlanWeek(input: {
  periodStartDate: string;
  todayIso: string;
  workweek: PlanWorkweek;
}): boolean {
  const currentWeekStart = buildEmployeePlanPeriod("weekly", input.todayIso, input.workweek).periodStartDate;
  return input.periodStartDate < currentWeekStart;
}

/**
 * Whole days from one YYYY-MM-DD to another. Both sides are date-only and parsed as UTC, so no
 * timezone ever enters the arithmetic and the result is exact.
 */
export function wholeDaysBetween(fromIso: string, toIso: string) {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

/** Shift a YYYY-MM-DD date by whole days. */
export function shiftIsoDate(iso: string, days: number) {
  const base = new Date(`${iso}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/**
 * The destination period, plus the ONE whole-day delta to apply to every item, when a plan is
 * re-dated onto a different period.
 *
 * A single delta for the whole plan is what preserves weekday alignment — a Sunday visit stays on
 * Sunday. Re-deriving each item's new date on its own would not, and shifting the header without
 * the items leaves a plan whose rows sit outside their own period.
 */
export function planPeriodMove(
  planKind: EmployeePlanKind,
  currentPeriodStartDate: string,
  targetAnchorDate: string,
  workweek: PlanWorkweek,
) {
  const target = buildEmployeePlanPeriod(planKind, targetAnchorDate, workweek);
  return { dayDelta: wholeDaysBetween(currentPeriodStartDate, target.periodStartDate), target };
}

/**
 * The required working slot for each date in a period, per the workweek.
 * Returns a Map<YYYY-MM-DD, "full" | "am" | "half"> covering only the days that must be
 * planned. Days not present are off (Fri/Sat for Head Office, Fri for Field).
 */
export function planRequiredSlotsByDate(
  periodStartDate: string,
  periodEndDate: string,
  workweek: PlanWorkweek,
): Map<string, PlanDayRequirement> {
  const required = new Map<string, PlanDayRequirement>();
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
