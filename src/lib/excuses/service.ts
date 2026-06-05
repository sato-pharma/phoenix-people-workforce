import { createHash, randomBytes } from "node:crypto";

import {
  assertPermission,
  normalizeHrId,
  normalizeLineName,
  normalizeRole,
  resolveEmployeeIdentityId,
  type AccessContext,
} from "@/lib/auth/permissions";
import { sendPhoenixEmail } from "@/lib/email/send-phoenix-email";
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

function escapeHtml(value: string | null | undefined) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

function canUseExcuses(access: AccessContext, employee: EmployeeDirectoryRow) {
  return normalizeRole(access.role) === "National Sales Manager" ||
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
    throw new Error("Forbidden: excuses are available for Head Office employees and National Sales Managers only.");
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

function buildDecisionUrl(input: {
  baseUrl: string;
  decision: EmployeeExcuseDecision;
  requestId: string;
  token: string;
}) {
  const url = new URL(`/api/excuses/${input.requestId}/decision`, input.baseUrl);
  url.searchParams.set("decision", input.decision);
  url.searchParams.set("token", input.token);
  return url.toString();
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
  manager: EmployeeDirectoryRow;
  request: EmployeeExcuseRequest;
  token: string;
}) {
  const approveUrl = buildDecisionUrl({
    baseUrl: input.baseUrl,
    decision: "approve",
    requestId: input.request.id,
    token: input.token,
  });
  const rejectUrl = buildDecisionUrl({
    baseUrl: input.baseUrl,
    decision: "reject",
    requestId: input.request.id,
    token: input.token,
  });
  const typeLabel = input.request.excuseType === "morning" ? "Morning excuse" : "Afternoon excuse";
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;line-height:1.6">
      <p style="margin:0 0 12px;color:#f97316;font-weight:800;letter-spacing:.14em;text-transform:uppercase">Phoenix Workforce</p>
      <h2 style="margin:0 0 12px">Excuse approval required</h2>
      <p>${escapeHtml(input.request.employeeName)} submitted a ${escapeHtml(typeLabel)} for ${escapeHtml(input.request.excuseDate)}.</p>
      <p>Duration: ${input.request.durationHours} hours.</p>
      <p style="margin-top:20px">
        <a href="${escapeHtml(approveUrl)}" style="display:inline-block;margin-right:8px;border-radius:10px;background:#15803d;color:white;padding:10px 16px;text-decoration:none;font-weight:700">Approve</a>
        <a href="${escapeHtml(rejectUrl)}" style="display:inline-block;border-radius:10px;background:#be123c;color:white;padding:10px 16px;text-decoration:none;font-weight:700">Reject</a>
      </p>
    </div>`;
  const text = [
    "Excuse approval required",
    `${input.request.employeeName} submitted a ${typeLabel} for ${input.request.excuseDate}.`,
    `Approve: ${approveUrl}`,
    `Reject: ${rejectUrl}`,
  ].join("\n");

  await sendPhoenixEmail({
    html,
    idempotencyKey: `excuse-manager-${input.request.id}`,
    subject: `Excuse approval: ${input.request.employeeName}`,
    text,
    to: [input.manager.workEmail as string],
  });
}

async function sendEmployeeDecisionEmail(input: {
  request: EmployeeExcuseRequest & { employeeWorkEmail?: string | null };
}) {
  const employeeEmail = cleanText(input.request.employeeWorkEmail);
  if (!employeeEmail) return;

  const statusLabel = input.request.status === "approved" ? "approved" : "rejected";
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;line-height:1.6">
      <p style="margin:0 0 12px;color:#f97316;font-weight:800;letter-spacing:.14em;text-transform:uppercase">Phoenix Workforce</p>
      <h2 style="margin:0 0 12px">Excuse request ${escapeHtml(statusLabel)}</h2>
      <p>Your ${escapeHtml(input.request.excuseType)} excuse for ${escapeHtml(input.request.excuseDate)} was ${escapeHtml(statusLabel)}.</p>
    </div>`;

  await sendPhoenixEmail({
    html,
    idempotencyKey: `excuse-employee-${input.request.id}-${statusLabel}`,
    subject: `Your excuse request was ${statusLabel}`,
    text: `Your ${input.request.excuseType} excuse for ${input.request.excuseDate} was ${statusLabel}.`,
    to: [employeeEmail],
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
    sendManagerEmail({ baseUrl: options.baseUrl, manager, request, token }),
    enqueueInAppNotification({
      category: "excuse",
      dedupeKey: `excuse-manager-${request.id}`,
      href: "/employee-portals/excuses",
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

export function isExcusesSchemaMissing(error: unknown) {
  return isExcusesSchemaMissingMessage(error);
}

export function excuseErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "");
}
