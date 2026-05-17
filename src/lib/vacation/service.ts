import { createHash, randomBytes } from "node:crypto";

import {
  assertPermission,
  normalizeHrIdForAccess,
  resolveEmployeeIdentityId,
  type AccessContext,
} from "@/lib/auth/permissions";
import { getEmployeeDirectory, type EmployeeDirectoryData, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { enqueueInAppNotification } from "@/lib/notifications/in-app";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { toDateOnlyString } from "@/lib/date-only";
import {
  calculateVacationDurationDays,
  calculateVacationPayment,
  getVacationBalancePeriod,
  normalizeVacationDayPart,
  normalizeVacationPaymentStatus,
  normalizeVacationType,
  vacationTypeLabel,
} from "@/lib/vacation/calculations";
import {
  buildVacationDecisionUrl,
  sendVacationDecisionResultEmail,
  sendVacationManagerDecisionEmail,
} from "@/lib/vacation/email";
import type {
  VacationBalanceSnapshot,
  VacationDecision,
  VacationEmployeeSummary,
  VacationPaymentStatus,
  VacationReportData,
  VacationReportFilters,
  VacationRequestInput,
  VacationRequestRecord,
  VacationRequestStatus,
} from "@/lib/vacation/types";
import { VACATION_DAY_PARTS, VACATION_TYPES } from "@/lib/vacation/types";

const vacationRequestsTable = "v2_vacation_requests";
const vacationEventsTable = "v2_vacation_request_events";
const vacationTokensTable = "v2_vacation_email_tokens";
const emailTokenTtlDays = 14;

type VacationRequestDbRow = {
  balance_after_days: number | string | null;
  balance_before_days: number | string | null;
  created_at: string | null;
  day_part: string | null;
  department_name: string | null;
  duration_days: number | string | null;
  employee_hire_date: string | null;
  employee_hr_id: string | null;
  employee_name: string | null;
  employee_work_email: string | null;
  end_date: string | null;
  entitlement_days: number | string | null;
  id: string;
  line_name: string | null;
  manager_decision: string | null;
  manager_decision_at: string | null;
  manager_decision_by_hr_id: string | null;
  manager_decision_comment: string | null;
  manager_hr_id: string | null;
  manager_name: string | null;
  manager_of_manager_hr_id: string | null;
  manager_of_manager_name: string | null;
  payment_status: string | null;
  period_end: string | null;
  period_start: string | null;
  start_date: string | null;
  status: string | null;
  submitted_by_hr_id: string | null;
  unpaid_reason: string | null;
  used_paid_days: number | string | null;
  vacation_type: string | null;
};

type VacationEmailTokenDbRow = {
  expires_at: string | null;
  id: string;
  manager_hr_id: string | null;
  request_id: string | null;
  used_at: string | null;
};

type HrRecipient = {
  email: string | null;
  hrId: string;
  name: string;
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

function nullableText(value: unknown) {
  const normalized = text(value);
  return normalized || null;
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function canonicalHrId(value: string | null | undefined) {
  return normalizeHrIdForAccess(value) ?? null;
}

function hrIdsMatch(left: string | null | undefined, right: string | null | undefined) {
  const leftCanonical = canonicalHrId(left);
  const rightCanonical = canonicalHrId(right);
  return Boolean(leftCanonical && rightCanonical && leftCanonical === rightCanonical);
}

function isAllVacationVisibility(access: AccessContext) {
  return access.scope === "system" || access.role === "Super Admin" || access.role === "HR Specialist";
}

function isVacationSchemaMissingError(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes(vacationRequestsTable) ||
    message.includes(vacationEventsTable) ||
    message.includes(vacationTokensTable) ||
    message.includes("could not find the table") ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist"))
  );
}

export function isVacationSchemaMissing(error: unknown) {
  return isVacationSchemaMissingError(error);
}

export function vacationErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function findEmployeeByHrId(directory: EmployeeDirectoryData, hrId: string | null | undefined) {
  const canonical = canonicalHrId(hrId);
  if (!canonical) return null;
  return directory.employees.find((employee) => canonicalHrId(employee.hrId) === canonical) ?? null;
}

function summarizeEmployee(employee: EmployeeDirectoryRow): VacationEmployeeSummary {
  return {
    departmentName: employee.departmentName,
    fullName: employee.fullName,
    hireDate: employee.hireDate,
    hrId: employee.hrId,
    lineName: employee.lineName,
    managerHrId: employee.managerHrId,
    managerName: employee.managerName,
    workEmail: employee.workEmail,
  };
}

async function getCurrentEmployee(access: AccessContext, directory?: EmployeeDirectoryData) {
  const identityHrId = resolveEmployeeIdentityId(access);
  if (!identityHrId) {
    throw new Error("Your employee profile is not linked yet. Please contact HR.");
  }

  const employeeDirectory = directory ?? await getEmployeeDirectory();
  const employee = findEmployeeByHrId(employeeDirectory, identityHrId);
  if (!employee) {
    throw new Error("Your employee profile is not available in the employee directory. Please contact HR.");
  }

  return { directory: employeeDirectory, employee };
}

function managerChain(directory: EmployeeDirectoryData, employee: EmployeeDirectoryRow) {
  const manager = findEmployeeByHrId(directory, employee.managerHrId);
  const managerOfManager = manager ? findEmployeeByHrId(directory, manager.managerHrId) : null;
  return { manager, managerOfManager };
}

function mapVacationRow(row: VacationRequestDbRow, canDecide = false): VacationRequestRecord {
  return {
    balanceAfterDays: numberValue(row.balance_after_days),
    balanceBeforeDays: numberValue(row.balance_before_days),
    canDecide,
    createdAt: row.created_at ?? "",
    dayPart: normalizeVacationDayPart(row.day_part) ?? "full_day",
    departmentName: row.department_name,
    durationDays: numberValue(row.duration_days),
    employeeHireDate: row.employee_hire_date,
    employeeHrId: text(row.employee_hr_id),
    employeeName: text(row.employee_name),
    employeeWorkEmail: row.employee_work_email,
    endDate: text(row.end_date),
    entitlementDays: numberValue(row.entitlement_days),
    id: row.id,
    lineName: row.line_name,
    managerDecision:
      row.manager_decision === "approved" || row.manager_decision === "rejected"
        ? row.manager_decision
        : null,
    managerDecisionAt: row.manager_decision_at,
    managerDecisionByHrId: row.manager_decision_by_hr_id,
    managerDecisionComment: row.manager_decision_comment,
    managerHrId: row.manager_hr_id,
    managerName: row.manager_name,
    managerOfManagerHrId: row.manager_of_manager_hr_id,
    managerOfManagerName: row.manager_of_manager_name,
    paymentStatus: normalizeVacationPaymentStatus(row.payment_status) ?? "unpaid",
    periodEnd: row.period_end,
    periodStart: row.period_start,
    startDate: text(row.start_date),
    status:
      row.status === "approved" || row.status === "rejected" || row.status === "pending_manager"
        ? row.status
        : "pending_manager",
    submittedByHrId: row.submitted_by_hr_id,
    unpaidReason:
      row.unpaid_reason === "first_six_months" ||
      row.unpaid_reason === "insufficient_balance" ||
      row.unpaid_reason === "missing_hire_date"
        ? row.unpaid_reason
        : null,
    usedPaidDays: numberValue(row.used_paid_days),
    vacationType: normalizeVacationType(row.vacation_type) ?? "annual",
  };
}

function canDecideVacation(access: AccessContext, request: Pick<VacationRequestRecord, "managerHrId" | "status">) {
  if (request.status !== "pending_manager") return false;
  if (access.scope === "system") return true;
  return hrIdsMatch(resolveEmployeeIdentityId(access), request.managerHrId);
}

function canSeeVacation(access: AccessContext, request: VacationRequestRecord) {
  if (isAllVacationVisibility(access)) return true;
  const viewerHrId = resolveEmployeeIdentityId(access);
  return (
    hrIdsMatch(viewerHrId, request.employeeHrId) ||
    hrIdsMatch(viewerHrId, request.managerHrId) ||
    hrIdsMatch(viewerHrId, request.managerOfManagerHrId)
  );
}

async function insertVacationEvent(input: {
  actorHrId?: string | null;
  actorLoginId?: string | null;
  eventType: string;
  message: string;
  metadata?: Record<string, unknown>;
  requestId: string;
}) {
  const { error } = await getSupabaseAdmin().from(vacationEventsTable).insert({
    actor_hr_id: input.actorHrId ?? null,
    actor_login_id: input.actorLoginId ?? null,
    event_type: input.eventType,
    message: input.message,
    metadata: input.metadata ?? {},
    request_id: input.requestId,
  });
  if (error) throw new Error(typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error));
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function createVacationEmailToken(request: VacationRequestRecord) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + emailTokenTtlDays * 86400000).toISOString();
  const { error } = await getSupabaseAdmin().from(vacationTokensTable).insert({
    expires_at: expiresAt,
    manager_hr_id: request.managerHrId,
    request_id: request.id,
    token_hash: tokenHash(token),
  });
  if (error) throw new Error(typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error));
  return token;
}

async function getHrRecipients(directory: EmployeeDirectoryData): Promise<HrRecipient[]> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("app_auth_users")
      .select("login_id,hr_id,role,is_active")
      .eq("is_active", true)
      .eq("role", "HR Specialist");

    if (error) return [];

    return (data ?? [])
      .map((row) => {
        const hrId = text((row as Record<string, unknown>).hr_id);
        if (!hrId) return null;
        const employee = findEmployeeByHrId(directory, hrId);
        return {
          email: employee?.workEmail ?? null,
          hrId,
          name: employee?.fullName ?? hrId,
        };
      })
      .filter((entry): entry is HrRecipient => Boolean(entry));
  } catch {
    return [];
  }
}

async function notifyRecipients(input: {
  href: string;
  message: string;
  metadata?: Record<string, unknown>;
  recipients: Array<string | null | undefined>;
  requestId: string;
  title: string;
  type: string;
}) {
  const recipientHrIds = Array.from(
    new Set(input.recipients.map((recipient) => text(recipient).toUpperCase()).filter(Boolean)),
  );

  await Promise.allSettled(
    recipientHrIds.map((recipientHrId) =>
      enqueueInAppNotification({
        category: "vacation_request",
        dedupeKey: `vacation:${input.requestId}:${input.type}:${recipientHrId}`,
        href: input.href,
        message: input.message,
        metadata: input.metadata,
        recipientHrId,
        title: input.title,
      }),
    ),
  );
}

async function dispatchVacationSubmitted(input: {
  baseUrl: string;
  directory: EmployeeDirectoryData;
  request: VacationRequestRecord;
}) {
  const hrRecipients = await getHrRecipients(input.directory);
  const reportHref = `/leave-management/vacation-report?requestId=${encodeURIComponent(input.request.id)}`;
  await notifyRecipients({
    href: reportHref,
    message: `${input.request.employeeName} submitted ${vacationTypeLabel(input.request.vacationType)} for ${input.request.durationDays} day(s).`,
    metadata: { requestId: input.request.id, status: input.request.status },
    recipients: [
      input.request.managerHrId,
      input.request.managerOfManagerHrId,
      ...hrRecipients.map((recipient) => recipient.hrId),
    ],
    requestId: input.request.id,
    title: "Vacation request submitted",
    type: "submitted",
  });

  if (!input.request.managerHrId || !input.request.managerName) return;
  const managerEmail = await resolveManagerEmail(input.directory, input.request.managerHrId);
  if (!managerEmail) return;

  const token = await createVacationEmailToken(input.request);
  await sendVacationManagerDecisionEmail({
    approveUrl: buildVacationDecisionUrl({
      baseUrl: input.baseUrl,
      decision: "approve",
      requestId: input.request.id,
      token,
    }),
    managerEmail,
    managerName: input.request.managerName,
    rejectUrl: buildVacationDecisionUrl({
      baseUrl: input.baseUrl,
      decision: "reject",
      requestId: input.request.id,
      token,
    }),
    request: input.request,
  });
}

async function dispatchVacationDecision(input: {
  decision: VacationDecision;
  directory: EmployeeDirectoryData;
  request: VacationRequestRecord;
}) {
  const hrRecipients = await getHrRecipients(input.directory);
  const reportHref = `/leave-management/vacation-report?requestId=${encodeURIComponent(input.request.id)}`;
  await notifyRecipients({
    href: reportHref,
    message: `${input.request.employeeName}'s vacation request was ${input.decision === "approve" ? "approved" : "rejected"}.`,
    metadata: { requestId: input.request.id, status: input.request.status },
    recipients: [
      input.request.employeeHrId,
      input.request.managerOfManagerHrId,
      ...hrRecipients.map((recipient) => recipient.hrId),
    ],
    requestId: input.request.id,
    title: `Vacation request ${input.decision === "approve" ? "approved" : "rejected"}`,
    type: `decision:${input.decision}`,
  });

  if (!input.request.employeeWorkEmail) return;
  await sendVacationDecisionResultEmail({
    cc: [
      ...hrRecipients.map((recipient) => recipient.email).filter((email): email is string => Boolean(email)),
      await resolveManagerEmail(input.directory, input.request.managerOfManagerHrId),
    ].filter((email): email is string => Boolean(email)),
    decision: input.decision,
    employeeEmail: input.request.employeeWorkEmail,
    request: input.request,
  });
}

async function resolveManagerEmail(directory: EmployeeDirectoryData, managerHrId: string | null | undefined) {
  const manager = findEmployeeByHrId(directory, managerHrId);
  return manager?.workEmail ?? null;
}

async function approvedPaidDaysInPeriod(input: {
  employeeHrId: string;
  excludeRequestId?: string;
  periodEnd: string | null;
  periodStart: string | null;
}) {
  if (!input.periodStart || !input.periodEnd) return 0;

  const { data, error } = await getSupabaseAdmin()
    .from(vacationRequestsTable)
    .select("id,duration_days")
    .ilike("employee_hr_id", input.employeeHrId)
    .eq("status", "approved")
    .eq("payment_status", "paid")
    .gte("start_date", input.periodStart)
    .lt("start_date", input.periodEnd);

  if (error) throw new Error(typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error));

  return (data ?? [])
    .filter((row) => String((row as Record<string, unknown>).id) !== input.excludeRequestId)
    .reduce((sum, row) => sum + numberValue((row as Record<string, unknown>).duration_days), 0);
}

async function calculatePaymentForRequest(input: {
  durationDays: number;
  employeeHrId: string;
  excludeRequestId?: string;
  hireDate: string | null;
  startDate: string;
}) {
  const period = getVacationBalancePeriod({
    hireDate: input.hireDate,
    referenceDate: input.startDate,
  });
  const usedPaidDays = await approvedPaidDaysInPeriod({
    employeeHrId: input.employeeHrId,
    excludeRequestId: input.excludeRequestId,
    periodEnd: period?.periodEnd ?? null,
    periodStart: period?.periodStart ?? null,
  });

  return calculateVacationPayment({
    approvedPaidDaysInPeriod: usedPaidDays,
    durationDays: input.durationDays,
    hireDate: input.hireDate,
    startDate: input.startDate,
  });
}

export async function getVacationRequestPageData(access: AccessContext) {
  await assertPermission(access, "leave", "create");
  const { directory, employee } = await getCurrentEmployee(access);
  const today = toDateOnlyString(new Date()) ?? "";
  const { manager, managerOfManager } = managerChain(directory, employee);

  let balance: VacationBalanceSnapshot | null = null;
  let balanceError: string | null = null;
  try {
    balance = await calculatePaymentForRequest({
      durationDays: 0,
      employeeHrId: employee.hrId,
      hireDate: employee.hireDate,
      startDate: today,
    });
  } catch (err) {
    balanceError = isVacationSchemaMissingError(err)
      ? "Vacation schema is not ready. Apply the new v2 vacation migration before using this module."
      : (err instanceof Error ? err.message : String(err));
  }

  return {
    balance,
    balanceError,
    dayPartOptions: VACATION_DAY_PARTS,
    employee: summarizeEmployee(employee),
    manager: manager ? summarizeEmployee(manager) : null,
    managerOfManager: managerOfManager ? summarizeEmployee(managerOfManager) : null,
    vacationTypeOptions: VACATION_TYPES,
  };
}

export async function createVacationRequest(access: AccessContext, input: VacationRequestInput, options: { baseUrl: string }) {
  await assertPermission(access, "leave", "create");
  const vacationType = normalizeVacationType(input.vacationType);
  const dayPart = normalizeVacationDayPart(input.dayPart);
  const startDate = toDateOnlyString(input.startDate);
  const endDate = toDateOnlyString(input.endDate);

  if (!vacationType) throw new Error("Vacation type is invalid.");
  if (!dayPart) throw new Error("Vacation day part is invalid.");
  if (!startDate || !endDate) throw new Error("Vacation start and end dates are required.");

  const durationDays = calculateVacationDurationDays({ dayPart, endDate, startDate });
  const { directory, employee } = await getCurrentEmployee(access);
  const { manager, managerOfManager } = managerChain(directory, employee);
  if (!manager?.hrId) {
    throw new Error("Your direct manager is not assigned. Please contact HR before submitting a vacation request.");
  }

  const balance = await calculatePaymentForRequest({
    durationDays,
    employeeHrId: employee.hrId,
    hireDate: employee.hireDate,
    startDate,
  });

  const now = new Date().toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from(vacationRequestsTable)
    .insert({
      balance_after_days: balance.balanceAfterDays,
      balance_before_days: balance.balanceBeforeDays,
      day_part: dayPart,
      department_name: employee.departmentName,
      duration_days: durationDays,
      employee_hire_date: employee.hireDate,
      employee_hr_id: employee.hrId,
      employee_name: employee.fullName,
      employee_work_email: employee.workEmail,
      end_date: endDate,
      entitlement_days: balance.entitlementDays,
      line_name: employee.lineName,
      manager_hr_id: manager.hrId,
      manager_name: manager.fullName,
      manager_of_manager_hr_id: managerOfManager?.hrId ?? null,
      manager_of_manager_name: managerOfManager?.fullName ?? null,
      payment_status: balance.paymentStatus,
      period_end: balance.periodEnd,
      period_start: balance.periodStart,
      start_date: startDate,
      status: "pending_manager",
      submitted_by_hr_id: employee.hrId,
      submitted_by_login_id: access.loginId ?? null,
      unpaid_reason: balance.unpaidReason,
      updated_at: now,
      used_paid_days: balance.usedPaidDays,
      vacation_type: vacationType,
    })
    .select("*")
    .single();

  if (error) throw new Error(typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error));

  const request = mapVacationRow(data as VacationRequestDbRow);
  await insertVacationEvent({
    actorHrId: employee.hrId,
    actorLoginId: access.loginId,
    eventType: "submitted",
    message: "Vacation request submitted.",
    metadata: { paymentStatus: request.paymentStatus, unpaidReason: request.unpaidReason },
    requestId: request.id,
  });

  await dispatchVacationSubmitted({ baseUrl: options.baseUrl, directory, request }).catch(async (error) => {
    await insertVacationEvent({
      actorHrId: employee.hrId,
      actorLoginId: access.loginId,
      eventType: "notification_failed",
      message: vacationErrorMessage(error),
      requestId: request.id,
    }).catch(() => undefined);
  });

  return request;
}

async function fetchVacationRequestById(id: string) {
  const { data, error } = await getSupabaseAdmin()
    .from(vacationRequestsTable)
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error));
  return data ? mapVacationRow(data as VacationRequestDbRow) : null;
}

async function applyVacationDecision(input: {
  access?: AccessContext;
  actorHrId: string | null;
  actorLoginId?: string | null;
  decision: VacationDecision;
  decisionComment?: string | null;
  request: VacationRequestRecord;
}) {
  if (input.request.status !== "pending_manager") {
    throw new Error("This vacation request already has a manager decision.");
  }

  const directory = await getEmployeeDirectory();
  let balance: VacationBalanceSnapshot = input.request;
  if (input.decision === "approve") {
    balance = await calculatePaymentForRequest({
      durationDays: input.request.durationDays,
      employeeHrId: input.request.employeeHrId,
      excludeRequestId: input.request.id,
      hireDate: input.request.employeeHireDate,
      startDate: input.request.startDate,
    });
  }

  const managerDecision = input.decision === "approve" ? "approved" : "rejected";
  const now = new Date().toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from(vacationRequestsTable)
    .update({
      balance_after_days: balance.balanceAfterDays,
      balance_before_days: balance.balanceBeforeDays,
      entitlement_days: balance.entitlementDays,
      manager_decision: managerDecision,
      manager_decision_at: now,
      manager_decision_by_hr_id: input.actorHrId,
      manager_decision_comment: nullableText(input.decisionComment),
      payment_status: balance.paymentStatus,
      period_end: balance.periodEnd,
      period_start: balance.periodStart,
      status: managerDecision,
      unpaid_reason: balance.unpaidReason,
      updated_at: now,
      used_paid_days: balance.usedPaidDays,
    })
    .eq("id", input.request.id)
    .eq("status", "pending_manager")
    .select("*")
    .single();

  if (error) throw new Error(typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error));
  const updated = mapVacationRow(data as VacationRequestDbRow);

  await insertVacationEvent({
    actorHrId: input.actorHrId,
    actorLoginId: input.actorLoginId,
    eventType: managerDecision,
    message: `Vacation request ${managerDecision}.`,
    metadata: {
      decisionComment: input.decisionComment ?? null,
      paymentStatus: updated.paymentStatus,
      unpaidReason: updated.unpaidReason,
    },
    requestId: updated.id,
  });

  await dispatchVacationDecision({ decision: input.decision, directory, request: updated }).catch(async (error) => {
    await insertVacationEvent({
      actorHrId: input.actorHrId,
      actorLoginId: input.actorLoginId,
      eventType: "notification_failed",
      message: vacationErrorMessage(error),
      requestId: updated.id,
    }).catch(() => undefined);
  });

  return updated;
}

export async function decideVacationRequest(access: AccessContext, input: {
  decision: VacationDecision;
  decisionComment?: string | null;
  requestId: string;
}) {
  await assertPermission(access, "leave", "approve");
  const request = await fetchVacationRequestById(input.requestId);
  if (!request) throw new Error("Vacation request was not found.");
  if (!canDecideVacation(access, request)) {
    throw new Error("Forbidden: only the assigned direct manager can decide this vacation request.");
  }

  return applyVacationDecision({
    access,
    actorHrId: resolveEmployeeIdentityId(access),
    actorLoginId: access.loginId,
    decision: input.decision,
    decisionComment: input.decisionComment,
    request,
  });
}

export async function decideVacationRequestByToken(input: {
  decision: VacationDecision;
  requestId: string;
  token: string;
}) {
  const hash = tokenHash(input.token);
  const { data, error } = await getSupabaseAdmin()
    .from(vacationTokensTable)
    .select("id,request_id,manager_hr_id,expires_at,used_at")
    .eq("request_id", input.requestId)
    .eq("token_hash", hash)
    .maybeSingle();

  if (error) throw new Error(typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error));
  const tokenRow = data as VacationEmailTokenDbRow | null;
  if (!tokenRow) throw new Error("Vacation approval link is invalid.");
  if (tokenRow.used_at) throw new Error("Vacation approval link was already used.");
  if (!tokenRow.expires_at || new Date(tokenRow.expires_at).getTime() < Date.now()) {
    throw new Error("Vacation approval link has expired.");
  }

  const request = await fetchVacationRequestById(input.requestId);
  if (!request) throw new Error("Vacation request was not found.");
  if (!hrIdsMatch(tokenRow.manager_hr_id, request.managerHrId)) {
    throw new Error("Vacation approval link does not match the assigned direct manager.");
  }

  const updated = await applyVacationDecision({
    actorHrId: request.managerHrId,
    actorLoginId: "email-token",
    decision: input.decision,
    request,
  });

  await getSupabaseAdmin()
    .from(vacationTokensTable)
    .update({ used_at: new Date().toISOString() })
    .eq("id", tokenRow.id);

  return updated;
}

function normalizeDecision(value: unknown): VacationDecision | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "approve" || normalized === "approved") return "approve";
  if (normalized === "reject" || normalized === "rejected") return "reject";
  return null;
}

export function parseVacationDecision(value: unknown) {
  return normalizeDecision(value);
}

function cleanFilters(filters: VacationReportFilters): VacationReportFilters {
  return {
    dateFrom: nullableText(filters.dateFrom) ?? undefined,
    dateTo: nullableText(filters.dateTo) ?? undefined,
    department: nullableText(filters.department) ?? undefined,
    employee: nullableText(filters.employee) ?? undefined,
    line: nullableText(filters.line) ?? undefined,
    manager: nullableText(filters.manager) ?? undefined,
    paymentStatus: normalizeVacationPaymentStatus(filters.paymentStatus) ?? "all",
    requestId: nullableText(filters.requestId) ?? undefined,
    search: nullableText(filters.search) ?? undefined,
    status:
      filters.status === "approved" || filters.status === "rejected" || filters.status === "pending_manager"
        ? filters.status
        : "all",
    vacationType: normalizeVacationType(filters.vacationType) ?? "all",
  };
}

function rowMatchesFilters(row: VacationRequestRecord, filters: VacationReportFilters) {
  if (filters.status && filters.status !== "all" && row.status !== filters.status) return false;
  if (filters.paymentStatus && filters.paymentStatus !== "all" && row.paymentStatus !== filters.paymentStatus) return false;
  if (filters.vacationType && filters.vacationType !== "all" && row.vacationType !== filters.vacationType) return false;
  if (filters.employee && !hrIdsMatch(row.employeeHrId, filters.employee)) return false;
  if (filters.manager && !hrIdsMatch(row.managerHrId, filters.manager)) return false;
  if (filters.department && row.departmentName !== filters.department) return false;
  if (filters.line && row.lineName !== filters.line) return false;
  if (filters.requestId && row.id !== filters.requestId) return false;
  if (filters.dateFrom && row.startDate < filters.dateFrom) return false;
  if (filters.dateTo && row.startDate > filters.dateTo) return false;

  const search = filters.search?.toLowerCase();
  if (search) {
    const haystack = [
      row.employeeName,
      row.employeeHrId,
      row.managerName,
      row.managerHrId,
      row.departmentName,
      row.lineName,
      vacationTypeLabel(row.vacationType),
      row.status,
      row.paymentStatus,
    ].join(" ").toLowerCase();
    if (!haystack.includes(search)) return false;
  }

  return true;
}

function buildReportOptions(rows: VacationRequestRecord[]): VacationReportData["options"] {
  const unique = (values: Array<string | null | undefined>) =>
    Array.from(new Set(values.map((value) => text(value)).filter(Boolean))).sort((a, b) => a.localeCompare(b));

  const employees = Array.from(
    new Map(rows.map((row) => [row.employeeHrId, { label: `${row.employeeName} (${row.employeeHrId})`, value: row.employeeHrId }])).values(),
  ).sort((left, right) => left.label.localeCompare(right.label));

  const managers = Array.from(
    new Map(
      rows
        .filter((row) => row.managerHrId)
        .map((row) => [row.managerHrId ?? "", { label: `${row.managerName ?? row.managerHrId} (${row.managerHrId})`, value: row.managerHrId ?? "" }]),
    ).values(),
  ).sort((left, right) => left.label.localeCompare(right.label));

  return {
    departments: unique(rows.map((row) => row.departmentName)),
    employees,
    lines: unique(rows.map((row) => row.lineName)),
    managers,
  };
}

function buildReportSummary(rows: VacationRequestRecord[]): VacationReportData["summary"] {
  return {
    approved: rows.filter((row) => row.status === "approved").length,
    paidDays: rows.filter((row) => row.paymentStatus === "paid").reduce((sum, row) => sum + row.durationDays, 0),
    pending: rows.filter((row) => row.status === "pending_manager").length,
    rejected: rows.filter((row) => row.status === "rejected").length,
    total: rows.length,
    unpaidDays: rows.filter((row) => row.paymentStatus === "unpaid").reduce((sum, row) => sum + row.durationDays, 0),
  };
}

export async function getVacationReportData(access: AccessContext, filters: VacationReportFilters = {}): Promise<VacationReportData> {
  await assertPermission(access, "leave", "read");
  const clean = cleanFilters(filters);
  const { data, error } = await getSupabaseAdmin()
    .from(vacationRequestsTable)
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error) throw new Error(typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error));

  const visibleRows = (data ?? [])
    .map((row) => mapVacationRow(row as VacationRequestDbRow))
    .filter((row) => canSeeVacation(access, row))
    .map((row) => ({ ...row, canDecide: canDecideVacation(access, row) }));
  const filteredRows = visibleRows.filter((row) => rowMatchesFilters(row, clean));

  return {
    filters: clean,
    options: buildReportOptions(visibleRows),
    rows: filteredRows,
    summary: buildReportSummary(filteredRows),
  };
}
