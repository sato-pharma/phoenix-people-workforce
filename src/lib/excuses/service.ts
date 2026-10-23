import { createHash, randomBytes } from "node:crypto";

import {
  assertPermission,
  normalizeHrId,
  normalizeLineName,
  normalizeRole,
  resolveEmployeeIdentityId,
  type AccessContext,
} from "@/lib/auth/permissions";
import { writeAuditLog, type AuditEntityType } from "@/lib/admin/audit";
import { EMAIL_TEMPLATE_KEYS } from "@/lib/email-templates/service";
import {
  getEmployeeDirectory,
  type EmployeeDirectoryData,
  type EmployeeDirectoryRow,
} from "@/lib/employees/employee-directory";
import { hrIdLookupKeys, resolveStoredHrId } from "@/lib/hr-id";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { conflictError } from "@/lib/http/api-errors";
import { afterResponse } from "@/lib/http/after-response";
import { getConfiguredHrNotificationEmails } from "@/lib/notifications/recipients";
import { createSystemNotification } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type EmployeeExcuseType = "morning" | "afternoon";
export type EmployeeExcuseDecision = "approve" | "reject" | "return";
export type EmployeeExcuseStatus = "pending_manager" | "approved" | "rejected" | "returned_to_employee";

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
  requestCode: string;
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
  employee_work_email?: string | null;
  excuse_date: string;
  excuse_type: EmployeeExcuseType;
  id: string;
  line_name: string | null;
  manager_decision?: EmployeeExcuseStatus | null;
  manager_decision_at: string | null;
  manager_decision_comment: string | null;
  manager_decision_by_hr_id?: string | null;
  manager_hr_id: string | null;
  manager_name: string | null;
  request_code: string;
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
const excuseAuditEntityType = ["excuse", "request"].join("_") as AuditEntityType;

// The read column list used to be repeated verbatim at every call site. It is a constant now
// because request_code exposed the failure mode: a column added to seven of eight selects reaches
// most screens and is quietly undefined on the eighth, with nothing to show that it happened.
const excuseColumns =
  "id,request_code,employee_hr_id,employee_name,department_name,line_name,manager_hr_id,manager_name,excuse_date,excuse_type,duration_hours,status,manager_decision,manager_decision_by_hr_id,manager_decision_at,manager_decision_comment,created_at";
const excuseColumnsWithEmail =
  "id,request_code,employee_hr_id,employee_name,employee_work_email,department_name,line_name,manager_hr_id,manager_name,excuse_date,excuse_type,duration_hours,status,manager_decision,manager_decision_by_hr_id,manager_decision_at,manager_decision_comment,created_at";

function cleanText(value: string | null | undefined) {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function requestMonthKey(dateText: string) {
  return dateText.slice(0, 7);
}

// Africa/Cairo, never the server clock. This keys the 2-per-month excuse allowance, and the
// portal gates its Submit button on the resulting `monthly.remaining`. A UTC month key means
// that for the first 2-3 hours of a Cairo month an employee who used both excuses LAST month is
// still counted against it, so the UI refuses a request the server would accept.
function currentMonthKey() {
  return currentCairoDateOnlyIso().slice(0, 7);
}

function activeStatus(status: EmployeeExcuseStatus) {
  return status === "pending_manager" || status === "approved" || status === "returned_to_employee";
}

function actionCenterHref(requestId: string) {
  // Canonical admin URL; hrefs.ts remaps to the portal shell for portal-mode readers.
  return `/admin/approvals/excuse/${encodeURIComponent(requestId)}`;
}

function statusLabel(status: EmployeeExcuseStatus) {
  if (status === "approved") return "approved";
  if (status === "rejected") return "rejected";
  if (status === "returned_to_employee") return "returned to employee";
  return "pending manager";
}

function decisionVerb(status: EmployeeExcuseStatus) {
  if (status === "approved") return "approved";
  if (status === "rejected") return "rejected";
  if (status === "returned_to_employee") return "returned with reply";
  return "updated";
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

function employeeRowByHrId(directory: EmployeeDirectoryData) {
  return new Map(
    directory.employees
      .map((employee) => [normalizeHrId(employee.hrId), employee] as const)
      .filter((entry): entry is [string, EmployeeDirectoryRow] => Boolean(entry[0])),
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
  "Marketing Manager",
]);

// Owner decision 2026-07-30: District (Sales) Managers and Regional Managers are out of the
// Excuse module ENTIRELY — they neither submit excuses nor decide them. Excuse is a Head-Office
// / fingerprint-attendance concept, so the field ladder at and below a DSM never uses it: the
// DSM/RM "Excuse Approvals" surface was a permanently-empty link, and the Head-Office-line branch
// of canUseExcuses was the only path by which one could ever have submitted. Verified against
// production before locking this: no excuse request has ever been submitted by, or routed to, a
// DSM or RM, and no excuse-eligible employee reports to one — so nothing is orphaned here.
// This is a ROLE exclusion and deliberately does NOT include the generic "Manager" role, which is
// the Head-Office people-manager rung that legitimately decides its own reports' excuses.
const EXCUSE_EXCLUDED_ROLES = new Set(["District Manager", "Regional Manager"]);

export function isExcuseExcludedRole(role: string | null | undefined): boolean {
  return EXCUSE_EXCLUDED_ROLES.has(normalizeRole(role));
}

/**
 * Does this HR_ID currently hold an excuse-excluded ACCESS role? Reads `app_auth_users` (the only
 * permission source — a job title never is, see resolveEmployeeAccessRole) and throws on failure
 * rather than fail-open, because the two callers use it as a gate.
 */
async function hrIdHoldsExcuseExcludedRole(hrId: string | null | undefined): Promise<boolean> {
  const target = normalizeHrId(hrId);
  if (!target) return false;
  // Compare in JS via normalizeHrId rather than filtering on hr_id in the query: HR_ID casing and
  // punctuation drift between tables, and a case-sensitive `.in()` would silently miss the match.
  const { data, error } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select("hr_id")
    .in("role", [...EXCUSE_EXCLUDED_ROLES]);
  if (error) throw error;
  return ((data ?? []) as Array<{ hr_id: string | null }>).some(
    (row) => normalizeHrId(row.hr_id) === target,
  );
}

function canUseExcuses(access: AccessContext, employee: EmployeeDirectoryRow) {
  if (isExcuseExcludedRole(access.role)) return false;
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
    requestCode: row.request_code,
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
  const employeeHrKeys = hrIdLookupKeys(employeeHrId);
  if (employeeHrKeys.length === 0) return [];

  const { data, error } = await getSupabaseAdmin()
    .from("v2_excuse_requests")
    .select(excuseColumns)
    .in("employee_hr_id", employeeHrKeys)
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
  if (isExcuseExcludedRole(access.role)) {
    // Own message: an Office-line DSM/RM would otherwise read the generic text below as "you are a
    // Head Office employee, so this should work", which is exactly the case being removed here.
    throw new Error("Forbidden: the excuse module is not available for District or Regional Managers.");
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
  const employeeHrId = employee.hrId;
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
  if (normalized === "return" || normalized === "returned" || normalized === "returned_to_employee") return "return";
  return null;
}

function decisionToStatus(decision: EmployeeExcuseDecision): EmployeeExcuseStatus {
  if (decision === "approve") return "approved";
  if (decision === "return") return "returned_to_employee";
  return "rejected";
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

function resolveHrNotificationRecipients(directory: EmployeeDirectoryData): EmployeeDirectoryRow[] {
  const configuredEmails = new Set(
    getConfiguredHrNotificationEmails()
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
  if (configuredEmails.size === 0) return [];
  return directory.employees.filter((employee) => {
    const email = cleanText(employee.workEmail)?.toLowerCase();
    return Boolean(email && configuredEmails.has(email));
  });
}

function isHrVisibilityActor(directory: EmployeeDirectoryData, access: AccessContext) {
  const role = normalizeRole(access.role);
  if (role === "Super Admin" || role === "CEO" || role === "HR Operations") {
    return true;
  }
  const employee = findCurrentEmployee(directory, access);
  const employeeEmail = cleanText(employee?.workEmail)?.toLowerCase();
  if (!employeeEmail) return false;
  return getConfiguredHrNotificationEmails()
    .map((email) => email.trim().toLowerCase())
    .includes(employeeEmail);
}

async function notifyHrVisibilityRecipients(input: {
  actionUrl: string;
  directory: EmployeeDirectoryData;
  eventType: string;
  message: string;
  metadata: Record<string, unknown>;
  priority: "normal" | "high";
  title: string;
}) {
  const hrRecipients = resolveHrNotificationRecipients(input.directory);
  await Promise.allSettled(
    hrRecipients.map((hr) =>
      createSystemNotification({
        actionUrl: input.actionUrl,
        channels: ["in_app", "telegram", "push"],
        eventType: input.eventType,
        message: input.message,
        metadata: {
          ...input.metadata,
          idempotencyKey: `${String(input.metadata.idempotencyKey ?? input.eventType)}:hr:${hr.hrId}`,
        },
        module: "excuse",
        priority: input.priority,
        recipientHrId: hr.hrId,
        recordId: String(input.metadata.requestId ?? ""),
        subjectHrId: String(input.metadata.employeeHrId ?? ""),
        title: input.title,
      }),
    ),
  );
}

/**
 * The notices an excuse raises go out AFTER the reply has gone (2026-10-23 slow-buttons audit): an
 * excuse decision took 8 s on production and a submit about the same, nearly all of it the manager's
 * and HR's notices — profile and preference reads, event and audit rows, Telegram, the phone push and
 * the templated email, one wave after another — awaited before the answer left. The request is already
 * saved when these run, and the old code let a failed notice reject a saved submit; now a failed
 * notice is logged and never changes the answer. Outside a request (the unit suite, a script)
 * `afterResponse` awaits the task exactly as before.
 */
function notifyManagerOfExcuse(input: Parameters<typeof deliverManagerOfExcuseNotice>[0]) {
  return afterResponse("excuse_notice:manager", () => deliverManagerOfExcuseNotice(input));
}

async function deliverManagerOfExcuseNotice(input: {
  directory: EmployeeDirectoryData;
  employee: EmployeeDirectoryRow;
  manager: EmployeeDirectoryRow;
  occurrenceKey?: string;
  request: EmployeeExcuseRequest;
  type: "submitted" | "resubmitted";
}) {
  const typeLabel = input.request.excuseType === "morning" ? "Morning excuse" : "Afternoon excuse";
  const managerActionUrl = actionCenterHref(input.request.id);
  const title = input.type === "resubmitted" ? "Excuse resubmitted for approval" : "Excuse approval required";
  const verb = input.type === "resubmitted" ? "resubmitted" : "submitted";
  const message = `${input.employee.displayName} ${verb} a ${typeLabel} for ${input.request.excuseDate}.`;
  const occurrenceKey = input.occurrenceKey ?? input.request.createdAt;
  await createSystemNotification({
    actionUrl: managerActionUrl,
    actorId: input.request.employeeHrId,
    channels: ["in_app", "email", "telegram", "push"],
    email: {
      ctaHref: managerActionUrl,
      ctaLabel: "Review in Action Center",
      employeeHrId: input.request.employeeHrId,
      includeHrInbox: true,
      metrics: [
        { label: "Request code", value: input.request.requestCode },
        { label: "Employee", value: `${input.employee.displayName} (${input.request.employeeHrId})` },
        { label: "Job Title", value: input.employee.jobTitle ?? "—" },
        { label: "Line", value: input.request.lineName ?? input.employee.lineName ?? "—" },
        { label: "Area", value: input.employee.areaName ?? "—" },
        { label: "Excuse type", value: typeLabel },
        { label: "Date", value: input.request.excuseDate },
        { label: "Duration", value: `${input.request.durationHours} hours` },
      ],
      notificationType: "general",
      recipients: [input.manager.workEmail as string],
      subject: `Excuse approval: ${input.employee.displayName}`,
      summary: message,
      // The manager-facing editable template shows Job Title/Line/Area/Duration; the metric
      // mapping does not fill those fields, so supply them explicitly to avoid blank cells.
      templateContext: {
        area: input.employee.areaName ?? "—",
        duration: `${input.request.durationHours} hours`,
        jobTitle: input.employee.jobTitle ?? "—",
        requestCode: input.request.requestCode,
        line: input.request.lineName ?? input.employee.lineName ?? "—",
      },
      title,
      tone: "warning",
    },
    eventType: input.type === "resubmitted" ? "request_resubmitted" : "request_submitted",
    message,
    metadata: {
      employeeHrId: input.request.employeeHrId,
      idempotencyKey: `excuse:manager:${input.request.id}:${input.type}:${occurrenceKey}`,
      requestId: input.request.id,
      status: input.request.status,
    },
    module: "excuse",
    priority: "high",
    recipientHrId: input.manager.hrId,
    recordId: input.request.id,
    subjectHrId: input.request.employeeHrId,
    title,
  });

  await notifyHrVisibilityRecipients({
    actionUrl: managerActionUrl,
    directory: input.directory,
    eventType: input.type === "resubmitted" ? "request_resubmitted" : "request_submitted",
    message,
    metadata: {
      employeeHrId: input.request.employeeHrId,
      idempotencyKey: `excuse:hr:${input.request.id}:${input.type}:${occurrenceKey}`,
      requestId: input.request.id,
      status: input.request.status,
    },
    priority: "high",
    title,
  });
}

function notifyDecisionRecipients(input: Parameters<typeof deliverDecisionNotices>[0]) {
  return afterResponse("excuse_notice:decision", () => deliverDecisionNotices(input));
}

async function deliverDecisionNotices(input: {
  directory: EmployeeDirectoryData;
  request: EmployeeExcuseRequest & { employeeWorkEmail?: string | null };
}) {
  const employeeEmail = cleanText(input.request.employeeWorkEmail);
  const requestStatusLabel = statusLabel(input.request.status);
  const managerAction = decisionVerb(input.request.status);
  const excuseTypeLabel = input.request.excuseType === "morning" ? "Morning excuse" : "Afternoon excuse";
  const actionUrl = actionCenterHref(input.request.id);
  const managerNote = cleanText(input.request.managerDecisionComment);
  const noteSuffix = managerNote ? ` Manager reply/reason: ${managerNote}` : "";
  const summary = `Your ${input.request.excuseType} excuse for ${input.request.excuseDate} was ${managerAction} by your direct manager.${noteSuffix}`;
  const title = `Excuse request ${requestStatusLabel}`;
  try {
    // Best-effort — the manager's decision (DB update + audit log) has already committed by
    // the time callers reach this point; a notification failure (e.g. a synthetic/orphaned
    // employeeHrId tripping the notification_events.employee_hr_id FK) must never mask that.
    await createSystemNotification({
      actionUrl,
      actorId: input.request.managerHrId,
      channels: ["in_app", "email", "telegram", "push"],
      email: {
        ctaHref: actionUrl,
        ctaLabel: "Open in Action Center",
        employeeHrId: input.request.employeeHrId,
        includeHrInbox: true,
        metrics: [
          { label: "Request code", value: input.request.requestCode },
          { label: "Excuse type", value: excuseTypeLabel },
          { label: "Date", value: input.request.excuseDate },
          { label: "Status", value: requestStatusLabel },
        ],
        notificationType: "general",
        recipients: employeeEmail ? [employeeEmail] : undefined,
        subject: `Your excuse request was ${requestStatusLabel}`,
        summary,
        // Pin the dedicated employee-facing template so the decision email does NOT reuse
        // manager-oriented wording ("...pending your review", "Dear Dr.").
        templateKey: EMAIL_TEMPLATE_KEYS.EXCUSE_DECISION,
        templateContext: {
          duration: `${input.request.durationHours} hours`,
          employeeHrId: input.request.employeeHrId,
          employeeName: findEmployeeByHrId(input.directory, input.request.employeeHrId)?.displayName ?? input.request.employeeName,
          excuseDate: input.request.excuseDate,
          excuseType: excuseTypeLabel,
          line: input.request.lineName ?? "—",
          requestCode: input.request.requestCode,
          status: requestStatusLabel,
        },
        title,
        tone: input.request.status === "approved" ? "success" : "warning",
      },
      eventType: "request_decided",
      message: summary,
      metadata: {
        employeeHrId: input.request.employeeHrId,
        idempotencyKey: `excuse:employee:${input.request.id}:${input.request.status}:${input.request.managerDecisionAt ?? ""}`,
        requestId: input.request.id,
        status: input.request.status,
      },
      module: "excuse",
      priority: "normal",
      recipientHrId: input.request.employeeHrId,
      recordId: input.request.id,
      subjectHrId: input.request.employeeHrId,
      title,
    });
  } catch (error) {
    logError("Failed to notify employee of excuse decision", { labels: { event: "excuse_employee_decision_notify_failed", requestId: input.request.id }, error });
  }

  await notifyHrVisibilityRecipients({
    actionUrl,
    directory: input.directory,
    eventType: "request_decided",
    message: `${findEmployeeByHrId(input.directory, input.request.employeeHrId)?.displayName ?? input.request.employeeName}'s ${input.request.excuseType} excuse for ${input.request.excuseDate} was ${managerAction} by the direct manager.${noteSuffix}`,
    metadata: {
      employeeHrId: input.request.employeeHrId,
      idempotencyKey: `excuse:hr-decision:${input.request.id}:${input.request.status}:${input.request.managerDecisionAt ?? ""}`,
      requestId: input.request.id,
      status: input.request.status,
    },
    priority: "normal",
    title,
  });
}

export async function createExcuseRequest(
  access: AccessContext,
  input: { excuseDate?: unknown; excuseType?: unknown },
) {
  const { directory, employee } = await loadEligibleEmployee(access);
  const byHrId = employeeRowByHrId(directory);
  const employeeHrId = resolveStoredHrId(employee.hrId, byHrId) ?? employee.hrId;
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
  const managerHrId = resolveStoredHrId(manager.hrId, byHrId) ?? manager.hrId;
  // Refuse UP FRONT rather than minting a request (and an emailed approve/reject token) that the
  // assigned manager is no longer allowed to decide. Without this the row would sit at
  // pending_manager forever, only recoverable via reassignExcuseManager.
  if (await hrIdHoldsExcuseExcludedRole(managerHrId)) {
    throw new Error("Your direct manager cannot decide excuse requests. Please contact HR.");
  }
  const submittedByHrId =
    resolveStoredHrId(access.hrId, byHrId) ??
    resolveStoredHrId(access.loginId, byHrId) ??
    employeeHrId;

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
      manager_hr_id: managerHrId,
      manager_name: manager.fullName,
      manager_work_email: manager.workEmail,
      status: "pending_manager",
      submitted_by_hr_id: submittedByHrId,
      submitted_by_login_id: access.loginId ?? null,
    })
    .select(excuseColumns)
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

  await notifyManagerOfExcuse({ directory, employee, manager, request, type: "submitted" });

  return {
    request,
    workspace: await getExcuseWorkspace(access),
  };
}

async function fetchRequestById(requestId: string) {
  const { data, error } = await getSupabaseAdmin()
    .from("v2_excuse_requests")
    .select(excuseColumnsWithEmail)
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
  if (input.decision === "return") {
    throw new Error("Returning an excuse request requires a reply. Open Action Center to return it with a manager reply.");
  }

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
  // The emailed approve/reject link carries no session, so the role check cannot come from an
  // AccessContext — resolve the assigned manager's access role directly. Requests are no longer
  // created for an excluded manager, but a link minted before this rule shipped is still live for
  // up to 14 days, and that link must not be a way around the block.
  if (await hrIdHoldsExcuseExcludedRole(requestRow.manager_hr_id)) {
    throw new Error("Forbidden: District and Regional Managers cannot decide excuse requests.");
  }

  const status = decisionToStatus(input.decision);
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
    .eq("status", "pending_manager")
    .select(excuseColumnsWithEmail)
    .maybeSingle();

  if (updateError) throw updateError;
  if (!updated) throw conflictError("This excuse request has already been decided.");

  await getSupabaseAdmin()
    .from("v2_excuse_email_tokens")
    .update({ used_at: now })
    .eq("request_id", input.requestId)
    .eq("token_hash", tokenHash);

  const request = mapExcuseRequestRow(updated as ExcuseRequestRow);
  const directory = await getEmployeeDirectory();
  await notifyDecisionRecipients({
    directory,
    request: {
      ...request,
      employeeWorkEmail: (updated as { employee_work_email?: string | null }).employee_work_email,
    },
  });

  return request;
}

export async function getManagerPendingExcuses(access: AccessContext): Promise<EmployeeExcuseRequest[]> {
  const supabase = getSupabaseAdmin();
  // Excuse has no HR-acknowledge stage (single-step: direct manager decides only) — Super Admin
  // gets NO blanket bypass here, matching the confirmed model: he can only act where he's the
  // actual assigned manager, or at a genuine HR step (which doesn't exist for excuses). scope
  // "system" is reserved for background/system-actor calls, never a real user session.
  const isSystemActor = access.scope === "system";
  // District/Regional Managers hold no excuse authority at all (see EXCUSE_EXCLUDED_ROLES), so a
  // real session in either role has nothing actionable here even if a legacy row still names them.
  // This also empties their Action Center excuse cards and the excuse-approvals-pending nav badge.
  if (!isSystemActor && isExcuseExcludedRole(access.role)) return [];

  let query = supabase
    .from("v2_excuse_requests")
    .select(excuseColumns)
    .eq("status", "pending_manager")
    .order("created_at", { ascending: true });

  if (!isSystemActor) {
    const actorHrId = resolveEmployeeIdentityId(access);
    if (!actorHrId) return [];
    query = query.in("manager_hr_id", hrIdLookupKeys(actorHrId));
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
  // Same as getManagerPendingExcuses above — no Super Admin bypass; excuse has no HR step, so
  // authority is strictly "the assigned manager, and only the assigned manager."
  const isSystemActor = access.scope === "system";

  const requestRow = await fetchRequestById(input.requestId);
  if (!requestRow) throw new Error("Excuse request was not found.");
  if (requestRow.status !== "pending_manager") {
    throw new Error("This excuse request has already been decided.");
  }

  if (!isSystemActor) {
    if (isExcuseExcludedRole(access.role)) {
      throw new Error("Forbidden: District and Regional Managers cannot decide excuse requests.");
    }
    if (!actorHrId) throw new Error("Your employee profile is not linked. Contact HR.");
    if (normalizeHrId(actorHrId) !== normalizeHrId(requestRow.manager_hr_id)) {
      throw new Error("You are not the assigned manager for this excuse request.");
    }
  }

  const comment = typeof input.comment === "string" ? input.comment.trim() || null : null;
  if (input.decision === "return" && !comment) {
    throw new Error("A manager reply is required when returning an excuse request to the employee.");
  }

  const deciderHrId = actorHrId ?? requestRow.manager_hr_id;
  const directory = await getEmployeeDirectory();
  const storedDeciderHrId = resolveStoredHrId(deciderHrId, employeeRowByHrId(directory)) ?? deciderHrId;
  const status = decisionToStatus(input.decision);
  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await getSupabaseAdmin()
    .from("v2_excuse_requests")
    .update({
      manager_decision: status,
      manager_decision_at: now,
      manager_decision_by_hr_id: storedDeciderHrId,
      manager_decision_comment: comment,
      status,
      updated_at: now,
    })
    .eq("id", input.requestId)
    .eq("status", "pending_manager")
    .select(excuseColumnsWithEmail)
    .maybeSingle();

  if (updateError) throw updateError;
  if (!updated) throw conflictError("This excuse request has already been decided.");

  const request = mapExcuseRequestRow(updated as ExcuseRequestRow);
  await writeAuditLog({
    actorLoginId: access.loginId ?? storedDeciderHrId ?? "system",
    entityId: request.id,
    entityType: excuseAuditEntityType,
    oldValues: {
      managerDecision: requestRow.manager_decision ?? null,
      managerDecisionAt: requestRow.manager_decision_at,
      managerDecisionComment: requestRow.manager_decision_comment,
      status: requestRow.status,
    },
    newValues: {
      managerDecision: status,
      managerDecisionAt: now,
      managerDecisionByHrId: storedDeciderHrId,
      managerDecisionComment: comment,
      status,
    },
    summary: `Excuse request ${statusLabel(status)} by direct manager`,
  });

  await notifyDecisionRecipients({
    directory,
    request: {
      ...request,
      employeeWorkEmail: (updated as { employee_work_email?: string | null }).employee_work_email,
    },
  });

  return request;
}

// Active-status check mirroring the D4 drift semantics (employment_status IN active/on_leave;
// empty is treated as active). Kept local since excuses/service has no other active-check helper.
function isActiveExcuseManager(employee: EmployeeDirectoryRow) {
  const status = cleanText(employee.employmentStatus)?.toLowerCase() ?? "";
  return status === "" || status === "active" || status === "on_leave";
}

// HR/Super-Admin (or a system actor) re-routes a stuck excuse to a new active manager when the
// assigned manager resigned before deciding. This is REASSIGNMENT, not deciding-in-place: it only
// changes WHO the assigned manager is (manager_hr_id/manager_name/manager_work_email); it never
// sets manager_decision or status. The new manager must still be the literal assigned manager to
// decide (decideExcuseRequestAsManager is unchanged). Excuse has NO permission-matrix entry and NO
// HR-acknowledge stage, so the narrowest possible new grant is system-actor OR Super Admin — this
// deliberately does NOT let Super Admin decide an excuse in a manager's place (owner-locked model).
export async function reassignExcuseManager(
  access: AccessContext,
  input: { requestId: string; newManagerHrId: string },
): Promise<EmployeeExcuseRequest> {
  if (!(access.scope === "system" || access.role === "Super Admin")) {
    throw new Error("Forbidden: only Super Admin can reassign a stuck excuse approver.");
  }

  const newManagerHrId = cleanText(input.newManagerHrId);
  if (!newManagerHrId) {
    throw new Error("A new manager is required.");
  }

  const requestRow = await fetchRequestById(input.requestId);
  if (!requestRow) throw new Error("Excuse request was not found.");
  if (requestRow.status !== "pending_manager") {
    throw new Error("This excuse request has already been decided.");
  }

  const directory = await getEmployeeDirectory();
  const byHrId = employeeRowByHrId(directory);
  const newManager = findEmployeeByHrId(directory, newManagerHrId);
  if (!newManager) {
    throw new Error("The selected manager is not available in the employee directory.");
  }
  if (!isActiveExcuseManager(newManager)) {
    throw new Error("The selected manager is not active. Choose an active manager to receive this request.");
  }
  if (!cleanText(newManager.workEmail)) {
    throw new Error("The selected manager has no work email on record. Choose a manager with a work email.");
  }

  const storedManagerHrId = resolveStoredHrId(newManager.hrId, byHrId) ?? newManager.hrId;
  const previousManagerHrId = requestRow.manager_hr_id;
  const previousManagerName = requestRow.manager_name;
  const now = new Date().toISOString();

  const { data: updated, error: updateError } = await getSupabaseAdmin()
    .from("v2_excuse_requests")
    .update({
      manager_hr_id: storedManagerHrId,
      manager_name: newManager.fullName,
      manager_work_email: newManager.workEmail,
      updated_at: now,
    })
    .eq("id", input.requestId)
    .eq("status", "pending_manager")
    .select(excuseColumnsWithEmail)
    .maybeSingle();

  if (updateError) throw updateError;
  if (!updated) throw conflictError("This excuse request has already been decided.");

  const request = mapExcuseRequestRow(updated as ExcuseRequestRow);
  await writeAuditLog({
    actorLoginId: access.loginId ?? resolveEmployeeIdentityId(access) ?? "system",
    entityId: request.id,
    entityType: excuseAuditEntityType,
    oldValues: { managerHrId: previousManagerHrId, managerName: previousManagerName, status: requestRow.status },
    newValues: { managerHrId: storedManagerHrId, managerName: newManager.fullName, status: request.status },
    summary: `Excuse request approver reassigned from ${previousManagerHrId ?? "unassigned"} to ${storedManagerHrId}`,
  });

  // Retarget the standard manager-stage alert to the newly-assigned manager. A fresh
  // occurrenceKey keeps the notification idempotency key distinct from the original submission.
  const employee = findEmployeeByHrId(directory, request.employeeHrId);
  if (employee) {
    await notifyManagerOfExcuse({
      directory,
      employee,
      manager: newManager,
      occurrenceKey: now,
      request,
      type: "submitted",
    });
  }

  return request;
}

export async function resubmitExcuseRequest(
  access: AccessContext,
  input: { excuseDate?: unknown; excuseType?: unknown; requestId: string },
) {
  const { directory, employee } = await loadEligibleEmployee(access);
  const byHrId = employeeRowByHrId(directory);
  const employeeHrId = resolveStoredHrId(employee.hrId, byHrId) ?? employee.hrId;
  const requestRow = await fetchRequestById(input.requestId);
  if (!requestRow) throw new Error("Excuse request was not found.");
  if (normalizeHrId(requestRow.employee_hr_id) !== normalizeHrId(employeeHrId)) {
    throw new Error("Forbidden: you can only resubmit your own excuse request.");
  }
  if (requestRow.status !== "returned_to_employee") {
    throw new Error("Only returned excuse requests can be resubmitted.");
  }

  const excuseDate = input.excuseDate === undefined || input.excuseDate === null || input.excuseDate === ""
    ? requestRow.excuse_date
    : validateDateOnly(input.excuseDate);
  const excuseType = input.excuseType === undefined || input.excuseType === null || input.excuseType === ""
    ? requestRow.excuse_type
    : parseExcuseType(input.excuseType);
  if (!excuseType) throw new Error("Excuse type must be morning or afternoon.");

  const manager = findEmployeeByHrId(directory, requestRow.manager_hr_id ?? employee.managerHrId);
  if (!manager) {
    throw new Error("Direct manager is not linked for this employee. Please contact HR.");
  }
  if (!cleanText(manager.workEmail)) {
    throw new Error("Direct manager work email is missing. Please contact HR.");
  }
  const managerHrId = resolveStoredHrId(manager.hrId, byHrId) ?? manager.hrId;
  // Same up-front refusal as createExcuseRequest: never re-route a returned request back to a
  // manager who is no longer allowed to decide it.
  if (await hrIdHoldsExcuseExcludedRole(managerHrId)) {
    throw new Error("Your direct manager cannot decide excuse requests. Please contact HR.");
  }

  const existingRequests = (await fetchEmployeeExcuseRequests(employeeHrId)).filter((request) => request.id !== input.requestId);
  const targetMonth = requestMonthKey(excuseDate);
  const monthly = computeMonthlySummary(existingRequests, targetMonth);
  if (monthly.remaining <= 0) {
    throw new Error(`Monthly excuse limit reached for ${targetMonth}.`);
  }

  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await getSupabaseAdmin()
    .from("v2_excuse_requests")
    .update({
      employee_hr_id: employeeHrId,
      excuse_date: excuseDate,
      excuse_type: excuseType,
      manager_hr_id: managerHrId,
      manager_name: manager.fullName,
      manager_work_email: manager.workEmail,
      manager_decision: null,
      manager_decision_at: null,
      manager_decision_by_hr_id: null,
      manager_decision_comment: null,
      status: "pending_manager",
      updated_at: now,
    })
    .eq("id", input.requestId)
    .eq("status", "returned_to_employee")
    .select(excuseColumnsWithEmail)
    .maybeSingle();

  if (updateError) throw updateError;
  if (!updated) throw conflictError("Only returned excuse requests can be resubmitted.");

  const request = mapExcuseRequestRow(updated as ExcuseRequestRow);
  await writeAuditLog({
    actorLoginId: access.loginId ?? employeeHrId,
    entityId: request.id,
    entityType: excuseAuditEntityType,
    oldValues: {
      excuseDate: requestRow.excuse_date,
      excuseType: requestRow.excuse_type,
      managerDecision: requestRow.manager_decision ?? null,
      managerDecisionAt: requestRow.manager_decision_at,
      managerDecisionByHrId: requestRow.manager_decision_by_hr_id ?? null,
      managerDecisionComment: requestRow.manager_decision_comment,
      status: requestRow.status,
    },
    newValues: {
      excuseDate,
      excuseType,
      managerDecision: null,
      managerDecisionAt: null,
      managerDecisionByHrId: null,
      managerDecisionComment: null,
      status: "pending_manager",
    },
    summary: "Returned excuse request resubmitted to direct manager",
  });

  await notifyManagerOfExcuse({
    directory,
    employee,
    manager,
    occurrenceKey: now,
    request,
    type: "resubmitted",
  });

  return {
    request,
    workspace: await getExcuseWorkspace(access),
  };
}

export async function getExcuseRequestForActionCenterDeepLink(
  access: AccessContext,
  requestId: string,
): Promise<{ canAct: boolean; request: EmployeeExcuseRequest } | null> {
  const requestRow = await fetchRequestById(requestId);
  if (!requestRow) return null;

  const directory = await getEmployeeDirectory();
  const actorHrId = resolveEmployeeIdentityId(access) ?? access.hrId ?? null;
  const isAssignedManager = normalizeHrId(actorHrId) === normalizeHrId(requestRow.manager_hr_id);
  const isEmployeeOwner = normalizeHrId(actorHrId) === normalizeHrId(requestRow.employee_hr_id);
  const canSee = isAssignedManager || isEmployeeOwner || access.scope === "system" || isHrVisibilityActor(directory, access);
  if (!canSee) return null;

  return {
    canAct: (isAssignedManager || access.scope === "system") && requestRow.status === "pending_manager",
    request: mapExcuseRequestRow(requestRow),
  };
}

export function isExcusesSchemaMissing(error: unknown) {
  return isExcusesSchemaMissingMessage(error);
}

export async function runExcuseSlaDaily(): Promise<{ processed: number; errors: number }> {
  const today = new Date().toISOString().slice(0, 10);
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("v2_excuse_requests")
    .select("id, employee_hr_id, employee_name, excuse_date, excuse_type, created_at, manager_hr_id")
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
        channels: ["in_app", "email", "telegram", "push"],
        eventType: "excuse_sla_reminder",
        message: `${String(row.employee_name)}'s ${String(row.excuse_type)} excuse for ${String(row.excuse_date)} has been pending ${ageDays} day${ageDays === 1 ? "" : "s"}.`,
        metadata: { idempotencyKey: `excuse:${String(row.id)}:sla:${String(row.manager_hr_id)}:${today}` },
        module: "excuse",
        priority: "normal",
        recipientHrId: String(row.manager_hr_id),
        // The excuse belongs to the EMPLOYEE, not to the manager who has to approve it. Module
        // "excuse" is an employee-subject workflow module, so without a subject the email half
        // is refused outright — 27 rows between 2026-08-08 and 2026-09-06, zero sent — while the
        // in-app copy still reached the manager, which is what kept the gap invisible.
        subjectHrId: String(row.employee_hr_id),
        title: "Excuse approval overdue",
        actionUrl: `/admin/approvals/excuse/${encodeURIComponent(String(row.id))}`,
        email: {
          ctaHref: `/admin/approvals/excuse/${encodeURIComponent(String(row.id))}`,
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
