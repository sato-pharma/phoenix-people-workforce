import { NextResponse } from "next/server";

import {
  canAccess,
  normalizeHrId,
  type AccessContext,
} from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  buildVacationDecisionEmailHtml,
  buildVacationDecisionEmailText,
  buildVacationManagerApprovalEmailHtml,
  buildVacationManagerApprovalEmailText,
  type VacationWorkflowDecision,
  type VacationWorkflowRequest,
} from "@/emails/vacation-workflow";
import {
  createVacationRequestRecord,
  deriveWorkflowStatus,
  mapWorkflowStatusToDb,
  parseVacationRequest,
  type VacationDayType,
  type LeaveWorkflowActor,
  type VacationRequestRecord,
  type VacationRequestType,
  vacationDayTypeOptions,
  vacationRequestTypeForSubmission,
} from "@/lib/leave/requests";
import { recordLeaveRequestEvent, createLeaveNotificationAttempt, updateLeaveNotificationAttempt } from "@/lib/leave/audit";
import { getWorkflowStatusLabel, resolveAllowedActions as resolveWorkflowActionsForActor, transitionLeaveRequest } from "@/lib/leave/workflow";
import { resolveLeaveRequestPersistencePayload } from "@/lib/leave/request-persistence";
import { sendPhoenixEmail } from "@/lib/email/send-phoenix-email";
import { enqueueInAppNotification } from "@/lib/notifications/in-app";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const workflowNotificationPrefix = "Vacation Request Workflow";
const vacationReportPath = "/vacation-report";
const employeeVacationReportPath = "/employee-portals/vacation-report";

type VacationWorkflowAction = "submit" | "decide";

type RawPayload = {
  action?: unknown;
  decision?: unknown;
  overrideReason?: unknown;
  request?: unknown;
  requestId?: unknown;
};

type LeaveRequestPersistedInput = VacationWorkflowRequest & {
  managerOfManagerHrId?: string | null;
};

type LeaveRequestDbRow = {
  approval_status_date?: unknown;
  approved_or_rejected_at?: unknown;
  approved_or_rejected_by?: unknown;
  available_balance_at_submission?: unknown;
  created_at?: unknown;
  current_annual_entitlement_at_submission?: unknown;
  day_type?: unknown;
  direct_manager?: unknown;
  direct_manager_email?: unknown;
  direct_manager_hr_id?: unknown;
  duration_days?: unknown;
  employee_area?: unknown;
  employee_email?: unknown;
  employee_hire_date?: unknown;
  employee_hr_id?: unknown;
  employee_id?: unknown;
  employee_line?: unknown;
  employee_name?: unknown;
  employee_team?: unknown;
  first_year_entitlement_at_submission?: unknown;
  half_day_impact?: unknown;
  id?: unknown;
  manager_of_manager_hr_id?: unknown;
  paid_status?: unknown;
  pending_leave_impact_at_submission?: unknown;
  request_type?: unknown;
  reason?: unknown;
  rejection_reason?: unknown;
  start_date?: unknown;
  end_date?: unknown;
  status?: unknown;
  team?: unknown;
  total_days?: unknown;
  total_entitled_balance_at_submission?: unknown;
  unpaid_leave_days_at_submission?: unknown;
  updated_at?: unknown;
  used_paid_leave_at_submission?: unknown;
  remaining_paid_balance_at_submission?: unknown;
  vacation_type?: unknown;
  idempotency_key?: unknown;
  manager_status?: unknown;
  hr_status?: unknown;
  payroll_status?: unknown;
  payment_status?: unknown;
  manager_decision_at?: unknown;
  hr_decision_at?: unknown;
  requested_at?: unknown;
};

type EmployeeDirectoryRow = {
  full_name: string | null;
  hire_date: string | null;
  hr_id: string | null;
  manager_hr_id: string | null;
  area_id: number | null;
  line_id: number | null;
  team_id: number | null;
  area_name: string | null;
  line_name: string | null;
  team_name: string | null;
  areas?: {
    name?: unknown;
  } | null;
  lines?: {
    name?: unknown;
  } | null;
  teams?: {
    name?: unknown;
  } | null;
  area?: unknown;
  line?: unknown;
  team?: unknown;
  work_email: string | null;
};

type AppAuthUserRow = {
  hr_id: string | null;
  login_id: string;
  line?: string | null;
  name: string | null;
};

type AuthenticatedEmployee = {
  employeeEmail: string;
  employeeHireDate: string;
  employeeHrId: string;
  employeeName: string;
  directManagerHrId: string | null;
  employeeArea: string;
  employeeLine: string;
  employeeTeam: string;
  profileComplete: boolean;
};

type VacationSubmitInput = {
  dayType: VacationDayType;
  requestType: VacationRequestType;
  reason: string;
  startDate: string;
  endDate: string;
};

type VacationDecisionInput = {
  decision: VacationWorkflowDecision;
  overrideReason?: string;
  reason: string;
  requestId: string;
};

type EmailDeliveryResult = {
  recipients: string[];
  sent: boolean;
  skipped?: boolean;
  error?: string;
};

type InAppDeliveryResult = {
  recipient: string;
  sent: boolean;
  error?: string;
};

type NotificationRecipients = {
  actorIds: string[];
  hrEmails: string[];
  requestStatus?: string;
};

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanDate(value: unknown) {
  const text = cleanString(value);
  if (!text) return "";
  const parsed = new Date(`${text}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? "" : text;
}

function toNumber(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function resolveLookupNameById(input: { table: "areas" | "lines" | "teams"; id: number | null }) {
  const { table, id } = input;
  if (id === null) {
    return "";
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(table)
    .select("name")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    return "";
  }

  return cleanString((data as { name?: unknown } | null)?.name);
}

function cleanDecimal(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function isAllowedVacationRequestType(value: unknown) {
  const candidate = cleanString(value);
  return (vacationRequestTypeForSubmission as readonly string[]).includes(candidate)
    ? (candidate as VacationRequestType)
    : "Annual Leave";
}

function isAllowedDayType(value: unknown) {
  const candidate = cleanString(value);
  return vacationDayTypeOptions.includes(candidate as VacationDayType)
    ? (candidate as VacationDayType)
    : "Full Day";
}

function isAllowedDecision(value: unknown) {
  const candidate = cleanString(value);
  return candidate === "approve" || candidate === "reject"
    ? (candidate as VacationWorkflowDecision)
    : null;
}

function toDecimal(value: unknown) {
  return cleanDecimal(value);
}

function toStringOrNull(value: unknown) {
  const text = cleanString(value);
  return text.length > 0 ? text : null;
}

function parseSubmitPayload(raw: unknown) {
  if (!raw || typeof raw !== "object") return null;
  const request = (raw as Record<string, unknown>).request;
  const source = request && typeof request === "object"
    ? request as Record<string, unknown>
    : raw as Record<string, unknown>;

  const requestType = isAllowedVacationRequestType(
    source.requestType ?? source.request_type ?? source.vacationType ?? source.vacation_type,
  );
  const dayType = isAllowedDayType(source.dayType ?? source.day_type);
  const startDate = cleanDate(source.startDate ?? source.start_date);
  const endDate = cleanDate(source.endDate ?? source.end_date);
  const reason = cleanString(source.reason ?? source.comment ?? source.note ?? source.notes);

  if (!requestType || !startDate || !endDate) {
    return null;
  }

  return { dayType, requestType, reason, startDate, endDate } as VacationSubmitInput;
}

function parseDecisionPayload(raw: unknown) {
  if (!raw || typeof raw !== "object") return null;
  const request = (raw as Record<string, unknown>).request;
  const base = request && typeof request === "object"
    ? request as Record<string, unknown>
    : raw as Record<string, unknown>;

  const requestId = cleanString(base.id ?? base.requestId ?? base.request_id);
  const decision = isAllowedDecision(base.decision);
  const reason = cleanString(base.rejectionReason ?? base.rejection_reason ?? base.reason);
  const overrideReason = cleanString(base.overrideReason ?? base.override_reason);

  if (!requestId || !decision) return null;
  return { decision, overrideReason, reason, requestId } as VacationDecisionInput;
}

function buildRequestSnapshot(input: {
  actor: AuthenticatedEmployee;
  directManager: EmployeeDirectoryRow | null;
  managerManager: EmployeeDirectoryRow | null;
  submission: VacationSubmitInput;
  existingRecords: VacationRequestRecord[];
}) {
  const calculated = createVacationRequestRecord({
    employeeEmail: input.actor.employeeEmail,
    employeeId: input.actor.employeeHrId,
    employeeHireDate: input.actor.employeeHireDate,
    employeeName: input.actor.employeeName,
    reason: input.submission.reason,
    requestType: input.submission.requestType,
    dayType: input.submission.dayType,
    startDate: input.submission.startDate,
    endDate: input.submission.endDate,
    existingRecords: input.existingRecords,
  });

  return {
    ...calculated,
    employeeId: input.actor.employeeHrId,
    employeeName: input.actor.employeeName,
    employeeEmail: input.actor.employeeEmail,
    employeeArea: input.actor.employeeArea,
    employeeLine: input.actor.employeeLine,
    employeeTeam: input.actor.employeeTeam,
    team: input.actor.employeeTeam,
    employeeHireDate: input.actor.employeeHireDate,
    directManager: input.directManager?.full_name ?? "",
    directManagerEmail: input.directManager?.work_email?.toLowerCase() ?? "",
    directManagerHrId: input.actor.directManagerHrId ?? "",
    managerOfManagerHrId: input.managerManager?.hr_id ?? null,
    workflowStatus: input.directManager?.hr_id ? "awaiting_manager" : "needs_routing",
    workflowSnapshot: {
      ...calculated.workflowSnapshot,
      hrStatus: "pending",
      managerStatus: input.directManager?.hr_id ? "pending" : "not_required",
      payrollStatus: "not_required",
      requestedAt: calculated.createdAt,
      requestedAtIso: calculated.createdAt,
    },
  } satisfies LeaveRequestPersistedInput;
}

function isInvalidHalfDayRange(input: VacationSubmitInput) {
  return input.dayType !== "Full Day" && input.startDate !== input.endDate;
}

function pickRelationName(value: unknown) {
  if (Array.isArray(value)) {
    const first = value[0];
    if (!first || typeof first !== "object") return "";
    return cleanString(first["name"]);
  }
  if (!value || typeof value !== "object") return "";
  return cleanString((value as { name?: unknown }).name);
}

async function enrichEmployeeDirectoryRow(row: EmployeeDirectoryRow) {
  const [areaNameFromId, lineNameFromId, teamNameFromId] = await Promise.all([
    resolveLookupNameById({ id: toNumber(row.area_id), table: "areas" }),
    resolveLookupNameById({ id: toNumber(row.line_id), table: "lines" }),
    resolveLookupNameById({ id: toNumber(row.team_id), table: "teams" }),
  ]);

  return {
    ...row,
    area_name: row.area_name || areaNameFromId || null,
    line_name: row.line_name || lineNameFromId || null,
    team_name: row.team_name || teamNameFromId || null,
  } as EmployeeDirectoryRow;
}

const leaveRequestsTable = "leave_requests";
const pendingWorkflowStatuses = ["pending_manager", "pending_hr", "Pending", "draft"] as const;
const leaveRequestsMigrationHint =
  "Leave requests schema is not ready. Apply the active Supabase baseline migration at supabase/migrations/20260517000000_remote_app_baseline.sql.";

function isLeaveRequestStorageIssue(error: { code?: string; message?: string; details?: string } | null) {
  if (!error) return false;
  const message = `${error.message ?? ""} ${error.details ?? ""}`.toLowerCase();
  const code = (error.code ?? "").toUpperCase();
  return code === "42P01" || code === "PGRST205" || message.includes("leave_requests");
}

function sanitizeDbPayload(payload: Record<string, unknown>) {
  const next = { ...payload };
  Object.keys(next).forEach((key) => {
    if (next[key] === undefined) {
      delete next[key];
    }
  });
  return next;
}

function mapDbRowToVacationRequest(row: LeaveRequestDbRow): VacationWorkflowRequest | null {
  return parseVacationRequest({
    approvalStatusDate: cleanString(row.approval_status_date ?? row.approved_or_rejected_at),
    approvedOrRejectedBy: row.approved_or_rejected_by,
    availableBalanceAtSubmission: row.available_balance_at_submission,
    currentAnnualEntitlementAtSubmission: row.current_annual_entitlement_at_submission,
    createdAt: cleanString(row.created_at),
    dayType: row.day_type,
    durationDays: row.duration_days,
    employeeArea: row.employee_area,
    employeeEmail: row.employee_email,
    employeeHireDate: row.employee_hire_date,
    employeeId: row.employee_hr_id ?? row.employee_id,
    employeeKey: "",
    employeeName: row.employee_name,
    employeeTeam: row.employee_team,
    endDate: row.end_date,
    halfDayImpact: row.half_day_impact,
    id: row.id,
    paymentStatus: row.paid_status,
    pendingLeaveImpactAtSubmission: row.pending_leave_impact_at_submission,
    reason: row.reason,
    requestType: row.request_type ?? row.vacation_type,
    startDate: row.start_date,
    status: row.status,
    hr_status: row.hr_status,
    manager_status: row.manager_status,
    payment_status: row.payment_status,
    payroll_status: row.payroll_status,
    manager_decision_at: row.manager_decision_at,
    hr_decision_at: row.hr_decision_at,
    requested_at: row.requested_at,
    totalDays: row.total_days,
    totalEntitledBalanceAtSubmission: row.total_entitled_balance_at_submission,
    unpaidLeaveDaysAtSubmission: row.unpaid_leave_days_at_submission,
    usedPaidLeaveAtSubmission: row.used_paid_leave_at_submission,
    remainingPaidBalanceAtSubmission: row.remaining_paid_balance_at_submission,
    firstYearEntitlementAtSubmission: row.first_year_entitlement_at_submission,
    directManager: row.direct_manager,
    directManagerEmail: row.direct_manager_email,
    directManagerHrId: row.direct_manager_hr_id,
    rejectionReason: row.rejection_reason,
    team: row.team,
  });
}

function normalizeDbRecord(input: LeaveRequestPersistedInput, now = new Date().toISOString()) {
  const workflowStatus = input.workflowStatus || deriveWorkflowStatus({
    directManagerMissing: !input.directManagerHrId,
    hrStatus: input.workflowSnapshot?.hrStatus,
    managerStatus: input.workflowSnapshot?.managerStatus,
    payrollStatus: input.workflowSnapshot?.payrollStatus,
    status: "pending_manager",
  });
  return {
    id: input.id,
    employee_email: input.employeeEmail.toLowerCase(),
    employee_hire_date: input.employeeHireDate,
    employee_hr_id: toStringOrNull(input.employeeId),
    employee_name: input.employeeName,
    reason: input.reason,
    request_type: input.requestType,
    vacation_type: input.requestType,
    day_type: input.dayType,
    start_date: input.startDate,
    end_date: input.endDate,
    duration_days: toDecimal(input.durationDays),
    half_day_impact: toDecimal(input.halfDayImpact),
    total_days: toDecimal(input.totalDays),
    paid_status: input.paymentStatus,
    available_balance_at_submission: toDecimal(input.availableBalanceAtSubmission),
    first_year_entitlement_at_submission: toDecimal(input.firstYearEntitlementAtSubmission),
    current_annual_entitlement_at_submission: toDecimal(input.currentAnnualEntitlementAtSubmission),
    used_paid_leave_at_submission: toDecimal(input.usedPaidLeaveAtSubmission),
    remaining_paid_balance_at_submission: toDecimal(input.remainingPaidBalanceAtSubmission),
    unpaid_leave_days_at_submission: toDecimal(input.unpaidLeaveDaysAtSubmission),
    pending_leave_impact_at_submission: toDecimal(input.pendingLeaveImpactAtSubmission),
    total_entitled_balance_at_submission: toDecimal(input.totalEntitledBalanceAtSubmission),
    status: mapWorkflowStatusToDb(workflowStatus),
    rejection_reason: input.rejectionReason || "",
    direct_manager: input.directManager || "",
    direct_manager_email: input.directManagerEmail || "",
    direct_manager_hr_id: toStringOrNull(input.directManagerHrId),
    manager_of_manager_hr_id: toStringOrNull(input.managerOfManagerHrId),
    submitted_at: input.createdAt,
    requested_at: input.workflowSnapshot?.requestedAt || input.createdAt || now,
    manager_status: input.workflowSnapshot?.managerStatus || "pending",
    hr_status: input.workflowSnapshot?.hrStatus || "pending",
    payroll_status: input.workflowSnapshot?.payrollStatus || "not_required",
    employee_area: toStringOrNull(input.employeeArea),
    employee_line: toStringOrNull(input.employeeLine),
    employee_team: toStringOrNull(input.employeeTeam),
    created_at: input.createdAt || now,
    updated_at: now,
    team: toStringOrNull(input.team),
  };
}

function findLeaveRequestMissingColumn(error: { message?: string; details?: string }): string | null {
  const text = `${error.message ?? ""} ${error.details ?? ""}`.toLowerCase();
  const quoted = text.match(/could not find the '([^']+)' column of 'leave_requests'/i);
  if (quoted?.[1]) {
    return quoted[1];
  }

  const relMatch = text.match(/column "([^"]+)" of relation "leave_requests"/i);
  if (relMatch?.[1]) {
    return relMatch[1];
  }

  return null;
}

async function upsertLeaveRequestPayload(payload: Record<string, unknown>, supabase: ReturnType<typeof getSupabaseAdmin>) {
  const writePayload = sanitizeDbPayload(payload);
  const { error } = await supabase
    .from(leaveRequestsTable)
    .upsert(writePayload, { onConflict: "id" });

  if (!error) {
    return;
  }

  if (isLeaveRequestStorageIssue(error)) {
    throw new Error(leaveRequestsMigrationHint);
  }

  const missingColumn = findLeaveRequestMissingColumn(error);
  if (missingColumn) {
    throw new Error(`Leave request schema mismatch: missing required column "${missingColumn}".`);
  }

  throw new Error(error.message);
}

async function updateLeaveRequestPayload(
  payload: Record<string, unknown>,
  supabase: ReturnType<typeof getSupabaseAdmin>,
  requestId: string,
  expectedStatus?: string,
) {
  const writePayload = sanitizeDbPayload(payload);
  let query = supabase
    .from(leaveRequestsTable)
    .update(writePayload)
    .eq("id", requestId);

  query = expectedStatus ? query.eq("status", expectedStatus) : query.in("status", [...pendingWorkflowStatuses]);

  const { data, error } = await query.select("*").maybeSingle();

  if (!error) {
    return data as LeaveRequestDbRow | null;
  }

  if (isLeaveRequestStorageIssue(error)) {
    throw new Error(leaveRequestsMigrationHint);
  }

  const missingColumn = findLeaveRequestMissingColumn(error);
  if (missingColumn) {
    throw new Error(`Leave request schema mismatch: missing required column "${missingColumn}".`);
  }

  throw new Error(error.message);
}

async function loadLeaveRequestsFromDb(input?: {
  employeeHrId?: string | null;
  requestId?: string | null;
}) {
  const supabase = getSupabaseAdmin();
  let query = supabase
    .from(leaveRequestsTable)
    .select("*")
    .order("created_at", { ascending: false });

  if (input?.employeeHrId) {
    query = query.eq("employee_hr_id", cleanString(input.employeeHrId));
  }

  if (input?.requestId) {
    query = query.eq("id", cleanString(input.requestId));
  }

  const { data, error } = await query;
  if (error) {
    if (isLeaveRequestStorageIssue(error)) {
      throw new Error(leaveRequestsMigrationHint);
    }
    throw new Error(error.message);
  }

  return ((data ?? []) as Array<Record<string, unknown>>)
    .map((row) => mapDbRowToVacationRequest(row as LeaveRequestDbRow))
    .filter((request): request is VacationWorkflowRequest => request !== null);
}

async function upsertVacationRequest(input: LeaveRequestPersistedInput) {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const persistenceValues = await resolveLeaveRequestPersistencePayload({
    dayType: input.dayType,
    durationDays: input.durationDays,
    halfDayImpact: input.halfDayImpact,
    paymentStatus: input.paymentStatus,
    requestType: input.requestType,
    supabase,
    totalDays: input.totalDays,
  });
  const payload = {
    ...normalizeDbRecord(input, now),
    ...persistenceValues,
  } as Record<string, unknown>;

  await upsertLeaveRequestPayload(payload, supabase);

  return now;
}

async function setVacationRequestStatus(input: {
  approvalAt: string;
  actorHrId?: string | null;
  actorRole: LeaveWorkflowActor;
  decision: VacationWorkflowDecision;
  overrideReason?: string;
  request: VacationWorkflowRequest;
  approverName: string;
}): Promise<VacationWorkflowRequest> {
  const supabase = getSupabaseAdmin();
  const { decision, request, approvalAt, approverName } = input;
  const transition = transitionLeaveRequest({
    action: decision,
    actor: input.actorRole,
    currentStatus: request.workflowStatus,
    overrideReason: input.overrideReason,
    rejectionReason: request.rejectionReason,
  });

  const updates = {
    approved_or_rejected_at: approvalAt,
    approved_or_rejected_by: approverName,
    approval_status_date: approvalAt,
    rejection_reason: decision === "reject" ? request.rejectionReason : "",
    status: mapWorkflowStatusToDb(transition.nextStatus),
    manager_status: transition.managerStatus,
    hr_status: transition.hrStatus,
    payroll_status: transition.payrollStatus,
    manager_decision_at: input.actorRole === "manager" || request.workflowStatus === "awaiting_manager" ? approvalAt : request.workflowSnapshot.managerDecisionAt,
    hr_decision_at: input.actorRole === "hr" || request.workflowStatus === "awaiting_hr" ? approvalAt : request.workflowSnapshot.hrDecisionAt,
    updated_at: approvalAt,
  };

  const persisted = await updateLeaveRequestPayload(
    updates,
    supabase,
    request.id,
    String(request.status).trim().toLowerCase() === "approved" || String(request.status).trim().toLowerCase() === "rejected"
      ? mapWorkflowStatusToDb(request.workflowStatus)
      : String(request.workflowStatus) === "awaiting_manager"
        ? "pending_manager"
        : String(request.workflowStatus) === "awaiting_hr"
          ? "pending_hr"
          : String(request.workflowStatus) === "needs_routing"
            ? "needs_routing"
            : mapWorkflowStatusToDb(request.workflowStatus),
  );

  if (!persisted) {
    throw new Error("No pending request found to update.");
  }

  const updatedRequest = mapDbRowToVacationRequest(persisted);
  if (!updatedRequest) {
    throw new Error("Unable to parse updated request.");
  }

  await recordLeaveRequestEvent({
    actorHrId: input.actorHrId,
    actorRole: input.actorRole,
    eventType: transition.requiresAuditOverride ? "admin_override" : `decision_${decision}`,
    fromStatus: request.workflowStatus,
    overrideReason: input.overrideReason,
    reason: request.rejectionReason,
    requestId: request.id,
    snapshot: updates,
    toStatus: transition.nextStatus,
  });

  return updatedRequest;
}

async function fetchLeaveRequestById(requestId: string, employeeHrId?: string | null) {
  const records = await loadLeaveRequestsFromDb({
    requestId,
    employeeHrId,
  });
  return records[0] ?? null;
}

function buildDecisionRequest(input: {
  request: VacationWorkflowRequest;
  decision: VacationWorkflowDecision;
  approverName: string;
}) {
  const now = new Date().toISOString();

  return {
    ...input.request,
    approvalStatusDate: now,
    approvedOrRejectedBy: input.approverName,
    rejectionReason:
      input.decision === "reject" ? input.request.rejectionReason : "",
    status: input.decision === "approve" ? "Approved" : "Rejected",
  } satisfies VacationWorkflowRequest;
}

function parseEmails(value: string | undefined | null) {
  return String(value ?? "")
    .split(/[;,]/)
    .map((email) => email.trim())
    .filter(Boolean)
    .map((email) => email.toLowerCase());
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value)).map((value) => value.trim())));
}

function normalizeBaseUrl(incomingUrl: string) {
  const configured =
    process.env.NOTIFICATION_DASHBOARD_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    process.env.VERCEL_URL ||
    new URL(incomingUrl).origin;

  if (!configured) return new URL(incomingUrl).origin;
  if (/^https?:\/\//i.test(configured)) return configured.replace(/\/+$/, "");
  return `https://${configured.replace(/\/+$/, "")}`;
}

async function resolveEmployeeHrIdFromAppAuth(loginId: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("app_auth_users")
    .select("hr_id")
    .eq("login_id", loginId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return (data as { hr_id: string | null } | null)?.hr_id ?? null;
}

async function resolveEmployeeHrIdFromWorkEmail(loginId: string) {
  const supabase = getSupabaseAdmin();
  const loginText = cleanString(loginId);
  if (!loginText) return null;

  const { data, error } = await supabase
    .from("employees")
    .select("hr_id")
    .ilike("work_email", loginText)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return (data as { hr_id: string | null } | null)?.hr_id ?? null;
}

async function findEmployeeByHrId(inputHrId: string | null | undefined) {
  if (!inputHrId) return null;
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("employees")
    .select("full_name,hire_date,hr_id,manager_hr_id,work_email,area_id,line_id,team_id,area_name,line_name,team_name,areas(name),lines(name),teams(name)")
    .ilike("hr_id", cleanString(inputHrId))
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  const row = (data as EmployeeDirectoryRow | null) ?? null;
  if (!row) return null;
  return enrichEmployeeDirectoryRow(row);
}

async function resolveAuthUserLine(input: { loginId?: string | null; hrId?: string | null }) {
  const supabase = getSupabaseAdmin();

  if (input.loginId) {
    const { data } = await supabase
      .from("app_auth_users")
      .select("line")
      .ilike("login_id", cleanString(input.loginId))
      .maybeSingle();
    const line = cleanString((data as { line?: unknown } | null)?.line);
    if (line) {
      return line;
    }
  }

  if (input.hrId) {
    const { data } = await supabase
      .from("app_auth_users")
      .select("line")
      .ilike("hr_id", cleanString(input.hrId))
      .maybeSingle();
    return cleanString((data as { line?: unknown } | null)?.line);
  }

  return "";
}

async function resolveAuthenticatedEmployee(access: AccessContext): Promise<AuthenticatedEmployee | null> {
  if (!access) return null;

  let hrId = normalizeHrId(access.hrId);
  if (!hrId && access.loginId) {
    hrId = normalizeHrId(await resolveEmployeeHrIdFromAppAuth(access.loginId));
  }
  if (!hrId && access.loginId) {
    hrId = normalizeHrId(await resolveEmployeeHrIdFromWorkEmail(access.loginId));
  }

  if (!hrId) return null;

  const employee = await findEmployeeByHrId(hrId);
  const authLine = access.loginId || access.hrId ? await resolveAuthUserLine(access) : "";
  const displayName = cleanString(employee?.full_name) || access.loginId || hrId;
  const employeeArea = pickRelationName(employee?.areas) || pickRelationName(employee?.area) || cleanString(employee?.area_name);
  const employeeLine = pickRelationName(employee?.lines) || pickRelationName(employee?.line) || cleanString(employee?.line_name) || authLine;
  const employeeTeam = pickRelationName(employee?.teams) || pickRelationName(employee?.team) || cleanString(employee?.team_name);

  return {
    directManagerHrId: cleanString(employee?.manager_hr_id),
    employeeEmail: cleanString(employee?.work_email),
    employeeHireDate: cleanDate(employee?.hire_date),
    employeeHrId: hrId,
    employeeName: displayName,
    employeeArea,
    employeeLine,
    employeeTeam,
    profileComplete: Boolean(employee?.full_name && employee?.hire_date && employee?.work_email),
  };
}

async function resolveActorName(access: AccessContext) {
  const supabase = getSupabaseAdmin();
  if (access.loginId) {
    const { data } = await supabase
      .from("app_auth_users")
      .select("name")
      .eq("login_id", access.loginId)
      .maybeSingle();

    const row = data as AppAuthUserRow | null;
    if (row?.name) return row.name.trim();
  }

  if (access.hrId) {
    const employee = await findEmployeeByHrId(access.hrId);
    if (employee?.full_name) return employee.full_name;
  }

  return access.loginId ?? access.hrId ?? "System";
}

function buildNotificationRecipients(input: {
  directManager: EmployeeDirectoryRow | null;
  managerManager: EmployeeDirectoryRow | null;
}): NotificationRecipients {
  const directManagerEmail = input.directManager?.work_email?.toLowerCase() ?? "";
  const actorEmails = parseEmails(process.env.HR_NOTIFICATION_EMAILS);
  const actorIds = uniqueStrings([
    input.directManager?.hr_id,
    input.managerManager?.hr_id,
    ...parseEmails(process.env.HR_NOTIFICATION_EMAILS),
  ]);

  const hrEmails = actorEmails;

  return { actorIds, hrEmails };
}

async function sendNotificationEmail(input: {
  cc?: string[];
  html: string;
  idempotencyKey: string;
  request: VacationWorkflowRequest;
  stage: string;
  subject: string;
  text: string;
  to: string[];
}) {
  const from =
    process.env.VACATION_WORKFLOW_EMAIL_FROM ||
    process.env.NOTIFICATION_EMAIL_FROM ||
    "Phoenix Workforce <phoenix@mail.satopharma.com>";

  if (input.to.length === 0) {
    await createLeaveNotificationAttempt({
      channel: "email",
      errorText: "Recipient list is empty.",
      recipients: [],
      requestId: input.request.id,
      stage: input.stage,
      status: "skipped",
    });
    return {
      recipients: [],
      sent: false,
      skipped: true,
      error: "Recipient list is empty.",
    } as EmailDeliveryResult;
  }

  try {
    const attemptId = await createLeaveNotificationAttempt({
      channel: "email",
      recipients: input.to,
      requestId: input.request.id,
      stage: input.stage,
      status: "pending",
    });
    const result = await sendPhoenixEmail({
      bcc: undefined,
      cc: input.cc,
      from,
      html: input.html,
      idempotencyKey: input.idempotencyKey,
      subject: input.subject,
      text: input.text,
      to: input.to,
    });
    await updateLeaveNotificationAttempt({
      attemptId,
      errorText: result.skipped ? result.reason : null,
      metadata: { cc: input.cc ?? [], idempotencyKey: input.idempotencyKey, skipped: result.skipped },
      status: result.skipped ? "skipped" : "sent",
    });
    return {
      recipients: input.to,
      sent: !result.skipped,
      skipped: result.skipped,
      error: result.skipped ? result.reason : undefined,
    } as EmailDeliveryResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send workflow email.";
    await createLeaveNotificationAttempt({
      channel: "email",
      errorText: message,
      recipients: input.to,
      requestId: input.request.id,
      stage: input.stage,
      status: "failed",
    });
    return {
      error: message,
      recipients: input.to,
      sent: false,
      skipped: true,
    } as EmailDeliveryResult;
  }
}

async function sendInApp(input: {
  action: "manager-approval" | "manager-decision";
  recipientHrId: string | null;
  request: VacationWorkflowRequest;
}) {
  const dedupeKey = `vacation-workflow:${input.action}:${input.request.id}:${input.recipientHrId ?? "none"}`;

  if (!input.recipientHrId) {
    return { recipient: "UNKNOWN", sent: false, error: "recipient_id_missing" } as InAppDeliveryResult;
  }

  const result = await enqueueInAppNotification({
    category: "general",
    dedupeKey,
    href: "/vacation-report",
    message: `${input.request.employeeName} - ${input.request.totalDays} day(s) ${input.action === "manager-approval" ? "pending approval" : "status update"}`,
    recipientHrId: input.recipientHrId,
    title: `${workflowNotificationPrefix} - ${input.action}`,
  });

  return {
    recipient: input.recipientHrId,
    sent: !result.skipped,
    error: result.skipped ? result.reason : undefined,
  } as InAppDeliveryResult;
}

async function sendManagerApprovalNotification(input: {
  baseUrl: string;
  directManager: EmployeeDirectoryRow | null;
  request: VacationWorkflowRequest;
}) {
  const directManagerEmail = input.directManager?.work_email?.toLowerCase() ?? "";
  const directManagerName = input.directManager?.full_name || "Direct Manager";
  const html = buildVacationManagerApprovalEmailHtml({
    actorName: directManagerName,
    baseUrl: input.baseUrl,
    request: input.request,
    reportPath: vacationReportPath,
  });
  const text = buildVacationManagerApprovalEmailText({
    actorName: directManagerName,
    baseUrl: input.baseUrl,
    request: input.request,
    reportPath: vacationReportPath,
  });

  return sendNotificationEmail({
    cc: [],
    html,
    idempotencyKey: `${workflowNotificationPrefix}-submit-${input.request.id}`,
    request: input.request,
    stage: input.request.workflowStatus,
    subject: `Vacation Request Requires Approval - ${input.request.employeeName}`,
    text,
    to: directManagerEmail ? [directManagerEmail] : [],
  });
}

async function sendDecisionStatusNotification(input: {
  actorName?: string;
  baseUrl: string;
  decision: VacationWorkflowDecision;
  request: VacationWorkflowRequest;
  hrNotificationEmails: string[];
  managerManager: EmployeeDirectoryRow | null;
}) {
  const cc = uniqueStrings([...input.hrNotificationEmails, input.managerManager?.work_email ?? null]);
  const employeeEmail = input.request.employeeEmail?.toLowerCase() ?? "";
  const html = buildVacationDecisionEmailHtml({
    actorName: input.actorName,
    baseUrl: input.baseUrl,
    decision: input.decision,
    reportPath: employeeVacationReportPath,
    request: input.request,
  });
  const text = buildVacationDecisionEmailText({
    actorName: input.actorName,
    baseUrl: input.baseUrl,
    decision: input.decision,
    reportPath: employeeVacationReportPath,
    request: input.request,
  });

  return sendNotificationEmail({
    cc,
    html,
    idempotencyKey: `${workflowNotificationPrefix}-${input.decision}-${input.request.id}`,
    request: input.request,
    stage: input.request.workflowStatus,
    subject: `Vacation Request ${input.decision === "approve" ? "Approved" : "Rejected"} - ${input.request.employeeName}`,
    text,
    to: employeeEmail ? [employeeEmail] : [],
  });
}

async function notifySystemActors(request: VacationWorkflowRequest, actorIds: string[]) {
  const inApp = await Promise.all(
    actorIds.map((actorId) =>
      sendInApp({
        action: "manager-approval",
        recipientHrId: actorId,
        request,
      }).catch((error) => ({
        error: error instanceof Error ? error.message : "Unable to send notification.",
        recipient: actorId,
        sent: false,
      })),
    ),
  );

  return inApp;
}

async function notifySystemActorsForDecision(request: VacationWorkflowRequest, actorIds: string[]) {
  const inApp = await Promise.all(
    actorIds.map((actorId) =>
      sendInApp({
        action: "manager-decision",
        recipientHrId: actorId,
        request,
      }).catch((error) => ({
        error: error instanceof Error ? error.message : "Unable to send notification.",
        recipient: actorId,
        sent: false,
      })),
    ),
  );

  return inApp;
}

function deriveWarnings(results: { sent: boolean; error?: string }[]) {
  return results
    .filter((result) => !result.sent && result.error)
    .map((result) => result.error)
    .filter((warning): warning is string => Boolean(warning));
}

function addWarning(list: string[], value: string | undefined | null) {
  const next = cleanString(value);
  if (!next) return;
  list.push(next);
}

function isDateRangeInvalid(input: VacationSubmitInput) {
  const start = cleanDate(input.startDate);
  const end = cleanDate(input.endDate);
  if (!start || !end) return true;
  return new Date(start).getTime() > new Date(end).getTime();
}

function getRequestError(response: VacationSubmitInput | VacationDecisionInput | null, action: VacationWorkflowAction) {
  if (action === "submit" && !response) {
    return "Invalid submit request payload.";
  }

  if (action === "decide" && !response) {
    return "Invalid decision payload.";
  }

  return null;
}

function shouldReturnForbidden(error: unknown) {
  return (
    isForbiddenError(error) ||
    typeof error === "string" &&
    error.toLowerCase().startsWith("forbidden")
  );
}

function shouldExposeError(errorMessage: string) {
  const normalized = errorMessage.toLowerCase();
  return (
    normalized.includes("leave requests schema is not ready")
    || normalized.includes("leave type")
    || normalized.includes("active default leave policy")
    || normalized.includes("leave request schema mismatch")
    || normalized.includes("unable to resolve")
  );
}

function decorateRequestForActor(request: VacationWorkflowRequest, actor: LeaveWorkflowActor) {
  return {
    ...request,
    allowedActions: resolveWorkflowActionsForActor({
      actor,
      request,
    }),
  } satisfies VacationWorkflowRequest;
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const canViewAll = await canAccess(access, "admin", "read");
    const actor = canViewAll ? null : await resolveAuthenticatedEmployee(access);
    const viewerRole: LeaveWorkflowActor = canViewAll ? "admin" : access.role === "HR Specialist" ? "hr" : "manager";
    const requestedEmployeeId = canViewAll ? null : actor?.employeeHrId ?? null;
    if (!canViewAll && !requestedEmployeeId) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const requestId = cleanString(new URL(request.url).searchParams.get("requestId"));
    const requests = await loadLeaveRequestsFromDb({
      employeeHrId: requestedEmployeeId,
      requestId: requestId || null,
    });

    return NextResponse.json({ requests: requests.map((item) => decorateRequestForActor(item, viewerRole)) });
  } catch (error) {
    if (shouldReturnForbidden(error)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to load vacation requests." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) {
      return NextResponse.json({ success: false, error: "Unauthorized." }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as RawPayload;
    const action = cleanString(body.action) as VacationWorkflowAction;
    const baseUrl = normalizeBaseUrl(request.url);
    const canAccessAdminData = await canAccess(access, "admin", "read");
    const canApprove = await canAccess(access, "admin", "approve");

    if (!["submit", "decide"].includes(action)) {
      return NextResponse.json({ success: false, error: "Invalid workflow action." }, { status: 400 });
    }

    if (action === "submit") {
      const payload = parseSubmitPayload(body);
      const invalid = getRequestError(payload, action);
      if (invalid) {
        return NextResponse.json({ success: false, error: invalid }, { status: 400 });
      }

      if (!payload) {
        return NextResponse.json({ success: false, error: "Invalid submit request payload." }, { status: 400 });
      }

      if (isDateRangeInvalid(payload)) {
        return NextResponse.json(
          { success: false, error: "Start date must be earlier than or equal to end date." },
          { status: 400 },
        );
      }

      if (isInvalidHalfDayRange(payload)) {
        return NextResponse.json(
          { success: false, error: "AM/PM requests must have the same start and end date." },
          { status: 400 },
        );
      }

      const actor = await resolveAuthenticatedEmployee(access);
      if (!actor) {
        return NextResponse.json(
          { success: false, error: "Forbidden: employee profile not found." },
          { status: 403 },
        );
      }
      if (!actor.profileComplete) {
        return NextResponse.json(
          { success: false, error: "Your employee profile is incomplete. Contact HR to link your profile data." },
          { status: 409 },
        );
      }

      const existingRecords = await loadLeaveRequestsFromDb({ employeeHrId: actor.employeeHrId });
      const directManager = await findEmployeeByHrId(actor.directManagerHrId);
      const managerManager = await findEmployeeByHrId(directManager?.manager_hr_id ?? null);

      const requestSnapshot = buildRequestSnapshot({
        actor,
        directManager,
        existingRecords,
        managerManager,
        submission: payload,
      });

      if (requestSnapshot.durationDays <= 0) {
        return NextResponse.json(
          { success: false, error: "Request date range must produce at least one leave day." },
          { status: 400 },
        );
      }

      await upsertVacationRequest(requestSnapshot);
      await recordLeaveRequestEvent({
        actorHrId: actor.employeeHrId,
        actorRole: "system",
        eventType: "submitted",
        requestId: requestSnapshot.id,
        snapshot: {
          employee_hr_id: requestSnapshot.employeeId,
          request_type: requestSnapshot.requestType,
          workflow_status: requestSnapshot.workflowStatus,
        },
        toStatus: requestSnapshot.workflowStatus,
      });

      const actors = buildNotificationRecipients({
        directManager,
        managerManager,
      });

      const managerEmailResult = directManager?.hr_id
        ? await sendManagerApprovalNotification({
            baseUrl,
            directManager: directManager ?? null,
            request: requestSnapshot,
          })
        : {
            recipients: [],
            sent: false,
            skipped: true,
            error: "Missing direct manager routing for leave request.",
          };

      const inApp = directManager?.hr_id ? await notifySystemActors(requestSnapshot, actors.actorIds) : [];
      const inAppRecipients = actors.actorIds;

      const warnings: string[] = [];
      addWarning(warnings, managerEmailResult.error);
      addWarning(warnings, deriveWarnings(inApp).join("; "));
      if (!directManager?.hr_id) {
        addWarning(warnings, "Request requires manual routing before workflow can continue.");
      }

      return NextResponse.json({
        action: "submit",
        data: {
          directManagerEmail: managerEmailResult,
          inApp,
          inAppRecipients,
          requestId: requestSnapshot.id,
          requestSnapshot: decorateRequestForActor(requestSnapshot, canAccessAdminData ? "admin" : "manager"),
        },
        success: true,
        warnings,
      });
    }

    if (action === "decide") {
      const payload = parseDecisionPayload(body);
      const invalid = getRequestError(payload, action);
      if (invalid) {
        return NextResponse.json({ success: false, error: invalid }, { status: 400 });
      }

      if (!payload) {
        return NextResponse.json({ success: false, error: "Invalid decision payload." }, { status: 400 });
      }

      const persistedRequest = await fetchLeaveRequestById(payload.requestId);
      if (!persistedRequest) {
        return NextResponse.json({ success: false, error: "Request not found." }, { status: 404 });
      }

      const actorHrId = normalizeHrId(access.hrId);
      const canDirectManageRequest =
        Boolean(actorHrId) &&
        actorHrId === normalizeHrId(persistedRequest.directManagerHrId);
      const isHrActor = access.role === "HR Specialist";
      const actorRole: LeaveWorkflowActor =
        canApprove || canAccessAdminData
          ? "admin"
          : isHrActor
            ? "hr"
            : canDirectManageRequest
              ? "manager"
              : "manager";

      if (!canApprove && !canAccessAdminData && !canDirectManageRequest && !isHrActor) {
        return NextResponse.json(
          { success: false, error: "Forbidden: only admins, HR, or the assigned direct manager can decide requests." },
          { status: 403 },
        );
      }

      const allowedActions = resolveWorkflowActionsForActor({
        actor: actorRole,
        request: persistedRequest,
      });
      if (!allowedActions.includes(payload.decision)) {
        return NextResponse.json(
          { success: false, error: `Action "${payload.decision}" is not allowed while request is ${getWorkflowStatusLabel(persistedRequest.workflowStatus)}.` },
          { status: 409 },
        );
      }

      const actorName = await resolveActorName(access);
      const decisionRequest = buildDecisionRequest({
        request: {
          ...persistedRequest,
          rejectionReason: payload.decision === "reject" ? payload.reason : "",
        },
        decision: payload.decision,
        approverName: actorName,
      });

      const now = new Date().toISOString();
      const updatedRequest = await setVacationRequestStatus({
        approverName: actorName,
        approvalAt: now,
        actorHrId: access.hrId,
        actorRole,
        decision: payload.decision,
        overrideReason: payload.overrideReason,
        request: decisionRequest,
      });
      const responseRequest = decorateRequestForActor(updatedRequest, actorRole);

      const directManager = await findEmployeeByHrId(persistedRequest.directManagerHrId);
      const managerManager = await findEmployeeByHrId(directManager?.manager_hr_id ?? null);
      const actors = buildNotificationRecipients({
        directManager,
        managerManager,
      });

      const decisionEmailResult = await sendDecisionStatusNotification({
        actorName,
        baseUrl,
        decision: payload.decision,
        hrNotificationEmails: actors.hrEmails,
        managerManager,
        request: updatedRequest,
      });
      const inApp = await notifySystemActorsForDecision(
        updatedRequest,
        actors.actorIds,
      );
      const warnings: string[] = [];
      addWarning(warnings, decisionEmailResult.error);
      addWarning(warnings, deriveWarnings(inApp).join("; "));

      return NextResponse.json({
        action: "decide",
        data: {
          decisionEmail: decisionEmailResult,
          inApp,
          inAppRecipients: actors.actorIds,
          requestId: responseRequest.id,
          requestSnapshot: responseRequest,
        },
        decision: payload.decision,
        success: true,
        warnings,
      });
    }

    return NextResponse.json({ success: false, error: "Invalid workflow action." }, { status: 400 });
  } catch (error) {
    if (shouldReturnForbidden(error) || isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
    }

    const debugError = error instanceof Error ? error.message : String(error ?? "");
    if (shouldExposeError(debugError) || (process.env.NODE_ENV !== "production" && debugError)) {
      return NextResponse.json(
        {
          debug: debugError,
          error: debugError,
          success: false,
        },
        { status: 500 },
      );
    }

    return NextResponse.json(
      { success: false, error: "Unable to complete vacation workflow request." },
      { status: 500 },
    );
  }
}
