import crypto from "crypto";

import { writeAuditLog } from "@/lib/admin/audit";

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
  | "not_found";

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
  type PhoenixRole,
} from "@/lib/auth/permissions";
import { resolveViewerAllowedLines } from "@/lib/auth/scope-visibility";
import { pickDeliverableEmail } from "@/lib/email/email-safety";
import { getEmployeeDirectory, type EmployeeDirectoryData, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import { hrIdLookupKeys } from "@/lib/hr-id";
import { getConfirmedNationalHolidays } from "@/lib/vacation/national-holidays";
import { createSystemNotification, type NotificationDeliveryStatus } from "@/lib/notifications/system";
import { buildPlanEmailTable } from "@/lib/weekly-planning/email-table";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  buildEmployeePlanPeriod,
  canEditEmployeePlanStatus,
  employeePlanActivityTypes,
  getNextEmployeePlanStatus,
  isClosedEmployeePlanStatus,
  isWeeklyMonthlyPlanEligibleTitle,
  planRequiredSlotsByDate,
  resolvePlanWorkweek,
  type EmployeePlanAction,
  type EmployeePlanActivityType,
  type EmployeePlanKind,
  type EmployeePlanStatus,
  type PlanSlot,
  type PlanWorkweek,
} from "@/lib/weekly-planning/plan-v1";

type PlanHeaderRow = {
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
  canSubmitPlans: boolean;
  hasMorePlans: boolean;
  loadedPlanCount: number;
  planLimit: number;
  workplaceRegions: string[];
  currentEmployee: {
    fullName: string;
    hrId: string;
    jobTitle: string | null;
    managerHrId: string | null;
    managerName: string | null;
    workweek: PlanWorkweek;
  } | null;
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
    if (plan.status === "manager_approved") summary.ceoPending += 1;
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

const approvedPlanningRegions = [
  "ALEX-BHR",
  "Cairo",
  "Delta 1",
  "Delta 2",
  "Giza",
  "Upper Egypt",
] as const;

function canonicalPlanningRegion(value: unknown) {
  const raw = cleanText(value);
  if (!raw) return null;
  const directMatch = approvedPlanningRegions.find((region) => region.toLowerCase() === raw.toLowerCase());
  if (directMatch) return directMatch;
  const normalized = raw.toLowerCase().replace(/[()]/g, "").replace(/\s+/g, " ").trim();
  if (["alex-bhr", "alex bhr", "alex/bhr", "alex", "alexandria", "bhr", "beheira"].includes(normalized)) {
    return "ALEX-BHR";
  }
  if (normalized === "cairo") return "Cairo";
  if (normalized === "delta 1" || normalized === "delta-1") return "Delta 1";
  if (normalized === "delta 2" || normalized === "delta-2") return "Delta 2";
  if (normalized === "giza") return "Giza";
  if (normalized === "upper egypt") return "Upper Egypt";
  return null;
}

function workplaceRegionsFromDirectory(directory: EmployeeDirectoryRow[]) {
  const regionNameByKey = new Map<string, string>();
  for (const row of directory) {
    const regionName = canonicalPlanningRegion(row.regionName);
    if (!regionName) continue;
    const key = regionName.toLowerCase();
    if (!regionNameByKey.has(key)) {
      regionNameByKey.set(key, regionName);
    }
  }
  return approvedPlanningRegions.filter((region) => regionNameByKey.has(region.toLowerCase()));
}

function workplaceRegionsForEmployee(employee: EmployeeDirectoryRow | null, directory: EmployeeDirectoryRow[]) {
  if (!employee) {
    return workplaceRegionsFromDirectory(directory);
  }

  const byLine = workplaceRegionsFromDirectory(directory.filter((row) => isSameLine(row, employee)));
  if (byLine.length > 0) return byLine;

  return workplaceRegionsFromDirectory(directory);
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

// Single Visit's region -> area cascade must show every area in the region,
// including ones with no rep hired yet (it never assigns a rep). Double
// Visit/Coaching need the opposite - only areas with a real same-line rep to
// auto-assign. Rather than two data sources, we fold open Medical Rep
// position_vacancies (already loaded via getEmployeeDirectory().lookups) into
// the same options array with a "Vacant" fullName, so areasForRegion's
// existing requireAssignedRep filter (keyed off isVacantMedicalRep) naturally
// includes them for Single Visit and excludes them for Double Visit/Coaching.
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

async function medicalRepOptionsForEmployee(
  employee: EmployeeDirectoryRow | null,
  orgWide = false,
  allowedLineNames: string[] | null = null,
) {
  if (!employee) return [];
  const directory = await getEmployeeDirectory();
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
      areaName: candidate.areaName,
      fullName: candidate.fullName,
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

function canViewPlan(access: AccessContext, employee: EmployeeDirectoryRow | null, plan: PlanHeaderRow) {
  if (access.role === "Super Admin" || access.scope === "system") return true;
  if (hrIdsMatch(access.hrId, plan.employee_hr_id)) return true;
  if (hrIdsMatch(access.hrId, plan.manager_hr_id)) return true;
  if (access.role === "CEO") return true;
  return isHrReviewer(access, employee) && ["final_approved", "hr_acknowledged"].includes(plan.status);
}

function assertPlanOwner(access: AccessContext, plan: PlanHeaderRow) {
  if (!hrIdsMatch(access.hrId, plan.employee_hr_id) && access.role !== "Super Admin") {
    throw new Error("Forbidden: only the employee can edit this plan.");
  }
}

// Super Admin has NO standing bypass here — he may decide a manager-stage plan only if he
// personally is the assigned manager (hrIdsMatch below already covers that case like anyone
// else). Owner-confirmed rule: Super Admin cannot act on someone else's turn — his own place in
// the chain is the final HR-acknowledge step (see acknowledgeEmployeePlan/isHrReviewer), not a
// stand-in for the direct manager or CEO.
async function assertManagerReviewer(access: AccessContext, plan: PlanHeaderRow) {
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

type NormalizeItemsOptions = {
  submit?: boolean;
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

function validActivityType(value: string): EmployeePlanActivityType {
  if (value === "Coaching") return "Other";
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
  const usesGeography = activityUsesGeography(activityType, isCoaching);
  const requiresGeography = activityRequiresGeography(activityType, isCoaching);
  const requiresRep = activityRequiresRep(activityType, isCoaching);
  const locationText = activityType === "Training"
    ? normalizeTrainingFormat(item.locationText)
    : usesGeography
      ? canonicalPlanningRegion(item.locationText)
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
    throw new Error(`${isCoaching ? "Coaching" : activityDisplayLabel(activityType)} requires selecting an approved region.`);
  }
  if (options.submit && requiresGeography && !area) {
    throw new Error(`${isCoaching ? "Coaching" : activityDisplayLabel(activityType)} requires selecting an area.`);
  }
  if (options.submit && requiresRep && !selectedRepHrId) {
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
  return {
    activityDate,
    activityTitle: isCoaching ? "Coaching" : activityTitle || activityDisplayLabel(activityType),
    activityType,
    area,
    attendees: nullableText(item.attendees),
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
    actor_hr_id: input.access.hrId,
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
    p_actor_hr_id: input.access.hrId,
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
}) {
  const { error } = await getSupabaseAdmin().rpc("phx_weekly_plan_decide", {
    p_action: input.action,
    p_actor_hr_id: input.access.hrId,
    p_actor_login_id: input.access.loginId ?? null,
    p_actor_role: input.access.role,
    p_comment: input.comment ?? null,
    p_expected_revision: input.expectedRevision,
    p_plan_id: input.planId,
    p_return_notes: (input.returnNotes ?? [])
      .map((note) => ({ itemId: cleanText(note.itemId), note: cleanText(note.note) }))
      .filter((note) => note.itemId && note.note),
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
    p_hr_id: input.hrId,
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
    p_actor_hr_id: input.access.hrId,
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
    p_actor_hr_id: input.access.hrId,
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
    p_actor_hr_id: input.access.hrId,
    p_actor_login_id: input.access.loginId ?? null,
    p_actor_role: input.access.role,
    p_comment: input.comment ?? null,
    p_decision: input.decision,
    p_expected_revision: input.expectedRevision,
    p_plan_id: input.planId,
  });
  if (error) rethrowWeeklyPlanRpcError(error);
}

async function loadRecipientEmailMap(recipients: Array<{ hrId: string | null }>) {
  const hrIds = Array.from(new Set(recipients.map((recipient) => normalizeHrId(recipient.hrId)).filter(Boolean)));
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
    recipients[0],
    ...(input.emailCcRecipients ?? recipients.slice(1)),
  ].filter((recipient): recipient is { email?: string | null; hrId: string | null; userId?: string | null } => Boolean(recipient?.hrId || recipient?.userId));
  const emailByHrId = await loadRecipientEmailMap(emailRefs);
  const emailFor = (recipient: { email?: string | null; hrId: string | null }) =>
    pickDeliverableEmail(recipient.email, emailByHrId.get(normalizeHrId(recipient.hrId)));
  const primaryKey = normalizeHrId(recipients[0].hrId) || recipients[0].userId || "";
  const primaryEmail = emailMode === "none" ? null : emailFor(recipients[0]);
  const ccEmails = emailMode === "none" ? [] : Array.from(new Set(
    emailRefs
      .slice(1)
      .map((recipient) => emailFor(recipient))
      .filter((email): email is string => Boolean(email)),
  ));
  await Promise.all(recipients
    .map((recipient) => createSystemNotification({
      actionUrl: input.actionUrl,
      category: "general",
      channels: emailMode !== "none" && (normalizeHrId(recipient.hrId) || recipient.userId || "") === primaryKey ? ["in_app", "email", "telegram"] : ["in_app", "telegram"],
      ...(emailMode !== "none" && (normalizeHrId(recipient.hrId) || recipient.userId || "") === primaryKey
        ? {
            email: {
              cc: ccEmails,
              metrics: [
                { label: "Employee", value: `${input.plan.employee_name} (${input.plan.employee_hr_id})` },
                { label: "Plan", value: `${input.plan.plan_kind} - ${input.plan.period_key}` },
                { label: "Period", value: `${input.plan.period_start_date} to ${input.plan.period_end_date}` },
              ],
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
        ...input.additionalMetadata,
      },
      module: "weekly_plans",
      priority: "high",
      recordId: input.plan.id,
      recipientHrId: recipient.hrId,
      recipientUserId: recipient.userId,
      subjectHrId: input.plan.employee_hr_id,
      title: input.title,
    })));
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

async function authRoleForHrId(hrId: string | null | undefined): Promise<PhoenixRole | null> {
  const normalized = normalizeHrId(hrId);
  if (!normalized) return null;
  const { data, error } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select("role")
    .eq("hr_id", normalized)
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
  let mode: "admin" | "employee-portal" = "admin";
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

async function hrAcknowledgementRecipients() {
  const supabase = getSupabaseAdmin();
  const { data: authRows } = await supabase
    .from("app_auth_users")
    .select("login_id,hr_id,name,auth_email,role")
    .in("role", ["Super Admin"]);
  const { data: employees } = await supabase
    .from("employees")
    .select("hr_id,full_name,job_title,position_title")
    .or("job_title.ilike.%HR Manager%,job_title.ilike.%Admin HR%,position_title.ilike.%HR Manager%,position_title.ilike.%Admin HR%");
  const employeeHrIds = new Set(((employees ?? []) as Array<{ hr_id?: string | null }>).map((row) => normalizeHrId(row.hr_id)).filter(Boolean));
  const recipients = ((authRows ?? []) as AuthUserRow[])
    .filter((row) => row.role === "Super Admin" || employeeHrIds.has(normalizeHrId(row.hr_id)))
    .map((row) => ({ hrId: row.hr_id ?? null, userId: row.login_id ?? null }));
  for (const hrId of employeeHrIds) {
    if (!recipients.some((recipient) => hrIdsMatch(recipient.hrId, hrId))) {
      recipients.push({ hrId, userId: null });
    }
  }
  return recipients;
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
        console.error(`[weekly-plans] plan ${plan.id} has NULL manager_hr_id — routing to skip-level manager ${skipLevel.hrId}`);
      }
    } catch (lookupError) {
      errored = true;
      console.error(`[weekly-plans] skip-level manager lookup failed for plan ${plan.id}`, lookupError);
    }
  }

  // Fallback 2: Super Admin
  if (managerRecipients.length === 0) {
    try {
      const admins = await resolveSuperAdminRecipients();
      if (admins.length > 0) {
        managerRecipients = admins;
        fellBackToSuperAdmin = true;
        console.error(`[weekly-plans] plan ${plan.id} falling back to Super Admin — no manager resolved`);
      }
    } catch (fallbackError) {
      errored = true;
      console.error(`[weekly-plans] Super Admin fallback failed for plan ${plan.id}`, fallbackError);
    }
  }

  if (managerRecipients.length === 0) {
    console.error(`[weekly-plans] plan ${plan.id} (employee ${plan.employee_hr_id}) persisted but no manager recipient resolved — manual follow-up required`);
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
      message: `${plan.employee_name} submitted a ${plan.plan_kind} plan for ${plan.period_key}.`,
      plan,
      recipients: managerRecipients,
      title: `${plan.employee_name}'s ${plan.plan_kind} plan needs manager review`,
    });
    return { errored, fellBackToSuperAdmin, recipientCount: managerRecipients.length };
  } catch (notifyError) {
    console.error(`[weekly-plans] failed to notify manager for plan ${plan.id}`, notifyError);
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
        console.error(`[weekly-plans] hrAcknowledgementRecipients() returned 0 for plan ${plan.id} — using Super Admin fallback`);
      }
    } catch (fallbackError) {
      console.error(`[weekly-plans] HR + Super Admin fallback lookup failed for plan ${plan.id}`, fallbackError);
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
    message: `${plan.employee_name} submitted a ${plan.plan_kind} plan for ${plan.period_key}.`,
    plan,
    recipients: primary,
    title: `${plan.employee_name}'s ${plan.plan_kind} plan was submitted`,
  });
}

// Single fan-out for a fresh submission: direct manager (review) + HR (awareness).
// Best-effort and isolated — a failure to reach HR must never block the manager alert.
async function notifyPlanSubmitted(plan: PlanHeaderRow) {
  const hrRecipients = (await hrAcknowledgementRecipients())
    .filter((recipient) => !hrIdsMatch(recipient.hrId, plan.manager_hr_id));
  await Promise.allSettled([notifyManager(plan, hrRecipients), notifyHrOnSubmit(plan, hrRecipients)]);
}

// Best-effort — a failure to notify must never mask a decision that already
// committed via rpcDecidePlan (see decideEmployeePlan).
async function notifyCeo(plan: PlanHeaderRow) {
  try {
    const ceos = await authUsersByRole("CEO");
    await notifyRecipients({
      actionUrl: `/admin/approvals/plan/${plan.id}`,
      eventType: "plan_manager_approved",
      message: `${plan.manager_name ?? "The direct manager"} approved ${plan.employee_name}'s ${plan.plan_kind} plan for ${plan.period_key}.`,
      plan,
      recipients: ceos.map((row) => ({ hrId: row.hr_id ?? null, userId: row.login_id ?? null })),
      title: `${plan.employee_name}'s ${plan.plan_kind} plan needs CEO approval`,
    });
  } catch (error) {
    console.error(`[weekly-plans] failed to notify CEO for plan ${plan.id}`, error);
  }
}

async function notifyHr(plan: PlanHeaderRow) {
  try {
    await notifyRecipients({
      actionUrl: `/admin/approvals/plan/${plan.id}`,
      eventType: "plan_ceo_approved",
      message: `CEO approved ${plan.employee_name}'s ${plan.plan_kind} plan for ${plan.period_key}. Please review and acknowledge.`,
      plan,
      recipients: await hrAcknowledgementRecipients(),
      title: `${plan.employee_name}'s approved ${plan.plan_kind} plan needs HR acknowledgement`,
    });
  } catch (error) {
    console.error(`[weekly-plans] failed to notify HR for plan ${plan.id}`, error);
  }
}

async function notifyEmployeeReturnedOrRejected(plan: PlanHeaderRow, action: EmployeePlanAction, comment: string | null) {
  try {
    await notifyRecipients({
      actionUrl: `/employee-portals/plans?plan=${plan.id}`,
      eventType: action,
      message: `${plan.plan_kind} plan ${action.includes("reject") ? "was rejected" : "was returned for edit"}.${comment ? ` Comment: ${comment}` : ""}`,
      plan,
      recipients: [{ hrId: plan.employee_hr_id }],
      title: `Your ${plan.plan_kind} plan was ${action.includes("reject") ? "rejected" : "returned"}`,
    });
  } catch (error) {
    console.error(`[weekly-plans] failed to notify employee of ${action} for plan ${plan.id}`, error);
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
    authorName: byHrId.get(normalizeHrId(row.author_hr_id))?.fullName ?? null,
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
  const plan = await loadPlanRow(planId);
  const employee = await currentEmployee(access);
  if (!canViewPlan(access, employee, plan)) {
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

// Fans a new comment out to every OTHER participant already engaged with this
// plan: the submitter, the assigned manager, whoever has recorded a decision on
// it (captures CEO/HR once they've actually acted), and everyone who has
// already posted in the thread. Deliberately does NOT notify every CEO/HR
// account by default — only those who have engaged — to avoid spamming
// unrelated executives on every reply. Role-aware deep links reuse
// planReviewActionUrl so each recipient lands in their own shell. Best-effort:
// a notification failure never blocks the comment itself.
async function notifyPlanComment(plan: PlanHeaderRow, comment: EmployeePlanComment) {
  try {
    const participantKeys = new Set<string>();
    if (plan.employee_hr_id) participantKeys.add(normalizeHrId(plan.employee_hr_id));
    if (plan.manager_hr_id) participantKeys.add(normalizeHrId(plan.manager_hr_id));
    for (const decision of plan.employee_plan_decisions ?? []) {
      if (decision.actor_hr_id) participantKeys.add(normalizeHrId(decision.actor_hr_id));
    }
    const { data: priorAuthors } = await getSupabaseAdmin()
      .from("employee_plan_comments")
      .select("author_hr_id")
      .eq("plan_id", plan.id);
    for (const row of (priorAuthors ?? []) as Array<{ author_hr_id: string }>) {
      if (row.author_hr_id) participantKeys.add(normalizeHrId(row.author_hr_id));
    }
    participantKeys.delete(normalizeHrId(comment.authorHrId));
    if (participantKeys.size === 0) return;

    const truncatedBody = comment.body.length > 140 ? `${comment.body.slice(0, 140)}…` : comment.body;
    await Promise.all(Array.from(participantKeys).map(async (hrId) => {
      const actionUrl = hrIdsMatch(hrId, plan.employee_hr_id)
        ? `/employee-portals/plans?plan=${plan.id}`
        : await planReviewActionUrl(hrId, plan.id);
      await notifyRecipients({
        actionUrl,
        eventType: "plan_comment",
        message: `${comment.authorName ?? comment.authorHrId} commented on the ${plan.plan_kind} plan: "${truncatedBody}"`,
        plan,
        recipients: [{ hrId }],
        title: `New comment on ${plan.plan_kind} plan`,
      });
    }));
  } catch (error) {
    console.error(`[weekly-plans] failed to notify participants of a new comment on plan ${plan.id}`, error);
  }
}

export async function addPlanComment(access: AccessContext, planId: string, input: {
  body: string;
  itemId?: string | null;
  parentId?: string | null;
}): Promise<EmployeePlanComment> {
  const body = String(input.body ?? "").trim();
  if (!body) throw new Error("Comment cannot be empty.");
  const plan = await loadPlanRow(planId);
  const employee = await currentEmployee(access);
  if (!canViewPlan(access, employee, plan)) {
    throw new Error("Forbidden: you cannot comment on this plan.");
  }
  const { data, error } = await getSupabaseAdmin()
    .from("employee_plan_comments")
    .insert({
      author_hr_id: access.hrId,
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
  const viewerHrId = normalizeHrId(access.hrId);
  const employee = directory.employees.find((item) => normalizeHrId(item.hrId) === viewerHrId) ?? null;
  const canSubmitPlans = Boolean(employee && canSubmitFromEmployee(employee, access.role) && await canAccess(access, "weekly_plans", "create"));
  const canAcknowledgeHr = isHrReviewer(access, employee);
  const medicalRepOptions = await medicalRepOptionsForEmployee(
    employee,
    isOrgWidePlanningEmployee(employee, access.role),
    await resolveViewerAllowedLines(access),
  );
  const workplaceRegions = workplaceRegionsForEmployee(employee, directory.employees);

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
    const visible = cappedRows.filter((plan) => canViewPlan(access, employee, plan));
    const plans = visible.map(mapPlan);
    return {
      canAcknowledgeHr,
      canSubmitPlans,
      currentEmployee: employee
        ? {
            fullName: employee.fullName,
            hrId: employee.hrId,
            jobTitle: employeeTitle(employee, access.role),
            managerHrId: employee.managerHrId,
            managerName: employee.managerName,
            workweek: resolvePlanWorkweek({
              jobTitle: employeeTitle(employee, access.role),
              role: access.role,
            }),
          }
        : null,
      hasMorePlans,
      loadedPlanCount: cappedRows.length,
      medicalRepOptions,
      planLimit: WORKSPACE_PLAN_LIMIT,
      workplaceRegions,
      plans,
      schemaReady: true,
      summary: summarizePlans(plans),
    };
  } catch (error) {
    if (!isSchemaMissing(error)) throw error;
    return {
      canAcknowledgeHr,
      canSubmitPlans,
      currentEmployee: employee
        ? {
            fullName: employee.fullName,
            hrId: employee.hrId,
            jobTitle: employeeTitle(employee, access.role),
            managerHrId: employee.managerHrId,
            managerName: employee.managerName,
            workweek: resolvePlanWorkweek({
              jobTitle: employeeTitle(employee, access.role),
              role: access.role,
            }),
          }
        : null,
      hasMorePlans: false,
      loadedPlanCount: 0,
      medicalRepOptions,
      planLimit: WORKSPACE_PLAN_LIMIT,
      workplaceRegions,
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
 *   • submitted        → manager stage, only for the actual assigned manager.
 *   • manager_approved → CEO stage, only for the actual CEO.
 * Super Admin has NO standing bypass here (owner-confirmed: he cannot act on someone else's
 * turn — only where he's personally the assigned manager, which hrIdsMatch already covers, or
 * at the final HR-acknowledge stage, handled separately by acknowledgeEmployeePlan/isHrReviewer).
 * Returns null when the caller has no pending action on the plan.
 */
export function resolveApproverPlanStage(
  status: EmployeePlanStatus,
  managerHrId: string | null,
  access: Pick<AccessContext, "hrId" | "role" | "scope">,
): ApproverPlanStage | null {
  const isCeo = access.role === "CEO";
  if (status === "submitted") {
    return hrIdsMatch(access.hrId, managerHrId) ? "manager" : null;
  }
  if (status === "manager_approved") {
    return isCeo ? "ceo" : null;
  }
  return null;
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
  id: string;
  itemCount: number;
  items: ApproverPlanItem[];
  managerName: string | null;
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
  return { label: title || activityDisplayLabel(activityType), isCoaching: false };
}

function mapApproverPlanItem(item: {
  activity_date: string;
  activity_title: string;
  activity_type: EmployeePlanActivityType;
  area: string | null;
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
    repName: nullableText(item.double_visit_medical_rep_name),
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
        "id,employee_hr_id,employee_name,employee_job_title,manager_hr_id,manager_name,period_key,period_start_date,period_end_date,plan_kind,status,submitted_at,created_at,employee_plan_items(activity_date,activity_type,activity_title,area,location_text,objective,double_visit_medical_rep_name,start_time,end_time,notes,sort_order,employee_plan_visit_details(id,plan_id,item_id,doctor_name,speciality,address,objective,sort_order))",
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

    const items: ApproverPendingPlan[] = [];
    for (const row of rows) {
      const stage = resolveApproverPlanStage(row.status, row.manager_hr_id, access);
      if (!stage) continue;
      const planItems = (row.employee_plan_items ?? [])
        .slice()
        .sort((a, b) => `${a.activity_date}-${String(a.sort_order).padStart(4, "0")}`.localeCompare(`${b.activity_date}-${String(b.sort_order).padStart(4, "0")}`))
        .map(mapApproverPlanItem);
      items.push({
        employeeHrId: row.employee_hr_id,
        employeeJobTitle: row.employee_job_title,
        employeeName: row.employee_name,
        id: row.id,
        itemCount: planItems.length,
        items: planItems,
        managerName: row.manager_name,
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

export type PlanPrefillSource = "vacation" | "excuse" | "national_vacation" | "weekly";

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
      .select("id,status,plan_kind")
      .eq("plan_kind", "weekly")
      .in("status", ["submitted", "manager_approved", "ceo_approved", "final_approved", "hr_acknowledged"])
      .lte("period_start_date", end)
      .gte("period_end_date", start)
      .in("employee_hr_id", keys)
      .limit(20);
    if (headersError) throw headersError;
    const planIds = ((headers ?? []) as Array<{ id: string }>).map((row) => row.id);
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
    const present = slotsByDate.get(date) ?? new Set<PlanSlot>();
    const hasFull = present.has("full");
    const dayLabel = formatPlanDayLabel(date);
    if (requirement === "am") {
      if (!hasFull && !present.has("am")) incomplete.push(`${dayLabel} (morning)`);
      continue;
    }
    // requirement === "full": needs a full-day entry OR both AM and PM.
    if (hasFull) continue;
    const hasAm = present.has("am");
    const hasPm = present.has("pm");
    if (hasAm && hasPm) continue;
    if (!hasAm && !hasPm) incomplete.push(dayLabel);
    else incomplete.push(`${dayLabel} (${hasAm ? "afternoon" : "morning"} missing)`);
  }

  if (incomplete.length > 0) {
    throw new Error(
      `Plan is incomplete — every working day must be fully filled before submit. Missing: ${incomplete.join(", ")}.`,
    );
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

export async function createEmployeePlan(access: AccessContext, input: {
  anchorDate: string;
  items: EmployeePlanItemInput[];
  planKind: EmployeePlanKind;
  submit?: boolean;
}) {
  await assertPermission(access, "weekly_plans", "create");
  const employee = await currentEmployee(access);
  if (!employee || !canSubmitFromEmployee(employee, access.role)) {
    throw new Error("Forbidden: this position is not eligible to submit weekly/monthly plans.");
  }
  if (!employee.managerHrId) {
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
  const items = normalizeItems(
    input.items,
    period.periodStartDate,
    period.periodEndDate,
    await medicalRepOptionsForEmployee(
      employee,
      isOrgWidePlanningEmployee(employee, access.role),
      await resolveViewerAllowedLines(access),
    ),
    { submit: Boolean(input.submit) },
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
    await notifyPlanSubmitted(await loadPlanRow(plan.id));
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

  if (isClosedEmployeePlanStatus(existing.status)) {
    // Revising a closed plan: spawn a new draft revision (parent_plan_id chain).
    // We always create it as 'draft' first; if the caller wants to submit in
    // the same call, the item RPC promotes the new revision atomically. The
    // revise audit row is written separately so the new row's
    // history starts with a `revise` decision row before the optional submit.
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
      { submit: Boolean(input.submit) },
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
        parent_plan_id: existing.id,
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
    const revisionRow = data as PlanHeaderRow;
    await recordDecision({
      access,
      action: "revise",
      fromStatus: existing.status,
      planId: revisionRow.id,
      toStatus: "draft",
    });
    await rpcReplacePlanItems({
      access,
      expectedRevision: revisionRow.revision,
      items,
      planId: revisionRow.id,
      submit: Boolean(input.submit),
    });
    if (input.submit) {
      await notifyPlanSubmitted(await loadPlanRow(revisionRow.id));
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
    { submit: Boolean(input.submit) },
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
    await notifyPlanSubmitted(await loadPlanRow(existing.id));
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
  if (input.action.startsWith("manager_")) {
    // The assigned direct manager (or Super Admin) decides the manager stage by virtue of the
    // org assignment, independent of the global weekly_plans:approve grant. This lets eligible
    // submitters' managers (e.g. Marketing/Group Product/National Sales Manager) approve, return,
    // or reject their reports' plans even though their role lacks a company-wide approve grant.
    await assertManagerReviewer(access, plan);
  } else if (input.action.startsWith("ceo_")) {
    await assertPermission(access, "weekly_plans", "approve");
    assertCeoReviewer(access);
  }
  // The next status is computed client-side for the audit-log entry and the
  // notification branch below, but the SQL function recomputes the same rule
  // server-side using phx_weekly_plan_next_status, which is the source of
  // truth. The RPC also runs SELECT FOR UPDATE on the header row before
  // writing, so two concurrent decides can't both succeed.
  const nextStatus = getNextEmployeePlanStatus(plan.status, input.action, { comment: input.comment });
  await rpcDecidePlan({
    access,
    action: input.action,
    comment: input.comment,
    expectedRevision: plan.revision,
    planId,
    returnNotes: input.returnNotes,
  });

  const updated = await loadPlanRow(planId);
  if (input.action === "manager_approve") await notifyCeo(updated);
  if (input.action === "ceo_approve") {
    await notifyHr(await loadPlanRow(planId));
  }
  if (input.action.includes("return") || input.action.includes("reject")) {
    await notifyEmployeeReturnedOrRejected(updated, input.action, input.comment ?? null);
  }
  await writeAuditLog({
    actorLoginId: access.loginId,
    entityId: planId,
    entityType: "weekly_plan",
    newValues: { status: nextStatus },
    oldValues: { status: plan.status },
    summary: `${updated.plan_kind} plan decision: ${input.action}`,
  });
  return mapPlan(await loadPlanRow(planId));
}

export async function acknowledgeEmployeePlan(access: AccessContext, planId: string, comment?: string | null) {
  const employee = await currentEmployee(access);
  if (!isHrReviewer(access, employee)) {
    throw new Error("Forbidden: only HR Manager/Admin HR can acknowledge approved plans.");
  }
  const plan = await loadPlanRow(planId);
  const hrId = access.hrId ?? access.loginId ?? `system-${crypto.randomUUID()}`;
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
      eventType: "hr_acknowledge",
      message: `Your ${plan.plan_kind} plan (${plan.period_key}) has been acknowledged by HR.`,
      plan,
      recipients: [{ hrId: plan.employee_hr_id }],
      title: `Your ${plan.plan_kind} plan was acknowledged by HR`,
    });
  } catch (error) {
    console.error(`[weekly-plans] ack notify failed for plan ${plan.id}`, error);
  }
}

async function notifyVisitDetailsRequested(plan: PlanHeaderRow) {
  try {
    const portalPlanUrl = `/employee-portals/plans?plan=${plan.id}`;
    await notifyRecipients({
      actionUrl: portalPlanUrl,
      eventType: "plan_details_requested",
      message: `Your manager has requested visit details for your ${plan.plan_kind} plan (${plan.period_key}). Please fill in the doctor information before resubmitting.`,
      plan,
      recipients: [{ hrId: plan.employee_hr_id }],
      title: `Visit details required for your ${plan.plan_kind} plan`,
    });
  } catch (error) {
    console.error(`[weekly-plans] failed to notify employee for visit details request on plan ${plan.id}`, error);
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
    p_actor_hr_id: access.hrId,
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
  const plan = await loadPlanRow(planId);
  if (!hrIdsMatch(access.hrId, plan.employee_hr_id) && access.role !== "Super Admin") {
    throw new Error("Forbidden: only the employee can submit visit details.");
  }
  if (!Array.isArray(details) || details.length === 0) {
    throw new Error("At least one visit detail entry is required.");
  }
  const { error } = await getSupabaseAdmin().rpc("phx_weekly_plan_submit_details", {
    p_actor_hr_id: access.hrId,
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
  await notifyManager(cancelledRow).catch((err) => console.error("[weekly-plans] cancel notify failed", err));
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
    console.error(`[weekly-plans] plan ${plan.id} edit request has no manager_hr_id — manual follow-up required`);
    return;
  }
  try {
    const actionUrl = await planReviewActionUrl(plan.manager_hr_id, plan.id);
    await notifyRecipients({
      actionUrl,
      eventType: "plan_edit_requested",
      message: `${plan.employee_name} requested to edit their submitted ${plan.plan_kind} plan for ${plan.period_key}.`,
      plan,
      recipients: [{ hrId: plan.manager_hr_id }],
      title: `${plan.employee_name} requested to edit their ${plan.plan_kind} plan`,
    });
  } catch (notifyError) {
    console.error(`[weekly-plans] failed to notify manager of edit request for plan ${plan.id}`, notifyError);
  }
}

// Mirrors notifyEmployeeReturnedOrRejected — the employee otherwise has no way to know
// their edit request was decided short of reopening the portal themselves.
async function notifyEmployeeEditRequestDecision(
  plan: PlanHeaderRow,
  decision: "approve" | "reject",
  comment: string | null,
): Promise<void> {
  try {
    await notifyRecipients({
      actionUrl: `/employee-portals/plans?plan=${plan.id}`,
      eventType: decision === "approve" ? "plan_edit_request_approved" : "plan_edit_request_rejected",
      message: decision === "approve"
        ? `Your manager approved your edit request. You can now edit and resubmit your ${plan.plan_kind} plan for ${plan.period_key}.`
        : `Your manager rejected your edit request for your ${plan.plan_kind} plan.${comment ? ` Comment: ${comment}` : ""}`,
      plan,
      recipients: [{ hrId: plan.employee_hr_id }],
      title: decision === "approve" ? "Your edit request was approved" : "Your edit request was rejected",
    });
  } catch (notifyError) {
    console.error(`[weekly-plans] failed to notify employee of edit request decision for plan ${plan.id}`, notifyError);
  }
}

export async function requestEditEmployeePlan(access: AccessContext, planId: string) {
  await assertPermission(access, "weekly_plans", "update");
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
  // Only the direct manager or Super Admin can decide.
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
  await notifyEmployeeEditRequestDecision(updated, input.decision, input.comment ?? null);
  return mapPlan(updated);
}
