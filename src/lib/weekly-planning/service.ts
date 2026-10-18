import crypto from "crypto";

import { writeAuditLog } from "@/lib/admin/audit";
import { DM_PLANS_IN_PHOENIX_CRM, dmPlansInPhoenixCrm } from "@/lib/phoenix-crm/server/manager-plan-switch";
import {
  canonicalPlanningRegionName,
  planningAreaBelongsToRegion,
} from "@/lib/weekly-planning/regions";
import {
  loadPlanningAreaSeats,
  loadPlanningSeatDirectory,
  type PlanningAreaSeat,
  type PlanningSeatDirectory,
} from "@/lib/weekly-planning/planning-areas";

/**
 * Typed errors raised by the weekly-plan state-transition RPCs introduced in
 * migration 20260617090000. The RPC body raises a P0001 exception whose message
 * begins with one of the well-known prefixes below; the supabase-js wrapper
 * surfaces it as `{ message: "weekly_plan_*: ..." }` which we recognise here
 * and rethrow as `WeeklyPlanRpcError`. Route handlers map this class to the
 * right HTTP status (409 for conflict/transition, 404 for not-found).
 */
export type WeeklyPlanRpcErrorCode =
  | "revision_conflict"
  | "invalid_transition"
  | "not_found"
  | "duplicate_period";

export class WeeklyPlanRpcError extends Error {
  code: WeeklyPlanRpcErrorCode;
  status: number;
  constructor(code: WeeklyPlanRpcErrorCode, message: string) {
    super(message);
    this.name = "WeeklyPlanRpcError";
    this.code = code;
    this.status = code === "not_found" ? 404 : 409;
  }
}

function rethrowWeeklyPlanRpcError(error: unknown): never {
  // supabase-js .rpc() returns errors as plain objects { message, code, details, hint }
  // (not PostgrestError instances) unless .throwOnError() is chained.
  const obj = error != null && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const message = error instanceof Error
    ? error.message
    : typeof obj.message === "string"
      ? obj.message
      : String(error ?? "");
  if (message.startsWith("weekly_plan_revision_conflict")) {
    throw new WeeklyPlanRpcError(
      "revision_conflict",
      "This plan was updated by someone else. Refresh and try again.",
    );
  }
  if (message.startsWith("weekly_plan_invalid_transition")) {
    throw new WeeklyPlanRpcError(
      "invalid_transition",
      message.replace(/^weekly_plan_invalid_transition:\s*/, "Invalid plan transition: "),
    );
  }
  if (message.startsWith("weekly_plan_not_found")) {
    throw new WeeklyPlanRpcError("not_found", "Plan was not found.");
  }
  // A unique violation on the plan-header indexes (submit or final approval colliding with another
  // plan for the period, or with another live revision of the same plan) is a conflict the person
  // can act on, not a server fault — and its raw text used to be rewritten by the form into the
  // false "You already have an active plan for this period."
  const uniqueViolation = translatePlanUniqueViolation(message, obj.code);
  if (uniqueViolation) throw new WeeklyPlanRpcError("duplicate_period", uniqueViolation);
  throw error instanceof Error ? error : new Error(message);
}

/** True when the thrown error came from a weekly-plan RPC guard. */
export function isWeeklyPlanRpcError(error: unknown): error is WeeklyPlanRpcError {
  return error instanceof WeeklyPlanRpcError;
}

import {
  assertPermission,
  canAccess,
  normalizeHrIdForAccess,
  resolveNavigationMode,
  type AccessContext,
  type NavigationMode,
  type PhoenixRole,
} from "@/lib/auth/permissions";
import { resolveViewerAllowedLines } from "@/lib/auth/scope-visibility";
import { ACTIVE_EMPLOYMENT_STATUSES_IN_LIST } from "@/lib/auth/session-lifecycle";
import { conversationMessageIdempotencyKey } from "@/lib/conversations/notify";
import { pickDeliverableEmail } from "@/lib/email/email-safety";
import { getEmployeeDirectory, type EmployeeDirectoryData, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import { hrIdForStorage, hrIdLookupKeys } from "@/lib/hr-id";
import type { PlanAdherenceScore } from "@/lib/weekly-planning/plan-adherence";
import { loadPlanAdherenceForPlans } from "@/lib/weekly-planning/plan-adherence-data";
import {
  canPlanMarketingDoubleVisit,
  findMarketingDoubleVisitPartner,
  isMarketingDoubleVisit,
  MARKETING_DOUBLE_VISIT_TITLE,
  marketingDoubleVisitPartners,
  type MarketingDoubleVisitPartner,
} from "@/lib/weekly-planning/marketing-double-visit";
import { getConfirmedNationalHolidays } from "@/lib/vacation/national-holidays";
import { createSystemNotification, type NotificationDeliveryStatus } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import { buildPlanEmailTable } from "@/lib/weekly-planning/email-table";
import { viewerMayEditPlan } from "@/lib/weekly-planning/plan-editor-state";
import { planEmailMetrics, planNounLabel, planSentenceLabel } from "@/lib/weekly-planning/plan-labels";
import {
  isPlanOwnerWithinViewerManagementChain,
  resolvePlanViewerScope,
  type PlanViewerScope,
} from "@/lib/weekly-planning/plan-visibility";
import {
  chooseRevisionTarget,
  dropPendingRevisionsOfPlansOfRecord,
  REVISION_PENDING_MESSAGE,
  translatePlanUniqueViolation,
  type RevisionSibling,
} from "@/lib/weekly-planning/plan-revisions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  isSecondApproverForManager,
  managerHrIdsForSecondApprover,
  planHasSecondApprover,
  secondApproverHrIdForManager,
  secondApproverLabelForManager,
} from "@/lib/weekly-planning/second-approver";
import {
  buildEmployeePlanPeriod,
  canEditEmployeePlanStatus,
  employeePlanActivityTypes,
  getNextEmployeePlanStatus,
  isClosedEmployeePlanStatus,
  isDistrictManagerPlanSubmitter,
  isDistrictManagerPlanTitle,
  isPastPlanWeek,
  isWeeklyMonthlyPlanEligibleTitle,
  planDayGapText,
  movedPlanItemDate,
  planMoveRefusal,
  planPeriodMove,
  planRequiredSlotsByDate,
  planWorkweekAllowsHalfDays,
  resolvePlanWorkweek,
  type EmployeePlanAction,
  type EmployeePlanActivityType,
  type EmployeePlanKind,
  type EmployeePlanStatus,
  type PlanSlot,
  type PlanWorkweek,
} from "@/lib/weekly-planning/plan-v1";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";

export type PlanHeaderRow = {
  ceo_decision_at: string | null;
  ceo_decision_by_hr_id: string | null;
  ceo_decision_comment: string | null;
  created_at: string;
  created_by_login_id: string | null;
  employee_hr_id: string;
  employee_job_title: string | null;
  employee_name: string;
  final_approved_at: string | null;
  hierarchy_snapshot: Record<string, unknown> | null;
  id: string;
  manager_decision_at: string | null;
  manager_decision_by_hr_id: string | null;
  manager_decision_comment: string | null;
  manager_hr_id: string | null;
  manager_name: string | null;
  off_window_flagged: boolean | null;
  parent_plan_id: string | null;
  period_end_date: string;
  period_key: string;
  period_start_date: string;
  plan_kind: EmployeePlanKind;
  revision: number;
  status: EmployeePlanStatus;
  submitted_at: string | null;
  submitted_by_login_id: string | null;
  updated_at: string;
  employee_plan_items?: PlanItemRow[];
  employee_plan_hr_acknowledgements?: PlanAckRow[];
  employee_plan_decisions?: PlanDecisionRow[];
};

type PlanVisitDetailRow = {
  id: string;
  plan_id: string;
  item_id: string;
  doctor_name: string;
  speciality: string;
  address: string;
  objective: string;
  sort_order: number;
};

type PlanItemRow = {
  activity_date: string;
  activity_title: string;
  activity_type: EmployeePlanActivityType;
  area: string | null;
  attendees: string | null;
  double_visit_medical_rep_hr_id: string | null;
  double_visit_medical_rep_name: string | null;
  end_time: string | null;
  id: string;
  location_text: string | null;
  notes: string;
  objective: string | null;
  plan_id: string;
  sort_order: number;
  start_time: string | null;
  employee_plan_item_return_notes?: PlanReturnNoteRow[];
  employee_plan_visit_details?: PlanVisitDetailRow[];
};

type PlanAckRow = {
  acknowledged_at: string;
  comment: string | null;
  hr_id: string;
  id: string;
  login_id: string | null;
  plan_id: string;
  role_label: string | null;
};

type PlanDecisionRow = {
  action: EmployeePlanAction;
  actor_hr_id: string | null;
  actor_role: string | null;
  comment: string | null;
  created_at: string;
  from_status: EmployeePlanStatus;
  id: string;
  to_status: EmployeePlanStatus;
};

type PlanReturnNoteRow = {
  action: Extract<EmployeePlanAction, "manager_return" | "ceo_return">;
  actor_hr_id: string | null;
  actor_login_id: string | null;
  actor_role: string | null;
  activity_date: string | null;
  activity_title: string | null;
  created_at: string;
  id: string;
  item_id: string | null;
  note: string;
  plan_id: string;
  sort_order: number | null;
};

type AuthUserRow = {
  auth_email?: string | null;
  hr_id?: string | null;
  is_active?: boolean | null;
  login_id?: string | null;
  name?: string | null;
  role?: string | null;
};

export type EmployeePlanItemInput = {
  activityDate: string;
  activityTitle: string;
  activityType: EmployeePlanActivityType;
  area?: string | null;
  attendees?: string | null;
  doubleVisitMedicalRepHrId?: string | null;
  doubleVisitMedicalRepName?: string | null;
  endTime?: string | null;
  locationText?: string | null;
  notes?: string | null;
  objective?: string | null;
  sortOrder?: number;
  startTime?: string | null;
};

export type VisitDetail = {
  id: string;
  doctorName: string;
  speciality: string;
  address: string;
  objective: string;
  sortOrder: number;
};

export type VisitDetailInput = {
  itemId: string;
  doctorName: string;
  speciality: string;
  address: string;
  objective: string;
  sortOrder: number;
};

export type EmployeePlanReturnNote = {
  action: Extract<EmployeePlanAction, "manager_return" | "ceo_return">;
  actorHrId: string | null;
  actorRole: string | null;
  createdAt: string;
  id: string;
  note: string;
};

export type EmployeePlanReturnNoteInput = {
  itemId: string;
  note: string;
};

// One row of the plan's approval/decision history (employee_plan_decisions).
export type EmployeePlanDecision = {
  action: EmployeePlanAction;
  actorHrId: string | null;
  // The decider's name, resolved against the employee directory (nickname-aware). Only populated by
  // getEmployeePlansWorkspace; other mapPlan() callers leave it undefined and the history prints the
  // role alone — it never prints the HR id.
  actorName?: string | null;
  actorRole: string | null;
  comment: string | null;
  createdAt: string;
  fromStatus: EmployeePlanStatus;
  id: string;
  toStatus: EmployeePlanStatus;
};

// One message in the plan's two-way conversation (employee_plan_comments). Unlike
// employee_plan_decisions (an append-only status-transition log) and
// employee_plan_item_return_notes (approver-only, per-row), this is a genuine
// thread: the submitter and any participant in the approval chain (manager, CEO,
// HR/Super Admin) can post regardless of the plan's current status.
export type EmployeePlanComment = {
  authorHrId: string;
  authorName: string | null;
  authorRole: string | null;
  body: string;
  createdAt: string;
  id: string;
  itemId: string | null;
  parentId: string | null;
  planId: string;
};

export type EmployeePlan = {
  /**
   * How closely this plan matched what the CRM recorded — undefined when nobody scored it.
   *
   * Populated by getEmployeePlansWorkspace for the VIEWER'S OWN plans only, and left undefined for
   * everyone else's. That bound is deliberate and is not a silent cap: the workspace can hold up to
   * WORKSPACE_PLAN_LIMIT plans across a whole team, and scoring all of them would mean one CRM
   * evidence read per distinct owner on every page load. An approver who wants a subordinate's
   * score opens the plan in the approvals hub, which scores any single plan on demand.
   */
  adherence?: PlanAdherenceScore | null;
  acknowledgements: Array<{
    acknowledgedAt: string;
    comment: string | null;
    hrId: string;
    roleLabel: string | null;
  }>;
  decisions: EmployeePlanDecision[];
  employeeHrId: string;
  employeeJobTitle: string | null;
  employeeName: string;
  // Nickname-aware display name (nickname when set, else employeeName). Only
  // populated by callers with employee-directory access (see
  // getEmployeePlansWorkspace); other mapPlan() callers leave this undefined and
  // consumers should fall back to employeeName.
  employeeDisplayName?: string;
  finalApprovedAt: string | null;
  id: string;
  items: Array<{
    activityDate: string;
    activityTitle: string;
    activityType: EmployeePlanActivityType;
    area: string | null;
    attendees: string | null;
    doubleVisitMedicalRepHrId: string | null;
    doubleVisitMedicalRepName: string | null;
    endTime: string | null;
    id: string;
    locationText: string | null;
    notes: string;
    objective: string | null;
    returnNotes: EmployeePlanReturnNote[];
    sortOrder: number;
    startTime: string | null;
    visitDetails: VisitDetail[];
  }>;
  managerHrId: string | null;
  managerName: string | null;
  // Nickname-aware display name (nickname when set, else managerName). Only
  // populated by callers with employee-directory access (see
  // getEmployeePlansWorkspace); other mapPlan() callers leave this undefined and
  // consumers should fall back to managerName.
  managerDisplayName?: string | null;
  // True when this weekly plan was filed for a week that had already begun or elapsed at creation
  // (the wrong-week guard, owner 2026-09-26). A review marker only — never blocks anything.
  offWindowFlagged: boolean;
  periodEndDate: string;
  periodKey: string;
  periodStartDate: string;
  planKind: EmployeePlanKind;
  revision: number;
  status: EmployeePlanStatus;
  submittedAt: string | null;
  updatedAt: string;
};

export type EmployeePlansSummary = {
  ceoPending: number;
  detailsRequested: number;
  drafts: number;
  finalApproved: number;
  hrAcknowledged: number;
  managerPending: number;
  rejected: number;
  returned: number;
  submitted: number;
};

export type EmployeePlansWorkspace = {
  canAcknowledgeHr: boolean;
  canMovePlanPeriod: boolean;
  /** Product Managers and Group Product Managers only — see marketing-double-visit.ts. */
  canPlanMarketingDoubleVisit: boolean;
  canSubmitPlans: boolean;
  hasMorePlans: boolean;
  /**
   * His week is planned in Phoenix CRM now (`dmPlansInPhoenixCrm`), so this page is his HISTORY: every plan
   * he filed on this form before, to read only (owner, 2026-10-17). False for everyone else.
   */
  plansInPhoenixCrm: boolean;
  /** Who a Marketing Double Visit can be with: active PMs, GPMs and the Marketing Manager, never the owner. */
  marketingDoubleVisitPartners: MarketingDoubleVisitPartner[];
  /**
   * Managers whose District Manager plans this viewer decides the SECOND stage for (second-approver.ts).
   * Empty for nearly everyone — it is what puts a plan resting at manager_approved in his review queue.
   */
  secondApproverManagerHrIds: string[];
  loadedPlanCount: number;
  planLimit: number;
  currentEmployee: {
    areaName: string | null;
    fullName: string;
    hrId: string;
    jobTitle: string | null;
    managerHrId: string | null;
    managerName: string | null;
    regionCode: string | null;
    regionName: string | null;
    /** The DM district the AU seat model states for the owner — the Area picker's first authority. */
    seatRegionCode: string | null;
    workweek: PlanWorkweek;
  } | null;
  /** AU seat-model areas for the plan owner's line — the authority behind the Area picker. */
  planningAreaSeats: PlanningAreaSeat[];
  medicalRepOptions: Array<{
    areaName: string | null;
    fullName: string;
    hrId: string;
    lineName: string | null;
    regionName: string | null;
  }>;
  plans: EmployeePlan[];
  schemaReady: boolean;
  summary: EmployeePlansSummary;
};

const planSelect = `
  *,
  employee_plan_items (*, employee_plan_item_return_notes (*), employee_plan_visit_details (*)),
  employee_plan_hr_acknowledgements (*),
  employee_plan_decisions (*)
`;

const WORKSPACE_PLAN_LIMIT = 250;

// Statuses that never became "the plan of record" for their period — a plan that
// died here (or was never submitted at all) leaves no live claim on the period, so
// a fresh submission shouldn't be blocked by it. 'draft' is included deliberately,
// matching the original employee_plan_headers_active_period_uidx design: an
// unsubmitted draft is a private scratchpad, not a claim on the period, so multiple
// stray/abandoned drafts for the same period are harmless and pre-existing (found
// in staging while verifying this fix). Every other status — including
// final_approved/hr_acknowledged, the actual gap this check closes — is a real
// submission and must block a second, unlinked plan for the same employee/period.
// See assertNoActivePlanForSamePeriod.
const DUPLICATE_PERIOD_IGNORED_STATUSES = new Set<EmployeePlanStatus>([
  "draft",
  "cancelled",
  "manager_rejected",
  "ceo_rejected",
]);

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function nullableText(value: unknown) {
  const cleaned = cleanText(value);
  return cleaned ? cleaned : null;
}

function isStrictIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function assertItemDateInPeriod(activityDate: string, periodStartDate: string, periodEndDate: string) {
  if (!isStrictIsoDate(activityDate)) {
    throw new Error("Plan item activityDate must be a valid YYYY-MM-DD date.");
  }
  if (activityDate < periodStartDate || activityDate > periodEndDate) {
    throw new Error(`Plan item activityDate must stay inside the selected period (${periodStartDate} to ${periodEndDate}).`);
  }
}

function normalizeHrId(value: string | null | undefined) {
  return normalizeHrIdForAccess(value) ?? "";
}

function hrIdsMatch(left: string | null | undefined, right: string | null | undefined) {
  return Boolean(normalizeHrId(left) && normalizeHrId(left) === normalizeHrId(right));
}

function normalizedName(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

function isSchemaMissing(error: unknown) {
  const text = error instanceof Error ? error.message : JSON.stringify(error);
  return /employee_plan_headers|employee_plan_items|employee_plan_item_return_notes|employee_plan_visit_details|double_visit_medical_rep|schema cache|does not exist|PGRST205|42P01/i.test(text);
}

function mapReturnNotes(item: PlanItemRow): EmployeePlanReturnNote[] {
  return (item.employee_plan_item_return_notes ?? [])
    .map((note) => ({
      action: note.action,
      actorHrId: note.actor_hr_id,
      actorRole: note.actor_role,
      createdAt: note.created_at,
      id: note.id,
      note: note.note,
    }))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function mapPlan(row: PlanHeaderRow): EmployeePlan {
  return {
    acknowledgements: (row.employee_plan_hr_acknowledgements ?? []).map((ack) => ({
      acknowledgedAt: ack.acknowledged_at,
      comment: ack.comment,
      hrId: ack.hr_id,
      roleLabel: ack.role_label,
    })),
    decisions: (row.employee_plan_decisions ?? [])
      .map((d) => ({
        action: d.action,
        actorHrId: d.actor_hr_id,
        actorRole: d.actor_role,
        comment: d.comment,
        createdAt: d.created_at,
        fromStatus: d.from_status,
        id: d.id,
        toStatus: d.to_status,
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    employeeHrId: row.employee_hr_id,
    employeeJobTitle: row.employee_job_title,
    employeeName: row.employee_name,
    finalApprovedAt: row.final_approved_at,
    id: row.id,
    items: (row.employee_plan_items ?? [])
      .map((item) => ({
        activityDate: item.activity_date,
        activityTitle: item.activity_title,
        activityType: item.activity_type,
        area: item.area,
        attendees: item.attendees,
        doubleVisitMedicalRepHrId: item.double_visit_medical_rep_hr_id,
        doubleVisitMedicalRepName: item.double_visit_medical_rep_name,
        endTime: item.end_time,
        id: item.id,
        locationText: item.location_text,
        notes: item.notes,
        objective: item.objective,
        returnNotes: mapReturnNotes(item),
        sortOrder: item.sort_order,
        startTime: item.start_time,
        visitDetails: (item.employee_plan_visit_details ?? [])
          .map((d) => ({
            id: d.id,
            doctorName: d.doctor_name,
            speciality: d.speciality,
            address: d.address,
            objective: d.objective,
            sortOrder: d.sort_order,
          }))
          .sort((a, b) => a.sortOrder - b.sortOrder),
      }))
      .sort((a, b) => `${a.activityDate}-${a.sortOrder}`.localeCompare(`${b.activityDate}-${b.sortOrder}`)),
    managerHrId: row.manager_hr_id,
    managerName: row.manager_name,
    offWindowFlagged: Boolean(row.off_window_flagged),
    periodEndDate: row.period_end_date,
    periodKey: row.period_key,
    periodStartDate: row.period_start_date,
    planKind: row.plan_kind,
    revision: row.revision,
    status: row.status,
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
  };
}

function emptyPlansSummary(): EmployeePlansSummary {
  return {
    ceoPending: 0,
    detailsRequested: 0,
    drafts: 0,
    finalApproved: 0,
    hrAcknowledged: 0,
    managerPending: 0,
    rejected: 0,
    returned: 0,
    submitted: 0,
  };
}

function summarizePlans(plans: EmployeePlan[]): EmployeePlansSummary {
  const summary = emptyPlansSummary();
  for (const plan of plans) {
    if (plan.status === "draft") summary.drafts += 1;
    if (plan.status === "submitted") {
      summary.submitted += 1;
      summary.managerPending += 1;
    }
    if (plan.status === "details_requested") summary.detailsRequested += 1;
    if (plan.status === "manager_approved") {
      if (!isDistrictManagerPlanTitle(plan.employeeJobTitle)) {
        summary.ceoPending += 1;
      }
    }
    if (plan.status === "final_approved") summary.finalApproved += 1;
    if (plan.status === "hr_acknowledged") summary.hrAcknowledged += 1;
    if (plan.status.includes("returned")) summary.returned += 1;
    if (plan.status.includes("rejected")) summary.rejected += 1;
  }
  return summary;
}

function employeeTitle(employee: EmployeeDirectoryRow | null | undefined, fallbackRole?: PhoenixRole) {
  return employee?.positionTitle ?? employee?.jobTitle ?? fallbackRole ?? null;
}

function canSubmitFromEmployee(employee: EmployeeDirectoryRow | null, role: PhoenixRole) {
  return isWeeklyMonthlyPlanEligibleTitle(employeeTitle(employee, role), role);
}

function isMedicalRepEmployee(employee: EmployeeDirectoryRow) {
  const title = `${employee.positionTitle ?? ""} ${employee.jobTitle ?? ""}`.toLowerCase();
  return title.includes("medical rep") || title.includes("medical representative");
}

function isActiveEmployee(employee: EmployeeDirectoryRow) {
  return ["active", "on_leave", ""].includes(normalizedName(employee.employmentStatus));
}

function isSameLine(employee: EmployeeDirectoryRow, owner: EmployeeDirectoryRow) {
  if (employee.lineId && owner.lineId) return employee.lineId === owner.lineId;
  const employeeLine = normalizedName(employee.lineName);
  const ownerLine = normalizedName(owner.lineName);
  return Boolean(employeeLine && ownerLine && employeeLine === ownerLine);
}

// Training Manager has org-wide training oversight (see canSeeEmployee in
// permissions.ts) so, unlike PM/GPM/NSM, their Double Visit medical-rep pool
// must span every line rather than just the line on their own employee row.
function isOrgWidePlanningEmployee(employee: EmployeeDirectoryRow | null, fallbackRole?: PhoenixRole) {
  if (fallbackRole === "Training Manager") return true;
  return resolveJobFunctionRole(employeeTitle(employee, fallbackRole)) === "Training Manager";
}

// National Sales Manager sits at the top of the sales chain, reporting directly to the CEO
// with no "manager of manager" above them, so manager_hr_id may legitimately be unset.
// createEmployeePlan uses this to let NSM submit without a manager on record instead of
// hard-blocking; the manager stage itself is still a real CEO decision (see
// assertManagerReviewer/notifyManager's null-manager fallbacks and decideEmployeePlan's
// manager_approve -> ceo_approve cascade for the CEO).
function isNationalSalesManagerEmployee(employee: EmployeeDirectoryRow | null, fallbackRole?: PhoenixRole) {
  if (fallbackRole === "National Sales Manager") return true;
  return resolveJobFunctionRole(employeeTitle(employee, fallbackRole)) === "National Sales Manager";
}

// Region -> area cascade shows every area in the region for every activity type, including
// ones whose Medical Rep seat is currently vacant (or never hired) — Single Visit never
// assigns a rep at all, and Double Visit/Coaching now allow picking such an area too, simply
// auto-assigning no rep (see areaHasAssignableRep/autoMedicalRepForArea). Rather than two data
// sources, we fold open Medical Rep position_vacancies (already loaded via
// getEmployeeDirectory().lookups) into the same options array with a "Vacant" fullName, so
// isVacantMedicalRepOption can tell a real rep apart from an open seat wherever a caller
// needs to (auto-assign, submit validation), without a second lookup.
function vacantMedicalRepOptionsForEmployee(
  vacancies: EmployeeDirectoryData["lookups"]["medicalRepVacancies"],
  employee: EmployeeDirectoryRow,
  orgWide: boolean,
  overrideLineKeys: Set<string> | null,
) {
  return vacancies
    .filter((vacancy) => Boolean(vacancy.areaName) && vacancy.areaName !== "Unknown Area")
    .filter((vacancy) => {
      if (orgWide) return true;
      if (overrideLineKeys) return overrideLineKeys.has(normalizedName(vacancy.lineName));
      if (typeof vacancy.lineId === "number" && typeof employee.lineId === "number") {
        return vacancy.lineId === employee.lineId;
      }
      const vacancyLine = normalizedName(vacancy.lineName);
      const employeeLine = normalizedName(employee.lineName);
      return Boolean(vacancyLine && employeeLine && vacancyLine === employeeLine);
    })
    .map((vacancy) => ({
      areaName: vacancy.areaName,
      fullName: "Vacant Medical Rep Seat",
      hrId: `vacancy:${vacancy.vacancyCode}`,
      lineName: vacancy.lineName,
      regionName: vacancy.regionName,
    }));
}

/** The owner's line seat map, for the submit-time area check. Fails soft to an empty list,
 *  which makes that check pass everything rather than block a submission on a read failure. */
async function planningSeatsForOwner(owner: EmployeeDirectoryRow | null): Promise<PlanningAreaSeat[]> {
  try {
    return await loadPlanningAreaSeats(owner?.lineId ?? null);
  } catch {
    return [];
  }
}

async function medicalRepOptionsForEmployee(
  employee: EmployeeDirectoryRow | null,
  orgWide = false,
  allowedLineNames: string[] | null = null,
  seatDirectory: PlanningSeatDirectory | null = null,
) {
  if (!employee) return [];
  const directory = await getEmployeeDirectory();
  // A rep whose employee row has a blank area_name is invisible to every area-keyed lookup
  // (auto-assign, areaHasAssignableRep), so the area the seat model now offers had no rep
  // behind it. Five occupied areas are in that state, Beni Suef among them. Fails soft: an
  // unreachable seat view leaves the roster exactly as it was.
  const seats = seatDirectory ?? (await loadPlanningSeatDirectory().catch(() => null));
  // When the plan owner has a multi-line scope override (e.g. a Product Manager
  // covering both Pedia and Anti infective), the double-visit rep pool must span
  // every scoped line, not just the single line on their own employee row. With
  // no override we keep the historical same-line behaviour, so normal PMs are
  // unaffected.
  const overrideLineKeys = allowedLineNames && allowedLineNames.length > 0
    ? new Set(allowedLineNames.map((line) => normalizedName(line)).filter(Boolean))
    : null;
  const activeOptions = directory.employees
    .filter((candidate) => candidate.hrId !== employee.hrId)
    .filter(isActiveEmployee)
    .filter(isMedicalRepEmployee)
    .filter((candidate) =>
      orgWide ||
      (overrideLineKeys
        ? overrideLineKeys.has(normalizedName(candidate.lineName))
        : isSameLine(candidate, employee)),
    )
    .map((candidate) => ({
      areaName: candidate.areaName?.trim() || seats?.areaByHrId.get(normalizeHrId(candidate.hrId)) || null,
      fullName: candidate.displayName,
      hrId: candidate.hrId,
      lineName: candidate.lineName,
      regionName: candidate.regionName,
    }));
  const vacantOptions = vacantMedicalRepOptionsForEmployee(
    directory.lookups.medicalRepVacancies,
    employee,
    orgWide,
    overrideLineKeys,
  );
  return [...activeOptions, ...vacantOptions].sort((left, right) => left.fullName.localeCompare(right.fullName));
}

function isHrReviewer(access: AccessContext, _employee: EmployeeDirectoryRow | null) {
  return access.role === "Super Admin";
}

function canViewPlan(
  access: AccessContext,
  employee: EmployeeDirectoryRow | null,
  plan: PlanHeaderRow,
  scope: PlanViewerScope | null = null,
) {
  if (access.role === "Super Admin" || access.scope === "system") return true;
  if (hrIdsMatch(access.hrId, plan.employee_hr_id)) return true;
  if (hrIdsMatch(access.hrId, plan.manager_hr_id)) return true;
  if (access.role === "CEO") return true;
  if (isHrReviewer(access, employee) && ["final_approved", "hr_acknowledged"].includes(plan.status)) return true;
  // Skip-level visibility: scope is the viewer's precomputed downward management chain
  // (resolvePlanViewerScope), built ONCE per request by the caller. Callers that never
  // compute it (none today) simply pass nothing and this branch stays inert.
  if (scope && isPlanOwnerWithinViewerManagementChain(plan.employee_hr_id, scope)) return true;
  // Second approver (second-approver.ts) reads all his DMs' plans, every status and period.
  if (isSecondApproverForManager(access.hrId, plan.manager_hr_id)) return true;
  return false;
}

// The rule itself is viewerMayEditPlan - the plans workspace calls the very same function to decide
// whether to offer Save / Submit / Add day, so the editor never offers what this answers with 403.
function assertPlanOwner(access: AccessContext, plan: PlanHeaderRow) {
  if (!viewerMayEditPlan({ planOwnerHrId: plan.employee_hr_id, viewerHrId: access.hrId, viewerRole: access.role })) {
    throw new Error("Forbidden: only the employee can edit this plan.");
  }
}

// Super Admin has NO standing bypass here — he may decide a manager-stage plan only if he
// personally is the assigned manager (hrIdsMatch below already covers that case like anyone
// else). Owner-confirmed rule: Super Admin cannot act on someone else's turn — his own place in
// the chain is the final HR-acknowledge step (see acknowledgeEmployeePlan/isHrReviewer), not a
// stand-in for the direct manager or CEO.
//
// Exception: a plan with no manager_hr_id at all (e.g. a National Sales Manager plan — NSM
// reports directly to the CEO with no manager of manager, and createEmployeePlan allows them
// to submit without a manager on record) has no one who could ever satisfy hrIdsMatch. The
// CEO — NSM's real direct manager either way — decides this stage instead.
async function assertManagerReviewer(access: AccessContext, plan: PlanHeaderRow) {
  if (!plan.manager_hr_id) {
    if (access.role !== "CEO") {
      throw new Error("Forbidden: only the direct manager can decide this plan.");
    }
    return;
  }
  if (!hrIdsMatch(access.hrId, plan.manager_hr_id)) {
    throw new Error("Forbidden: only the direct manager can decide this plan.");
  }
  const directory = await getEmployeeDirectory();
  const managerEmployee = directory.employees.find((emp) => hrIdsMatch(emp.hrId, plan.manager_hr_id));
  if (managerEmployee && !isActiveEmployee(managerEmployee)) {
    throw new Error("Forbidden: only an active direct manager can decide this plan.");
  }
}

// Same rule as assertManagerReviewer — only the actual CEO decides this stage; Super Admin's
// authority does not extend to standing in for the CEO.
function assertCeoReviewer(access: AccessContext) {
  if (access.role !== "CEO") {
    throw new Error("Forbidden: only the CEO can decide this stage.");
  }
}

// Only the named second approver decides that stage of a District Manager plan whose manager has
// one — the same identity rule as assertManagerReviewer (no CEO, no Super Admin stand-in), and an
// inactive approver decides nothing.
async function assertSecondApprover(access: AccessContext, plan: PlanHeaderRow) {
  if (!isSecondApproverForManager(access.hrId, plan.manager_hr_id)) {
    throw new Error(
      `Forbidden: only ${secondApproverLabelForManager(plan.manager_hr_id) ?? "the assigned second approver"} can decide this stage of a plan reporting to ${plan.manager_name ?? "this manager"}.`,
    );
  }
  const directory = await getEmployeeDirectory();
  const approver = directory.employees.find((emp) => hrIdsMatch(emp.hrId, access.hrId));
  if (approver && !isActiveEmployee(approver)) {
    throw new Error("Forbidden: only an active second approver can decide this plan.");
  }
}

type MarketingDoubleVisitContext = {
  allowed: boolean;
  partners: MarketingDoubleVisitPartner[];
};

// The owner-side half of Marketing Double Visit: whether this plan owner is offered it, and the
// people they may pick. An owner who is not offered it gets an empty list, so the picker can never
// carry a name the submit check would then refuse.
async function marketingDoubleVisitContextFor(
  employee: EmployeeDirectoryRow | null,
  role: PhoenixRole,
): Promise<MarketingDoubleVisitContext> {
  if (!employee || !canPlanMarketingDoubleVisit(employeeTitle(employee, role), role)) {
    return { allowed: false, partners: [] };
  }
  const directory = await getEmployeeDirectory();
  return {
    allowed: true,
    partners: marketingDoubleVisitPartners(
      directory.employees.filter(isActiveEmployee).map((candidate) => ({
        fullName: candidate.fullName,
        hrId: candidate.hrId,
        jobTitle: employeeTitle(candidate),
      })),
      employee.hrId,
    ),
  };
}

type NormalizeItemsOptions = {
  /** Omitted by a caller that never offers the option: a Marketing Double Visit then cannot be submitted. */
  marketingDoubleVisit?: MarketingDoubleVisitContext;
  submit?: boolean;
  /**
   * The AU seat map for the plan owner's line. Empty when it could not be loaded, which makes
   * the area check below pass everything — the picker's narrowing is a convenience, and a
   * transient read failure must never block a submission.
   */
  planningSeats?: readonly PlanningAreaSeat[];
};

type PlanningMedicalRepOption = {
  areaName?: string | null;
  fullName: string;
  hrId: string;
  lineName?: string | null;
};

function isVacantMedicalRepOption(rep: PlanningMedicalRepOption) {
  const text = `${rep.fullName ?? ""} ${rep.hrId ?? ""}`.toLowerCase();
  return /\bvacan(t|cy)\b/.test(text);
}

// Within a single line an area maps to exactly one rep, so the historical
// behaviour of taking the first non-vacant match is safe. Once an org-wide
// caller (Training Manager) supplies reps from every line, the same area can
// have one rep per line; auto-fill only when that's still unambiguous and
// otherwise require the caller to send an explicit doubleVisitMedicalRepHrId
// (the client resolves this once both Line and Area are picked).
function autoMedicalRepForArea(options: PlanningMedicalRepOption[], area: string | null) {
  if (!area) return null;
  const candidates = options.filter(
    (rep) => normalizedName(rep.areaName) === normalizedName(area) && !isVacantMedicalRepOption(rep),
  );
  return candidates.length === 1 ? candidates[0] : null;
}

// Whether an area has any real (non-vacant) rep at all, regardless of line disambiguation —
// used to tell "this area genuinely has no medical rep" (submittable with no rep attached)
// apart from "a rep exists here but couldn't be auto-resolved" (still a required gap).
function areaHasAssignableRep(options: PlanningMedicalRepOption[], area: string | null) {
  if (!area) return false;
  return options.some(
    (rep) => normalizedName(rep.areaName) === normalizedName(area) && !isVacantMedicalRepOption(rep),
  );
}

function validActivityType(value: string): EmployeePlanActivityType {
  if (value === "Coaching") return "Other";
  if (value === MARKETING_DOUBLE_VISIT_TITLE) return "Other";
  if (value === "Single Visit") return "Field";
  if ((employeePlanActivityTypes as readonly string[]).includes(value)) return value as EmployeePlanActivityType;
  return "Other";
}

function activityDisplayLabel(value: EmployeePlanActivityType) {
  return value === "Field" ? "Single Visit" : value;
}

function isCoachingActivity(activityType: EmployeePlanActivityType, activityTitle: string) {
  return activityType === "Other" && activityTitle.toLowerCase() === "coaching";
}

function normalizeTrainingFormat(value: unknown) {
  const cleaned = cleanText(value);
  return ["Zoom", "Physical", "Other"].includes(cleaned) ? cleaned : null;
}

function activityUsesGeography(activityType: EmployeePlanActivityType, isCoaching: boolean) {
  return isCoaching || !["Office", "Admin", "Remote", "Vacation", "Training"].includes(activityType);
}

function activityRequiresGeography(activityType: EmployeePlanActivityType, isCoaching: boolean) {
  return isCoaching || activityType === "Field" || activityType === "Double Visit";
}

function activityRequiresRep(activityType: EmployeePlanActivityType, isCoaching: boolean) {
  return isCoaching || activityType === "Double Visit";
}

function normalizeItems(
  items: EmployeePlanItemInput[],
  periodStartDate: string,
  periodEndDate: string,
  medicalRepOptions: PlanningMedicalRepOption[],
  options: NormalizeItemsOptions = {},
): EmployeePlanItemInput[] {
  const fallback: EmployeePlanItemInput = {
    activityDate: periodStartDate,
    activityTitle: "Office",
    activityType: "Office",
    sortOrder: 0,
  };
  const repByHrId = new Map(medicalRepOptions.map((option) => [normalizeHrId(option.hrId), option]));
  const normalized = items.length > 0 ? items : [fallback];
  return normalized.map((item, index) => ({
    ...normalizeItem(item, index, periodStartDate, periodEndDate, repByHrId, medicalRepOptions, options),
  }));
}

function normalizeItem(
  item: EmployeePlanItemInput,
  index: number,
  periodStartDate: string,
  periodEndDate: string,
  repByHrId: Map<string, PlanningMedicalRepOption>,
  medicalRepOptions: PlanningMedicalRepOption[],
  options: NormalizeItemsOptions,
): EmployeePlanItemInput & { doubleVisitMedicalRepName?: string | null } {
  const activityDate = cleanText(item.activityDate) || periodStartDate;
  assertItemDateInPeriod(activityDate, periodStartDate, periodEndDate);

  const rawActivityType = cleanText(item.activityType);
  const activityType = validActivityType(rawActivityType);
  const activityTitle = rawActivityType === "Coaching" ? "Coaching" : cleanText(item.activityTitle);
  const isCoaching = rawActivityType === "Coaching" || isCoachingActivity(activityType, activityTitle);
  const isMarketingVisit = !isCoaching && isMarketingDoubleVisit(rawActivityType, activityTitle);
  const activityLabel = isCoaching
    ? "Coaching"
    : isMarketingVisit
      ? MARKETING_DOUBLE_VISIT_TITLE
      : activityDisplayLabel(activityType);
  // A Marketing Double Visit asks for a region and an area exactly as Coaching does, but never
  // for a Medical Rep — its partner is a marketing colleague, resolved below.
  const usesGeography = activityUsesGeography(activityType, isCoaching || isMarketingVisit);
  const requiresGeography = activityRequiresGeography(activityType, isCoaching || isMarketingVisit);
  const requiresRep = activityRequiresRep(activityType, isCoaching);
  const locationText = activityType === "Training"
    ? normalizeTrainingFormat(item.locationText)
    : usesGeography
      ? canonicalPlanningRegionName(item.locationText)
      : null;
  const area = usesGeography ? nullableText(item.area) : null;
  const rawSelectedRepHrId = requiresRep ? nullableText(item.doubleVisitMedicalRepHrId) : null;
  let selectedRep: PlanningMedicalRepOption | null = null;
  let selectedRepHrId: string | null = null;
  let selectedRepName: string | null = null;
  if (rawSelectedRepHrId) {
    const rep = repByHrId.get(normalizeHrId(rawSelectedRepHrId));
    if (!rep) {
      if (options.submit) {
        throw new Error("Selected double-visit Medical Rep is not available for this employee line.");
      }
    } else if (isVacantMedicalRepOption(rep)) {
      if (options.submit) {
        throw new Error("Selected Medical Rep is not assigned to the selected area.");
      }
    } else {
      selectedRep = rep;
      selectedRepHrId = rawSelectedRepHrId;
      selectedRepName = rep.fullName;
    }
  }
  if (requiresRep && area && !selectedRep) {
    selectedRep = autoMedicalRepForArea(medicalRepOptions, area);
    selectedRepHrId = selectedRep?.hrId ?? null;
    selectedRepName = selectedRep?.fullName ?? null;
  }
  if (options.submit && requiresGeography && !locationText) {
    throw new Error(`${activityLabel} requires selecting an approved region.`);
  }
  if (options.submit && requiresGeography && !area) {
    throw new Error(`${activityLabel} requires selecting an area.`);
  }
  // The Area picker narrows to the owner's district, but until now nothing server-side looked
  // at the area at all — any string was stored. This is the backstop. It rejects only an area
  // the seat map KNOWS and files under a different region; a spelling the map has never heard
  // of passes, because 48 of the 325 live plan rows carry legacy spellings ("Gharbia (1)",
  // "Tanta") that people cannot be asked to fix mid-plan.
  if (
    options.submit &&
    area &&
    locationText &&
    !planningAreaBelongsToRegion(options.planningSeats ?? [], locationText, area)
  ) {
    throw new Error(`"${area}" is not an area of ${locationText}. Pick an area from the list.`);
  }
  // An area with no real rep at all (vacant seat or none) is a valid, submittable choice —
  // it's only a real gap when a rep does exist for the area but couldn't be resolved (e.g.
  // an org-wide caller submitting without picking the disambiguating line).
  if (options.submit && requiresRep && !selectedRepHrId && areaHasAssignableRep(medicalRepOptions, area)) {
    throw new Error(`${isCoaching ? "Coaching" : "Double Visit"} requires an assigned same-line Medical Rep for the selected area.`);
  }
  if (
    options.submit &&
    requiresRep &&
    area &&
    selectedRep?.areaName &&
    normalizedName(selectedRep.areaName) !== normalizedName(area)
  ) {
    throw new Error("Selected Medical Rep is not assigned to the selected area.");
  }
  // The partner is stored by NAME in `attendees` and is always re-read against the live list, so a
  // submitted name that is not an active PM, GPM or Marketing Manager — or is the owner — never lands.
  let attendees = nullableText(item.attendees);
  if (isMarketingVisit) {
    const context = options.marketingDoubleVisit;
    if (options.submit && !context?.allowed) {
      throw new Error("Marketing Double Visit is only for Product Managers and Group Product Managers.");
    }
    const partner = findMarketingDoubleVisitPartner(context?.partners ?? [], attendees);
    if (options.submit && !partner) {
      throw new Error(
        attendees
          ? `"${attendees}" is not a Product Manager, Group Product Manager or Marketing Manager you can double-visit with.`
          : "Marketing Double Visit requires choosing who you are visiting with.",
      );
    }
    if (partner) attendees = partner.fullName;
  }
  return {
    activityDate,
    activityTitle: isCoaching || isMarketingVisit ? activityLabel : activityTitle || activityDisplayLabel(activityType),
    activityType,
    area,
    attendees,
    doubleVisitMedicalRepHrId: requiresRep ? selectedRepHrId : null,
    doubleVisitMedicalRepName: requiresRep ? selectedRepName : null,
    endTime: nullableText(item.endTime),
    locationText,
    notes: cleanText(item.notes),
    objective: nullableText(item.objective),
    sortOrder: Number.isFinite(item.sortOrder) ? Number(item.sortOrder) : index,
    startTime: nullableText(item.startTime),
  };
}

async function currentEmployee(access: AccessContext) {
  const directory = await getEmployeeDirectory();
  const viewerHrId = normalizeHrId(access.hrId);
  return directory.employees.find((employee) => normalizeHrId(employee.hrId) === viewerHrId) ?? null;
}

// Same lookup as currentEmployee, but keeps the full directory instead of discarding it —
// callers that also need resolvePlanViewerScope (skip-level plan visibility) get it for the
// price of a lookup they were already paying, with no extra query.
async function currentEmployeeWithDirectory(access: AccessContext) {
  const directory = await getEmployeeDirectory();
  const viewerHrId = normalizeHrId(access.hrId);
  const employee = directory.employees.find((row) => normalizeHrId(row.hrId) === viewerHrId) ?? null;
  return { directory, employee };
}

// Guards createEmployeePlan against spawning a second, unlinked header for a
// period that already has a live one (the B-122 duplicate-week incident: two
// independent headers both reached hr_acknowledged for the same week because
// nothing stopped a brand-new plan from being created instead of using the
// existing revise flow on updateEmployeePlan, which links via parent_plan_id
// and is unaffected by this check). Only a revision of a DEAD plan (rejected or
// cancelled) calls it, because that revision is a fresh, unlinked claim on the period.
async function assertNoActivePlanForSamePeriod(
  employeeHrId: string,
  planKind: EmployeePlanKind,
  period: { periodEndDate: string; periodStartDate: string },
) {
  const { data, error } = await getSupabaseAdmin()
    .from("employee_plan_headers")
    .select("id,status")
    .eq("employee_hr_id", employeeHrId)
    .eq("plan_kind", planKind)
    .eq("period_start_date", period.periodStartDate)
    .eq("period_end_date", period.periodEndDate);
  if (error) throw error;
  const active = ((data ?? []) as Array<{ id: string; status: EmployeePlanStatus }>).find(
    (row) => !DUPLICATE_PERIOD_IGNORED_STATUSES.has(row.status),
  );
  if (active) {
    throw new WeeklyPlanRpcError(
      "duplicate_period",
      `A ${planKind} plan already exists for ${period.periodStartDate} to ${period.periodEndDate} (status: ${active.status}). Edit or revise that plan instead of creating a new one.`,
    );
  }
}

async function loadPlanRow(planId: string): Promise<PlanHeaderRow> {
  const { data, error } = await getSupabaseAdmin()
    .from("employee_plan_headers")
    .select(planSelect)
    .eq("id", planId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Plan was not found.");
  return data as PlanHeaderRow;
}

/** Every revision header already linked to one plan, whatever its status. */
async function loadRevisionSiblings(parentPlanId: string): Promise<RevisionSibling[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("employee_plan_headers")
    .select("id,status,revision,created_at")
    .eq("parent_plan_id", parentPlanId);
  if (error) throw error;
  return ((data ?? []) as Array<{ created_at: string; id: string; revision: number; status: EmployeePlanStatus }>).map((row) => ({
    createdAt: row.created_at,
    id: row.id,
    revision: row.revision,
    status: row.status,
  }));
}

/**
 * Take back a revision draft this request just spawned when the write that was meant to fill it
 * failed. Only a DRAFT is deleted (never a header that reached any other status), the items,
 * decisions and comments go with it through ON DELETE CASCADE, and a failure here is logged rather
 * than thrown — the caller is already rethrowing the error that matters.
 */
async function discardUnsubmittedRevision(planId: string) {
  const { error } = await getSupabaseAdmin()
    .from("employee_plan_headers")
    .delete()
    .eq("id", planId)
    .eq("status", "draft");
  if (error) {
    logError("Weekly plan revision draft could not be taken back after a failed write", {
      labels: { event: "weekly_plan_revision_discard_failed", planId },
      error,
    });
  }
}

function planItemsRpcPayload(items: EmployeePlanItemInput[]) {
  return items.map((item) => ({
    activityDate: item.activityDate,
    activityTitle: item.activityTitle,
    activityType: item.activityType,
    area: item.area ?? null,
    attendees: item.attendees ?? null,
    doubleVisitMedicalRepHrId: item.doubleVisitMedicalRepHrId ?? null,
    doubleVisitMedicalRepName: "doubleVisitMedicalRepName" in item ? item.doubleVisitMedicalRepName ?? null : null,
    endTime: item.endTime ?? null,
    locationText: item.locationText ?? null,
    notes: item.notes ?? "",
    objective: item.objective ?? null,
    sortOrder: item.sortOrder ?? 0,
    startTime: item.startTime ?? null,
  }));
}

async function recordDecision(input: {
  access: AccessContext;
  action: EmployeePlanAction;
  comment?: string | null;
  fromStatus: EmployeePlanStatus;
  planId: string;
  toStatus: EmployeePlanStatus;
}) {
  const { error } = await getSupabaseAdmin().from("employee_plan_decisions").insert({
    action: input.action,
    actor_hr_id: hrIdForStorage(input.access.hrId),
    actor_login_id: input.access.loginId ?? null,
    actor_role: input.access.role,
    comment: input.comment ?? null,
    from_status: input.fromStatus,
    plan_id: input.planId,
    to_status: input.toStatus,
  });
  if (error) throw error;
}

/**
 * Atomic state-transition wrappers around the SECURITY DEFINER functions
 * introduced in migration 20260617090000. Each call bundles
 *   SELECT FOR UPDATE header → revision-match guard → UPDATE header →
 *   INSERT into employee_plan_decisions (+ return-notes for return actions)
 * into a single Postgres transaction. The revision column is the optimistic-
 * lock token; concurrent callers with the same expected_revision lose with
 * a `weekly_plan_revision_conflict` exception that the route layer maps to
 * HTTP 409. Notifications stay outside the RPC: they were never the source
 * of the drift bug and remain best-effort.
 */
async function rpcReplacePlanItems(input: {
  access: AccessContext;
  expectedRevision: number;
  items: EmployeePlanItemInput[];
  planId: string;
  submit: boolean;
}) {
  const { error } = await getSupabaseAdmin().rpc("phx_weekly_plan_replace_items", {
    p_actor_hr_id: hrIdForStorage(input.access.hrId),
    p_actor_login_id: input.access.loginId ?? null,
    p_actor_role: input.access.role,
    p_expected_revision: input.expectedRevision,
    p_items: planItemsRpcPayload(input.items),
    p_plan_id: input.planId,
    p_submit: input.submit,
  });
  if (error) rethrowWeeklyPlanRpcError(error);
}

async function rpcDecidePlan(input: {
  access: AccessContext;
  action: Extract<EmployeePlanAction, "manager_approve" | "manager_reject" | "manager_return" | "ceo_approve" | "ceo_reject" | "ceo_return">;
  comment?: string | null;
  expectedRevision: number;
  planId: string;
  returnNotes?: EmployeePlanReturnNoteInput[];
  // District Manager plans skip the CEO stage: a manager_approve with this flag lands the plan
  // on final_approved in one decision, writing NO ceo_approve row (see migration 20260905183000).
  bypassCeo?: boolean;
}) {
  const { error } = await getSupabaseAdmin().rpc("phx_weekly_plan_decide", {
    p_action: input.action,
    p_actor_hr_id: hrIdForStorage(input.access.hrId),
    p_actor_login_id: input.access.loginId ?? null,
    p_actor_role: input.access.role,
    p_comment: input.comment ?? null,
    p_expected_revision: input.expectedRevision,
    p_plan_id: input.planId,
    p_return_notes: (input.returnNotes ?? [])
      .map((note) => ({ itemId: cleanText(note.itemId), note: cleanText(note.note) }))
      .filter((note) => note.itemId && note.note),
    p_bypass_ceo: input.bypassCeo ?? false,
  });
  if (error) rethrowWeeklyPlanRpcError(error);
}

async function rpcAcknowledgePlan(input: {
  comment?: string | null;
  expectedRevision: number;
  hrId: string;
  loginId: string | null;
  planId: string;
  roleLabel: string | null;
}) {
  const { error } = await getSupabaseAdmin().rpc("phx_weekly_plan_acknowledge", {
    p_comment: input.comment ?? null,
    p_expected_revision: input.expectedRevision,
    p_hr_id: hrIdForStorage(input.hrId),
    p_login_id: input.loginId,
    p_plan_id: input.planId,
    p_role_label: input.roleLabel,
  });
  if (error) rethrowWeeklyPlanRpcError(error);
}

async function rpcCancelPlan(input: {
  access: AccessContext;
  comment?: string | null;
  expectedRevision: number;
  planId: string;
}) {
  const { error } = await getSupabaseAdmin().rpc("phx_weekly_plan_cancel", {
    p_actor_hr_id: hrIdForStorage(input.access.hrId),
    p_actor_login_id: input.access.loginId ?? null,
    p_actor_role: input.access.role,
    p_comment: input.comment ?? null,
    p_expected_revision: input.expectedRevision,
    p_plan_id: input.planId,
  });
  if (error) rethrowWeeklyPlanRpcError(error);
}

// Note: row-level return notes are now written inside phx_weekly_plan_decide
// (migration 20260617090000). The previous recordReturnNotes() helper was
// retired with the atomicity rewire and no longer has a caller.

async function rpcRequestEditPlan(input: {
  access: AccessContext;
  expectedRevision: number;
  planId: string;
}) {
  const { error } = await getSupabaseAdmin().rpc("phx_weekly_plan_request_edit", {
    p_actor_hr_id: hrIdForStorage(input.access.hrId),
    p_actor_login_id: input.access.loginId ?? null,
    p_actor_role: input.access.role,
    p_expected_revision: input.expectedRevision,
    p_plan_id: input.planId,
  });
  if (error) rethrowWeeklyPlanRpcError(error);
}

async function rpcDecideEditRequest(input: {
  access: AccessContext;
  comment?: string | null;
  decision: "approve" | "reject";
  expectedRevision: number;
  planId: string;
}) {
  const { error } = await getSupabaseAdmin().rpc("phx_weekly_plan_decide_edit_request", {
    p_actor_hr_id: hrIdForStorage(input.access.hrId),
    p_actor_login_id: input.access.loginId ?? null,
    p_actor_role: input.access.role,
    p_comment: input.comment ?? null,
    p_decision: input.decision,
    p_expected_revision: input.expectedRevision,
    p_plan_id: input.planId,
  });
  if (error) rethrowWeeklyPlanRpcError(error);
}

// Work emails for a set of recipients, keyed by the canonical HR id.
//
// `hrIdLookupKeys` rather than the canonical key alone. `normalizeHrId` lower-cases ("A-7" ->
// "a-7") while `employees.hr_id` is stored UPPER-case in 185 of 186 rows, so the previous
// `.in("hr_id", [canonical])` matched ZERO employees on every call — measured against production
// on 2026-09-03: the lowercase form returned 0 rows where the stored form returned 3. It failed
// silently and in exactly one direction: the To address is resolved downstream by
// createSystemNotification from recipientHrId, so mail still went out, but the cc list is built
// HERE and could therefore never be anything but empty. Every weekly-plan email ever sent carried
// an empty cc because of this line, which is why fixing the addressing alone would not have
// produced a single copied recipient.
async function loadRecipientEmailMap(recipients: Array<{ hrId: string | null }>) {
  const hrIds = Array.from(new Set(
    recipients.flatMap((recipient) => hrIdLookupKeys(recipient.hrId)),
  ));
  const output = new Map<string, string>();
  if (hrIds.length === 0) return output;
  const { data, error } = await getSupabaseAdmin()
    .from("employees")
    .select("hr_id,work_email")
    .in("hr_id", hrIds);
  if (error) return output;
  for (const row of (data ?? []) as Array<{ hr_id?: string | null; work_email?: string | null }>) {
    const hrId = normalizeHrId(row.hr_id);
    const email = pickDeliverableEmail(row.work_email);
    if (hrId && email) output.set(hrId, email);
  }
  return output;
}

async function notifyRecipients(input: {
  actionUrl: string;
  additionalMetadata?: Record<string, unknown>;
  emailCcRecipients?: Array<{ email?: string | null; hrId: string | null; userId?: string | null }>;
  emailMode?: "none" | "primary_to_cc";
  eventType: string;
  message: string;
  /**
   * Identifier of THIS message — the comment row's id, threaded through to
   * `conversationMessageIdempotencyKey` in conversations/notify.ts. `createSystemNotification` keys
   * an event on { actionUrl, eventType, module, recipient, title }, and a growing thread's title and
   * action url never change between its messages, so without this the second comment onwards
   * collapses onto the first one's event and is silently dropped. Omit for a one-off event (a plan
   * submitted, a decision recorded) that only ever fires once per recipient for a given plan.
   */
  messageKey?: string | number | null;
  plan: PlanHeaderRow;
  recipients: Array<{ email?: string | null; hrId: string | null; userId?: string | null }>;
  title: string;
}) {
  // The actual submitted plan rows ride along so the weekly_plans email template can
  // render them as a table via the {{planTable}} variable.
  const planTable = buildPlanEmailTable(input.plan.employee_plan_items);
  const recipients = input.recipients.filter((recipient) => recipient.hrId || recipient.userId);
  if (recipients.length === 0) return;
  const emailMode = input.emailMode ?? "primary_to_cc";
  const emailRefs = [
    ...recipients,
    ...(input.emailCcRecipients ?? []),
  ].filter((recipient): recipient is { email?: string | null; hrId: string | null; userId?: string | null } => Boolean(recipient?.hrId || recipient?.userId));
  const emailByHrId = await loadRecipientEmailMap(emailRefs);
  const emailFor = (recipient: { email?: string | null; hrId: string | null }) =>
    pickDeliverableEmail(recipient.email, emailByHrId.get(normalizeHrId(recipient.hrId)));
  // Prefer the first recipient who actually has a deliverable email as "primary" — a
  // synthetic account (e.g. PHX-1) with no work_email must not silently swallow the
  // whole email, including the cc'd real addresses, just by sorting first.
  const primaryIndex = emailMode === "none" ? 0 : Math.max(0, recipients.findIndex((recipient) => Boolean(emailFor(recipient))));
  const primaryRecipient = recipients[primaryIndex];
  const primaryKey = normalizeHrId(primaryRecipient.hrId) || primaryRecipient.userId || "";
  const primaryEmail = emailMode === "none" ? null : emailFor(primaryRecipient);
  const ccSource = input.emailCcRecipients ?? recipients.filter((_, index) => index !== primaryIndex);
  const ccEmails = emailMode === "none" ? [] : Array.from(new Set(
    ccSource
      .map((recipient) => emailFor(recipient))
      .filter((email): email is string => Boolean(email)),
  ));
  await Promise.all(recipients
    .map((recipient) => {
      const idempotencyKey = conversationMessageIdempotencyKey(
        { eventType: input.eventType, messageKey: input.messageKey, module: "weekly_plans", recordId: input.plan.id },
        normalizeHrId(recipient.hrId) || recipient.userId || "",
      );
      return createSystemNotification({
        actionUrl: input.actionUrl,
        category: "general",
        channels: emailMode !== "none" && (normalizeHrId(recipient.hrId) || recipient.userId || "") === primaryKey ? ["in_app", "email", "telegram", "push"] : ["in_app", "telegram", "push"],
        ...(emailMode !== "none" && (normalizeHrId(recipient.hrId) || recipient.userId || "") === primaryKey
          ? {
              email: {
                cc: ccEmails,
                metrics: planEmailMetrics(input.plan),
                planTableHtml: planTable.html,
                planTableText: planTable.text,
                recipients: primaryEmail ? [primaryEmail] : undefined,
              },
            }
          : {}),
        eventType: input.eventType,
        message: input.message,
        metadata: {
          planId: input.plan.id,
          planKind: input.plan.plan_kind,
          periodKey: input.plan.period_key,
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...input.additionalMetadata,
        },
        module: "weekly_plans",
        priority: "high",
        recordId: input.plan.id,
        recipientHrId: recipient.hrId,
        recipientUserId: recipient.userId,
        subjectHrId: input.plan.employee_hr_id,
        title: input.title,
      });
    }));
}

async function resolveSuperAdminRecipients() {
  const { data, error } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select("login_id,hr_id")
    .eq("role", "Super Admin")
    .eq("is_active", true);
  if (error) return [];
  return ((data ?? []) as Array<{ hr_id?: string | null; login_id?: string | null }>).map((row) => ({
    hrId: row.hr_id ?? null,
    userId: row.login_id ?? null,
  }));
}

async function authUsersByRole(role: PhoenixRole) {
  const { data, error } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select("login_id,hr_id,name,auth_email,role")
    .eq("role", role);
  if (error) return [];
  return (data ?? []) as AuthUserRow[];
}

/**
 * Answers "does this person hold the District Manager app role?" for many plans with one read —
 * acting District Managers included, whose job title says Medical Representative.
 */
export async function loadDistrictManagerAppRoleMatcher(): Promise<(hrId: string | null | undefined) => boolean> {
  const rows = await authUsersByRole("District Manager");
  const keys = new Set(rows.map((row) => normalizeHrId(row.hr_id)).filter(Boolean));
  return (hrId) => {
    const key = normalizeHrId(hrId);
    return Boolean(key) && keys.has(key);
  };
}

export async function authRoleForHrId(hrId: string | null | undefined): Promise<PhoenixRole | null> {
  // app_auth_users.hr_id is stored in canonical display form (e.g. "B-10"), never the
  // separator-stripped comparison key normalizeHrId produces ("b10") - querying by the
  // stripped form silently matched nothing for every hyphenated id.
  const lookupHrId = hrIdForStorage(hrId);
  if (!lookupHrId) return null;
  const { data, error } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select("role")
    .eq("hr_id", lookupHrId)
    .maybeSingle();
  if (error || !data) return null;
  const role = (data as { role?: string | null }).role;
  return role ? (role as PhoenixRole) : null;
}

/**
 * The manager-review notification must deep-link to the shell the recipient
 * actually lives in. Admin-shell managers (e.g. Marketing Manager, Super Admin,
 * CEO) review at /admin/weekly-plans; portal managers (e.g. National Sales /
 * Group Product Manager) review at /employee-portals/plans. Pointing everyone at
 * the portal page silently bounced admin-shell managers to /overview, which is
 * how a submitted plan could appear to "go nowhere". Defaults to the admin shell
 * when the role can't be resolved (portal managers always have a login row).
 */
async function planReviewActionUrl(hrId: string | null | undefined, planId: string): Promise<string> {
  let mode: NavigationMode = "admin";
  try {
    const role = await authRoleForHrId(hrId);
    if (role) {
      mode = resolveNavigationMode({ hrId: normalizeHrId(hrId), role, scope: "self", source: "session" });
    }
  } catch {
    // best-effort — fall back to the admin shell review page
  }
  // Approver review lands on the dedicated Approvals Hub plan page (role-aware shell), replacing
  // the old combined-hub deep-link / planner. The employee-facing planner stays for editing.
  if (mode === "employee-portal") {
    return `/employee-portals/approvals/plan/${planId}`;
  }
  return `/admin/approvals/plan/${planId}`;
}

/**
 * Who hears about a plan on HR's behalf - the HR MANAGER / SECTION HEAD, resolved by APP ROLE.
 *
 * This is NOT the HR department. Plan acknowledgement is one person's responsibility - the HR
 * Manager (B-10, held as Super Admin, whose employee job title is "HR Section Head") - and it is
 * now automated. HR Advisory ("HR Business Partner") and HR Operations ("HR Specialist") are not
 * acknowledgers: owner 2026-09-04, "the HR manager is the only one responsible for acknowledgement
 * ... don't mix between roles ... only HR manager or section head". So a Business Partner was being
 * mailed a plan she has no role in.
 *
 * This path therefore resolves to Super Admin ONLY, and deliberately DIVERGES from the
 * deductions-comment audience in conversations/notify.ts, which mails both HR seats (HR_SEAT_ROLES)
 * because the owner asked for that separately. The two were briefly unified on 2026-09-03 - a
 * change that fixed a genuinely dead HR leg (it matched `job_title ilike '%HR Manager%'` and
 * selected a `position_title` column that does not exist on `employees`, so PostgREST rejected the
 * request and `const { data } = await ...` discarded the error unread; even repaired it matched 0
 * of 186 employees, so every plan mail had in fact been reaching the Super Admins alone). Resolving
 * by ROLE rather than job title was the right half of that fix and stays; widening to the whole
 * department was the wrong half and is reverted here.
 *
 * `is_active`/dropLeavers still apply, and notifyHrOnSubmit keeps its Super Admin fallback.
 */
async function hrAcknowledgementRecipients() {
  const supabase = getSupabaseAdmin();
  const { data: authRows, error } = await supabase
    .from("app_auth_users")
    .select("login_id,hr_id,name,auth_email,role,is_active")
    .in("role", ["Super Admin"]);
  if (error) {
    // Logged, never discarded: reading `data` and ignoring `error` is precisely how the old title
    // lookup failed for months without producing a single symptom.
    logError("Weekly plan HR acknowledgement recipients lookup failed", {
      labels: { event: "weekly_plan_hr_recipients_lookup_failed" },
      error,
    });
    return [];
  }
  const seen = new Set<string>();
  const recipients: Array<{ hrId: string | null; userId: string | null }> = [];
  for (const row of (authRows ?? []) as AuthUserRow[]) {
    // Only an explicit false excludes - `is_active` is nullable, and a null must not be read as
    // deactivated. Same test resolveHrAudience applies to the conversation audience.
    if (row.is_active === false) continue;
    // The admin-HR canary carries hr_id NULL by design, so the login id is what identifies a row
    // when there is no HR id to key on.
    const key = normalizeHrId(row.hr_id) || (row.login_id ? `login:${row.login_id}` : "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    recipients.push({ hrId: row.hr_id ?? null, userId: row.login_id ?? null });
  }
  return dropLeavers(recipients);
}

/**
 * Remove anyone who has left, from a recipient list already chosen by role.
 *
 * `app_auth_users.is_active` is NOT this test on its own: a resigned employee's login very often
 * stays active - authority in this app is is_active AND employment_status - so resolving HR by role
 * alone would keep mailing plans to someone who left. The title lookup this replaced did carry an
 * employment-status filter, and tests/leaver-roster-exclusion.test.ts pins this file for exactly
 * that reason; the filter had to come with the fix, not go with the bug.
 *
 * Absence from `employees` is NOT a leaver. The admin-HR canary carries hr_id NULL by design, and a
 * new account can exist before its employee record does, so only a row that is present AND
 * confirmed terminal is dropped - the same rule as the null-status escape hatch, which treats an
 * unset status as legacy data rather than a departure.
 *
 * Fails OPEN. If either lookup errors the whole list is returned unfiltered, because losing a
 * notification is the worse failure and this function's entire history is of silent under-delivery.
 */
async function dropLeavers(recipients: Array<{ hrId: string | null; userId: string | null }>) {
  const lookups = Array.from(new Set(recipients.flatMap((recipient) => hrIdLookupKeys(recipient.hrId))));
  if (lookups.length === 0) return recipients;
  const supabase = getSupabaseAdmin();
  const [known, active] = await Promise.all([
    supabase.from("employees").select("hr_id").in("hr_id", lookups),
    supabase
      .from("employees")
      .select("hr_id")
      .in("hr_id", lookups)
      .or(`employment_status.is.null,employment_status.in.${ACTIVE_EMPLOYMENT_STATUSES_IN_LIST}`),
  ]);
  if (known.error || active.error) {
    logError("Weekly plan leaver check failed - notifying the unfiltered list", {
      labels: { event: "weekly_plan_hr_recipients_leaver_check_failed" },
      error: known.error ?? active.error,
    });
    return recipients;
  }
  const keysOf = (rows: unknown) => new Set(
    ((rows ?? []) as Array<{ hr_id?: string | null }>).map((row) => normalizeHrId(row.hr_id)).filter(Boolean),
  );
  const knownKeys = keysOf(known.data);
  const activeKeys = keysOf(active.data);
  return recipients.filter((recipient) => {
    const key = normalizeHrId(recipient.hrId);
    if (!key || !knownKeys.has(key)) return true;
    return activeKeys.has(key);
  });
}

async function notifyManager(plan: PlanHeaderRow, ccRecipients: Array<{ hrId: string | null; userId?: string | null }> = []): Promise<NotificationDeliveryStatus> {
  let fellBackToSuperAdmin = false;
  let errored = false;

  let managerRecipients: Array<{ hrId: string | null; userId?: string | null }> =
    plan.manager_hr_id ? [{ hrId: plan.manager_hr_id }] : [];

  // Fallback 1: skip-level manager from directory
  if (managerRecipients.length === 0) {
    try {
      const directory = await getEmployeeDirectory();
      const emp = directory.employees.find((e) => hrIdsMatch(e.hrId, plan.employee_hr_id));
      const mgr = emp?.managerHrId ? directory.employees.find((e) => hrIdsMatch(e.hrId, emp.managerHrId)) : null;
      const skipLevel = mgr?.managerHrId ? directory.employees.find((e) => hrIdsMatch(e.hrId, mgr.managerHrId)) : null;
      if (skipLevel?.hrId) {
        managerRecipients = [{ hrId: skipLevel.hrId }];
        logError("Weekly plan has null manager_hr_id — routing to skip-level manager", {
          labels: { event: "weekly_plan_null_manager_skip_level_routed", planId: plan.id, skipLevelManagerHrId: skipLevel.hrId },
        });
      }
    } catch (lookupError) {
      errored = true;
      logError("Weekly plan skip-level manager lookup failed", {
        labels: { event: "weekly_plan_skip_level_manager_lookup_failed", planId: plan.id },
        error: lookupError,
      });
    }
  }

  // Fallback 1b: National Sales Manager reports directly to the CEO — there is no
  // "manager of manager" above them, so a plan with no manager_hr_id on record (and no
  // skip-level resolved above) routes straight to the CEO rather than Super Admin. The
  // CEO is NSM's real manager either way; see assertManagerReviewer's matching fallback.
  if (managerRecipients.length === 0 && resolveJobFunctionRole(plan.employee_job_title) === "National Sales Manager") {
    try {
      const ceos = await authUsersByRole("CEO");
      if (ceos.length > 0) {
        managerRecipients = ceos.map((row) => ({ hrId: row.hr_id ?? null, userId: row.login_id ?? null }));
        logError("Weekly plan has null manager_hr_id for an NSM — routing to CEO", {
          labels: { event: "weekly_plan_null_manager_nsm_ceo_routed", planId: plan.id },
        });
      }
    } catch (lookupError) {
      errored = true;
      logError("Weekly plan CEO lookup failed", {
        labels: { event: "weekly_plan_ceo_lookup_failed", planId: plan.id },
        error: lookupError,
      });
    }
  }

  // Fallback 2: Super Admin
  if (managerRecipients.length === 0) {
    try {
      const admins = await resolveSuperAdminRecipients();
      if (admins.length > 0) {
        managerRecipients = admins;
        fellBackToSuperAdmin = true;
        logError("Weekly plan falling back to Super Admin — no manager resolved", {
          labels: { event: "weekly_plan_manager_fallback_super_admin", planId: plan.id },
        });
      }
    } catch (fallbackError) {
      errored = true;
      logError("Weekly plan Super Admin fallback failed", {
        labels: { event: "weekly_plan_super_admin_fallback_failed", planId: plan.id },
        error: fallbackError,
      });
    }
  }

  if (managerRecipients.length === 0) {
    logError("Weekly plan persisted but no manager recipient resolved — manual follow-up required", {
      labels: { event: "weekly_plan_no_manager_recipient_resolved", planId: plan.id, employeeHrId: plan.employee_hr_id },
    });
    return { errored, fellBackToSuperAdmin, recipientCount: 0 };
  }

  try {
    const actionUrl = await planReviewActionUrl(managerRecipients[0]?.hrId ?? plan.manager_hr_id, plan.id);
    // roleHrefs ensures portal-mode managers (PM, GPM, MM, NSM, DM, RM, TM…) always
    // land at the employee-portal review page regardless of when the plan was submitted.
    // The fallback actionUrl (admin shell) covers CEO and Super Admin.
    const portalPlanUrl = `/employee-portals/approvals/plan/${plan.id}`;
    const roleHrefs: Record<string, string> = {
      "Employee": portalPlanUrl,
      "Medical Rep": portalPlanUrl,
      "District Manager": portalPlanUrl,
      "Manager": portalPlanUrl,
      "Regional Manager": portalPlanUrl,
      "National Sales Manager": portalPlanUrl,
      "Product Manager": portalPlanUrl,
      "Group Product Manager": portalPlanUrl,
      "Marketing Manager": portalPlanUrl,
      "Training Manager": portalPlanUrl,
    };
    await notifyRecipients({
      actionUrl,
      additionalMetadata: { roleHrefs },
      emailCcRecipients: ccRecipients,
      eventType: "plan_submitted",
      message: `${plan.employee_name} submitted a ${planSentenceLabel(plan.plan_kind, plan.period_start_date, plan.period_end_date)}.`,
      plan,
      recipients: managerRecipients,
      title: `${plan.employee_name}'s ${planNounLabel(plan.plan_kind)} needs manager review`,
    });
    return { errored, fellBackToSuperAdmin, recipientCount: managerRecipients.length };
  } catch (notifyError) {
    logError("Weekly plan failed to notify manager", {
      labels: { event: "weekly_plan_notify_manager_failed", planId: plan.id },
      error: notifyError,
    });
    return { errored: true, fellBackToSuperAdmin, recipientCount: managerRecipients.length };
  }
}

// HR must be alerted (in-app + email + Telegram) for EVERY plan submission, not only at
// the final acknowledgement stage. The direct manager is excluded here so an HR person who
// is also the submitter's manager is not double-notified (they already got the review ping).
async function notifyHrOnSubmit(plan: PlanHeaderRow, resolvedRecipients?: Array<{ hrId: string | null; userId?: string | null }>) {
  let primary = (resolvedRecipients ?? await hrAcknowledgementRecipients())
    .filter((recipient) => !hrIdsMatch(recipient.hrId, plan.manager_hr_id));

  // If hrAcknowledgementRecipients() yields nothing, fall back to Super Admin so the
  // submission is never silently dropped. Mirrors the PR #238 support-request pattern.
  if (primary.length === 0) {
    try {
      const admins = await resolveSuperAdminRecipients();
      primary = admins.filter((recipient) => !hrIdsMatch(recipient.hrId, plan.manager_hr_id));
      if (primary.length > 0) {
        logError("Weekly plan hrAcknowledgementRecipients returned 0 — using Super Admin fallback", {
          labels: { event: "weekly_plan_hr_recipients_empty_super_admin_fallback", planId: plan.id },
        });
      }
    } catch (fallbackError) {
      logError("Weekly plan HR + Super Admin fallback lookup failed", {
        labels: { event: "weekly_plan_hr_super_admin_fallback_lookup_failed", planId: plan.id },
        error: fallbackError,
      });
    }
  }

  if (primary.length === 0) return;
  await notifyRecipients({
    actionUrl: `/admin/approvals/plan/${plan.id}`,
    // Tags this copy as awareness-only (vs. the manager's action-needed copy of the same
    // eventType) so the in-app bell's auto-archive-on-decide logic never treats HR's "FYI, a
    // plan was submitted" ping as a stale pending-action item — see notifications/in-app.ts.
    additionalMetadata: { audience: "hr_awareness" },
    emailMode: "none",
    eventType: "plan_submitted",
    message: `${plan.employee_name} submitted a ${planSentenceLabel(plan.plan_kind, plan.period_start_date, plan.period_end_date)}.`,
    plan,
    recipients: primary,
    title: `${plan.employee_name}'s ${planNounLabel(plan.plan_kind)} was submitted`,
  });
}

/**
 * Tell the manager a plan they may already have in their queue is GONE.
 *
 * Cancel used to reuse notifyManager(), whose payload is hardcoded to the submission copy
 * ("<name> submitted a <kind> plan" / "needs manager review", eventType plan_submitted).
 * A cancellation therefore reached the manager as a brand-new review request pointing at a
 * plan they can no longer act on. This sends the truthful cancellation notice instead;
 * recipient resolution is deliberately identical (same manager_hr_id, no skip-level/CEO
 * fallbacks — an already-cancelled plan needs no escalation to find an approver).
 */
async function notifyManagerPlanCancelled(plan: PlanHeaderRow, comment: string | null): Promise<void> {
  if (!plan.manager_hr_id) return;
  const reason = comment?.trim();
  await notifyRecipients({
    actionUrl: `/admin/approvals/plan/${plan.id}`,
    eventType: "plan_cancelled",
    message:
      `${plan.employee_name} cancelled their ${planSentenceLabel(plan.plan_kind, plan.period_start_date, plan.period_end_date)}.`
      + (reason ? ` Reason: ${reason}` : "")
      + " No review is needed.",
    plan,
    recipients: [{ hrId: plan.manager_hr_id }],
    title: `${plan.employee_name}'s ${planNounLabel(plan.plan_kind)} was cancelled`,
  });
}

// Single fan-out for a fresh submission: direct manager (review) + HR (awareness).
// Best-effort and isolated — a failure to reach HR must never block the manager alert.
// National Sales Manager's "direct manager" is the CEO (see notifyManager's NSM fallback) —
// the CEO still gets a real "needs manager review" alert and must make a real decision; the
// double-click for the same person is avoided in decideEmployeePlan, not by skipping the review.
async function notifyPlanSubmitted(plan: PlanHeaderRow) {
  const hrRecipients = (await hrAcknowledgementRecipients())
    .filter((recipient) => !hrIdsMatch(recipient.hrId, plan.manager_hr_id));
  await Promise.allSettled([notifyManager(plan, hrRecipients), notifyHrOnSubmit(plan, hrRecipients)]);
}

// ===========================================================================
// Weekly -> monthly reconciliation
//
// The owner's precedence rule (2026-09-03): a submitted weekly plan WINS, the covering monthly
// plan is rewritten to match, and the change is flagged. It exists because the two cadences could
// previously assert different things about the same day with nothing reconciling them - measured
// in production at 9 disagreeing days out of 26 shared ones, including a monthly plan claiming
// Office on three days the weekly plan called Vacation.
//
// The sync is deliberately NOT symmetric-and-simultaneous. A month spans ~4.3 weeks, each with its
// own independent approval state, so two mutual writers would ping-pong and an approved month
// would have to un-approve itself whenever one of its weeks was returned. Instead there is one
// source of truth per day, and it changes hands once: the monthly SEEDS the week
// (loadMonthlySourcedItems), and the week overrides the month the moment it is submitted.
// ===========================================================================

// What a day claims, reduced to a comparable string. Time is part of the print because a day can
// carry an AM and a PM row that must not collapse into one another.
export function planDayFingerprint(rows: Array<{
  activity_title: string;
  activity_type: string;
  area: string | null;
  end_time: string | null;
  location_text: string | null;
  start_time: string | null;
}>) {
  return rows
    .map((row) => [
      String(row.start_time ?? "").slice(0, 5),
      String(row.end_time ?? "").slice(0, 5),
      cleanText(row.activity_type),
      cleanText(row.activity_title),
      cleanText(row.area),
      cleanText(row.location_text),
    ].join("~"))
    .sort()
    .join("||");
}

type MonthlyReconcileOutcome = {
  changedDates: string[];
  monthlyPlanId: string;
  rewritten: boolean;
};

/**
 * Bring the covering monthly plan into line with a just-submitted weekly plan.
 *
 * Rewrites the monthly plan's rows for the days the week covers - but ONLY while that monthly plan
 * is still editable. `phx_weekly_plan_replace_items` refuses any status outside
 * draft/manager_returned/ceo_returned, and that refusal is correct rather than an obstacle: an
 * approved monthly plan is a document somebody signed, and silently rewriting its rows underneath
 * that approval would destroy the audit trail the approval exists to create. When the month is
 * already approved the divergence is reported instead, and the weekly plan still governs - it is
 * the newer and more specific statement about the same days.
 *
 * Best-effort throughout: the weekly submission has already committed by the time this runs, so
 * nothing here may throw back into the caller's path.
 */
async function reconcileMonthlyFromWeekly(
  access: AccessContext,
  weeklyPlan: PlanHeaderRow,
): Promise<MonthlyReconcileOutcome[]> {
  if (weeklyPlan.plan_kind !== "weekly") return [];
  try {
    const keys = hrIdLookupKeys(weeklyPlan.employee_hr_id);
    if (keys.length === 0) return [];
    const supabase = getSupabaseAdmin();
    const { data: monthlyRows, error: monthlyError } = await supabase
      .from("employee_plan_headers")
      .select(planSelect)
      .eq("plan_kind", "monthly")
      .in("employee_hr_id", keys)
      .lte("period_start_date", weeklyPlan.period_end_date)
      .gte("period_end_date", weeklyPlan.period_start_date)
      .order("period_start_date", { ascending: true })
      .limit(20);
    if (monthlyError) throw monthlyError;

    // A cancelled or rejected month never became the plan of record, so it has nothing to
    // reconcile. Everything else does, a draft included: a draft month the employee is still
    // filling should absorb the week rather than sit there contradicting it.
    const live = ((monthlyRows ?? []) as PlanHeaderRow[]).filter(
      (row) => !["cancelled", "manager_rejected", "ceo_rejected"].includes(row.status),
    );

    // EVERY overlapping month, not the first row the query happened to return. A Saturday-anchored
    // Field Force week crosses a month boundary several times a year, and when it does BOTH months
    // legitimately own part of it - reconciling only one leaves the other holding exactly the
    // contradiction this feature exists to end, and it would be the arbitrary half.
    const outcomes: MonthlyReconcileOutcome[] = [];
    for (const monthly of live) {
      const outcome = await reconcileOneMonth(access, weeklyPlan, monthly);
      if (outcome) outcomes.push(outcome);
    }
    return outcomes;
  } catch (error) {
    logError("Weekly plan failed to reconcile the covering monthly plan", {
      labels: { event: "weekly_plan_monthly_reconcile_failed", planId: weeklyPlan.id },
      error,
    });
    return [];
  }
}

/** One weekly plan against one covering monthly plan. Throws; the caller above owns the logging. */
async function reconcileOneMonth(
  access: AccessContext,
  weeklyPlan: PlanHeaderRow,
  monthly: PlanHeaderRow,
): Promise<MonthlyReconcileOutcome | null> {
  // The overlap, not the whole week. A Saturday-anchored Field Force week straddles a month
  // boundary several times a year, and replacing the whole week's date span inside one month
  // would delete the neighbouring month's days from a plan that legitimately owns them.
  //
  // It is also what makes the write legal at all: phx_weekly_plan_replace_items refuses any item
  // whose activityDate falls outside the header's own period ("item activityDate % is outside plan
  // period % to %", read from the live function 2026-09-03), so an unclipped week crossing the
  // boundary would not merely be wrong - it would be rejected outright.
  const from = weeklyPlan.period_start_date > monthly.period_start_date
    ? weeklyPlan.period_start_date
    : monthly.period_start_date;
  const to = weeklyPlan.period_end_date < monthly.period_end_date
    ? weeklyPlan.period_end_date
    : monthly.period_end_date;
  if (from > to) return null;

  const inWindow = (date: string) => date >= from && date <= to;
  const weeklyItems = (weeklyPlan.employee_plan_items ?? []).filter((row) => inWindow(row.activity_date));
  const monthlyItems = monthly.employee_plan_items ?? [];
  const monthlyInWindow = monthlyItems.filter((row) => inWindow(row.activity_date));

  // Compare day by day so the flag can name the dates that actually moved.
  const byDate = (rows: PlanItemRow[]) => {
    const map = new Map<string, PlanItemRow[]>();
    for (const row of rows) {
      const bucket = map.get(row.activity_date);
      if (bucket) bucket.push(row);
      else map.set(row.activity_date, [row]);
    }
    return map;
  };
  const weeklyByDate = byDate(weeklyItems);
  const monthlyByDate = byDate(monthlyInWindow);
  const changedDates: string[] = [];
  for (const date of new Set([...weeklyByDate.keys(), ...monthlyByDate.keys()])) {
    if (planDayFingerprint(weeklyByDate.get(date) ?? []) !== planDayFingerprint(monthlyByDate.get(date) ?? [])) {
      changedDates.push(date);
    }
  }
  if (changedDates.length === 0) return null;
  changedDates.sort();

  if (canEditEmployeePlanStatus(monthly.status)) {
    const merged: EmployeePlanItemInput[] = [
      ...monthlyItems.filter((row) => !inWindow(row.activity_date)),
      ...weeklyItems,
    ]
      .sort((left, right) => (
        left.activity_date < right.activity_date
          ? -1
          : left.activity_date > right.activity_date
            ? 1
            : left.sort_order - right.sort_order
      ))
      .map((row, index) => ({
        activityDate: row.activity_date,
        activityTitle: row.activity_title,
        activityType: row.activity_type,
        area: row.area,
        attendees: row.attendees,
        doubleVisitMedicalRepHrId: row.double_visit_medical_rep_hr_id,
        doubleVisitMedicalRepName: row.double_visit_medical_rep_name,
        endTime: row.end_time,
        locationText: row.location_text,
        notes: row.notes ?? "",
        objective: row.objective,
        sortOrder: index,
        startTime: row.start_time,
      }));
    // The RPC rejects an empty payload outright, and an empty merge would mean erasing a month
    // to write nothing in its place. Report the divergence rather than destroy the plan.
    if (merged.length > 0) {
      try {
        await rpcReplacePlanItems({
          access,
          expectedRevision: monthly.revision,
          items: merged,
          planId: monthly.id,
          submit: false,
        });
        await writeAuditLog({
          actorLoginId: access.loginId,
          entityId: monthly.id,
          entityType: "weekly_plan",
          newValues: { changedDates, sourceWeeklyPlanId: weeklyPlan.id },
          summary: `monthly plan ${monthly.period_key} re-synced from submitted weekly plan ${weeklyPlan.period_key}`,
        });
        return { changedDates, monthlyPlanId: monthly.id, rewritten: true };
      } catch (error) {
        // The RPC bumps `revision` on every replace and checks the expected one first, so somebody
        // editing this month in another tab raises weekly_plan_revision_conflict. Fall through to
        // the flag rather than throw: the divergence is the half the employee actually needs told,
        // and letting this escape would drop it for every OTHER overlapping month too, from one
        // lost race.
        logError("Monthly plan could not be rewritten from the weekly plan", {
          labels: {
            event: "weekly_plan_monthly_rewrite_failed",
            monthlyPlanId: monthly.id,
            planId: weeklyPlan.id,
          },
          error,
        });
      }
    }
  }
  return { changedDates, monthlyPlanId: monthly.id, rewritten: false };
}

/**
 * Tell the submitter, copying their manager, that the month moved - or that it could not.
 *
 * Both halves of the owner's rule are visible here: when the month was rewritten this is a receipt,
 * and when it could not be it is the flag that stops the two plans disagreeing in silence. Dates
 * are listed in full, never summarised to a count, because "3 days changed" sends the reader
 * hunting for which three.
 */
async function notifyMonthlyResynced(weeklyPlan: PlanHeaderRow, outcome: MonthlyReconcileOutcome) {
  try {
    const monthly = await loadPlanRow(outcome.monthlyPlanId);
    const dateList = outcome.changedDates.join(", ");
    const message = outcome.rewritten
      ? `The monthly plan for ${monthly.period_key} was updated to match the weekly plan just submitted for ${weeklyPlan.period_key}. Days changed: ${dateList}.`
      : `The weekly plan submitted for ${weeklyPlan.period_key} disagrees with the already-approved monthly plan for ${monthly.period_key} on: ${dateList}. The weekly plan governs those days; the monthly plan could not be rewritten because it is already approved.`;
    await notifyRecipients({
      actionUrl: `/employee-portals/plans?plan=${monthly.id}`,
      additionalMetadata: {
        changedDates: outcome.changedDates,
        rewritten: outcome.rewritten,
        sourceWeeklyPlanId: weeklyPlan.id,
      },
      emailCcRecipients: monthly.manager_hr_id ? [{ hrId: monthly.manager_hr_id }] : [],
      eventType: outcome.rewritten ? "plan_monthly_resynced" : "plan_monthly_conflict",
      message,
      plan: monthly,
      recipients: [
        { hrId: monthly.employee_hr_id },
        ...(monthly.manager_hr_id ? [{ hrId: monthly.manager_hr_id }] : []),
      ],
      title: outcome.rewritten
        ? `Monthly plan ${monthly.period_key} updated from your weekly plan`
        : `Monthly plan ${monthly.period_key} disagrees with your submitted weekly plan`,
    });
  } catch (error) {
    logError("Weekly plan failed to notify of the monthly re-sync", {
      labels: { event: "weekly_plan_notify_monthly_resync_failed", planId: weeklyPlan.id },
      error,
    });
  }
}

/**
 * Everything that must happen once a plan is submitted: route it for approval, and - for a weekly
 * plan - settle the covering month against it. All three submit paths call this one function, so
 * the reconciliation cannot be wired into two of them and silently skipped by the third.
 */
async function afterPlanSubmitted(access: AccessContext, plan: PlanHeaderRow) {
  await notifyPlanSubmitted(plan);
  for (const outcome of await reconcileMonthlyFromWeekly(access, plan)) {
    await notifyMonthlyResynced(plan, outcome);
  }
}


// Best-effort — a failure to notify must never mask a decision that already
// committed via rpcDecidePlan (see decideEmployeePlan).
async function notifyCeo(plan: PlanHeaderRow) {
  try {
    const ceos = await authUsersByRole("CEO");
    await notifyRecipients({
      actionUrl: `/admin/approvals/plan/${plan.id}`,
      eventType: "plan_manager_approved",
      message: `${plan.manager_name ?? "The direct manager"} approved ${plan.employee_name}'s ${planSentenceLabel(plan.plan_kind, plan.period_start_date, plan.period_end_date)}.`,
      plan,
      recipients: ceos.map((row) => ({ hrId: row.hr_id ?? null, userId: row.login_id ?? null })),
      title: `${plan.employee_name}'s ${planNounLabel(plan.plan_kind)} needs CEO approval`,
    });
  } catch (error) {
    logError("Weekly plan failed to notify CEO", {
      labels: { event: "weekly_plan_notify_ceo_failed", planId: plan.id },
      error,
    });
  }
}

// The manager's approval of a plan that takes the second stage goes to the named second approver,
// never the CEO. Same eventType as the CEO's copy so the in-app bell treats it as actionable and
// archives it once the plan leaves manager_approved.
async function notifySecondApprover(plan: PlanHeaderRow) {
  try {
    const approverHrId = secondApproverHrIdForManager(plan.manager_hr_id);
    if (!approverHrId) return;
    await notifyRecipients({
      actionUrl: await planReviewActionUrl(approverHrId, plan.id),
      eventType: "plan_manager_approved",
      message: `${plan.manager_name ?? "The direct manager"} approved ${plan.employee_name}'s ${planSentenceLabel(plan.plan_kind, plan.period_start_date, plan.period_end_date)}. It now needs your approval.`,
      plan,
      recipients: [{ hrId: approverHrId }],
      title: `${plan.employee_name}'s ${planNounLabel(plan.plan_kind)} needs your approval`,
    });
  } catch (error) {
    logError("Weekly plan failed to notify the second approver", {
      labels: { event: "weekly_plan_notify_second_approver_failed", planId: plan.id },
      error,
    });
  }
}

// Called AFTER autoAcknowledgeFinalApprovedPlan, so `plan` is normally already hr_acknowledged
// and HR has nothing left to do — the copy says so instead of asking for a click that no longer
// exists. It still falls back to the original action-needed wording for the one case that can
// still reach HR's queue: the automatic acknowledgement failed and the plan is still
// final_approved, which is exactly when HR must be told to press the manual button.
//
// The awareness copy carries audience: "hr_awareness" so the in-app bell does not auto-archive it
// the moment the plan leaves HR's awaiting bucket — same split notifyHrOnSubmit uses (see
// classifyActionableApprovalCandidates in notifications/in-app.ts).
async function notifyHr(plan: PlanHeaderRow, deciderLabel: string | null = null) {
  const autoAcknowledged = plan.status === "hr_acknowledged";
  // "CEO" unless the last approval was the second approver's (second-approver.ts) — HR reads who
  // actually approved.
  const approver = deciderLabel ?? "CEO";
  try {
    await notifyRecipients({
      actionUrl: `/admin/approvals/plan/${plan.id}`,
      ...(autoAcknowledged ? { additionalMetadata: { audience: "hr_awareness" } } : {}),
      eventType: "plan_ceo_approved",
      message: autoAcknowledged
        ? `${approver} approved ${plan.employee_name}'s ${planSentenceLabel(plan.plan_kind, plan.period_start_date, plan.period_end_date)}. It was acknowledged automatically — no action needed.`
        : `${approver} approved ${plan.employee_name}'s ${planSentenceLabel(plan.plan_kind, plan.period_start_date, plan.period_end_date)}. Please review and acknowledge.`,
      plan,
      recipients: await hrAcknowledgementRecipients(),
      title: autoAcknowledged
        ? `${plan.employee_name}'s ${planNounLabel(plan.plan_kind)} was approved and acknowledged`
        : `${plan.employee_name}'s approved ${planNounLabel(plan.plan_kind)} needs HR acknowledgement`,
    });
  } catch (error) {
    logError("Weekly plan failed to notify HR", {
      labels: { event: "weekly_plan_notify_hr_failed", planId: plan.id },
      error,
    });
  }
}

// Returning a plan IS a conversation - the owner named it in the same breath as the comment
// threads on 2026-09-03 ("if someone sent anything in a conversation, or returned the plan"). So it
// is addressed the same way: To the submitter, CC whoever returned it. Before this the decider was
// nowhere on the mail, which left the employee holding a returned plan and a comment from a person
// they could not simply reply to.
async function notifyEmployeeReturnedOrRejected(
  plan: PlanHeaderRow,
  action: EmployeePlanAction,
  comment: string | null,
  actorHrId: string | null,
) {
  try {
    await notifyRecipients({
      actionUrl: `/employee-portals/plans?plan=${plan.id}`,
      emailCcRecipients: actorHrId && !hrIdsMatch(actorHrId, plan.employee_hr_id) ? [{ hrId: actorHrId }] : [],
      eventType: action,
      message: `Your ${planSentenceLabel(plan.plan_kind, plan.period_start_date, plan.period_end_date)} ${action.includes("reject") ? "was rejected" : "was returned for edit"}.${comment ? ` Comment: ${comment}` : ""}`,
      plan,
      recipients: [{ hrId: plan.employee_hr_id }],
      title: `Your ${planNounLabel(plan.plan_kind)} was ${action.includes("reject") ? "rejected" : "returned"}`,
    });
  } catch (error) {
    logError("Weekly plan failed to notify employee of return/reject", {
      labels: { event: "weekly_plan_notify_employee_return_or_reject_failed", planId: plan.id, action },
      error,
    });
  }
}

// The submitter previously heard nothing between submit and the final HR-acknowledge (or a
// return/reject) — a manager approval is real, useful news, so confirm it back to them too.
// eventType is the raw action ("manager_approve"), NOT "plan_manager_approved" — that string is
// reserved for the CEO's own actionable copy in ACTIONABLE_APPROVAL_NOTIFICATIONS
// (src/lib/notifications/in-app.ts); reusing it here would get this FYI copy auto-archived the
// instant the plan moves past manager_approved, same instant it's created.
async function notifyEmployeeManagerApproved(plan: PlanHeaderRow) {
  try {
    await notifyRecipients({
      actionUrl: `/employee-portals/plans?plan=${plan.id}`,
      emailMode: "none",
      eventType: "manager_approve",
      message: `${plan.manager_name ?? "Your manager"} approved your ${planSentenceLabel(plan.plan_kind, plan.period_start_date, plan.period_end_date)}.`,
      plan,
      recipients: [{ hrId: plan.employee_hr_id }],
      title: `Your ${planNounLabel(plan.plan_kind)} was approved by your manager`,
    });
  } catch (error) {
    logError("Weekly plan failed to notify employee of manager approval", {
      labels: { event: "weekly_plan_notify_employee_manager_approved_failed", planId: plan.id },
      error,
    });
  }
}

// ===========================================================================
// Two-way plan conversation (employee_plan_comments, migration 20260708010000).
// Anyone who canViewPlan() may read and post — the submitter, the assigned
// manager, the CEO, and HR/Super Admin at the final stages — independent of the
// plan's current status, so a returned/edit-requested plan can still carry a
// real back-and-forth instead of a one-shot decision comment.
// ===========================================================================

type PlanCommentRow = {
  author_hr_id: string;
  author_login_id: string | null;
  author_role: string | null;
  body: string;
  created_at: string;
  id: string;
  item_id: string | null;
  parent_id: string | null;
  plan_id: string;
};

async function mapPlanComments(rows: PlanCommentRow[]): Promise<EmployeePlanComment[]> {
  if (rows.length === 0) return [];
  const directory = await getEmployeeDirectory();
  const byHrId = new Map(directory.employees.map((employee) => [normalizeHrId(employee.hrId), employee]));
  return rows.map((row) => ({
    authorHrId: row.author_hr_id,
    authorName: byHrId.get(normalizeHrId(row.author_hr_id))?.displayName ?? null,
    authorRole: row.author_role,
    body: row.body,
    createdAt: row.created_at,
    id: row.id,
    itemId: row.item_id,
    parentId: row.parent_id,
    planId: row.plan_id,
  }));
}

const planCommentSelect = "id,plan_id,item_id,parent_id,author_hr_id,author_login_id,author_role,body,created_at";

export async function listPlanComments(
  access: AccessContext,
  planId: string,
): Promise<{ canComment: boolean; comments: EmployeePlanComment[]; schemaReady: boolean }> {
  // Read is the floor, exactly as in addPlanComment below: CEO (read/approve/export) and the Manager
  // role (read/approve) hold no `update`, so asserting it threw 403 and the thread showed them as
  // empty. canViewPlan is the real authorization.
  await assertPermission(access, "weekly_plans", "read");
  const plan = await loadPlanRow(planId);
  const { directory, employee } = await currentEmployeeWithDirectory(access);
  const viewerScope = resolvePlanViewerScope(access, directory.employees);
  if (!canViewPlan(access, employee, plan, viewerScope)) {
    throw new Error("Forbidden: you cannot view this plan's conversation.");
  }
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("employee_plan_comments")
      .select(planCommentSelect)
      .eq("plan_id", planId)
      .order("created_at", { ascending: true })
      .limit(500);
    if (error) throw error;
    const comments = await mapPlanComments((data ?? []) as PlanCommentRow[]);
    return { canComment: true, comments, schemaReady: true };
  } catch (error) {
    if (isSchemaMissing(error)) return { canComment: true, comments: [], schemaReady: false };
    throw error;
  }
}

// Fans a new comment out to everyone already engaged with this plan: the submitter, the assigned
// manager, whoever has recorded a decision on it (which captures CEO/HR once they have actually
// acted), and everyone who has already posted in the thread. Deliberately does NOT notify every
// CEO/HR account by default - only those who have engaged - to avoid spamming unrelated executives
// on every reply.
//
// ONE email per comment, addressed the way the owner asked for on 2026-09-03: To the plan's
// SUBMITTER, CC the person who wrote it plus every other participant. It used to call
// notifyRecipients once per participant with a single-element recipients array, which made each
// recipient their own "primary" and left the CC list empty every time - all five plan-comment
// emails ever sent in production went to one person with no cc, and the author was cut out
// entirely. Sending one addressed email instead of N private ones is also what makes the thread
// legible in a mailbox: everyone can see who else is on it.
//
// The author is deliberately absent from `recipients` but present in the cc: pinging someone
// in-app about their own comment is noise, while the emailed copy is precisely the "CC the sender"
// the owner asked for. Role-aware deep links reuse planReviewActionUrl so each recipient lands in
// their own shell. Best-effort: a notification failure never blocks the comment itself.
async function notifyPlanComment(plan: PlanHeaderRow, comment: EmployeePlanComment) {
  try {
    // participantKeys is a Set of normalizeHrId() comparison keys (hyphens/case stripped) so
    // duplicates collapse correctly - but that stripped form must never reach the database: it
    // silently failed the FK to employees.hr_id (stored as "B-10") for every hyphenated id, so
    // no plan-comment notification has ever reached anyone but the CEO ("AA", no hyphen).
    // canonicalHrIds keeps the first properly-cased form seen for each key, for actual storage.
    const participantKeys = new Set<string>();
    const canonicalHrIds = new Map<string, string>();
    const addParticipant = (rawHrId: string | null | undefined) => {
      const key = normalizeHrId(rawHrId);
      if (!key) return;
      participantKeys.add(key);
      if (!canonicalHrIds.has(key)) {
        const canonical = hrIdForStorage(rawHrId);
        if (canonical) canonicalHrIds.set(key, canonical);
      }
    };

    addParticipant(plan.employee_hr_id);
    addParticipant(plan.manager_hr_id);
    for (const decision of plan.employee_plan_decisions ?? []) {
      addParticipant(decision.actor_hr_id);
    }
    const { data: priorAuthors } = await getSupabaseAdmin()
      .from("employee_plan_comments")
      .select("author_hr_id")
      .eq("plan_id", plan.id);
    for (const row of (priorAuthors ?? []) as Array<{ author_hr_id: string }>) {
      addParticipant(row.author_hr_id);
    }
    addParticipant(comment.authorHrId);

    const submitterKey = normalizeHrId(plan.employee_hr_id);
    const authorKey = normalizeHrId(comment.authorHrId);
    const toCanonicalHrId = (key: string) => canonicalHrIds.get(key) ?? null;

    // In-app / Telegram / push audience: the submitter first (they are the email's To, and
    // notifyRecipients attaches the email to whichever recipient matches the primary), then every
    // other participant except the author.
    const notifyKeys = [
      ...(submitterKey ? [submitterKey] : []),
      ...Array.from(participantKeys).filter((key) => key !== submitterKey && key !== authorKey),
    ];
    // Everyone copied on the email: the author (the owner's "CC the sender") and every other
    // participant. The submitter is excluded because they are the To, not a cc.
    const ccKeys = new Set(participantKeys);
    if (authorKey) ccKeys.add(authorKey);
    ccKeys.delete(submitterKey);

    if (notifyKeys.length === 0 && ccKeys.size === 0) return;

    const actionUrl = submitterKey
      ? `/employee-portals/plans?plan=${plan.id}`
      : await planReviewActionUrl(toCanonicalHrId(notifyKeys[0] ?? "") ?? "", plan.id);
    await notifyRecipients({
      actionUrl,
      emailCcRecipients: Array.from(ccKeys).map((key) => ({ hrId: toCanonicalHrId(key) })),
      eventType: "plan_comment",
      // The full comment, never trimmed to a preview: the owner's standing rule is that text is
      // never truncated with an ellipsis, and a half-sentence is exactly what forces the reader
      // back into the app to find out what was actually said.
      message: `${comment.authorName ?? comment.authorHrId} commented on the ${planSentenceLabel(plan.plan_kind, plan.period_start_date, plan.period_end_date)}: "${comment.body}"`,
      // The comment's own id — without it a second comment on the same plan collapses onto the
      // first one's notification event, because the title and actionUrl above never change between
      // messages on the same thread.
      messageKey: comment.id,
      plan,
      recipients: notifyKeys.map((key) => ({ hrId: toCanonicalHrId(key) })),
      title: `New comment on ${planNounLabel(plan.plan_kind)}`,
    });
  } catch (error) {
    logError("Weekly plan failed to notify participants of a new comment", {
      labels: { event: "weekly_plan_notify_comment_participants_failed", planId: plan.id },
      error,
    });
  }
}

export async function addPlanComment(access: AccessContext, planId: string, input: {
  body: string;
  itemId?: string | null;
  parentId?: string | null;
}): Promise<EmployeePlanComment> {
  const body = String(input.body ?? "").trim();
  if (!body) throw new Error("Comment cannot be empty.");
  // Posting is gated on PARTICIPATION (canViewPlan below), not on weekly_plans:update.
  // The thread exists so an approver can ask a question instead of returning the plan — but the
  // two roles it was built for cannot hold `update`: CEO is ["read","approve","export"] and the
  // Manager role is ["read","approve"]. The old `update` assert therefore threw Forbidden on Send
  // for exactly them, while the composer rendered unconditionally and listPlanComments reported
  // canComment: true. Read is the floor; canViewPlan is the real authorization.
  await assertPermission(access, "weekly_plans", "read");
  const plan = await loadPlanRow(planId);
  const { directory, employee } = await currentEmployeeWithDirectory(access);
  const viewerScope = resolvePlanViewerScope(access, directory.employees);
  if (!canViewPlan(access, employee, plan, viewerScope)) {
    throw new Error("Forbidden: you cannot comment on this plan.");
  }
  const { data, error } = await getSupabaseAdmin()
    .from("employee_plan_comments")
    .insert({
      author_hr_id: hrIdForStorage(access.hrId),
      author_login_id: access.loginId ?? null,
      author_role: access.role,
      body,
      item_id: input.itemId ?? null,
      parent_id: input.parentId ?? null,
      plan_id: planId,
    })
    .select(planCommentSelect)
    .single();
  if (error) {
    if (isSchemaMissing(error)) {
      throw new Error("Plan conversation is not available yet — the database migration has not been applied.");
    }
    throw error;
  }
  const [mapped] = await mapPlanComments([data as PlanCommentRow]);
  await notifyPlanComment(plan, mapped);
  return mapped;
}

export async function getEmployeePlansWorkspace(access: AccessContext): Promise<EmployeePlansWorkspace> {
  await assertPermission(access, "employee_profile", "read");
  await assertPermission(access, "weekly_plans", "read");
  const directory = await getEmployeeDirectory();
  const directoryByHrId = new Map(directory.employees.map((item) => [normalizeHrId(item.hrId), item]));
  const viewerHrId = normalizeHrId(access.hrId);
  const employee = directory.employees.find((item) => normalizeHrId(item.hrId) === viewerHrId) ?? null;
  // A manager whose Phoenix CRM team is live plans his week THERE now (owner, 2026-10-16), so this form
  // offers him no new plan — it is his history, to read only (owner, 2026-10-17: "make them only able to
  // see their historical plans, which they submitted on the old module").
  const movedToPhoenixCrm = employee ? await plansInPhoenixCrm(access) : false;
  const canSubmitPlans = Boolean(
    employee &&
      !movedToPhoenixCrm &&
      canSubmitFromEmployee(employee, access.role) &&
      await canAccess(access, "weekly_plans", "create"),
  );
  const canAcknowledgeHr = isHrReviewer(access, employee);
  // Mirrors moveWeeklyPlanToPeriod exactly: HR/Super-Admin AND the approve grant. A flag carrying
  // only half the gate renders a button the server then rejects.
  const canMovePlanPeriod = canAcknowledgeHr && (await canAccess(access, "weekly_plans", "approve"));
  // One read, two jobs: it names the owner's district outright (the Area picker's first
  // authority) and fills the blank area_name that hides five reps from the rep list.
  // Fails soft for the same reason the seat map below does.
  const seatDirectory = await loadPlanningSeatDirectory().catch(() => null);
  const ownSeatRegionCode = employee
    ? seatDirectory?.districtByHrId.get(normalizeHrId(employee.hrId)) ?? null
    : null;
  const medicalRepOptions = await medicalRepOptionsForEmployee(
    employee,
    isOrgWidePlanningEmployee(employee, access.role),
    await resolveViewerAllowedLines(access),
    seatDirectory,
  );
  const marketingDoubleVisit = await marketingDoubleVisitContextFor(employee, access.role);
  // Fails soft: an unreachable/empty seat map leaves the picker on its roster-derived
  // fallback rather than blanking it, which is the failure this whole change exists to end.
  let planningAreaSeats: PlanningAreaSeat[] = [];
  try {
    planningAreaSeats = await loadPlanningAreaSeats(employee?.lineId ?? null);
  } catch {
    planningAreaSeats = [];
  }

  try {
    const { data, error } = await getSupabaseAdmin()
      .from("employee_plan_headers")
      .select(planSelect)
      .order("created_at", { ascending: false })
      .limit(WORKSPACE_PLAN_LIMIT + 1);
    if (error) throw error;
    const loadedRows = (data ?? []) as PlanHeaderRow[];
    const hasMorePlans = loadedRows.length > WORKSPACE_PLAN_LIMIT;
    const cappedRows = loadedRows.slice(0, WORKSPACE_PLAN_LIMIT);
    // His history is EVERY plan he filed here, never only the ones inside the company-wide window above.
    const ownHistoryRows = movedToPhoenixCrm && employee ? await loadOwnPlanRows(employee.hrId) : [];
    const loadedIds = new Set(cappedRows.map((row) => row.id));
    const workspaceRows = [...cappedRows, ...ownHistoryRows.filter((row) => !loadedIds.has(row.id))];
    const viewerScope = resolvePlanViewerScope(access, directory.employees);
    const visible = workspaceRows.filter((plan) => canViewPlan(access, employee, plan, viewerScope));
    const mapped = visible.map(mapPlan).map((plan) => ({
      ...plan,
      decisions: plan.decisions.map((decision) => ({
        ...decision,
        actorName: decision.actorHrId
          ? directoryByHrId.get(normalizeHrId(decision.actorHrId))?.displayName ?? null
          : null,
      })),
      employeeDisplayName: directoryByHrId.get(normalizeHrId(plan.employeeHrId))?.displayName || plan.employeeName,
      managerDisplayName: directoryByHrId.get(normalizeHrId(plan.managerHrId))?.displayName || plan.managerName,
    }));
    // The viewer's own plans carry their adherence score, so he sees it on the plan itself and not
    // only after opening the approvals hub. Scoped to his plans — see EmployeePlan.adherence for why
    // — and never load-bearing: a CRM failure leaves the field undefined and the list renders as before.
    const ownPlanIds = employee?.hrId
      ? mapped
          .filter((plan) => normalizeHrId(plan.employeeHrId) === normalizeHrId(employee.hrId))
          .map((plan) => plan.id)
      : [];
    const adherenceById = ownPlanIds.length > 0
      ? await loadPlanAdherenceForPlans(ownPlanIds).catch(() => new Map<string, PlanAdherenceScore>())
      : new Map<string, PlanAdherenceScore>();
    const plans = mapped.map((plan) => {
      const adherence = adherenceById.get(plan.id);
      return adherence ? { ...plan, adherence } : plan;
    });
    return {
      canAcknowledgeHr,
      canMovePlanPeriod,
      canPlanMarketingDoubleVisit: marketingDoubleVisit.allowed,
      secondApproverManagerHrIds: managerHrIdsForSecondApprover(access.hrId),
      canSubmitPlans,
      plansInPhoenixCrm: movedToPhoenixCrm,
      currentEmployee: employee
        ? {
            areaName: employee.areaName,
            fullName: employee.displayName,
            hrId: employee.hrId,
            jobTitle: employeeTitle(employee, access.role),
            managerHrId: employee.managerHrId,
            managerName: employee.managerName,
            regionCode: employee.regionCode ?? null,
            regionName: employee.regionName,
            seatRegionCode: ownSeatRegionCode,
            workweek: resolvePlanWorkweek({
              jobTitle: employeeTitle(employee, access.role),
              role: access.role,
            }),
          }
        : null,
      hasMorePlans,
      loadedPlanCount: cappedRows.length,
      marketingDoubleVisitPartners: marketingDoubleVisit.partners,
      medicalRepOptions,
      planningAreaSeats,
      planLimit: WORKSPACE_PLAN_LIMIT,
      plans,
      schemaReady: true,
      summary: summarizePlans(plans),
    };
  } catch (error) {
    if (!isSchemaMissing(error)) throw error;
    return {
      canAcknowledgeHr,
      canMovePlanPeriod,
      canPlanMarketingDoubleVisit: marketingDoubleVisit.allowed,
      secondApproverManagerHrIds: managerHrIdsForSecondApprover(access.hrId),
      canSubmitPlans,
      plansInPhoenixCrm: movedToPhoenixCrm,
      currentEmployee: employee
        ? {
            areaName: employee.areaName,
            fullName: employee.displayName,
            hrId: employee.hrId,
            jobTitle: employeeTitle(employee, access.role),
            managerHrId: employee.managerHrId,
            managerName: employee.managerName,
            regionCode: employee.regionCode ?? null,
            regionName: employee.regionName,
            seatRegionCode: ownSeatRegionCode,
            workweek: resolvePlanWorkweek({
              jobTitle: employeeTitle(employee, access.role),
              role: access.role,
            }),
          }
        : null,
      hasMorePlans: false,
      loadedPlanCount: 0,
      marketingDoubleVisitPartners: marketingDoubleVisit.partners,
      medicalRepOptions,
      planningAreaSeats,
      planLimit: WORKSPACE_PLAN_LIMIT,
      plans: [],
      schemaReady: false,
      summary: emptyPlansSummary(),
    };
  }
}

export type ApproverPlanStage = "manager" | "ceo";

/**
 * Pure authorization rule deciding which approval gate (if any) a plan in a given
 * status is awaiting from the caller. Mirrors the server-side guards enforced in
 * decideEmployeePlan (assertManagerReviewer / assertCeoReviewer):
 *   • submitted        → manager stage, only for the actual assigned manager (or, when the
 *     plan has no manager_hr_id at all, the CEO — see assertManagerReviewer's null-manager
 *     fallback).
 *   • manager_approved → CEO stage, only for the actual CEO — EXCEPT a District Manager plan whose
 *     manager has a configured second approver (second-approver.ts: the DMs reporting to Hany
 *     Saad), where that stage is Ali Mohamed Ali's and the CEO has no turn at all.
 * Super Admin has NO standing bypass here (owner-confirmed: he cannot act on someone else's
 * turn — only where he's personally the assigned manager, which hrIdsMatch already covers, or
 * at the final HR-acknowledge stage, handled separately by acknowledgeEmployeePlan/isHrReviewer).
 * Returns null when the caller has no pending action on the plan.
 */
export function resolveApproverPlanStage(
  status: EmployeePlanStatus,
  managerHrId: string | null,
  access: Pick<AccessContext, "hrId" | "role" | "scope">,
  jobTitle?: string | null,
  // The submitter's District-Manager-ness by title OR app role, when the caller resolved it (an
  // acting DM keeps a Medical Representative title). Left undefined it falls back to the title,
  // which is what every caller did before the second stage existed.
  submitterIsDistrictManager?: boolean,
): ApproverPlanStage | null {
  const isCeo = access.role === "CEO";
  if (status === "submitted") {
    if (hrIdsMatch(access.hrId, managerHrId)) return "manager";
    if (!managerHrId && isCeo) return "manager";
    return null;
  }
  if (status === "manager_approved") {
    const isDistrictManagerPlan = submitterIsDistrictManager ?? isDistrictManagerPlanTitle(jobTitle ?? null);
    if (planHasSecondApprover(managerHrId, isDistrictManagerPlan)) {
      return isSecondApproverForManager(access.hrId, managerHrId) ? "ceo" : null;
    }
    if (isCeo) {
      return isDistrictManagerPlan ? null : "ceo";
    }
    return null;
  }
  return null;
}

/**
 * The submitter's District-Manager-ness for resolveApproverPlanStage — resolved (one login-row read)
 * ONLY for the single case where it changes the answer: a plan resting at manager_approved under a
 * manager who has a second approver. Everywhere else it returns undefined and the pure rule falls
 * back to the title, so no other row pays a lookup.
 */
export async function resolveSubmitterIsDistrictManager(row: {
  employee_hr_id: string;
  employee_job_title: string | null;
  manager_hr_id: string | null;
  status: EmployeePlanStatus;
}): Promise<boolean | undefined> {
  if (row.status !== "manager_approved" || !secondApproverLabelForManager(row.manager_hr_id)) return undefined;
  return isDistrictManagerPlanSubmitter(row.employee_job_title, await authRoleForHrId(row.employee_hr_id));
}

// One planned activity, flattened for read-only calendar rendering in the approver
// inbox. Mirrors WeeklyPlanCalendarItem in the action-center types (kept structurally
// identical so the action-center mapper can pass it through without re-shaping).
export type ApproverPlanItem = {
  activityDate: string;
  activityLabel: string;
  activityType: EmployeePlanActivityType;
  area: string | null;
  isCoaching: boolean;
  notes: string | null;
  objective: string | null;
  region: string | null;
  repName: string | null;
  timeLabel: string | null;
  visitDetails: VisitDetail[];
};

export type ApproverPendingPlan = {
  employeeHrId: string;
  employeeJobTitle: string | null;
  employeeName: string;
  // Nickname-aware display name (nickname when set, else employeeName), resolved
  // live against the current employee directory. employeeName stays the persisted
  // submission-time snapshot.
  employeeDisplayName: string;
  id: string;
  itemCount: number;
  items: ApproverPlanItem[];
  managerName: string | null;
  // Nickname-aware display name for the manager (nickname when set, else
  // managerName), resolved live against the current employee directory.
  // managerName stays the persisted submission-time snapshot.
  managerDisplayName: string | null;
  periodEndDate: string;
  periodKey: string;
  periodStartDate: string;
  planKind: EmployeePlanKind;
  reviewHref: string;
  stage: ApproverPlanStage;
  status: EmployeePlanStatus;
  submittedAt: string;
};

function trimClockTime(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{1,2}:\d{2})/);
  return match ? match[1] : raw;
}

function approverTimeLabel(start: unknown, end: unknown): string | null {
  const s = trimClockTime(start);
  const e = trimClockTime(end);
  if (s && e) return `${s}–${e}`;
  if (s) return `from ${s}`;
  if (e) return `until ${e}`;
  return null;
}

function approverItemLabel(activityType: EmployeePlanActivityType, activityTitle: unknown): { label: string; isCoaching: boolean } {
  const title = String(activityTitle ?? "").trim();
  const isCoaching = activityType === "Other" && title.toLowerCase() === "coaching";
  if (isCoaching) return { label: "Coaching", isCoaching: true };
  if (isMarketingDoubleVisit(activityType, title)) return { label: MARKETING_DOUBLE_VISIT_TITLE, isCoaching: false };
  return { label: title || activityDisplayLabel(activityType), isCoaching: false };
}

function mapApproverPlanItem(item: {
  activity_date: string;
  activity_title: string;
  activity_type: EmployeePlanActivityType;
  area: string | null;
  attendees?: string | null;
  double_visit_medical_rep_name: string | null;
  end_time: string | null;
  location_text: string | null;
  notes: string | null;
  objective: string | null;
  start_time: string | null;
  employee_plan_visit_details?: PlanVisitDetailRow[];
}): ApproverPlanItem {
  const { label, isCoaching } = approverItemLabel(item.activity_type, item.activity_title);
  return {
    activityDate: item.activity_date,
    activityLabel: label,
    activityType: item.activity_type,
    area: nullableText(item.area),
    isCoaching,
    notes: nullableText(item.notes),
    objective: nullableText(item.objective),
    region: nullableText(item.location_text),
    // The approver calendar prints "with <repName>"; a Marketing Double Visit's partner is the name there.
    repName: isMarketingDoubleVisit(item.activity_type, item.activity_title)
      ? nullableText(item.attendees)
      : nullableText(item.double_visit_medical_rep_name),
    timeLabel: approverTimeLabel(item.start_time, item.end_time),
    visitDetails: (item.employee_plan_visit_details ?? [])
      .map((d) => ({
        id: d.id,
        doctorName: d.doctor_name,
        speciality: d.speciality,
        address: d.address,
        objective: d.objective,
        sortOrder: d.sort_order,
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder),
  };
}

/**
 * Plans currently awaiting the signed-in approver's decision, for the cross-module
 * Action Center inbox. Two gates are surfaced:
 *   • manager stage — a `submitted` plan whose `manager_hr_id` is the caller
 *     (Super Admin sees all submitted plans, mirroring assertManagerReviewer).
 *   • ceo stage — a `manager_approved` plan, surfaced to CEO / Super Admin only.
 * Authorization here mirrors the server-side guards in decideEmployeePlan, so a
 * row only appears for someone actually allowed to act on it. `reviewHref` points
 * at the viewer's own shell so they can open the full day-by-day plan first.
 */
export async function getPlansAwaitingAction(access: AccessContext): Promise<ApproverPendingPlan[]> {
  const isSuperAdmin = access.role === "Super Admin" || access.scope === "system";
  const isCeo = access.role === "CEO";
  const viewerHrId = normalizeHrId(access.hrId);
  if (!isSuperAdmin && !isCeo && !viewerHrId) return [];

  const reviewBase = resolveNavigationMode(access) === "employee-portal"
    ? "/employee-portals/plans"
    : "/admin/weekly-plans";

  try {
    const { data, error } = await getSupabaseAdmin()
      .from("employee_plan_headers")
      .select(
        "id,employee_hr_id,employee_name,employee_job_title,manager_hr_id,manager_name,period_key,period_start_date,period_end_date,plan_kind,status,submitted_at,created_at,employee_plan_items(activity_date,activity_type,activity_title,area,location_text,objective,attendees,double_visit_medical_rep_name,start_time,end_time,notes,sort_order,employee_plan_visit_details(id,plan_id,item_id,doctor_name,speciality,address,objective,sort_order))",
      )
      .in("status", ["submitted", "manager_approved"])
      .order("submitted_at", { ascending: true })
      .limit(WORKSPACE_PLAN_LIMIT);
    if (error) throw error;

    const rows = (data ?? []) as Array<
      Pick<
        PlanHeaderRow,
        | "id"
        | "employee_hr_id"
        | "employee_name"
        | "employee_job_title"
        | "manager_hr_id"
        | "manager_name"
        | "period_key"
        | "period_start_date"
        | "period_end_date"
        | "plan_kind"
        | "status"
        | "submitted_at"
        | "created_at"
      > & { employee_plan_items?: PlanItemRow[] }
    >;

    const directory = await getEmployeeDirectory();
    const directoryByHrId = new Map(directory.employees.map((employee) => [normalizeHrId(employee.hrId), employee]));

    const items: ApproverPendingPlan[] = [];
    for (const row of rows) {
      const stage = resolveApproverPlanStage(
        row.status,
        row.manager_hr_id,
        access,
        row.employee_job_title,
        await resolveSubmitterIsDistrictManager(row),
      );
      if (!stage) continue;
      const planItems = (row.employee_plan_items ?? [])
        .slice()
        .sort((a, b) => `${a.activity_date}-${String(a.sort_order).padStart(4, "0")}`.localeCompare(`${b.activity_date}-${String(b.sort_order).padStart(4, "0")}`))
        .map(mapApproverPlanItem);
      items.push({
        employeeHrId: row.employee_hr_id,
        employeeJobTitle: row.employee_job_title,
        employeeName: row.employee_name,
        employeeDisplayName: directoryByHrId.get(normalizeHrId(row.employee_hr_id))?.displayName || row.employee_name,
        id: row.id,
        itemCount: planItems.length,
        items: planItems,
        managerName: row.manager_name,
        managerDisplayName: directoryByHrId.get(normalizeHrId(row.manager_hr_id))?.displayName || row.manager_name,
        periodEndDate: row.period_end_date,
        periodKey: row.period_key,
        periodStartDate: row.period_start_date,
        planKind: row.plan_kind,
        reviewHref: `${reviewBase}?plan=${row.id}`,
        stage,
        status: row.status,
        submittedAt: row.submitted_at ?? row.created_at,
      });
    }
    return items;
  } catch (error) {
    if (isSchemaMissing(error)) return [];
    throw error;
  }
}

// ===========================================================================
// Cross-domain plan prefill + submission completeness guard
//
// Approved Vacation/Excuse days (and, for monthly plans, already-submitted
// weekly plans) are surfaced into the plan editor so the employee never
// re-declares them blind. The submission guard then enforces that every
// required working slot (per the role-aware workweek) is filled before a plan
// can leave draft. See plan-v1.ts for the workweek model.
// ===========================================================================

export type PlanPrefillSource = "vacation" | "excuse" | "national_vacation" | "weekly" | "monthly";

export type PlanPrefillItem = {
  activityDate: string;
  slot: PlanSlot;
  activityType: EmployeePlanActivityType;
  activityTitle: string;
  area: string | null;
  locationText: string | null;
  objective: string | null;
  notes: string;
  source: PlanPrefillSource;
  sourceLabel: string;
  // Locked rows (approved vacation/excuse) are read-only in the editor; sourced
  // weekly rows are editable. Both always satisfy the workday guard.
  locked: boolean;
};

export type PlanPrefill = {
  items: PlanPrefillItem[];
  schemaReady: boolean;
  // Egyptian national-holiday dates within the period, for the client to
  // soft-warn (not block) when a day is manually marked "National Vacation".
  nationalHolidayDates: string[];
};

const PLAN_SLOT_TIMES: Record<Exclude<PlanSlot, "full">, { start: string; end: string }> = {
  am: { start: "09:00", end: "13:00" },
  pm: { start: "13:00", end: "17:00" },
};

function planSlotFromTimes(start: string | null | undefined, end: string | null | undefined): PlanSlot {
  const s = String(start ?? "").slice(0, 5);
  const e = String(end ?? "").slice(0, 5);
  if (s === PLAN_SLOT_TIMES.am.start && e === PLAN_SLOT_TIMES.am.end) return "am";
  if (s === PLAN_SLOT_TIMES.pm.start && e === PLAN_SLOT_TIMES.pm.end) return "pm";
  return "full";
}

function dayPartToSlot(dayPart: string | null | undefined): PlanSlot {
  const value = String(dayPart ?? "").toLowerCase();
  if (value === "am_only") return "am";
  if (value === "pm_only") return "pm";
  return "full";
}

function excuseTypeToSlot(excuseType: string | null | undefined): PlanSlot {
  return String(excuseType ?? "").toLowerCase() === "afternoon" ? "pm" : "am";
}

function eachDateInclusive(start: string, end: string): string[] {
  const result: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor.getTime() <= last.getTime()) {
    result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

type ApprovedVacationRow = {
  start_date: string;
  end_date: string | null;
  day_part: string | null;
  vacation_type: string | null;
};

type ApprovedExcuseRow = {
  excuse_date: string;
  excuse_type: string | null;
};

// Manager-approved vacations overlapping [start, end]. We key on
// manager_decision='approved' (the moment the direct manager signs off), per
// product decision, independent of the later HR step. Degrades to [] if the
// column/table is absent so the editor never crashes.
async function loadManagerApprovedVacations(
  employeeHrId: string,
  start: string,
  end: string,
): Promise<{ rows: ApprovedVacationRow[]; ready: boolean }> {
  try {
    const keys = hrIdLookupKeys(employeeHrId);
    if (keys.length === 0) return { rows: [], ready: true };
    const { data, error } = await getSupabaseAdmin()
      .from("v2_vacation_requests")
      .select("start_date,end_date,day_part,vacation_type,manager_decision,status")
      .eq("manager_decision", "approved")
      .neq("status", "rejected")
      .lte("start_date", end)
      .gte("end_date", start)
      .in("employee_hr_id", keys)
      .limit(100);
    if (error) throw error;
    return { rows: (data ?? []) as ApprovedVacationRow[], ready: true };
  } catch (error) {
    if (isSchemaMissing(error)) return { rows: [], ready: false };
    throw error;
  }
}

// Submitted-but-not-yet-manager-approved vacations overlapping [start, end].
// These reserve the day in the plan (so the employee is never forced to plan
// work on a day they've already requested off) and are accepted by the submit
// guard. Once the manager approves, the request instead surfaces via
// loadManagerApprovedVacations (manager_decision='approved'); if it is rejected
// it drops out on the next editor open. Degrades to [] if the table is absent.
async function loadPendingVacations(
  employeeHrId: string,
  start: string,
  end: string,
): Promise<{ rows: ApprovedVacationRow[]; ready: boolean }> {
  try {
    const keys = hrIdLookupKeys(employeeHrId);
    if (keys.length === 0) return { rows: [], ready: true };
    const { data, error } = await getSupabaseAdmin()
      .from("v2_vacation_requests")
      .select("start_date,end_date,day_part,vacation_type,manager_decision,status")
      .in("status", ["needs_assignment", "pending_manager", "submitted"])
      .lte("start_date", end)
      .gte("end_date", start)
      .in("employee_hr_id", keys)
      .limit(100);
    if (error) throw error;
    return { rows: (data ?? []) as ApprovedVacationRow[], ready: true };
  } catch (error) {
    if (isSchemaMissing(error)) return { rows: [], ready: false };
    throw error;
  }
}

async function loadApprovedExcuses(
  employeeHrId: string,
  start: string,
  end: string,
): Promise<{ rows: ApprovedExcuseRow[]; ready: boolean }> {
  try {
    const keys = hrIdLookupKeys(employeeHrId);
    if (keys.length === 0) return { rows: [], ready: true };
    const { data, error } = await getSupabaseAdmin()
      .from("v2_excuse_requests")
      .select("excuse_date,excuse_type,status")
      .eq("status", "approved")
      .gte("excuse_date", start)
      .lte("excuse_date", end)
      .in("employee_hr_id", keys)
      .limit(100);
    if (error) throw error;
    return { rows: (data ?? []) as ApprovedExcuseRow[], ready: true };
  } catch (error) {
    if (isSchemaMissing(error)) return { rows: [], ready: false };
    throw error;
  }
}

// A plan only counts as a source for the other cadence once it has left draft. A draft is a
// private scratchpad (the same reading DUPLICATE_PERIOD_IGNORED_STATUSES takes), and a cancelled
// or rejected plan never became the plan of record — sourcing from either would seed a week from
// something its own author had already abandoned.
const PLAN_SOURCE_STATUSES = [
  "submitted",
  "manager_approved",
  "ceo_approved",
  "final_approved",
  "hr_acknowledged",
] as const satisfies readonly EmployeePlanStatus[];

// Submitted/approved weekly plans overlapping [start, end] (monthly sourcing).
async function loadWeeklySourcedItems(
  employeeHrId: string,
  start: string,
  end: string,
): Promise<{ items: PlanPrefillItem[]; ready: boolean }> {
  try {
    const keys = hrIdLookupKeys(employeeHrId);
    if (keys.length === 0) return { items: [], ready: true };
    const supabase = getSupabaseAdmin();
    const { data: headers, error: headersError } = await supabase
      .from("employee_plan_headers")
      .select("id,status,plan_kind,parent_plan_id")
      .eq("plan_kind", "weekly")
      .in("status", PLAN_SOURCE_STATUSES)
      .lte("period_start_date", end)
      .gte("period_end_date", start)
      .in("employee_hr_id", keys)
      .limit(20);
    if (headersError) throw headersError;
    const planIds = dropPendingRevisionsOfPlansOfRecord(
      (headers ?? []) as Array<{ id: string; parent_plan_id: string | null; status: string }>,
    ).map((row) => row.id);
    if (planIds.length === 0) return { items: [], ready: true };
    const { data: itemRows, error: itemsError } = await supabase
      .from("employee_plan_items")
      .select("activity_date,activity_type,activity_title,area,location_text,objective,notes,start_time,end_time")
      .in("plan_id", planIds)
      .gte("activity_date", start)
      .lte("activity_date", end)
      .order("activity_date", { ascending: true })
      .order("sort_order", { ascending: true })
      .limit(2000);
    if (itemsError) throw itemsError;
    const items = ((itemRows ?? []) as PlanItemRow[]).map((row) => ({
      activityDate: row.activity_date,
      slot: planSlotFromTimes(row.start_time, row.end_time),
      activityType: row.activity_type,
      activityTitle: row.activity_title,
      area: row.area,
      locationText: row.location_text,
      objective: row.objective,
      notes: row.notes ?? "",
      source: "weekly" as const,
      sourceLabel: "From weekly plan",
      // Locked & authoritative: a submitted week is the source of truth for its
      // days inside the monthly plan, re-synced on every open. The employee edits
      // the weekly plan to change it — it can never silently go missing here.
      locked: true,
    }));
    return { items, ready: true };
  } catch (error) {
    if (isSchemaMissing(error)) return { items: [], ready: false };
    throw error;
  }
}

// The covering monthly plan's items for [start, end] (weekly sourcing) — the other half of the
// sync, and the half that was missing.
//
// It matters that this direction exists at all. People write the month FIRST and refine it into
// weeks afterwards: both monthly plans ever submitted in production were created before any weekly
// plan for their month existed (A-7 on 2026-06-29 for July, A-10 on 2026-07-05). At that moment
// loadWeeklySourcedItems above had nothing to read, so the monthly plan was written blind, the
// weeks were written blind after it, and the two drifted — 9 of 26 shared days disagreed, four of
// them claiming Office on a day the week called Vacation.
//
// Unlike the weekly rows sourced INTO a monthly plan, these are NOT locked. The week is where a
// month gets refined, so the seed is a starting point the employee may edit freely; the weekly
// plan is authoritative once submitted, and reconcileMonthlyFromWeekly then carries the refinement
// back. Locking here would make the month un-refinable, which is the opposite of the intent.
async function loadMonthlySourcedItems(
  employeeHrId: string,
  start: string,
  end: string,
): Promise<{ items: PlanPrefillItem[]; ready: boolean }> {
  try {
    const keys = hrIdLookupKeys(employeeHrId);
    if (keys.length === 0) return { items: [], ready: true };
    const supabase = getSupabaseAdmin();
    const { data: headers, error: headersError } = await supabase
      .from("employee_plan_headers")
      .select("id,status,plan_kind,parent_plan_id")
      .eq("plan_kind", "monthly")
      .in("status", PLAN_SOURCE_STATUSES)
      .lte("period_start_date", end)
      .gte("period_end_date", start)
      .in("employee_hr_id", keys)
      .limit(20);
    if (headersError) throw headersError;
    const planIds = dropPendingRevisionsOfPlansOfRecord(
      (headers ?? []) as Array<{ id: string; parent_plan_id: string | null; status: string }>,
    ).map((row) => row.id);
    if (planIds.length === 0) return { items: [], ready: true };
    const { data: itemRows, error: itemsError } = await supabase
      .from("employee_plan_items")
      .select("activity_date,activity_type,activity_title,area,location_text,objective,notes,start_time,end_time")
      .in("plan_id", planIds)
      .gte("activity_date", start)
      .lte("activity_date", end)
      .order("activity_date", { ascending: true })
      .order("sort_order", { ascending: true })
      .limit(2000);
    if (itemsError) throw itemsError;
    const items = ((itemRows ?? []) as PlanItemRow[]).map((row) => ({
      activityDate: row.activity_date,
      slot: planSlotFromTimes(row.start_time, row.end_time),
      activityType: row.activity_type,
      activityTitle: row.activity_title,
      area: row.area,
      locationText: row.location_text,
      objective: row.objective,
      notes: row.notes ?? "",
      source: "monthly" as const,
      sourceLabel: "From monthly plan",
      locked: false,
    }));
    return { items, ready: true };
  } catch (error) {
    if (isSchemaMissing(error)) return { items: [], ready: false };
    throw error;
  }
}

/**
 * Build the prefill (locked vacation/excuse + sourced weekly items) for a given
 * period. Re-computed each time the editor opens, so the monthly plan always
 * live-reflects the latest submitted/approved weekly plans.
 */
export async function getPlanPrefill(
  access: AccessContext,
  kind: EmployeePlanKind,
  anchorDate: string,
): Promise<PlanPrefill> {
  await assertPermission(access, "weekly_plans", "read");
  const employee = await currentEmployee(access);
  if (!employee) return { items: [], schemaReady: true, nationalHolidayDates: [] };
  const workweek = resolvePlanWorkweek({
    jobTitle: employeeTitle(employee, access.role),
    role: access.role,
  });
  const period = buildEmployeePlanPeriod(kind, anchorDate, workweek);
  const start = period.periodStartDate;
  const end = period.periodEndDate;

  const items: PlanPrefillItem[] = [];
  let ready = true;

  const vacation = await loadManagerApprovedVacations(employee.hrId, start, end);
  ready = ready && vacation.ready;
  for (const row of vacation.rows) {
    const slot = dayPartToSlot(row.day_part);
    const clippedStart = row.start_date < start ? start : row.start_date;
    const clippedEnd = !row.end_date || row.end_date > end ? end : row.end_date;
    for (const date of eachDateInclusive(clippedStart, clippedEnd)) {
      items.push({
        activityDate: date,
        slot,
        activityType: "Vacation",
        activityTitle: "Vacation",
        area: null,
        locationText: null,
        objective: null,
        notes: "",
        source: "vacation",
        sourceLabel: "Approved vacation",
        locked: true,
      });
    }
  }

  // Reserve pending (submitted-but-unapproved) vacation days so the employee is
  // never forced to plan work on a day they have already requested off. Skips
  // dates already covered by an approved vacation above.
  const approvedVacationDates = new Set(
    items.filter((item) => item.source === "vacation").map((item) => item.activityDate),
  );
  const pendingVacation = await loadPendingVacations(employee.hrId, start, end);
  ready = ready && pendingVacation.ready;
  for (const row of pendingVacation.rows) {
    const slot = dayPartToSlot(row.day_part);
    const clippedStart = row.start_date < start ? start : row.start_date;
    const clippedEnd = !row.end_date || row.end_date > end ? end : row.end_date;
    for (const date of eachDateInclusive(clippedStart, clippedEnd)) {
      if (approvedVacationDates.has(date)) continue;
      items.push({
        activityDate: date,
        slot,
        activityType: "Vacation",
        activityTitle: "Vacation",
        area: null,
        locationText: null,
        objective: null,
        notes: "",
        source: "vacation",
        sourceLabel: "Vacation — pending approval",
        locked: true,
      });
    }
  }

  const excuses = await loadApprovedExcuses(employee.hrId, start, end);
  ready = ready && excuses.ready;
  for (const row of excuses.rows) {
    items.push({
      activityDate: row.excuse_date,
      slot: excuseTypeToSlot(row.excuse_type),
      activityType: "Excuse",
      activityTitle: "Excuse",
      area: null,
      locationText: null,
      objective: null,
      notes: "",
      source: "excuse",
      sourceLabel: "Approved excuse",
      locked: true,
    });
  }

  if (kind === "monthly") {
    const weekly = await loadWeeklySourcedItems(employee.hrId, start, end);
    ready = ready && weekly.ready;
    items.push(...weekly.items);
  } else {
    const monthly = await loadMonthlySourcedItems(employee.hrId, start, end);
    ready = ready && monthly.ready;
    // Never seed a day an approved vacation/excuse already speaks for: those rows are locked and
    // authoritative, and a monthly "Office" landing beside a locked "Vacation" on the same day is
    // the very contradiction this sync exists to end.
    const spokenFor = new Set(items.map((item) => `${item.activityDate}|${item.slot}`));
    items.push(...monthly.items.filter((item) => !spokenFor.has(`${item.activityDate}|${item.slot}`)));
  }

  const nationalHolidayDates = await loadNationalHolidayDates(start, end);

  // Hardcode HR-confirmed national holidays as locked rows on the working days
  // they land on, so the employee is never forced to hand-fill a public holiday
  // (and can never accidentally plan work over one). Holidays on an off-day need
  // no row. getConfirmedNationalHolidays (via loadNationalHolidayDates) already
  // resolves any HR-postponed observed date, so this lands on the real day off.
  const requiredSlotsForHolidays = planRequiredSlotsByDate(start, end, workweek);
  for (const date of nationalHolidayDates) {
    const requirement = requiredSlotsForHolidays.get(date);
    if (!requirement) continue;
    items.push({
      activityDate: date,
      slot: requirement === "am" ? "am" : "full",
      activityType: "National Vacation",
      activityTitle: "National Vacation",
      area: null,
      locationText: null,
      objective: null,
      notes: "",
      source: "national_vacation",
      sourceLabel: "National holiday (HR confirmed)",
      locked: true,
    });
  }

  return { items, schemaReady: ready, nationalHolidayDates };
}

// Egyptian national-holiday dates that fall within [start, end]. Cached + guarded
// so a slow/failed holiday source never breaks the editor (returns []).
async function loadNationalHolidayDates(start: string, end: string): Promise<string[]> {
  try {
    const monthsSeen = new Set<string>();
    const cursor = new Date(`${start}T00:00:00Z`);
    const last = new Date(`${end}T00:00:00Z`);
    while (cursor.getTime() <= last.getTime()) {
      monthsSeen.add(`${cursor.getUTCFullYear()}-${cursor.getUTCMonth() + 1}`);
      cursor.setUTCDate(1);
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    const dates = new Set<string>();
    for (const key of monthsSeen) {
      const [year, month] = key.split("-").map(Number);
      const result = await getConfirmedNationalHolidays({ month, year });
      for (const holiday of result.holidays) {
        for (const date of eachDateInclusive(holiday.startDate, holiday.endDate ?? holiday.startDate)) {
          if (date >= start && date <= end) dates.add(date);
        }
      }
    }
    return Array.from(dates).sort();
  } catch {
    return [];
  }
}

/**
 * Submission completeness guard. Throws a plain Error (surfaced to the user as
 * a 400-style message) when any required working slot is empty, or when a
 * Vacation/Excuse day is not backed by an approved request.
 */
async function assertSubmissionComplete(input: {
  employeeHrId: string;
  items: EmployeePlanItemInput[];
  periodEndDate: string;
  periodStartDate: string;
  workweek: PlanWorkweek;
}) {
  const { items, periodEndDate, periodStartDate, workweek } = input;
  const required = planRequiredSlotsByDate(periodStartDate, periodEndDate, workweek);

  // Slots present per date.
  const slotsByDate = new Map<string, Set<PlanSlot>>();
  for (const item of items) {
    const slot = planSlotFromTimes(item.startTime, item.endTime);
    const set = slotsByDate.get(item.activityDate) ?? new Set<PlanSlot>();
    set.add(slot);
    slotsByDate.set(item.activityDate, set);
  }

  const incomplete: string[] = [];
  for (const [date, requirement] of required) {
    const gap = planDayGapText(requirement, slotsByDate.get(date) ?? new Set<PlanSlot>());
    if (gap !== null) incomplete.push(`${formatPlanDayLabel(date)}${gap}`);
  }

  if (incomplete.length > 0) {
    const rule = planWorkweekAllowsHalfDays(workweek)
      ? "every working day needs at least its morning or its afternoon before submit"
      : "every working day must be fully filled before submit";
    throw new Error(`Plan is incomplete — ${rule}. Missing: ${incomplete.join(", ")}.`);
  }

  // Validate that any leave-typed days are backed by approved requests.
  const vacationItems = items.filter((item) => item.activityType === "Vacation");
  const excuseItems = items.filter((item) => item.activityType === "Excuse");
  if (vacationItems.length === 0 && excuseItems.length === 0) return;

  const [vacation, pendingVacation, excuses] = await Promise.all([
    vacationItems.length > 0
      ? loadManagerApprovedVacations(input.employeeHrId, periodStartDate, periodEndDate)
      : Promise.resolve({ rows: [] as ApprovedVacationRow[], ready: true }),
    vacationItems.length > 0
      ? loadPendingVacations(input.employeeHrId, periodStartDate, periodEndDate)
      : Promise.resolve({ rows: [] as ApprovedVacationRow[], ready: true }),
    excuseItems.length > 0
      ? loadApprovedExcuses(input.employeeHrId, periodStartDate, periodEndDate)
      : Promise.resolve({ rows: [] as ApprovedExcuseRow[], ready: true }),
  ]);

  // A Vacation day is valid if covered by any live vacation request — approved OR
  // still pending. Pending days are reserved in the editor; a later rejection
  // simply drops them out on the next editor open.
  const coveringVacations = [...vacation.rows, ...pendingVacation.rows];
  const vacationViolations: string[] = [];
  for (const item of vacationItems) {
    const covered = coveringVacations.some((row) => {
      const endDate = row.end_date ?? row.start_date;
      return item.activityDate >= row.start_date && item.activityDate <= endDate;
    });
    if (!covered) vacationViolations.push(formatPlanDayLabel(item.activityDate));
  }
  if (vacationViolations.length > 0) {
    throw new Error(
      `These days are marked Vacation but have no vacation request on file — submit a vacation request first: ${vacationViolations.join(", ")}.`,
    );
  }

  const excuseViolations: string[] = [];
  for (const item of excuseItems) {
    const slot = planSlotFromTimes(item.startTime, item.endTime);
    const covered = excuses.rows.some(
      (row) => row.excuse_date === item.activityDate && excuseTypeToSlot(row.excuse_type) === slot,
    );
    if (!covered) excuseViolations.push(formatPlanDayLabel(item.activityDate));
  }
  if (excuseViolations.length > 0) {
    throw new Error(
      `These days are marked Excuse but have no approved excuse request: ${excuseViolations.join(", ")}.`,
    );
  }
}

function formatPlanDayLabel(date: string): string {
  try {
    return new Intl.DateTimeFormat("en", {
      day: "2-digit",
      month: "short",
      timeZone: "UTC",
      weekday: "short",
    }).format(new Date(`${date}T00:00:00Z`));
  } catch {
    return date;
  }
}

/**
 * A district manager whose own Phoenix CRM team is live plans his week in Phoenix CRM, not here (owner,
 * 2026-10-16: "replace the old DM plan"; Mohamed Alaa stays on this form until his team starts). Each
 * one switches by himself the day his team starts. A failed read keeps this form open rather than
 * stranding a manager with no form at all.
 */
async function plansInPhoenixCrm(access: AccessContext): Promise<boolean> {
  return dmPlansInPhoenixCrm(access.hrId).catch(() => false);
}

async function assertPlansOnThisForm(access: AccessContext): Promise<void> {
  if (await plansInPhoenixCrm(access)) throw new Error(DM_PLANS_IN_PHOENIX_CRM);
}

/** Every plan one person filed on this form, newest first — a switched manager's history. */
async function loadOwnPlanRows(employeeHrId: string): Promise<PlanHeaderRow[]> {
  const ids = [...new Set([employeeHrId, employeeHrId.toUpperCase()])];
  const { data, error } = await getSupabaseAdmin()
    .from("employee_plan_headers")
    .select(planSelect)
    .in("employee_hr_id", ids)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as PlanHeaderRow[];
}

export async function createEmployeePlan(access: AccessContext, input: {
  anchorDate: string;
  items: EmployeePlanItemInput[];
  planKind: EmployeePlanKind;
  submit?: boolean;
}) {
  await assertPermission(access, "weekly_plans", "create");
  await assertPlansOnThisForm(access);
  const employee = await currentEmployee(access);
  if (!employee || !canSubmitFromEmployee(employee, access.role)) {
    throw new Error("Forbidden: this position is not eligible to submit weekly/monthly plans.");
  }
  // NSM has no manager of manager above them — allow submitting without a manager on
  // record instead of hard-blocking; the CEO decides the manager stage either way (see
  // assertManagerReviewer/notifyManager's null-manager fallbacks).
  const managerOptional = isNationalSalesManagerEmployee(employee, access.role);
  if (!employee.managerHrId && !managerOptional) {
    throw new Error("Direct manager is missing from employee profile.");
  }
  if (!isActiveEmployee(employee)) {
    throw new Error("Forbidden: only active employees can submit plans.");
  }
  const workweek = resolvePlanWorkweek({
    jobTitle: employeeTitle(employee, access.role),
    role: access.role,
  });
  const period = buildEmployeePlanPeriod(input.planKind, input.anchorDate, workweek);
  await assertNoActivePlanForSamePeriod(employee.hrId, input.planKind, period);
  // Wrong-week guard (owner, 2026-09-26): a weekly plan filed for a week that had already begun or
  // elapsed is flagged for review. Never a block — the plan is created normally; the flag only
  // makes an off-window plan visible to the owner and reviewers. Weekly only; set once here.
  const offWindowFlagged =
    input.planKind === "weekly" &&
    isPastPlanWeek({
      periodStartDate: period.periodStartDate,
      todayIso: currentCairoDateOnlyIso(),
      workweek,
    });
  const items = normalizeItems(
    input.items,
    period.periodStartDate,
    period.periodEndDate,
    await medicalRepOptionsForEmployee(
      employee,
      isOrgWidePlanningEmployee(employee, access.role),
      await resolveViewerAllowedLines(access),
    ),
    {
      marketingDoubleVisit: await marketingDoubleVisitContextFor(employee, access.role),
      planningSeats: await planningSeatsForOwner(employee),
      submit: Boolean(input.submit),
    },
  );
  if (input.submit) {
    await assertSubmissionComplete({
      employeeHrId: employee.hrId,
      items,
      periodEndDate: period.periodEndDate,
      periodStartDate: period.periodStartDate,
      workweek,
    });
  }

  // Always create the row in 'draft' first. If the caller asked to submit, we
  // replace items and optionally promote to 'submitted' through the item RPC,
  // so items, revision, and submit decision cannot drift under concurrency.
  const { data, error } = await getSupabaseAdmin()
    .from("employee_plan_headers")
    .insert({
      created_by_login_id: access.loginId ?? null,
      employee_hr_id: employee.hrId,
      employee_job_title: employeeTitle(employee, access.role),
      employee_name: employee.fullName,
      hierarchy_snapshot: {
        lineName: employee.lineName,
        managerHrId: employee.managerHrId,
        managerName: employee.managerName,
      },
      manager_hr_id: employee.managerHrId,
      manager_name: employee.managerName,
      off_window_flagged: offWindowFlagged,
      period_end_date: period.periodEndDate,
      period_key: period.periodKey,
      period_start_date: period.periodStartDate,
      plan_kind: input.planKind,
      status: "draft",
    })
    .select(planSelect)
    .single();
  if (error) throw error;
  const plan = data as PlanHeaderRow;
  await rpcReplacePlanItems({
    access,
    expectedRevision: plan.revision,
    items,
    planId: plan.id,
    submit: Boolean(input.submit),
  });
  if (input.submit) {
    await afterPlanSubmitted(access, await loadPlanRow(plan.id));
  }
  await writeAuditLog({
    actorLoginId: access.loginId,
    entityId: plan.id,
    entityType: "weekly_plan",
    newValues: { planKind: input.planKind, status: input.submit ? "submitted" : "draft" },
    summary: `${input.planKind} plan ${input.submit ? "submitted" : "draft created"}`,
  });
  return mapPlan(await loadPlanRow(plan.id));
}

export async function updateEmployeePlan(access: AccessContext, planId: string, input: {
  items: EmployeePlanItemInput[];
  submit?: boolean;
}) {
  await assertPermission(access, "weekly_plans", "update");
  const existing = await loadPlanRow(planId);
  assertPlanOwner(access, existing);
  await assertPlansOnThisForm(access);

  if (isClosedEmployeePlanStatus(existing.status)) {
    // Revising a closed plan: edit the revision already open for it, or spawn a new draft
    // revision (parent_plan_id chain). A new one is created as 'draft' first; if the caller
    // wants to submit in the same call, the item RPC promotes the revision atomically. The
    // revise audit row is written separately so the new row's history starts with a `revise`
    // decision row before the optional submit. When the revision is approved,
    // phx_weekly_plan_decide cancels the plan it revised in the same transaction.
    const owner = await currentEmployee(access);
    if (owner && !isActiveEmployee(owner)) {
      throw new Error("Forbidden: only active employees can revise plans.");
    }
    const items = normalizeItems(
      input.items,
      existing.period_start_date,
      existing.period_end_date,
      await medicalRepOptionsForEmployee(
        owner,
        isOrgWidePlanningEmployee(owner, access.role),
        await resolveViewerAllowedLines(access),
      ),
      {
        marketingDoubleVisit: await marketingDoubleVisitContextFor(owner, access.role),
        planningSeats: await planningSeatsForOwner(owner),
        submit: Boolean(input.submit),
      },
    );
    if (input.submit) {
      await assertSubmissionComplete({
        employeeHrId: existing.employee_hr_id,
        items,
        periodEndDate: existing.period_end_date,
        periodStartDate: existing.period_start_date,
        workweek: resolvePlanWorkweek({
          jobTitle: existing.employee_job_title,
          role: owner ? access.role : null,
        }),
      });
    }
    // An approved plan stays the plan of record while its revision waits for the decisions (the
    // unique index lets one live revision sit beside it); chooseRevisionTarget says whether to edit
    // a revision that already exists, spawn one, or refuse because one is already awaiting a
    // decision. A dead (rejected or cancelled) plan spawns an UNLINKED draft — see the helper.
    const target = chooseRevisionTarget(existing.status, await loadRevisionSiblings(existing.id));
    if (target.kind === "blocked") {
      throw new WeeklyPlanRpcError("duplicate_period", REVISION_PENDING_MESSAGE);
    }
    let revisionRow: PlanHeaderRow;
    let spawnedHere = false;
    if (target.kind === "reuse") {
      revisionRow = await loadPlanRow(target.revisionId);
    } else {
      if (!target.linkToParent) {
        await assertNoActivePlanForSamePeriod(existing.employee_hr_id, existing.plan_kind, {
          periodEndDate: existing.period_end_date,
          periodStartDate: existing.period_start_date,
        });
      }
      const { data, error } = await getSupabaseAdmin()
        .from("employee_plan_headers")
        .insert({
          created_by_login_id: access.loginId ?? null,
          employee_hr_id: existing.employee_hr_id,
          employee_job_title: existing.employee_job_title,
          employee_name: existing.employee_name,
          hierarchy_snapshot: existing.hierarchy_snapshot ?? {},
          manager_hr_id: existing.manager_hr_id,
          manager_name: existing.manager_name,
          parent_plan_id: target.linkToParent ? existing.id : null,
          period_end_date: existing.period_end_date,
          period_key: existing.period_key,
          period_start_date: existing.period_start_date,
          plan_kind: existing.plan_kind,
          revision: existing.revision + 1,
          status: "draft",
        })
        .select(planSelect)
        .single();
      if (error) throw error;
      revisionRow = data as PlanHeaderRow;
      spawnedHere = true;
      try {
        await recordDecision({
          access,
          action: "revise",
          fromStatus: existing.status,
          planId: revisionRow.id,
          toStatus: "draft",
        });
      } catch (decisionError) {
        await discardUnsubmittedRevision(revisionRow.id);
        throw decisionError;
      }
    }
    try {
      await rpcReplacePlanItems({
        access,
        expectedRevision: revisionRow.revision,
        items,
        planId: revisionRow.id,
        submit: Boolean(input.submit),
      });
    } catch (itemsError) {
      // The header and its `revise` decision committed before the item write, so a failed write
      // left an empty draft behind — 23 of them in production. Take back only what THIS call made.
      if (spawnedHere) await discardUnsubmittedRevision(revisionRow.id);
      throw itemsError;
    }
    if (input.submit) {
      await afterPlanSubmitted(access, await loadPlanRow(revisionRow.id));
    }
    return mapPlan(await loadPlanRow(revisionRow.id));
  }

  if (!canEditEmployeePlanStatus(existing.status)) {
    throw new Error("This plan cannot be edited in its current status.");
  }
  const owner = await currentEmployee(access);
  const editItems = normalizeItems(
    input.items,
    existing.period_start_date,
    existing.period_end_date,
    await medicalRepOptionsForEmployee(
      owner,
      isOrgWidePlanningEmployee(owner, access.role),
      await resolveViewerAllowedLines(access),
    ),
    {
      marketingDoubleVisit: await marketingDoubleVisitContextFor(owner, access.role),
      planningSeats: await planningSeatsForOwner(owner),
      submit: Boolean(input.submit),
    },
  );
  if (input.submit) {
    await assertSubmissionComplete({
      employeeHrId: existing.employee_hr_id,
      items: editItems,
      periodEndDate: existing.period_end_date,
      periodStartDate: existing.period_start_date,
      workweek: resolvePlanWorkweek({
        jobTitle: existing.employee_job_title,
        role: owner ? access.role : null,
      }),
    });
  }
  await rpcReplacePlanItems({
    access,
    expectedRevision: existing.revision,
    items: editItems,
    planId: existing.id,
    submit: Boolean(input.submit),
  });
  if (input.submit) {
    await afterPlanSubmitted(access, await loadPlanRow(existing.id));
  }
  await writeAuditLog({
    actorLoginId: access.loginId,
    entityId: existing.id,
    entityType: "weekly_plan",
    newValues: { status: input.submit ? "submitted" : existing.status },
    oldValues: { status: existing.status },
    summary: `${existing.plan_kind} plan ${input.submit ? "submitted" : "updated"}`,
  });
  return mapPlan(await loadPlanRow(existing.id));
}

export async function decideEmployeePlan(access: AccessContext, planId: string, input: {
  action: Extract<EmployeePlanAction, "manager_approve" | "manager_reject" | "manager_return" | "ceo_approve" | "ceo_reject" | "ceo_return">;
  comment?: string | null;
  returnNotes?: EmployeePlanReturnNoteInput[];
}) {
  const plan = await loadPlanRow(planId);
  // The submitter's District-Manager-ness by title OR app role — an acting DM keeps a Medical
  // Representative title (isDistrictManagerPlanSubmitter). Resolved once: the guards below and the
  // cascade both turn on it.
  const isDistrictManagerPlan = isDistrictManagerPlanSubmitter(plan.employee_job_title, await authRoleForHrId(plan.employee_hr_id));
  // The DMs reporting to Hany Saad take a second stage: Hany's approval rests at manager_approved
  // and Ali Mohamed Ali decides it (second-approver.ts, owner 2026-09-20) instead of it landing on
  // final_approved in one decision.
  const hasSecondApprover = planHasSecondApprover(plan.manager_hr_id, isDistrictManagerPlan);
  if (input.action.startsWith("manager_")) {
    // The assigned direct manager decides the manager stage by virtue of the org assignment,
    // independent of the global weekly_plans:approve grant. (No Super Admin bypass —
    // assertManagerReviewer below admits only the assigned manager, or CEO when the plan has
    // no manager at all.) This lets eligible
    // submitters' managers (e.g. Marketing/Group Product/National Sales Manager) approve, return,
    // or reject their reports' plans even though their role lacks a company-wide approve grant.
    await assertManagerReviewer(access, plan);
  } else if (input.action.startsWith("ceo_") && hasSecondApprover) {
    // Identity-gated exactly like the manager stage: the named second approver decides it by virtue
    // of the org assignment, independent of the global weekly_plans:approve grant, and nobody else
    // can — not the CEO, not Super Admin.
    await assertSecondApprover(access, plan);
  } else if (input.action.startsWith("ceo_")) {
    await assertPermission(access, "weekly_plans", "approve");
    assertCeoReviewer(access);
    // District Manager plans never reach a human CEO decision — their manager's approval
    // auto-cascades straight to final_approved further down. The CEO stage exists for every
    // other eligible role; block it here rather than only hiding it in the UI, so a direct
    // API call can't still push a DM plan through ceo_approve/ceo_reject/ceo_return.
    //
    // Title-only ON PURPOSE, unlike bypassCeo below. A plan whose submitter is a District
    // Manager by app role alone (an acting DM) could already be resting at manager_approved from
    // before the app-role check existed (2026-09-13), and the CEO stage is the only path left to
    // it — blocking it here would strand that plan with no one able to act. From then on such a
    // plan never reaches manager_approved, so there is nothing else for this guard to catch.
    if (isDistrictManagerPlanTitle(plan.employee_job_title)) {
      throw new Error("Forbidden: District Manager plans are decided by HR, not the CEO.");
    }
  }
  // District Manager plans have no CEO stage at all ("dsm submit, nsm respond, hr ack
  // automated" — owner, 2026-09-05). Their manager's (National Sales Manager's) approval is
  // the plan's ONE real approval, so it lands straight on final_approved in a single decision
  // that writes NO ceo_approve row — never a fabricated CEO decision stamped with the
  // manager's own identity. bypassCeo carries that through both the client-side next-status
  // computation and the RPC's server-side one (phx_weekly_plan_next_status.bypass_ceo).
  //
  // The submitter's APP ROLE counts as well as the title: an acting District Manager is titled a
  // Medical Representative (isDistrictManagerPlanSubmitter). The title alone put her plans at
  // manager_approved, waiting on a CEO stage a DM plan does not have.
  //
  // The one exception is a DM whose manager has a second approver (hasSecondApprover above): that
  // plan is NOT bypassed — Hany's approval rests at manager_approved for Ali's decision.
  const bypassCeo = input.action === "manager_approve" && isDistrictManagerPlan && !hasSecondApprover;

  // The next status is computed client-side for the audit-log entry and the
  // notification branch below, but the SQL function recomputes the same rule
  // server-side using phx_weekly_plan_next_status, which is the source of
  // truth. The RPC also runs SELECT FOR UPDATE on the header row before
  // writing, so two concurrent decides can't both succeed.
  const nextStatus = getNextEmployeePlanStatus(plan.status, input.action, { comment: input.comment, bypassCeo });
  await rpcDecidePlan({
    access,
    action: input.action,
    comment: input.comment,
    expectedRevision: plan.revision,
    planId,
    returnNotes: input.returnNotes,
    bypassCeo,
  });

  let updated = await loadPlanRow(planId);
  await writeAuditLog({
    actorLoginId: access.loginId,
    entityId: planId,
    entityType: "weekly_plan",
    newValues: { status: nextStatus },
    oldValues: { status: plan.status },
    summary: `${updated.plan_kind} plan decision: ${input.action}${bypassCeo ? " (District Manager plan — no CEO stage, final approval)" : ""}`,
  });

  if (bypassCeo) {
    // The single manager_approve above already reached final_approved with no CEO row. Just
    // acknowledge on HR's behalf and notify them, so the HR message can tell the truth about
    // the state the plan is actually in.
    updated = await autoAcknowledgeFinalApprovedPlan(access, updated);
    await notifyHr(updated);
  } else if (input.action === "manager_approve" && access.role === "CEO") {
    // National Sales Manager reports directly to the CEO with no manager of manager above
    // them, so the CEO is both the manager-stage and CEO-stage reviewer for their plans (see
    // assertManagerReviewer's null-manager fallback, and the manager_hr_id-is-the-CEO
    // convention). Their manager-stage approval is still a real decision the CEO must make —
    // it just shouldn't also require a separate, purely-formal second click to re-approve
    // their own decision, so it cascades straight into ceo_approve in the same request,
    // recorded as the CEO's own second real decision. (This is a genuine CEO decision, unlike
    // the DM bypass above, so it correctly writes a ceo_approve row under the CEO's identity.)
    await assertPermission(access, "weekly_plans", "approve");
    const beforeCeoApprove = updated;
    await rpcDecidePlan({
      access,
      action: "ceo_approve",
      comment: null,
      expectedRevision: updated.revision,
      planId,
      returnNotes: [],
    });
    updated = await loadPlanRow(planId);
    await writeAuditLog({
      actorLoginId: access.loginId,
      entityId: planId,
      entityType: "weekly_plan",
      newValues: { status: "final_approved" },
      oldValues: { status: beforeCeoApprove.status },
      summary: `${updated.plan_kind} plan decision: ceo_approve (auto-cascaded from manager approval)`,
    });
    updated = await autoAcknowledgeFinalApprovedPlan(access, updated);
    await notifyHr(updated);
  } else if (input.action === "manager_approve" && hasSecondApprover) {
    await notifySecondApprover(updated);
  } else if (input.action === "manager_approve") {
    await notifyCeo(updated);
  } else if (input.action === "ceo_approve") {
    updated = await autoAcknowledgeFinalApprovedPlan(access, updated);
    await notifyHr(updated, hasSecondApprover ? secondApproverLabelForManager(plan.manager_hr_id) : null);
  }
  if (input.action === "manager_approve") {
    await notifyEmployeeManagerApproved(updated);
  }
  if (input.action.includes("return") || input.action.includes("reject")) {
    await notifyEmployeeReturnedOrRejected(updated, input.action, input.comment ?? null, access.hrId ?? null);
  }
  return mapPlan(updated);
}

// Plans stuck on the manager stage — awaiting the assigned manager's decision. These mirror
// the D4 drift detector (scripts/weekly-plans-drift.sql) exactly. A `manager_returned` /
// `ceo_returned` plan is editable and, on resubmit (updateEmployeePlan), keeps its existing
// manager_hr_id verbatim — it is never re-resolved — so if that manager has since resigned the
// plan stays pinned to a dead approver just like a `submitted` one. All three therefore need
// reassignment.
const REASSIGNABLE_PLAN_STATUSES: EmployeePlanStatus[] = ["submitted", "manager_returned", "ceo_returned"];

// HR/Super-Admin re-routes a stuck plan to a new active manager when the assigned manager has
// resigned before deciding. This is REASSIGNMENT, not deciding-in-place: it only changes WHO
// owns the pending manager step (manager_hr_id/manager_name) and never touches `status` or runs
// a decision RPC. The newly-assigned manager must still pass the exact same assertManagerReviewer
// identity gate as any manager when they later decide — nothing here lets HR/Super-Admin approve,
// return, or reject in another manager's place (owner-locked approver model).
export async function reassignWeeklyPlanManager(
  access: AccessContext,
  input: { planId: string; newManagerHrId: string },
) {
  // Two-part gate, mirroring vacation's assertVacationAdminManagement: the standing weekly_plans
  // approve grant AND Super-Admin (isHrReviewer). Neither alone is sufficient.
  await assertPermission(access, "weekly_plans", "approve");
  if (!isHrReviewer(access, null)) {
    throw new Error("Forbidden: only HR or Super Admin can reassign a stuck plan approver.");
  }

  const newManagerHrId = cleanText(input.newManagerHrId);
  if (!newManagerHrId) {
    throw new Error("A new manager HR_ID is required.");
  }

  const plan = await loadPlanRow(input.planId);
  if (!REASSIGNABLE_PLAN_STATUSES.includes(plan.status)) {
    throw new Error(
      "Only plans awaiting a manager decision (submitted, manager_returned, ceo_returned) can be reassigned.",
    );
  }

  const directory = await getEmployeeDirectory();
  const newManager = directory.employees.find((emp) => hrIdsMatch(emp.hrId, newManagerHrId));
  if (!newManager) {
    throw new Error("The selected manager was not found in the employee directory.");
  }
  if (!isActiveEmployee(newManager)) {
    throw new Error("The selected manager is not active. Choose an active manager to receive this plan.");
  }

  const previousManagerHrId = plan.manager_hr_id;
  const previousManagerName = plan.manager_name;

  // Direct column update only — NOT rpcDecidePlan / any status transition.
  const { error } = await getSupabaseAdmin()
    .from("employee_plan_headers")
    .update({
      manager_hr_id: newManager.hrId,
      manager_name: newManager.fullName,
      updated_at: new Date().toISOString(),
    })
    .eq("id", plan.id);
  if (error) throw error;

  await writeAuditLog({
    actorLoginId: access.loginId,
    entityId: plan.id,
    entityType: "weekly_plan",
    newValues: { managerHrId: newManager.hrId, managerName: newManager.fullName },
    oldValues: { managerHrId: previousManagerHrId, managerName: previousManagerName },
    summary: `${plan.plan_kind} plan approver reassigned from ${previousManagerHrId ?? "unassigned"} to ${newManager.hrId}`,
  });

  const updated = await loadPlanRow(plan.id);
  // Retarget the standard manager-stage alert to the newly-assigned manager (best-effort;
  // notifyManager reads the freshly-updated manager_hr_id off `updated`).
  await notifyManager(updated).catch((err) =>
    logError("Weekly plan reassign notify failed", {
      labels: { event: "weekly_plan_reassign_notify_failed", planId: plan.id },
      error: err,
    }),
  );
  return mapPlan(updated);
}

// Statuses whose plan is still a live record. A rejected or cancelled plan is a closed one:
// re-dating it would resurrect it onto a week it was never meant for, and those statuses sit
// OUTSIDE employee_plan_headers_active_period_uidx, so the index would not stop it landing on a
// week that already has a real plan.
const MOVABLE_PLAN_STATUSES: EmployeePlanStatus[] = [
  "draft",
  "submitted",
  "edit_requested",
  "details_requested",
  "manager_approved",
  "manager_returned",
  "ceo_approved",
  "ceo_returned",
  "final_approved",
  "hr_acknowledged",
];

/**
 * HR / Super Admin re-dates a whole plan onto a different period, for the case this exists for:
 * the employee picked the wrong week in the editor and submitted an otherwise correct plan
 * against it. Before this, the only remedies were leaving the wrong week approved or rebuilding
 * the plan by hand in the database.
 *
 * The header AND every item move by ONE whole-day delta, so weekday alignment survives — a Sunday
 * visit stays on Sunday. Moving the header alone leaves a plan whose rows sit outside their own
 * period, which reads as corruption in every downstream view.
 *
 * This re-dates; it never decides. Status, revision, approvals and the decision trail are all
 * left exactly as they were.
 */
export async function moveWeeklyPlanToPeriod(
  access: AccessContext,
  input: { planId: string; targetAnchorDate: string },
) {
  // Same two-part gate as reassignWeeklyPlanManager: the standing weekly_plans approve grant AND
  // HR/Super-Admin. Neither alone is sufficient.
  await assertPermission(access, "weekly_plans", "approve");
  if (!isHrReviewer(access, null)) {
    throw new Error("Forbidden: only HR or Super Admin can move a plan to another period.");
  }

  const targetAnchorDate = cleanText(input.targetAnchorDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetAnchorDate)) {
    throw new Error("A target date (YYYY-MM-DD) inside the destination period is required.");
  }

  const plan = await loadPlanRow(input.planId);
  if (!MOVABLE_PLAN_STATUSES.includes(plan.status)) {
    throw new Error(`A ${plan.status} plan cannot be moved. Only a live plan can be re-dated.`);
  }

  // Destination boundaries come from the OWNER'S workweek, never from the raw anchor: Field Force
  // runs Saturday-Thursday and Head Office Sunday-Thursday, so one anchor date lands on different
  // period edges for different people.
  const directory = await getEmployeeDirectory();
  const owner = directory.employees.find((emp) => hrIdsMatch(emp.hrId, plan.employee_hr_id)) ?? null;
  const workweek = resolvePlanWorkweek({ jobTitle: owner?.jobTitle ?? plan.employee_job_title });
  const { dayDelta, target } = planPeriodMove(
    plan.plan_kind,
    plan.period_start_date,
    targetAnchorDate,
    workweek,
  );

  if (target.periodStartDate === plan.period_start_date && target.periodEndDate === plan.period_end_date) {
    throw new Error("The plan is already on that period.");
  }
  await assertNoActivePlanForSamePeriod(plan.employee_hr_id, plan.plan_kind, target);
  const nowIso = new Date().toISOString();
  const admin = getSupabaseAdmin();

  // Read the items BEFORE the header moves: a monthly plan can hold a day the destination month does
  // not have (the 31st into a 30-day month), and that is refused whole, with nothing written. A
  // weekly plan always has a place for every item (one delta keeps each on its weekday).
  const { data: itemRows, error: itemsReadError } = await admin
    .from("employee_plan_items")
    .select("*")
    .eq("plan_id", plan.id);
  if (itemsReadError) throw itemsReadError;
  const currentItems = (itemRows ?? []) as Array<Record<string, unknown> & { activity_date: string }>;
  const refusal = planMoveRefusal({
    dayDelta,
    itemDates: currentItems.map((record) => record.activity_date),
    planKind: plan.plan_kind,
    target,
  });
  if (refusal) throw new Error(refusal);
  const previous = {
    periodEndDate: plan.period_end_date,
    periodKey: plan.period_key,
    periodStartDate: plan.period_start_date,
  };

  // Header first, items second, and the header is put back if the items fail. Two statements
  // cannot be one transaction through the JS client, so the order is chosen so the half that may
  // need undoing is the one a single-row write can undo.
  const { error: headerError } = await admin
    .from("employee_plan_headers")
    .update({
      period_end_date: target.periodEndDate,
      period_key: target.periodKey,
      period_start_date: target.periodStartDate,
      updated_at: nowIso,
    })
    .eq("id", plan.id);
  if (headerError) throw headerError;

  try {
    const shifted = currentItems.map((record) => {
      const movedDate = movedPlanItemDate({
        activityDate: record.activity_date,
        dayDelta,
        planKind: plan.plan_kind,
        targetPeriodStartDate: target.periodStartDate,
      });
      // planMoveRefusal above already refused any day without a place, so this is unreachable; it
      // throws (and the header is put back) rather than ever writing a guessed date.
      if (movedDate === null) throw new Error("A plan day has no equivalent date in the destination period.");
      return { ...record, activity_date: movedDate, updated_at: nowIso };
    });
    if (shifted.length > 0) {
      // WHOLE rows, upserted in ONE statement. A per-row update loop can half-apply and leave the
      // plan's days split across two different weeks.
      const { error: itemsWriteError } = await admin
        .from("employee_plan_items")
        .upsert(shifted, { onConflict: "id" });
      if (itemsWriteError) throw itemsWriteError;
    }
  } catch (itemsError) {
    const { error: revertError } = await admin
      .from("employee_plan_headers")
      .update({
        period_end_date: previous.periodEndDate,
        period_key: previous.periodKey,
        period_start_date: previous.periodStartDate,
        updated_at: nowIso,
      })
      .eq("id", plan.id);
    if (revertError) {
      logError("Weekly plan move failed AND the header revert failed", {
        labels: { event: "weekly_plan_move_revert_failed", planId: plan.id },
        error: revertError,
      });
    }
    throw itemsError;
  }

  await writeAuditLog({
    actorLoginId: access.loginId,
    entityId: plan.id,
    entityType: "weekly_plan",
    newValues: {
      periodEndDate: target.periodEndDate,
      periodKey: target.periodKey,
      periodStartDate: target.periodStartDate,
    },
    oldValues: previous,
    summary: `${plan.plan_kind} plan for ${plan.employee_hr_id} moved from ${previous.periodKey} (${previous.periodStartDate}) to ${target.periodKey} (${target.periodStartDate})`,
  });

  return mapPlan(await loadPlanRow(plan.id));
}

// The HR acknowledgement is recorded automatically the instant a plan reaches final_approved
// (owner instruction 2026-09-02: "in weekly plans make HR acknowledgment automatic after the
// final approval"). The step itself is NOT removed — it runs the same phx_weekly_plan_acknowledge
// RPC, writes the same employee_plan_hr_acknowledgements row and the same hr_acknowledge decision
// row, so the D6 drift detector ("hr_acknowledged plans with no acknowledgement row") and every
// other hr_acknowledged reader keep working unchanged. What changed is who presses it.
//
// hr_id is plain text on that table with NO foreign key to employees, so this sentinel actor
// needs no employee row invented for it. It is also the ON CONFLICT key (plan_id, hr_id), so a
// plan that is revised and re-approved re-acknowledges in place instead of duplicating, and a
// later manual acknowledgement by a real HR person lands as its own separate row beside it.
const AUTO_HR_ACK_HR_ID = "SYSTEM-AUTO-HR-ACK";
const AUTO_HR_ACK_ROLE_LABEL = "Automatic HR acknowledgement";
const AUTO_HR_ACK_COMMENT = "Acknowledged automatically on final approval.";

/**
 * Acknowledge, on HR's behalf, a plan that has just reached final_approved.
 *
 * Best-effort by design: the approval itself already committed inside rpcDecidePlan, so a failure
 * here must never fail the approver's request or roll their decision back. The plan then simply
 * stays final_approved and HR's manual Acknowledge button — deliberately left in place — still
 * works exactly as it did before. Returns the row as it stands afterwards.
 */
async function autoAcknowledgeFinalApprovedPlan(access: AccessContext, plan: PlanHeaderRow): Promise<PlanHeaderRow> {
  if (plan.status !== "final_approved") return plan;
  try {
    await rpcAcknowledgePlan({
      comment: AUTO_HR_ACK_COMMENT,
      expectedRevision: plan.revision,
      hrId: AUTO_HR_ACK_HR_ID,
      loginId: null,
      planId: plan.id,
      roleLabel: AUTO_HR_ACK_ROLE_LABEL,
    });
  } catch (error) {
    logError("Weekly plan automatic HR acknowledgement failed — plan left at final_approved for manual acknowledgement", {
      labels: { event: "weekly_plan_auto_hr_ack_failed", planId: plan.id },
      error,
    });
    return plan;
  }

  const acknowledged = await loadPlanRow(plan.id);
  await writeAuditLog({
    actorLoginId: access.loginId,
    entityId: plan.id,
    entityType: "weekly_plan",
    newValues: { status: acknowledged.status },
    oldValues: { status: plan.status },
    summary: `${acknowledged.plan_kind} plan acknowledged by HR automatically on final approval`,
  });
  await notifyEmployeeAcknowledged(acknowledged);
  return acknowledged;
}

export async function acknowledgeEmployeePlan(access: AccessContext, planId: string, comment?: string | null) {
  const employee = await currentEmployee(access);
  if (!isHrReviewer(access, employee)) {
    throw new Error("Forbidden: only HR Manager/Admin HR can acknowledge approved plans.");
  }
  const plan = await loadPlanRow(planId);
  const hrId = access.hrId ?? access.loginId ?? `system-${crypto.randomUUID()}`;

  // District Manager plans reach final_approved directly from their manager's single approval
  // (decideEmployeePlan's bypassCeo path) and never rest at manager_approved, so there is no
  // stuck-plan case to cascade here. The former HACK advanced such plans by issuing a
  // ceo_approve under the acknowledging HR user's own identity — the same fabricated-CEO-row
  // defect this change removes at its source — so it is gone rather than reproduced here.
  await rpcAcknowledgePlan({
    comment,
    expectedRevision: plan.revision,
    hrId,
    loginId: access.loginId ?? null,
    planId,
    roleLabel: employeeTitle(employee, access.role),
  });
  await writeAuditLog({
    actorLoginId: access.loginId,
    entityId: planId,
    entityType: "weekly_plan",
    summary: `${plan.plan_kind} plan acknowledged by HR`,
  });
  const updatedAck = await loadPlanRow(planId);
  await notifyEmployeeAcknowledged(updatedAck);
  return mapPlan(updatedAck);
}

async function notifyEmployeeAcknowledged(plan: PlanHeaderRow) {
  try {
    await notifyRecipients({
      actionUrl: `/employee-portals/plans?plan=${plan.id}`,
      emailMode: "none",
      eventType: "hr_acknowledge",
      message: `Your ${planSentenceLabel(plan.plan_kind, plan.period_start_date, plan.period_end_date)} has been acknowledged by HR.`,
      plan,
      recipients: [{ hrId: plan.employee_hr_id }],
      title: `Your ${planNounLabel(plan.plan_kind)} was acknowledged by HR`,
    });
  } catch (error) {
    logError("Weekly plan HR-acknowledgement notify failed", {
      labels: { event: "weekly_plan_ack_notify_failed", planId: plan.id },
      error,
    });
  }
}

async function notifyVisitDetailsRequested(plan: PlanHeaderRow) {
  try {
    const portalPlanUrl = `/employee-portals/plans?plan=${plan.id}`;
    await notifyRecipients({
      actionUrl: portalPlanUrl,
      eventType: "plan_details_requested",
      message: `Your manager has requested visit details for your ${planSentenceLabel(plan.plan_kind, plan.period_start_date, plan.period_end_date)}. Please fill in the doctor information before resubmitting.`,
      plan,
      recipients: [{ hrId: plan.employee_hr_id }],
      title: `Visit details required for your ${planNounLabel(plan.plan_kind)}`,
    });
  } catch (error) {
    logError("Weekly plan failed to notify employee for visit details request", {
      labels: { event: "weekly_plan_notify_visit_details_requested_failed", planId: plan.id },
      error,
    });
  }
}

export async function requestVisitDetails(access: AccessContext, planId: string) {
  const plan = await loadPlanRow(planId);
  await assertManagerReviewer(access, plan);
  const hasFieldItems = (plan.employee_plan_items ?? []).some((item) => item.activity_type === "Field");
  if (!hasFieldItems) {
    throw new Error("This plan has no Single Visit (Field) days. Visit details can only be requested for plans with Field activities.");
  }
  const { error } = await getSupabaseAdmin().rpc("phx_weekly_plan_request_details", {
    p_actor_hr_id: hrIdForStorage(access.hrId),
    p_actor_login_id: access.loginId ?? null,
    p_actor_role: access.role,
    p_expected_revision: plan.revision,
    p_plan_id: planId,
  });
  if (error) rethrowWeeklyPlanRpcError(error);
  await writeAuditLog({
    actorLoginId: access.loginId,
    entityId: planId,
    entityType: "weekly_plan",
    newValues: { status: "details_requested" },
    oldValues: { status: plan.status },
    summary: `${plan.plan_kind} plan visit details requested`,
  });
  const updated = await loadPlanRow(planId);
  await notifyVisitDetailsRequested(updated);
  return mapPlan(updated);
}

export async function submitVisitDetails(access: AccessContext, planId: string, details: VisitDetailInput[]) {
  await assertPlansOnThisForm(access);
  const plan = await loadPlanRow(planId);
  if (!hrIdsMatch(access.hrId, plan.employee_hr_id) && access.role !== "Super Admin") {
    throw new Error("Forbidden: only the employee can submit visit details.");
  }
  if (!Array.isArray(details) || details.length === 0) {
    throw new Error("At least one visit detail entry is required.");
  }
  const { error } = await getSupabaseAdmin().rpc("phx_weekly_plan_submit_details", {
    p_actor_hr_id: hrIdForStorage(access.hrId),
    p_actor_login_id: access.loginId ?? null,
    p_actor_role: access.role,
    p_expected_revision: plan.revision,
    p_plan_id: planId,
    p_visit_details: details,
  });
  if (error) rethrowWeeklyPlanRpcError(error);
  await writeAuditLog({
    actorLoginId: access.loginId,
    entityId: planId,
    entityType: "weekly_plan",
    newValues: { status: "submitted" },
    oldValues: { status: plan.status },
    summary: `${plan.plan_kind} plan visit details submitted`,
  });
  const updated = await loadPlanRow(planId);
  await notifyManager(updated);
  return mapPlan(updated);
}

export async function cancelEmployeePlan(access: AccessContext, planId: string, comment?: string | null) {
  await assertPermission(access, "weekly_plans", "update");
  await assertPlansOnThisForm(access);
  const plan = await loadPlanRow(planId);
  assertPlanOwner(access, plan);
  await rpcCancelPlan({ access, comment, expectedRevision: plan.revision, planId });
  await writeAuditLog({
    actorLoginId: access.loginId,
    entityId: planId,
    entityType: "weekly_plan",
    newValues: { status: "cancelled" },
    oldValues: { status: plan.status },
    summary: `${plan.plan_kind} plan cancelled`,
  });
  const cancelledRow = await loadPlanRow(planId);
  await notifyManagerPlanCancelled(cancelledRow, comment ?? null).catch((err) =>
    logError("Weekly plan cancel notify failed", {
      labels: { event: "weekly_plan_cancel_notify_failed", planId: cancelledRow.id },
      error: err,
    }),
  );
  return mapPlan(cancelledRow);
}

// Approve a batch of plans. Only "manager_approve" in bulk; return/reject need per-plan comments.
export async function bulkDecideEmployeePlans(
  access: AccessContext,
  planIds: string[],
  action: "manager_approve",
): Promise<Array<{ planId: string; ok: boolean; message?: string }>> {
  const results: Array<{ planId: string; ok: boolean; message?: string }> = [];
  for (const planId of planIds) {
    try {
      await decideEmployeePlan(access, planId, { action });
      results.push({ ok: true, planId });
    } catch (error) {
      results.push({
        message: error instanceof Error ? error.message : String(error),
        ok: false,
        planId,
      });
    }
  }
  return results;
}

// Manager isn't notified by the RPC itself — alert them (in-app + email + Telegram) so a
// pending edit request doesn't sit unseen in their queue. Best-effort: a notify failure
// must never roll back or block the already-committed status transition.
async function notifyManagerEditRequested(plan: PlanHeaderRow): Promise<void> {
  if (!plan.manager_hr_id) {
    logError("Weekly plan edit request has no manager_hr_id — manual follow-up required", {
      labels: { event: "weekly_plan_edit_request_no_manager", planId: plan.id },
    });
    return;
  }
  try {
    const actionUrl = await planReviewActionUrl(plan.manager_hr_id, plan.id);
    await notifyRecipients({
      actionUrl,
      eventType: "plan_edit_requested",
      message: `${plan.employee_name} requested to edit their submitted ${planSentenceLabel(plan.plan_kind, plan.period_start_date, plan.period_end_date)}.`,
      plan,
      recipients: [{ hrId: plan.manager_hr_id }],
      title: `${plan.employee_name} requested to edit their ${planNounLabel(plan.plan_kind)}`,
    });
  } catch (notifyError) {
    logError("Weekly plan failed to notify manager of edit request", {
      labels: { event: "weekly_plan_notify_manager_edit_request_failed", planId: plan.id },
      error: notifyError,
    });
  }
}

// Mirrors notifyEmployeeReturnedOrRejected — the employee otherwise has no way to know
// their edit request was decided short of reopening the portal themselves.
async function notifyEmployeeEditRequestDecision(
  plan: PlanHeaderRow,
  decision: "approve" | "reject",
  comment: string | null,
  actorHrId: string | null,
): Promise<void> {
  try {
    await notifyRecipients({
      actionUrl: `/employee-portals/plans?plan=${plan.id}`,
      // Same addressing rule as every other conversation: the decider is copied so the employee can
      // reply to the person who actually decided.
      emailCcRecipients: actorHrId && !hrIdsMatch(actorHrId, plan.employee_hr_id) ? [{ hrId: actorHrId }] : [],
      // Approval is good news with nothing left to act on; rejection needs the employee's
      // attention, so only that branch keeps email.
      emailMode: decision === "approve" ? "none" : "primary_to_cc",
      eventType: decision === "approve" ? "plan_edit_request_approved" : "plan_edit_request_rejected",
      message: decision === "approve"
        ? `Your manager approved your edit request. You can now edit and resubmit your ${planSentenceLabel(plan.plan_kind, plan.period_start_date, plan.period_end_date)}.`
        : `Your manager rejected your edit request for your ${planSentenceLabel(plan.plan_kind, plan.period_start_date, plan.period_end_date)}.${comment ? ` Comment: ${comment}` : ""}`,
      plan,
      recipients: [{ hrId: plan.employee_hr_id }],
      title: decision === "approve" ? "Your edit request was approved" : "Your edit request was rejected",
    });
  } catch (notifyError) {
    logError("Weekly plan failed to notify employee of edit request decision", {
      labels: { event: "weekly_plan_notify_employee_edit_request_decision_failed", planId: plan.id },
      error: notifyError,
    });
  }
}

export async function requestEditEmployeePlan(access: AccessContext, planId: string) {
  await assertPermission(access, "weekly_plans", "update");
  await assertPlansOnThisForm(access);
  const plan = await loadPlanRow(planId);
  assertPlanOwner(access, plan);
  if (plan.status !== "submitted") {
    throw new Error("Forbidden: edit can only be requested on a submitted plan.");
  }
  await rpcRequestEditPlan({ access, expectedRevision: plan.revision, planId });
  await writeAuditLog({
    actorLoginId: access.loginId,
    entityId: planId,
    entityType: "weekly_plan",
    newValues: { status: "edit_requested" },
    oldValues: { status: plan.status },
    summary: `${plan.plan_kind} plan edit requested by employee`,
  });
  const updated = await loadPlanRow(planId);
  await notifyManagerEditRequested(updated);
  return mapPlan(updated);
}

export async function decideEditRequest(
  access: AccessContext,
  planId: string,
  input: { decision: "approve" | "reject"; comment?: string | null },
) {
  const plan = await loadPlanRow(planId);
  if (plan.status !== "edit_requested") {
    throw new Error("This plan does not have a pending edit request.");
  }
  // Only the assigned direct manager can decide (CEO only when the plan has no manager).
  await assertManagerReviewer(access, plan);
  // Direct managers must leave a reason when rejecting; higher-level reviewers
  // (Super Admin) may reject silently.
  const isDirectManager = hrIdsMatch(access.hrId, plan.manager_hr_id);
  if (input.decision === "reject" && isDirectManager && !String(input.comment ?? "").trim()) {
    throw new Error("A reason is required when rejecting an edit request as the direct manager.");
  }
  await rpcDecideEditRequest({
    access,
    comment: input.comment,
    decision: input.decision,
    expectedRevision: plan.revision,
    planId,
  });
  const action = input.decision === "approve" ? "approve_edit_request" : "reject_edit_request";
  const nextStatus = input.decision === "approve" ? "draft" : "submitted";
  await writeAuditLog({
    actorLoginId: access.loginId,
    entityId: planId,
    entityType: "weekly_plan",
    newValues: { status: nextStatus },
    oldValues: { status: plan.status },
    summary: `${plan.plan_kind} plan decision: ${action}`,
  });
  const updated = await loadPlanRow(planId);
  await notifyEmployeeEditRequestDecision(updated, input.decision, input.comment ?? null, access.hrId ?? null);
  return mapPlan(updated);
}
