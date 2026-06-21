import { createHash, randomBytes } from "node:crypto";

import {
  assertPermission,
  normalizeHrId,
  normalizeLineName,
  normalizeRole,
  resolveEmployeeIdentityId,
  type AccessContext,
} from "@/lib/auth/permissions";
import {
  getEmployeeDirectory,
  type EmployeeDirectoryData,
  type EmployeeDirectoryRow,
} from "@/lib/employees/employee-directory";
import { createSystemNotification } from "@/lib/notifications/system";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type EmployeeExcuseType = "morning" | "afternoon";
export type EmployeeExcuseDecision = "approve" | "reject";
export type EmployeeExcuseStatus = "pending_manager" | "approved" | "rejected";

export type EmployeeExcuseRequest = {
  createdAt: string;
  departmentName: string | null;
  durationHours: number;
  employeeHrId: string;
  employeeName: string;
  excuseDate: string;
  excuseType: EmployeeExcuseType;
  id: string;
  lineName: string | null;
  managerDecisionAt: string | null;
  managerDecisionComment: string | null;
  managerHrId: string | null;
  managerName: string | null;
  status: EmployeeExcuseStatus;
};

export type EmployeeExcuseWorkspaceData = {
  employee: {
    departmentName: string | null;
    fullName: string;
    hrId: string;
    lineName: string | null;
    managerName: string | null;
    roleLabel: string;
  };
  monthly: {
    allowance: number;
    approved: number;
    pending: number;
    remaining: number;
    used: number;
    yearMonth: string;
  };
  requests: EmployeeExcuseRequest[];
};

type ExcuseRequestRow = {
  created_at: string;
  department_name: string | null;
  duration_hours: number | string;
  employee_hr_id: string;
  employee_name: string;
  excuse_date: string;
  excuse_type: EmployeeExcuseType;
  id: string;
  line_name: string | null;
  manager_decision_at: string | null;
  manager_decision_comment: string | null;
  manager_hr_id: string | null;
  manager_name: string | null;
  status: EmployeeExcuseStatus;
};

type ExcuseTokenRow = {
  expires_at: string;
  manager_hr_id: string | null;
  token_hash: string;
  used_at: string | null;
};

const excuseDurationHours = 2;
const monthlyAllowance = Math.max(
  1,
  Number.parseInt(process.env.PHOENIX_MONTHLY_EXCUSE_ALLOWANCE ?? "2", 10) || 2,
);

function cleanText(value: string | null | undefined) {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function requestMonthKey(dateText: string) {
  return dateText.slice(0, 7);
}

function currentMonthKey() {
  return new Date().toISOString().slice(0, 7);
}

function activeStatus(status: EmployeeExcuseStatus) {
  return status === "pending_manager" || status === "approved";
}

function isExcusesSchemaMissingMessage(error: unknown) {
  const message = excuseErrorMessage(error).toLowerCase();
  return (
    message.includes("v2_excuse_requests") ||
    message.includes("v2_excuse_email_tokens") ||
    message.includes("could not find the table") ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist"))
  );
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function findEmployeeByHrId(
  directory: EmployeeDirectoryData,
  hrId: string | null | undefined,
) {
  const normalized = normalizeHrId(hrId);
  if (!normalized) return null;
  return (
    directory.employees.find((employee) => normalizeHrId(employee.hrId) === normalized) ??
    null
  );
}

function findCurrentEmployee(directory: EmployeeDirectoryData, access: AccessContext) {
  const candidates = Array.from(
    new Set(
      [access.hrId, access.loginId, resolveEmployeeIdentityId(access)]
        .map((value) => normalizeHrId(value))
        .filter(Boolean) as string[],
    ),
  );

  for (const candidate of candidates) {
    const employee = findEmployeeByHrId(directory, candidate);
    if (employee) return employee;
  }

  return null;
}

export function isHeadOfficeExcuseEmployee(
  employee: Pick<EmployeeDirectoryRow, "departmentName" | "lineName">,
) {
  const normalizedLine = normalizeLineName(employee.lineName).replace(/[^a-z0-9]/g, "");
  const normalizedDepartment = normalizeLineName(employee.departmentName).replace(/[^a-z0-9]/g, "");
  return ["office", "headoffice", "hq"].includes(normalizedLine) ||
    ["office", "headoffice", "hq"].includes(normalizedDepartment);
}

// Roles that may submit excuses regardless of whether they sit in Head Office.
// National Sales Manager has always been eligible; Product Manager, Group Product
// Manager, and Training Manager were added so the field/marketing leadership roles
// surfaced in the employee portal can record their own 2-hour excuses.
const EXCUSE_ELIGIBLE_ROLES = new Set([
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "Training Manager",
]);

function canUseExcuses(access: AccessContext, employee: EmployeeDirectoryRow) {
  return EXCUSE_ELIGIBLE_ROLES.has(normalizeRole(access.role)) ||
    isHeadOfficeExcuseEmployee(employee);
}

function mapExcuseRequestRow(row: ExcuseRequestRow): EmployeeExcuseRequest {
  return {
    createdAt: row.created_at,
    departmentName: row.department_name,
    durationHours: Number(row.duration_hours ?? excuseDurationHours),
    employeeHrId: row.employee_hr_id,
    employeeName: row.employee_name,
    excuseDate: row.excuse_date,
    excuseType: row.excuse_type,
    id: row.id,
    lineName: row.line_name,
    managerDecisionAt: row.manager_decision_at,
    managerDecisionComment: row.manager_decision_comment,
    managerHrId: row.manager_hr_id,
    managerName: row.manager_name,
    status: row.status,
  };
}

function computeMonthlySummary(requests: EmployeeExcuseRequest[], yearMonth = currentMonthKey()) {
  const activeThisMonth = requests.filter(
    (request) => requestMonthKey(request.excuseDate) === yearMonth && activeStatus(request.status),
  );
  const approved = activeThisMonth.filter((request) => request.status === "approved").length;
  const pending = activeThisMonth.filter((request) => request.status === "pending_manager").length;
  const used = activeThisMonth.length;

  return {
    allowance: monthlyAllowance,
    approved,
    pending,
    remaining: Math.max(0, monthlyAllowance - used),
    used,
    yearMonth,
  };
}

async function fetchEmployeeExcuseRequests(employeeHrId: string) {
  const { data, error } = await getSupabaseAdmin()
    .from("v2_excuse_requests")
    .select("id,employee_hr_id,employee_name,department_name,line_name,manager_hr_id,manager_name,excuse_date,excuse_type,duration_hours,status,manager_decision_at,manager_decision_comment,created_at")
    .ilike("employee_hr_id", employeeHrId)
    .order("excuse_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) throw error;
  return ((data ?? []) as ExcuseRequestRow[]).map(mapExcuseRequestRow);
}

async function loadEligibleEmployee(access: AccessContext) {
  await assertPermission(access, "employee_profile", "read");
  const directory = await getEmployeeDirectory();
  const employee = findCurrentEmployee(directory, access);
  if (!employee) {
    throw new Error("Forbidden: your employee profile is not linked yet.");
  }
  if (!canUseExcuses(access, employee)) {
    throw new Error("Forbidden: excuses are available for Head Office employees, National Sales Managers, Product Managers, Group Product Managers, and Training Managers only.");
  }

  return { directory, employee };
}

export async function getExcuseWorkspace(
  access: AccessContext,
): Promise<EmployeeExcuseWorkspaceData> {
  const { employee } = await loadEligibleEmployee(access);
  const employeeHrId = normalizeHrId(employee.hrId) ?? employee.hrId;
  const requests = await fetchEmployeeExcuseRequests(employeeHrId);

  return {
    employee: {
      departmentName: employee.departmentName,
      fullName: employee.fullName,
      hrId: employeeHrId,
      lineName: employee.lineName,
      managerName: employee.managerName,
      roleLabel: employee.jobTitle || employee.positionTitle || access.role,
    },
    monthly: computeMonthlySummary(requests),
    requests,
  };
}

export function parseExcuseType(value: unknown): EmployeeExcuseType | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "morning" || normalized === "afternoon" ? normalized : null;
}

export function parseExcuseDecision(value: unknown): EmployeeExcuseDecision | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "approve" || normalized === "approved") return "approve";
  if (normalized === "reject" || normalized === "rejected") return "reject";
  return null;
}

function validateDateOnly(value: unknown) {
  const dateText = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) {
    throw new Error("Excuse date is required.");
  }
  const date = new Date(`${dateText}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== dateText) {
    throw new Error("Excuse date is invalid.");
  }
  return dateText;
}

async function enqueueInAppNotification(input: {
  category: string;
  dedupeKey: string;
  href?: string | null;
  message: string;
  metadata?: Record<string, unknown>;
  recipientHrId: string;
  title: string;
}) {
  return createSystemNotification({
    actionUrl: input.href ?? null,
    category: input.category,
    channels: ["in_app"],
    eventType: "excuse_notification",
    message: input.message,
    metadata: { ...(input.metadata ?? {}), idempotencyKey: input.dedupeKey },
    module: "excuse",
    priority: "high",
    recipientHrId: input.recipientHrId,
    title: input.title,
  });
}

async function sendManagerEmail(input: {
  baseUrl: string;
  employee: EmployeeDirectoryRow;
  manager: EmployeeDirectoryRow;
  request: EmployeeExcuseRequest;
  token: string;
}) {
  const typeLabel = input.request.excuseType === "morning" ? "Morning excuse" : "Afternoon excuse";
  const managerActionUrl = `/admin/action-center?module=excuse&id=${encodeURIComponent(input.request.id)}`;
  await createSystemNotification({
    actionUrl: managerActionUrl,
    actorId: input.request.employeeHrId,
    channels: ["email"],
    email: {
      ctaHref: managerActionUrl,
      ctaLabel: "Review in Action Center",
      employeeHrId: input.request.employeeHrId,
      metrics: [
        { label: "Employee", value: `${input.request.employeeName} (${input.request.employeeHrId})` },
        { label: "Excuse type", value: typeLabel },
        { label: "Date", value: input.request.excuseDate },
        { label: "Duration", value: `${input.request.durationHours} hours` },
      ],
      notificationType: "general",
      recipients: [input.manager.workEmail as string],
      subject: `Excuse approval: ${input.request.employeeName}`,
      summary: `${input.request.employeeName} submitted a ${typeLabel} for ${input.request.excuseDate}.`,
      // The admin-edited excuse_request template shows Job Title/Line/Area/Duration; the
      // metric mapping does not fill those (the "Duration" metric label is not mapped), so
      // supply them explicitly to avoid blank cells.
      templateContext: {
        area: input.employee.areaName ?? "—",
        duration: `${input.request.durationHours} hours`,
        jobTitle: input.employee.jobTitle ?? "—",
        line: input.request.lineName ?? input.employee.lineName ?? "—",
      },
      title: "Excuse approval required",
      tone: "warning",
    },
    eventType: "request_submitted",
    message: `${input.request.employeeName} submitted a ${typeLabel} for ${input.request.excuseDate}.`,
    metadata: {
      employeeHrId: input.request.employeeHrId,
      idempotencyKey: `excuse-manager-email:${input.request.id}`,
      requestId: input.request.id,
      status: input.request.status,
    },
    module: "excuse",
    priority: "high",
    recipientHrId: input.manager.hrId,
    recordId: input.request.id,
    subjectHrId: input.request.employeeHrId,
    title: "Excuse approval required",
  });
}

async function sendEmployeeDecisionEmail(input: {
  request: EmployeeExcuseRequest & { employeeWorkEmail?: string | null };
}) {
  const employeeEmail = cleanText(input.request.employeeWorkEmail);
  if (!employeeEmail) return;

  const statusLabel = input.request.status === "approved" ? "approved" : "rejected";
  await createSystemNotification({
    actionUrl: "/employee-portals/excuses",
    actorId: input.request.managerHrId,
    channels: ["email"],
    email: {
      ctaHref: "/employee-portals/excuses",
      ctaLabel: "Open in Phoenix",
      employeeHrId: input.request.employeeHrId,
      metrics: [
        { label: "Excuse type", value: input.request.excuseType },
        { label: "Date", value: input.request.excuseDate },
        { label: "Status", value: statusLabel },
      ],
      notificationType: "general",
      recipients: [employeeEmail],
      subject: `Your excuse request was ${statusLabel}`,
      summary: `Your ${input.request.excuseType} excuse for ${input.request.excuseDate} was ${statusLabel}.`,
      // Fill the excuse_request template's Duration/Line cells from the request so they are
      // not blank. (Job Title/Area are not on the request object here.)
      templateContext: {
        duration: `${input.request.durationHours} hours`,
        line: input.request.lineName ?? "—",
      },
      title: `Excuse request ${statusLabel}`,
      tone: statusLabel === "approved" ? "success" : "warning",
    },
    eventType: "request_decided",
    message: `Your ${input.request.excuseType} excuse for ${input.request.excuseDate} was ${statusLabel}.`,
    metadata: {
      employeeHrId: input.request.employeeHrId,
      idempotencyKey: `excuse-employee-email:${input.request.id}:${statusLabel}`,
      requestId: input.request.id,
      status: input.request.status,
    },
    module: "excuse",
    priority: "normal",
    recipientHrId: input.request.employeeHrId,
    recordId: input.request.id,
    subjectHrId: input.request.employeeHrId,
    title: `Excuse request ${statusLabel}`,
  });
}

export async function createExcuseRequest(
  access: AccessContext,
  input: { excuseDate?: unknown; excuseType?: unknown },
  options: { baseUrl: string },
) {
  const { directory, employee } = await loadEligibleEmployee(access);
  const employeeHrId = normalizeHrId(employee.hrId) ?? employee.hrId;
  const excuseDate = validateDateOnly(input.excuseDate);
  const excuseType = parseExcuseType(input.excuseType);
  if (!excuseType) throw new Error("Excuse type must be morning or afternoon.");

  const manager = findEmployeeByHrId(directory, employee.managerHrId);
  if (!employee.managerHrId || !manager) {
    throw new Error("Direct manager is not linked for this employee. Please contact HR.");
  }
  if (!cleanText(manager.workEmail)) {
    throw new Error("Direct manager work email is missing. Please contact HR.");
  }

  const existingRequests = await fetchEmployeeExcuseRequests(employeeHrId);
  const targetMonth = requestMonthKey(excuseDate);
  const monthly = computeMonthlySummary(existingRequests, targetMonth);
  if (monthly.remaining <= 0) {
    throw new Error(`Monthly excuse limit reached for ${targetMonth}.`);
  }

  const { data, error } = await getSupabaseAdmin()
    .from("v2_excuse_requests")
    .insert({
      department_name: employee.departmentName,
      duration_hours: excuseDurationHours,
      employee_hr_id: employeeHrId,
      employee_name: employee.fullName,
      employee_work_email: employee.workEmail,
      excuse_date: excuseDate,
      excuse_type: excuseType,
      line_name: employee.lineName,
      manager_hr_id: normalizeHrId(employee.managerHrId),
      manager_name: manager.fullName,
      manager_work_email: manager.workEmail,
      status: "pending_manager",
      submitted_by_hr_id: normalizeHrId(access.hrId),
      submitted_by_login_id: access.loginId ?? null,
    })
    .select("id,employee_hr_id,employee_name,department_name,line_name,manager_hr_id,manager_name,excuse_date,excuse_type,duration_hours,status,manager_decision_at,manager_decision_comment,created_at")
    .single();

  if (error) throw error;

  const request = mapExcuseRequestRow(data as ExcuseRequestRow);
  const token = randomBytes(32).toString("base64url");
  const { error: tokenError } = await getSupabaseAdmin()
    .from("v2_excuse_email_tokens")
    .insert({
      expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      manager_hr_id: request.managerHrId,
      request_id: request.id,
      token_hash: hashToken(token),
    });

  if (tokenError) throw tokenError;

  await Promise.all([
    sendManagerEmail({ baseUrl: options.baseUrl, employee, manager, request, token }),
    enqueueInAppNotification({
      category: "excuse",
      dedupeKey: `excuse-manager-${request.id}`,
      href: `/admin/action-center?module=excuse&id=${encodeURIComponent(request.id)}`,
      message: `${request.employeeName} submitted a ${request.excuseType} excuse for ${request.excuseDate}.`,
      metadata: { requestId: request.id, status: request.status },
      recipientHrId: request.managerHrId ?? "",
      title: "Excuse approval required",
    }),
  ]);

  return {
    request,
    workspace: await getExcuseWorkspace(access),
  };
}

async function fetchRequestById(requestId: string) {
  const { data, error } = await getSupabaseAdmin()
    .from("v2_excuse_requests")
    .select("id,employee_hr_id,employee_name,employee_work_email,department_name,line_name,manager_hr_id,manager_name,excuse_date,excuse_type,duration_hours,status,manager_decision_at,manager_decision_comment,created_at")
    .eq("id", requestId)
    .maybeSingle();

  if (error) throw error;
  return data as (ExcuseRequestRow & { employee_work_email?: string | null }) | null;
}

export async function decideExcuseRequestByToken(input: {
  decision: EmployeeExcuseDecision;
  requestId: string;
  token: string;
}) {
  const requestRow = await fetchRequestById(input.requestId);
  if (!requestRow) throw new Error("Excuse request was not found.");
  if (requestRow.status !== "pending_manager") {
    throw new Error("This excuse request has already been decided.");
  }

  const tokenHash = hashToken(input.token);
  const { data: tokenRow, error: tokenError } = await getSupabaseAdmin()
    .from("v2_excuse_email_tokens")
    .select("token_hash,request_id,manager_hr_id,expires_at,used_at")
    .eq("request_id", input.requestId)
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (tokenError) throw tokenError;
  const tokenData = tokenRow as ExcuseTokenRow | null;
  if (!tokenData) throw new Error("Approval link is invalid.");
  if (tokenData.used_at) throw new Error("Approval link was already used.");
  if (new Date(tokenData.expires_at).getTime() < Date.now()) {
    throw new Error("Approval link has expired.");
  }
  if (normalizeHrId(tokenData.manager_hr_id) !== normalizeHrId(requestRow.manager_hr_id)) {
    throw new Error("Approval link does not match this request manager.");
  }

  const status: EmployeeExcuseStatus = input.decision === "approve" ? "approved" : "rejected";
  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await getSupabaseAdmin()
    .from("v2_excuse_requests")
    .update({
      manager_decision: status,
      manager_decision_at: now,
      manager_decision_by_hr_id: requestRow.manager_hr_id,
      status,
      updated_at: now,
    })
    .eq("id", input.requestId)
    .select("id,employee_hr_id,employee_name,employee_work_email,department_name,line_name,manager_hr_id,manager_name,excuse_date,excuse_type,duration_hours,status,manager_decision_at,manager_decision_comment,created_at")
    .single();

  if (updateError) throw updateError;

  await getSupabaseAdmin()
    .from("v2_excuse_email_tokens")
    .update({ used_at: now })
    .eq("request_id", input.requestId)
    .eq("token_hash", tokenHash);

  const request = mapExcuseRequestRow(updated as ExcuseRequestRow);
  await Promise.all([
    sendEmployeeDecisionEmail({
      request: {
        ...request,
        employeeWorkEmail: (updated as { employee_work_email?: string | null }).employee_work_email,
      },
    }),
    enqueueInAppNotification({
      category: "excuse",
      dedupeKey: `excuse-employee-${request.id}-${status}`,
      href: "/employee-portals/excuses",
      message: `Your ${request.excuseType} excuse for ${request.excuseDate} was ${status}.`,
      metadata: { requestId: request.id, status },
      recipientHrId: request.employeeHrId,
      title: `Excuse ${status}`,
    }),
  ]);

  return request;
}

export async function getManagerPendingExcuses(access: AccessContext): Promise<EmployeeExcuseRequest[]> {
  const supabase = getSupabaseAdmin();
  const isSystemActor = access.scope === "system";
  let query = supabase
    .from("v2_excuse_requests")
    .select("id,employee_hr_id,employee_name,department_name,line_name,manager_hr_id,manager_name,excuse_date,excuse_type,duration_hours,status,manager_decision_at,manager_decision_comment,created_at")
    .eq("status", "pending_manager")
    .order("created_at", { ascending: true });

  if (!isSystemActor) {
    const actorHrId = resolveEmployeeIdentityId(access);
    if (!actorHrId) return [];
    const normalized = normalizeHrId(actorHrId) ?? actorHrId;
    query = query.ilike("manager_hr_id", normalized);
  }

  const { data, error } = await query;
  if (error) throw error;
  return ((data ?? []) as ExcuseRequestRow[]).map((row) => mapExcuseRequestRow(row));
}

export async function decideExcuseRequestAsManager(
  access: AccessContext,
  input: { requestId: string; decision: EmployeeExcuseDecision; comment?: string | null },
): Promise<EmployeeExcuseRequest> {
  const actorHrId = resolveEmployeeIdentityId(access);
  const isSystemActor = access.scope === "system";

  const requestRow = await fetchRequestById(input.requestId);
  if (!requestRow) throw new Error("Excuse request was not found.");
  if (requestRow.status !== "pending_manager") {
    throw new Error("This excuse request has already been decided.");
  }

  if (!isSystemActor) {
    if (!actorHrId) throw new Error("Your employee profile is not linked. Contact HR.");
    if (normalizeHrId(actorHrId) !== normalizeHrId(requestRow.manager_hr_id)) {
      throw new Error("You are not the assigned manager for this excuse request.");
    }
  }

  const deciderHrId = actorHrId ?? requestRow.manager_hr_id;
  const status: EmployeeExcuseStatus = input.decision === "approve" ? "approved" : "rejected";
  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await getSupabaseAdmin()
    .from("v2_excuse_requests")
    .update({
      manager_decision: status,
      manager_decision_at: now,
      manager_decision_by_hr_id: deciderHrId,
      manager_decision_comment: input.comment ?? null,
      status,
      updated_at: now,
    })
    .eq("id", input.requestId)
    .select("id,employee_hr_id,employee_name,employee_work_email,department_name,line_name,manager_hr_id,manager_name,excuse_date,excuse_type,duration_hours,status,manager_decision_at,manager_decision_comment,created_at")
    .single();

  if (updateError) throw updateError;

  const request = mapExcuseRequestRow(updated as ExcuseRequestRow);
  await Promise.all([
    sendEmployeeDecisionEmail({
      request: {
        ...request,
        employeeWorkEmail: (updated as { employee_work_email?: string | null }).employee_work_email,
      },
    }),
    enqueueInAppNotification({
      category: "excuse",
      dedupeKey: `excuse-employee-${request.id}-${status}`,
      href: "/employee-portals/excuses",
      message: `Your ${request.excuseType} excuse for ${request.excuseDate} was ${status}.`,
      metadata: { requestId: request.id, status },
      recipientHrId: request.employeeHrId,
      title: `Excuse ${status}`,
    }),
  ]);

  return request;
}

export function isExcusesSchemaMissing(error: unknown) {
  return isExcusesSchemaMissingMessage(error);
}

export async function runExcuseSlaDaily(): Promise<{ processed: number; errors: number }> {
  const today = new Date().toISOString().slice(0, 10);
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("v2_excuse_requests")
    .select("id, employee_name, excuse_date, excuse_type, created_at, manager_hr_id")
    .eq("status", "pending_manager")
    .not("manager_hr_id", "is", null);
  if (error) return { processed: 0, errors: 1 };

  let processed = 0;
  let errors = 0;
  const now = Date.now();
  for (const row of data ?? []) {
    const ageDays = Math.max(0, Math.floor((now - new Date(row.created_at as string).getTime()) / 86400000));
    if (ageDays < 2) continue;
    try {
      await createSystemNotification({
        channels: ["email"],
        eventType: "excuse_sla_reminder",
        message: `${String(row.employee_name)}'s ${String(row.excuse_type)} excuse for ${String(row.excuse_date)} has been pending ${ageDays} day${ageDays === 1 ? "" : "s"}.`,
        metadata: { idempotencyKey: `excuse:${String(row.id)}:sla:${String(row.manager_hr_id)}:${today}` },
        module: "excuse",
        priority: "normal",
        recipientHrId: String(row.manager_hr_id),
        title: "Excuse approval overdue",
        actionUrl: `/admin/action-center?module=excuse&id=${String(row.id)}`,
        email: {
          ctaHref: `/admin/action-center?module=excuse&id=${String(row.id)}`,
          ctaLabel: "Review now",
          tone: "warning" as const,
        },
      });
      processed++;
    } catch {
      errors++;
    }
  }
  return { processed, errors };
}

export function excuseErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "");
}
