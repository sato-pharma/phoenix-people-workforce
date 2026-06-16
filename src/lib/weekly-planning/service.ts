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
  const message = error instanceof Error ? error.message : String(error ?? "");
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
  type AccessContext,
  type PhoenixRole,
} from "@/lib/auth/permissions";
import { pickDeliverableEmail } from "@/lib/email/email-safety";
import { getEmployeeDirectory, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
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
  type EmployeePlanAction,
  type EmployeePlanActivityType,
  type EmployeePlanKind,
  type EmployeePlanStatus,
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

export type EmployeePlan = {
  acknowledgements: Array<{
    acknowledgedAt: string;
    comment: string | null;
    hrId: string;
    roleLabel: string | null;
  }>;
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
  workplaceRegions: string[];
  currentEmployee: {
    fullName: string;
    hrId: string;
    jobTitle: string | null;
    managerHrId: string | null;
    managerName: string | null;
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
  employee_plan_items (*, employee_plan_item_return_notes (*)),
  employee_plan_hr_acknowledgements (*)
`;

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function nullableText(value: unknown) {
  const cleaned = cleanText(value);
  return cleaned ? cleaned : null;
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
  return /employee_plan_headers|employee_plan_items|employee_plan_item_return_notes|double_visit_medical_rep|schema cache|does not exist|PGRST205|42P01/i.test(text);
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

async function medicalRepOptionsForEmployee(employee: EmployeeDirectoryRow | null) {
  if (!employee) return [];
  const directory = await getEmployeeDirectory();
  return directory.employees
    .filter((candidate) => candidate.hrId !== employee.hrId)
    .filter(isActiveEmployee)
    .filter(isMedicalRepEmployee)
    .filter((candidate) => isSameLine(candidate, employee))
    .map((candidate) => ({
      areaName: candidate.areaName,
      fullName: candidate.fullName,
      hrId: candidate.hrId,
      lineName: candidate.lineName,
      regionName: candidate.regionName,
    }))
    .sort((left, right) => left.fullName.localeCompare(right.fullName));
}

function isHrReviewer(access: AccessContext, employee: EmployeeDirectoryRow | null) {
  const title = `${employee?.positionTitle ?? ""} ${employee?.jobTitle ?? ""} ${access.role}`.toLowerCase();
  return (
    access.role === "Super Admin" ||
    title.includes("hr manager") ||
    title.includes("admin hr") ||
    title.includes("hr specialist")
  );
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

async function assertManagerReviewer(access: AccessContext, plan: PlanHeaderRow) {
  if (access.role === "Super Admin") return;
  if (!hrIdsMatch(access.hrId, plan.manager_hr_id)) {
    throw new Error("Forbidden: only the direct manager can decide this plan.");
  }
  const directory = await getEmployeeDirectory();
  const managerEmployee = directory.employees.find((emp) => hrIdsMatch(emp.hrId, plan.manager_hr_id));
  if (managerEmployee && !isActiveEmployee(managerEmployee)) {
    throw new Error("Forbidden: only an active direct manager can decide this plan.");
  }
}

function assertCeoReviewer(access: AccessContext) {
  if (access.role !== "CEO" && access.role !== "Super Admin" && access.scope !== "system") {
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
};

function isVacantMedicalRepOption(rep: PlanningMedicalRepOption) {
  const text = `${rep.fullName ?? ""} ${rep.hrId ?? ""}`.toLowerCase();
  return /\bvacan(t|cy)\b/.test(text);
}

function autoMedicalRepForArea(options: PlanningMedicalRepOption[], area: string | null) {
  if (!area) return null;
  return options
    .filter((rep) => normalizedName(rep.areaName) === normalizedName(area))
    .find((rep) => !isVacantMedicalRepOption(rep)) ?? null;
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
    ...normalizeItem(item, index, periodStartDate, repByHrId, medicalRepOptions, options),
  }));
}

function normalizeItem(
  item: EmployeePlanItemInput,
  index: number,
  periodStartDate: string,
  repByHrId: Map<string, PlanningMedicalRepOption>,
  medicalRepOptions: PlanningMedicalRepOption[],
  options: NormalizeItemsOptions,
): EmployeePlanItemInput & { doubleVisitMedicalRepName?: string | null } {
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
    activityDate: cleanText(item.activityDate) || periodStartDate,
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

async function replacePlanItems(planId: string, items: EmployeePlanItemInput[]) {
  const supabase = getSupabaseAdmin();
  const { error: deleteError } = await supabase.from("employee_plan_items").delete().eq("plan_id", planId);
  if (deleteError) throw deleteError;
  if (!items.length) return;
  const { error: insertError } = await supabase.from("employee_plan_items").insert(items.map((item) => ({
    activity_date: item.activityDate,
    activity_title: item.activityTitle,
    activity_type: item.activityType,
    area: item.area ?? null,
    attendees: item.attendees ?? null,
    double_visit_medical_rep_hr_id: item.doubleVisitMedicalRepHrId ?? null,
    double_visit_medical_rep_name: "doubleVisitMedicalRepName" in item ? item.doubleVisitMedicalRepName ?? null : null,
    end_time: item.endTime ?? null,
    location_text: item.locationText ?? null,
    notes: item.notes ?? "",
    objective: item.objective ?? null,
    plan_id: planId,
    sort_order: item.sortOrder ?? 0,
    start_time: item.startTime ?? null,
  })));
  if (insertError) throw insertError;
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
async function rpcSubmitPlan(input: {
  access: AccessContext;
  expectedRevision: number;
  planId: string;
}) {
  const { error } = await getSupabaseAdmin().rpc("phx_weekly_plan_submit", {
    p_actor_hr_id: input.access.hrId,
    p_actor_login_id: input.access.loginId ?? null,
    p_actor_role: input.access.role,
    p_expected_revision: input.expectedRevision,
    p_plan_id: input.planId,
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
    await notifyRecipients({
      actionUrl: `/employee-portals/plans?plan=${plan.id}`,
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
    actionUrl: `/admin/weekly-plans?plan=${plan.id}`,
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

async function notifyCeo(plan: PlanHeaderRow) {
  const ceos = await authUsersByRole("CEO");
  await notifyRecipients({
    actionUrl: `/admin/weekly-plans?plan=${plan.id}`,
    eventType: "plan_manager_approved",
    message: `${plan.manager_name ?? "The direct manager"} approved ${plan.employee_name}'s ${plan.plan_kind} plan for ${plan.period_key}.`,
    plan,
    recipients: ceos.map((row) => ({ hrId: row.hr_id ?? null, userId: row.login_id ?? null })),
    title: `${plan.employee_name}'s ${plan.plan_kind} plan needs CEO approval`,
  });
}

async function notifyHr(plan: PlanHeaderRow) {
  await notifyRecipients({
    actionUrl: `/admin/weekly-plans?plan=${plan.id}`,
    eventType: "plan_ceo_approved",
    message: `CEO approved ${plan.employee_name}'s ${plan.plan_kind} plan for ${plan.period_key}. Please review and acknowledge.`,
    plan,
    recipients: await hrAcknowledgementRecipients(),
    title: `${plan.employee_name}'s approved ${plan.plan_kind} plan needs HR acknowledgement`,
  });
}

async function notifyEmployeeReturnedOrRejected(plan: PlanHeaderRow, action: EmployeePlanAction, comment: string | null) {
  await notifyRecipients({
    actionUrl: `/employee-portals/plans?plan=${plan.id}`,
    eventType: action,
    message: `${plan.plan_kind} plan ${action.includes("reject") ? "was rejected" : "was returned for edit"}.${comment ? ` Comment: ${comment}` : ""}`,
    plan,
    recipients: [{ hrId: plan.employee_hr_id }],
    title: `Your ${plan.plan_kind} plan was ${action.includes("reject") ? "rejected" : "returned"}`,
  });
}

export async function getEmployeePlansWorkspace(access: AccessContext): Promise<EmployeePlansWorkspace> {
  await assertPermission(access, "employee_profile", "read");
  await assertPermission(access, "weekly_plans", "read");
  const directory = await getEmployeeDirectory();
  const viewerHrId = normalizeHrId(access.hrId);
  const employee = directory.employees.find((item) => normalizeHrId(item.hrId) === viewerHrId) ?? null;
  const canSubmitPlans = Boolean(employee && canSubmitFromEmployee(employee, access.role) && await canAccess(access, "weekly_plans", "create"));
  const canAcknowledgeHr = isHrReviewer(access, employee);
  const medicalRepOptions = await medicalRepOptionsForEmployee(employee);
  const workplaceRegions = workplaceRegionsForEmployee(employee, directory.employees);

  try {
    const { data, error } = await getSupabaseAdmin()
      .from("employee_plan_headers")
      .select(planSelect)
      .order("created_at", { ascending: false })
      .limit(250);
    if (error) throw error;
    const visible = ((data ?? []) as PlanHeaderRow[]).filter((plan) => canViewPlan(access, employee, plan));
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
          }
        : null,
      medicalRepOptions,
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
          }
        : null,
      medicalRepOptions,
      workplaceRegions,
      plans: [],
      schemaReady: false,
      summary: emptyPlansSummary(),
    };
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
  const period = buildEmployeePlanPeriod(input.planKind, input.anchorDate);
  const items = normalizeItems(input.items, period.periodStartDate, await medicalRepOptionsForEmployee(employee), {
    submit: Boolean(input.submit),
  });

  // Always create the row in 'draft' first. If the caller asked to submit, we
  // insert items, then atomically promote to 'submitted' through the
  // phx_weekly_plan_submit RPC (which also records the decision row). This
  // guarantees the header never advertises a state that isn't backed by both
  // its items AND a decision row, and that two concurrent submits can't both
  // succeed.
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
  await replacePlanItems(plan.id, items);
  if (input.submit) {
    await rpcSubmitPlan({ access, expectedRevision: plan.revision, planId: plan.id });
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
    // the same call, the phx_weekly_plan_submit RPC promotes the new revision
    // atomically. The revise audit row is written separately so the new row's
    // history starts with a `revise` decision row before the optional submit.
    const owner = await currentEmployee(access);
    if (owner && !isActiveEmployee(owner)) {
      throw new Error("Forbidden: only active employees can revise plans.");
    }
    const items = normalizeItems(input.items, existing.period_start_date, await medicalRepOptionsForEmployee(owner), {
      submit: Boolean(input.submit),
    });
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
    await replacePlanItems(revisionRow.id, items);
    await recordDecision({
      access,
      action: "revise",
      fromStatus: existing.status,
      planId: revisionRow.id,
      toStatus: "draft",
    });
    if (input.submit) {
      await rpcSubmitPlan({ access, expectedRevision: revisionRow.revision, planId: revisionRow.id });
      await notifyPlanSubmitted(await loadPlanRow(revisionRow.id));
    }
    return mapPlan(await loadPlanRow(revisionRow.id));
  }

  if (!canEditEmployeePlanStatus(existing.status)) {
    throw new Error("This plan cannot be edited in its current status.");
  }
  const owner = await currentEmployee(access);
  await replacePlanItems(
    existing.id,
    normalizeItems(input.items, existing.period_start_date, await medicalRepOptionsForEmployee(owner), {
      submit: Boolean(input.submit),
    }),
  );
  if (input.submit) {
    await rpcSubmitPlan({ access, expectedRevision: existing.revision, planId: existing.id });
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
  return mapPlan(await loadPlanRow(planId));
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
  return mapPlan(await loadPlanRow(planId));
}

