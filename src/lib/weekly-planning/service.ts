import crypto from "crypto";

import { writeAuditLog } from "@/lib/admin/audit";
import {
  assertPermission,
  canAccess,
  normalizeHrIdForAccess,
  type AccessContext,
  type PhoenixRole,
} from "@/lib/auth/permissions";
import { getEmployeeDirectory, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { createSystemNotification } from "@/lib/notifications/system";
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

function normalizeText(value: string | null | undefined) {
  return String(value ?? "").trim();
}

function workplaceRegionsFromDirectory(directory: EmployeeDirectoryRow[]) {
  const regionNameByKey = new Map<string, string>();
  for (const row of directory) {
    const regionName = normalizeText(row.regionName);
    if (!regionName) continue;
    const key = regionName.toLowerCase();
    if (!regionNameByKey.has(key)) {
      regionNameByKey.set(key, regionName);
    }
  }
  return Array.from(regionNameByKey.values()).sort((a, b) => a.localeCompare(b));
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

function assertManagerReviewer(access: AccessContext, plan: PlanHeaderRow) {
  if (access.role === "Super Admin") return;
  if (!hrIdsMatch(access.hrId, plan.manager_hr_id)) {
    throw new Error("Forbidden: only the direct manager can decide this plan.");
  }
}

function assertCeoReviewer(access: AccessContext) {
  if (access.role !== "CEO" && access.role !== "Super Admin" && access.scope !== "system") {
    throw new Error("Forbidden: only the CEO can decide this stage.");
  }
}

function validActivityType(value: string): EmployeePlanActivityType {
  if ((employeePlanActivityTypes as readonly string[]).includes(value)) return value as EmployeePlanActivityType;
  return "Other";
}

function normalizeItems(
  items: EmployeePlanItemInput[],
  periodStartDate: string,
  medicalRepOptions: Array<{ fullName: string; hrId: string }>,
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
    ...normalizeItem(item, index, periodStartDate, repByHrId),
  }));
}

function normalizeItem(
  item: EmployeePlanItemInput,
  index: number,
  periodStartDate: string,
  repByHrId: Map<string, { fullName: string; hrId: string }>,
): EmployeePlanItemInput & { doubleVisitMedicalRepName?: string | null } {
  const activityType = validActivityType(cleanText(item.activityType));
  const selectedRepHrId = nullableText(item.doubleVisitMedicalRepHrId);
  let selectedRepName: string | null = null;
  if (activityType === "Double Visit") {
    if (!selectedRepHrId) {
      throw new Error("Double Visit requires selecting a same-line Medical Rep.");
    }
    const rep = repByHrId.get(normalizeHrId(selectedRepHrId));
    if (!rep) {
      throw new Error("Selected double-visit Medical Rep is not available for this employee line.");
    }
    selectedRepName = rep.fullName;
  }
  return {
    activityDate: cleanText(item.activityDate) || periodStartDate,
    activityTitle: cleanText(item.activityTitle) || "Untitled activity",
    activityType,
    area: nullableText(item.area),
    attendees: nullableText(item.attendees),
    doubleVisitMedicalRepHrId: activityType === "Double Visit" ? selectedRepHrId : null,
    doubleVisitMedicalRepName: activityType === "Double Visit" ? selectedRepName : null,
    endTime: nullableText(item.endTime),
    locationText: nullableText(item.locationText),
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

async function recordReturnNotes(input: {
  access: AccessContext;
  action: Extract<EmployeePlanAction, "manager_return" | "ceo_return">;
  notes?: EmployeePlanReturnNoteInput[];
  plan: PlanHeaderRow;
}) {
  const cleanNotes = (input.notes ?? [])
    .map((note) => ({
      itemId: cleanText(note.itemId),
      note: cleanText(note.note),
    }))
    .filter((note) => note.itemId && note.note);
  if (cleanNotes.length === 0) return;

  const itemsById = new Map((input.plan.employee_plan_items ?? []).map((item) => [item.id, item]));
  const rows = cleanNotes.map((note) => {
    const item = itemsById.get(note.itemId);
    if (!item) {
      throw new Error("Row return feedback includes an item that does not belong to this plan.");
    }
    return {
      action: input.action,
      activity_date: item.activity_date,
      activity_title: item.activity_title,
      actor_hr_id: input.access.hrId,
      actor_login_id: input.access.loginId ?? null,
      actor_role: input.access.role,
      item_id: item.id,
      note: note.note,
      plan_id: input.plan.id,
      sort_order: item.sort_order,
    };
  });

  const { error } = await getSupabaseAdmin().from("employee_plan_item_return_notes").insert(rows);
  if (error) throw error;
}

async function notifyRecipients(input: {
  actionUrl: string;
  eventType: string;
  message: string;
  plan: PlanHeaderRow;
  recipients: Array<{ hrId: string | null; userId?: string | null }>;
  title: string;
}) {
  await Promise.all(input.recipients
    .filter((recipient) => recipient.hrId || recipient.userId)
    .map((recipient) => createSystemNotification({
      actionUrl: input.actionUrl,
      category: "general",
      channels: ["in_app", "email", "telegram"],
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
    .in("role", ["HR Specialist", "Super Admin"]);
  const { data: employees } = await supabase
    .from("employees")
    .select("hr_id,full_name,job_title,position_title")
    .or("job_title.ilike.%HR Manager%,job_title.ilike.%Admin HR%,position_title.ilike.%HR Manager%,position_title.ilike.%Admin HR%");
  const employeeHrIds = new Set(((employees ?? []) as Array<{ hr_id?: string | null }>).map((row) => normalizeHrId(row.hr_id)).filter(Boolean));
  const recipients = ((authRows ?? []) as AuthUserRow[])
    .filter((row) => row.role === "Super Admin" || row.role === "HR Specialist" || employeeHrIds.has(normalizeHrId(row.hr_id)))
    .map((row) => ({ hrId: row.hr_id ?? null, userId: row.login_id ?? null }));
  for (const hrId of employeeHrIds) {
    if (!recipients.some((recipient) => hrIdsMatch(recipient.hrId, hrId))) {
      recipients.push({ hrId, userId: null });
    }
  }
  return recipients;
}

async function notifyManager(plan: PlanHeaderRow) {
  await notifyRecipients({
    actionUrl: `/employee-portals/plans?plan=${plan.id}`,
    eventType: "plan_submitted",
    message: `${plan.employee_name} submitted a ${plan.plan_kind} plan for ${plan.period_key}.`,
    plan,
    recipients: [{ hrId: plan.manager_hr_id }],
    title: `${plan.employee_name}'s ${plan.plan_kind} plan needs manager review`,
  });
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
  const period = buildEmployeePlanPeriod(input.planKind, input.anchorDate);
  const items = normalizeItems(input.items, period.periodStartDate, await medicalRepOptionsForEmployee(employee));
  const status: EmployeePlanStatus = input.submit ? "submitted" : "draft";
  const now = new Date().toISOString();

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
      status,
      submitted_at: input.submit ? now : null,
      submitted_by_login_id: input.submit ? access.loginId ?? null : null,
    })
    .select(planSelect)
    .single();
  if (error) throw error;
  const plan = data as PlanHeaderRow;
  await replacePlanItems(plan.id, items);
  if (input.submit) {
    await recordDecision({ access, action: "submit", fromStatus: "draft", planId: plan.id, toStatus: "submitted" });
    await notifyManager(await loadPlanRow(plan.id));
  }
  await writeAuditLog({
    actorLoginId: access.loginId,
    entityId: plan.id,
    entityType: "weekly_plan",
    newValues: { planKind: input.planKind, status },
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
    const next = getNextEmployeePlanStatus(existing.status, "revise");
    const owner = await currentEmployee(access);
    const items = normalizeItems(input.items, existing.period_start_date, await medicalRepOptionsForEmployee(owner));
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
        status: input.submit ? "submitted" : next,
        submitted_at: input.submit ? new Date().toISOString() : null,
        submitted_by_login_id: input.submit ? access.loginId ?? null : null,
      })
      .select(planSelect)
      .single();
    if (error) throw error;
    const revision = data as PlanHeaderRow;
    await replacePlanItems(revision.id, items);
    await recordDecision({
      access,
      action: "revise",
      fromStatus: existing.status,
      planId: revision.id,
      toStatus: input.submit ? "submitted" : "draft",
    });
    if (input.submit) await notifyManager(await loadPlanRow(revision.id));
    return mapPlan(await loadPlanRow(revision.id));
  }

  if (!canEditEmployeePlanStatus(existing.status)) {
    throw new Error("This plan cannot be edited in its current status.");
  }
  const nextStatus = input.submit ? getNextEmployeePlanStatus(existing.status, "submit") : existing.status;
  const owner = await currentEmployee(access);
  await replacePlanItems(existing.id, normalizeItems(input.items, existing.period_start_date, await medicalRepOptionsForEmployee(owner)));
  const { error } = await getSupabaseAdmin()
    .from("employee_plan_headers")
    .update({
      status: nextStatus,
      submitted_at: input.submit ? new Date().toISOString() : existing.submitted_at,
      submitted_by_login_id: input.submit ? access.loginId ?? null : existing.submitted_by_login_id,
    })
    .eq("id", existing.id);
  if (error) throw error;
  if (input.submit) {
    await recordDecision({ access, action: "submit", fromStatus: existing.status, planId: existing.id, toStatus: nextStatus });
    await notifyManager(await loadPlanRow(existing.id));
  }
  await writeAuditLog({
    actorLoginId: access.loginId,
    entityId: existing.id,
    entityType: "weekly_plan",
    newValues: { status: nextStatus },
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
  await assertPermission(access, "weekly_plans", "approve");
  const plan = await loadPlanRow(planId);
  if (input.action.startsWith("manager_")) assertManagerReviewer(access, plan);
  if (input.action.startsWith("ceo_")) assertCeoReviewer(access);
  const nextStatus = getNextEmployeePlanStatus(plan.status, input.action, { comment: input.comment });
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { status: nextStatus };
  if (input.action.startsWith("manager_")) {
    patch.manager_decision_at = now;
    patch.manager_decision_by_hr_id = access.hrId;
    patch.manager_decision_comment = input.comment ?? null;
  }
  if (input.action.startsWith("ceo_")) {
    patch.ceo_decision_at = now;
    patch.ceo_decision_by_hr_id = access.hrId;
    patch.ceo_decision_comment = input.comment ?? null;
  }
  if (nextStatus === "final_approved") {
    patch.final_approved_at = now;
  }
  const { error } = await getSupabaseAdmin().from("employee_plan_headers").update(patch).eq("id", planId);
  if (error) throw error;
  await recordDecision({
    access,
    action: input.action,
    comment: input.comment,
    fromStatus: plan.status,
    planId,
    toStatus: nextStatus,
  });
  if (input.action === "manager_return" || input.action === "ceo_return") {
    await recordReturnNotes({
      access,
      action: input.action,
      notes: input.returnNotes,
      plan,
    });
  }

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
  const nextStatus = getNextEmployeePlanStatus(plan.status, "hr_acknowledge");
  const hrId = access.hrId ?? access.loginId ?? `system-${crypto.randomUUID()}`;
  const { error: ackError } = await getSupabaseAdmin()
    .from("employee_plan_hr_acknowledgements")
    .upsert({
      comment: nullableText(comment),
      hr_id: hrId,
      login_id: access.loginId ?? null,
      plan_id: planId,
      role_label: employeeTitle(employee, access.role),
    }, { onConflict: "plan_id,hr_id" });
  if (ackError) throw ackError;
  const { error: updateError } = await getSupabaseAdmin()
    .from("employee_plan_headers")
    .update({ status: nextStatus })
    .eq("id", planId);
  if (updateError) throw updateError;
  await recordDecision({
    access,
    action: "hr_acknowledge",
    comment,
    fromStatus: plan.status,
    planId,
    toStatus: nextStatus,
  });
  await writeAuditLog({
    actorLoginId: access.loginId,
    entityId: planId,
    entityType: "weekly_plan",
    summary: `${plan.plan_kind} plan acknowledged by HR`,
  });
  return mapPlan(await loadPlanRow(planId));
}

