import ExcelJS from "exceljs";

import {
  assertPermission,
  canAccess,
  type AccessContext,
} from "@/lib/auth/permissions";
import { getEmployeeDirectory, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import {
  buildLeaveAnalytics,
  buildLeaveCalendarItems,
  buildTeamAvailability,
  detectLeaveConflicts,
  getLeaveCalendarRange,
} from "@/lib/leave/insights";
import {
  calculateCalendarLeaveDays,
  calculateLeaveDuration,
  calculateLeaveBalanceFromParts,
  calculateMonthlyAccrual,
  getWeekendDaysForEmployee,
  getAnnualEntitlement,
  isWithinFirstSixMonths,
  summarizeLeaveLedger,
} from "@/lib/leave/calculations";
import type {
  EmployeeLeaveBalance,
  LeaveAccrualPreview,
  LeaveAdjustmentInput,
  LeaveApproval,
  LeaveAuditLog,
  LeaveAnalytics,
  LeaveCalendarItem,
  LeaveConflictResult,
  LeaveDurationUnit,
  LeavePaymentStatus,
  LeaveDecisionInput,
  LeavePolicy,
  LeaveRequest,
  LeaveRequestFilters,
  LeaveStatus,
  LeaveTransaction,
  LeaveTransactionType,
  LeaveType,
  LeaveWallet,
  PublicHoliday,
  SubmitLeaveRequestInput,
  TeamAvailabilityDay,
} from "@/lib/leave/types";
import { createLeaveCorrelationId, writeLeaveAuditLog } from "@/lib/leave/audit";
import { getLeaveAttachmentUrl } from "@/lib/leave/attachments";
import { emitLeaveNotification } from "@/lib/leave/notifications";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type LeaveTypeRow = {
  id: string;
  code: string;
  name: string;
  is_paid: boolean;
  affects_payroll: boolean;
  requires_attachment: boolean;
  requires_manager_approval: boolean;
  requires_hr_approval: boolean;
  employee_selectable: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

type LeavePolicyRow = {
  id: string;
  name: string;
  country: string;
  annual_days_first_year: number | string;
  annual_days_after_first_year: number | string;
  accrual_method: LeavePolicy["accrualMethod"];
  accrual_frequency: LeavePolicy["accrualFrequency"];
  allow_negative_balance: boolean;
  carry_forward_enabled: boolean;
  carry_forward_limit: number | string;
  carry_forward_expiry_months: number;
  weekend_days: number[] | null;
  is_default: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

type EmployeeLeaveBalanceRow = {
  id: string;
  employee_hr_id: string;
  leave_type_id: string;
  policy_id: string;
  year: number;
  opening_balance: number | string;
  accrued: number | string;
  consumed: number | string;
  pending: number | string;
  adjusted: number | string;
  carry_forward: number | string;
  available_balance: number | string;
  last_accrual_date: string | null;
  created_at: string;
  updated_at: string;
};

type LeaveRequestRow = {
  id: string;
  employee_hr_id: string;
  leave_type_id: string;
  policy_id: string;
  start_date: string;
  end_date: string;
  total_calendar_days: number | string;
  total_working_days: number | string;
  reason: string | null;
  attachment_url: string | null;
  balance_leave_type_id: string | null;
  duration_unit: LeaveDurationUnit;
  hr_balance_decision: LeaveRequest["hrBalanceDecision"];
  payment_reason: string | null;
  payment_status: LeavePaymentStatus;
  status: LeaveStatus;
  manager_status: LeaveRequest["managerStatus"];
  hr_status: LeaveRequest["hrStatus"];
  payroll_status: LeaveRequest["payrollStatus"];
  manager_comment: string | null;
  hr_comment: string | null;
  requested_at: string;
  manager_decision_at: string | null;
  hr_decision_at: string | null;
  created_at: string;
  updated_at: string;
  leave_types?: Pick<LeaveTypeRow, "affects_payroll" | "code" | "is_paid" | "name"> | null;
};

type LeaveTransactionRow = {
  id: string;
  employee_hr_id: string;
  leave_type_id: string;
  policy_id: string;
  request_id: string | null;
  transaction_type: LeaveTransactionType;
  amount: number | string;
  balance_before: number | string;
  balance_after: number | string;
  notes: string | null;
  created_by: string | null;
  created_at: string;
};

type LeaveApprovalRow = {
  id: string;
  request_id: string;
  approver_hr_id: string;
  approver_role: string;
  approval_step: LeaveApproval["approvalStep"];
  status: LeaveApproval["status"];
  comment: string | null;
  action_date: string;
  created_at: string;
};

type PublicHolidayRow = {
  id: string;
  name: string;
  date: string;
  year: number;
  country: string;
  is_active: boolean;
  created_at: string;
};

type LeaveAuditLogRow = {
  id: string;
  correlation_id: string;
  event_type: string;
  request_id: string | null;
  employee_hr_id: string | null;
  actor_hr_id: string | null;
  actor_role: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

const annualLeaveCode = "annual_leave";
const emergencyLeaveCode = "emergency_leave";
const otherLeaveCode = "other";
const sickLeaveCode = "sick_leave";
const unpaidLeaveCode = "unpaid_leave";
const employeeSelectableLeaveCodes = new Set([annualLeaveCode, emergencyLeaveCode, sickLeaveCode, otherLeaveCode]);
const balanceConsumingSubmitLeaveCodes = new Set([annualLeaveCode, emergencyLeaveCode]);
const sickLeaveCertificateText = "\u0634\u0647\u0627\u062f\u0629 \u0645\u0631\u0636\u064a\u0629 \u0645\u062e\u062a\u0648\u0645\u0629 \u0645\u0646 \u0645\u0633\u062a\u0634\u0641\u0649 \u062d\u0643\u0648\u0645\u064a\nMedical certificate stamped by a governmental hospital";

function n(value: number | string | null | undefined) {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(date: string, days: number) {
  const source = new Date(`${date}T00:00:00.000Z`);
  source.setUTCDate(source.getUTCDate() + days);
  return source.toISOString().slice(0, 10);
}

function cleanHrId(value: string | null | undefined) {
  return String(value ?? "").trim().toUpperCase();
}

function hrIdsMatch(left: string | null | undefined, right: string | null | undefined) {
  return cleanHrId(left) === cleanHrId(right) && cleanHrId(left).length > 0;
}

function isManageRole(context: AccessContext) {
  return context.scope === "system" || context.role === "Super Admin" || context.role === "HR Specialist";
}

function payrollCanRead(context: AccessContext) {
  return isManageRole(context) || context.role === "Finance Manager";
}

function sickBackdateDays() {
  const configured = Number(process.env.LEAVE_SICK_BACKDATE_DAYS ?? 7);
  return Number.isFinite(configured) && configured >= 0 ? Math.trunc(configured) : 7;
}

function normalizeDurationUnit(value: LeaveDurationUnit | string | null | undefined): LeaveDurationUnit {
  return value === "am" || value === "pm" ? value : "full_day";
}

function paymentStatusLabel(status: LeavePaymentStatus) {
  if (status === "paid") return "Paid";
  if (status === "unpaid") return "Unpaid";
  if (status === "non_deducted") return "Non-Deducted";
  return "In Review";
}

function paymentReasonText(reasons: string[]) {
  return reasons.filter(Boolean).join("; ") || null;
}

function mapLeaveType(row: LeaveTypeRow): LeaveType {
  return {
    affectsPayroll: row.affects_payroll,
    code: row.code,
    createdAt: row.created_at,
    employeeSelectable: row.employee_selectable ?? true,
    id: row.id,
    isActive: row.is_active,
    isPaid: row.is_paid,
    name: row.name,
    requiresAttachment: row.requires_attachment,
    requiresHrApproval: row.requires_hr_approval,
    requiresManagerApproval: row.requires_manager_approval,
    updatedAt: row.updated_at,
  };
}

function mapLeavePolicy(row: LeavePolicyRow): LeavePolicy {
  return {
    accrualFrequency: row.accrual_frequency,
    accrualMethod: row.accrual_method,
    allowNegativeBalance: row.allow_negative_balance,
    annualDaysAfterFirstYear: n(row.annual_days_after_first_year),
    annualDaysFirstYear: n(row.annual_days_first_year),
    carryForwardEnabled: row.carry_forward_enabled,
    carryForwardExpiryMonths: row.carry_forward_expiry_months,
    carryForwardLimit: n(row.carry_forward_limit),
    country: row.country,
    createdAt: row.created_at,
    id: row.id,
    isActive: row.is_active,
    isDefault: row.is_default,
    name: row.name,
    updatedAt: row.updated_at,
    weekendDays: row.weekend_days?.length ? row.weekend_days.map(Number) : [5, 6],
  };
}

function mapBalance(row: EmployeeLeaveBalanceRow): EmployeeLeaveBalance {
  return {
    accrued: n(row.accrued),
    adjusted: n(row.adjusted),
    availableBalance: n(row.available_balance),
    carryForward: n(row.carry_forward),
    consumed: n(row.consumed),
    createdAt: row.created_at,
    employeeHrId: row.employee_hr_id,
    id: row.id,
    lastAccrualDate: row.last_accrual_date,
    leaveTypeId: row.leave_type_id,
    openingBalance: n(row.opening_balance),
    pending: n(row.pending),
    policyId: row.policy_id,
    updatedAt: row.updated_at,
    year: row.year,
  };
}

function mapTransaction(row: LeaveTransactionRow): LeaveTransaction {
  return {
    amount: n(row.amount),
    balanceAfter: n(row.balance_after),
    balanceBefore: n(row.balance_before),
    createdAt: row.created_at,
    createdBy: row.created_by,
    employeeHrId: row.employee_hr_id,
    id: row.id,
    leaveTypeId: row.leave_type_id,
    notes: row.notes,
    policyId: row.policy_id,
    requestId: row.request_id,
    transactionType: row.transaction_type,
  };
}

function mapApproval(row: LeaveApprovalRow): LeaveApproval {
  return {
    actionDate: row.action_date,
    approvalStep: row.approval_step,
    approverHrId: row.approver_hr_id,
    approverRole: row.approver_role,
    comment: row.comment,
    createdAt: row.created_at,
    id: row.id,
    requestId: row.request_id,
    status: row.status,
  };
}

function mapHoliday(row: PublicHolidayRow): PublicHoliday {
  return {
    country: row.country,
    createdAt: row.created_at,
    date: row.date,
    id: row.id,
    isActive: row.is_active,
    name: row.name,
    year: row.year,
  };
}

function mapLeaveRequest(
  row: LeaveRequestRow,
  employeeByHrId = new Map<string, EmployeeDirectoryRow>(),
  approvals: LeaveApproval[] = [],
): LeaveRequest {
  const employee = employeeByHrId.get(cleanHrId(row.employee_hr_id));
  return {
    approvalHistory: approvals,
    attachmentUrl: row.attachment_url,
    balanceLeaveTypeId: row.balance_leave_type_id,
    createdAt: row.created_at,
    durationUnit: row.duration_unit ?? "full_day",
    employee: employee
      ? {
          areaName: employee.areaName,
          fullName: employee.fullName,
          hrId: employee.hrId,
          jobTitle: employee.jobTitle,
          lineName: employee.lineName,
          managerHrId: employee.managerHrId,
          managerName: employee.managerName,
        }
      : null,
    employeeHrId: row.employee_hr_id,
    endDate: row.end_date,
    hrComment: row.hr_comment,
    hrBalanceDecision: row.hr_balance_decision,
    hrDecisionAt: row.hr_decision_at,
    hrStatus: row.hr_status,
    id: row.id,
    leaveType: row.leave_types
      ? {
          affectsPayroll: row.leave_types.affects_payroll,
          code: row.leave_types.code,
          isPaid: row.leave_types.is_paid,
          name: row.leave_types.name,
        }
      : null,
    leaveTypeId: row.leave_type_id,
    managerComment: row.manager_comment,
    managerDecisionAt: row.manager_decision_at,
    managerStatus: row.manager_status,
    payrollStatus: row.payroll_status,
    paymentReason: row.payment_reason,
    paymentStatus: row.payment_status ?? "in_review",
    policyId: row.policy_id,
    reason: row.reason,
    requestedAt: row.requested_at,
    startDate: row.start_date,
    status: row.status,
    totalCalendarDays: n(row.total_calendar_days),
    totalWorkingDays: n(row.total_working_days),
    updatedAt: row.updated_at,
  };
}

function employeeIsUnderManager(managerHrId: string | null | undefined, employeeHrId: string, employeeByHrId: Map<string, EmployeeDirectoryRow>) {
  const manager = cleanHrId(managerHrId);
  if (!manager) return false;
  let cursor = employeeByHrId.get(cleanHrId(employeeHrId));
  const seen = new Set<string>();

  while (cursor?.managerHrId) {
    const currentManager = cleanHrId(cursor.managerHrId);
    if (!currentManager || seen.has(currentManager)) break;
    if (currentManager === manager) return true;
    seen.add(currentManager);
    cursor = employeeByHrId.get(currentManager);
  }

  return false;
}

function canSeeLeaveEmployee(context: AccessContext, employeeHrId: string, employeeByHrId: Map<string, EmployeeDirectoryRow>) {
  if (isManageRole(context)) return true;
  if (hrIdsMatch(context.hrId, employeeHrId)) return true;
  if (employeeIsUnderManager(context.hrId, employeeHrId, employeeByHrId)) return true;
  return false;
}

function extraLeaveRecipients() {
  return String(
    [
      process.env.LEAVE_NOTIFICATION_CC_EMAILS,
      process.env.LEAVE_SFI_EMAILS,
      process.env.LEAVE_SFE_EMAILS,
    ]
      .filter(Boolean)
      .join(";"),
  )
    .split(/[;,]/)
    .map((email) => email.trim())
    .filter(Boolean);
}

export async function getLeaveTypes(includeInactive = false) {
  const supabase = getSupabaseAdmin();
  let query = supabase.from("leave_types").select("*").order("name", { ascending: true });
  if (!includeInactive) query = query.eq("is_active", true);
  const { data, error } = await query;
  if (error) throw error;
  return ((data ?? []) as LeaveTypeRow[]).map(mapLeaveType);
}

export async function getLeavePolicies(includeInactive = false) {
  const supabase = getSupabaseAdmin();
  let query = supabase.from("leave_policies").select("*").order("is_default", { ascending: false }).order("name", { ascending: true });
  if (!includeInactive) query = query.eq("is_active", true);
  const { data, error } = await query;
  if (error) throw error;
  return ((data ?? []) as LeavePolicyRow[]).map(mapLeavePolicy);
}

export async function getDefaultLeavePolicy() {
  const policies = await getLeavePolicies(false);
  const policy = policies.find((item) => item.isDefault) ?? policies[0];
  if (!policy) throw new Error("No active leave policy is configured.");
  return policy;
}

export async function getPublicHolidays(year: number, country = "EG") {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("public_holidays")
    .select("*")
    .eq("country", country)
    .eq("year", year)
    .eq("is_active", true)
    .order("date", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as PublicHolidayRow[]).map(mapHoliday);
}

async function getLeaveTypeById(id: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("leave_types").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Leave type was not found.");
  return mapLeaveType(data as LeaveTypeRow);
}

async function getAnnualLeaveType() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("leave_types").select("*").eq("code", annualLeaveCode).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Annual Leave type is not configured.");
  return mapLeaveType(data as LeaveTypeRow);
}

async function loadDirectoryMaps() {
  const directory = await getEmployeeDirectory();
  return {
    directory,
    employeeByHrId: new Map(directory.employees.map((employee) => [cleanHrId(employee.hrId), employee])),
  };
}

async function getEmployeeOrThrow(employeeHrId: string) {
  const { employeeByHrId } = await loadDirectoryMaps();
  const employee = employeeByHrId.get(cleanHrId(employeeHrId));
  if (!employee) throw new Error(`Employee ${employeeHrId} was not found.`);
  return employee;
}

async function getBalanceRow(employeeHrId: string, leaveTypeId: string, policyId: string, year: number) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("employee_leave_balances")
    .select("*")
    .eq("employee_hr_id", cleanHrId(employeeHrId))
    .eq("leave_type_id", leaveTypeId)
    .eq("policy_id", policyId)
    .eq("year", year)
    .maybeSingle();
  if (error) throw error;
  return data ? mapBalance(data as EmployeeLeaveBalanceRow) : null;
}

async function createBalance(employee: EmployeeDirectoryRow, leaveType: LeaveType, policy: LeavePolicy, year: number) {
  const openingBalance = 0;
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("employee_leave_balances")
    .insert({
      accrued: 0,
      adjusted: 0,
      available_balance: openingBalance,
      carry_forward: 0,
      consumed: 0,
      employee_hr_id: cleanHrId(employee.hrId),
      leave_type_id: leaveType.id,
      opening_balance: openingBalance,
      pending: 0,
      policy_id: policy.id,
      year,
    })
    .select("*")
    .single();
  if (error) throw error;
  return mapBalance(data as EmployeeLeaveBalanceRow);
}

async function ensureEmployeeBalance(employee: EmployeeDirectoryRow, leaveType: LeaveType, policy: LeavePolicy, year: number) {
  return (await getBalanceRow(employee.hrId, leaveType.id, policy.id, year)) ?? (await createBalance(employee, leaveType, policy, year));
}

function applyBalanceDelta(
  balance: EmployeeLeaveBalance,
  transactionType: LeaveTransactionType,
  amount: number,
) {
  const next = { ...balance };
  if (transactionType === "opening_balance") next.openingBalance += amount;
  if (transactionType === "accrual") next.accrued += amount;
  if (transactionType === "carry_forward") next.carryForward += amount;
  if (transactionType === "adjustment") next.adjusted += amount;
  if (transactionType === "pending") next.pending += amount;
  if (transactionType === "pending_reversal") next.pending = Math.max(0, next.pending - amount);
  if (transactionType === "consumed") next.consumed += amount;
  if (transactionType === "consumed_reversal") next.consumed = Math.max(0, next.consumed - amount);
  next.availableBalance = calculateLeaveBalanceFromParts(next);
  return next;
}

async function recordBalanceTransaction(input: {
  amount: number;
  balance: EmployeeLeaveBalance;
  createdBy: string | null;
  notes?: string | null;
  requestId?: string | null;
  transactionType: LeaveTransactionType;
}) {
  const supabase = getSupabaseAdmin();
  const before = input.balance.availableBalance;
  const next = applyBalanceDelta(input.balance, input.transactionType, input.amount);

  const { error: insertError } = await supabase.from("leave_transactions").insert({
    amount: input.amount,
    balance_after: next.availableBalance,
    balance_before: before,
    created_by: input.createdBy,
    employee_hr_id: input.balance.employeeHrId,
    leave_type_id: input.balance.leaveTypeId,
    notes: input.notes ?? null,
    policy_id: input.balance.policyId,
    request_id: input.requestId ?? null,
    transaction_type: input.transactionType,
  });
  if (insertError) throw insertError;

  const { data: updated, error: updateError } = await supabase
    .from("employee_leave_balances")
    .update({
      accrued: next.accrued,
      adjusted: next.adjusted,
      available_balance: next.availableBalance,
      carry_forward: next.carryForward,
      consumed: next.consumed,
      opening_balance: next.openingBalance,
      pending: next.pending,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.balance.id)
    .select("*")
    .single();
  if (updateError) throw updateError;

  return mapBalance(updated as EmployeeLeaveBalanceRow);
}

function isAnnualBalanceType(leaveType: LeaveType) {
  return leaveType.code === annualLeaveCode;
}

function shouldReserveBalanceOnSubmit(leaveType: LeaveType, paymentStatus: LeavePaymentStatus) {
  return paymentStatus === "paid" && balanceConsumingSubmitLeaveCodes.has(leaveType.code);
}

async function accrueMonthlyForEmployee(
  employee: EmployeeDirectoryRow,
  leaveType: LeaveType,
  policy: LeavePolicy,
  year: number,
  throughMonth: number,
  actor: string | null,
) {
  if (!isAnnualBalanceType(leaveType) || policy.accrualFrequency !== "monthly") {
    return ensureEmployeeBalance(employee, leaveType, policy, year);
  }

  let balance = await ensureEmployeeBalance(employee, leaveType, policy, year);
  const supabase = getSupabaseAdmin();
  const hireDate = employee.hireDate ? new Date(`${employee.hireDate}T00:00:00.000Z`) : null;
  const firstMonth = hireDate && hireDate.getUTCFullYear() === year ? hireDate.getUTCMonth() + 1 : 1;

  for (let month = Math.max(1, firstMonth); month <= throughMonth; month += 1) {
    const period = `${year}-${String(month).padStart(2, "0")}`;
    const notes = `monthly-accrual:${period}`;
    const { data: existing, error: existingError } = await supabase
      .from("leave_transactions")
      .select("id")
      .eq("employee_hr_id", cleanHrId(employee.hrId))
      .eq("leave_type_id", leaveType.id)
      .eq("policy_id", policy.id)
      .eq("transaction_type", "accrual")
      .eq("notes", notes)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing) continue;

    const accrualDate = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    const amount = calculateMonthlyAccrual(employee, policy, accrualDate);
    if (amount <= 0) continue;
    balance = await recordBalanceTransaction({
      amount,
      balance,
      createdBy: actor,
      notes,
      transactionType: "accrual",
    });
    const { error: lastAccrualError } = await supabase
      .from("employee_leave_balances")
      .update({ last_accrual_date: accrualDate, updated_at: new Date().toISOString() })
      .eq("id", balance.id);
    if (lastAccrualError) throw lastAccrualError;
    balance = { ...balance, lastAccrualDate: accrualDate };
  }

  return balance;
}

function mapAuditLog(row: LeaveAuditLogRow): LeaveAuditLog {
  return {
    actorHrId: row.actor_hr_id,
    actorRole: row.actor_role,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
    employeeHrId: row.employee_hr_id,
    eventType: row.event_type,
    id: row.id,
    metadata: row.metadata ?? {},
    requestId: row.request_id,
  };
}

function buildMonthlyAccrualEntries(employee: EmployeeDirectoryRow, policy: LeavePolicy, year: number, throughMonth: number) {
  if (policy.accrualFrequency !== "monthly") return [];
  const hireDate = employee.hireDate ? new Date(`${employee.hireDate}T00:00:00.000Z`) : null;
  const firstMonth = hireDate && hireDate.getUTCFullYear() === year ? hireDate.getUTCMonth() + 1 : 1;
  const entries: Array<{ accrual_date: string; amount: number; employee_hr_id: string; period: string }> = [];

  for (let month = Math.max(1, firstMonth); month <= throughMonth; month += 1) {
    const accrualDate = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    const amount = calculateMonthlyAccrual(employee, policy, accrualDate);
    if (amount <= 0) continue;
    entries.push({
      accrual_date: accrualDate,
      amount,
      employee_hr_id: cleanHrId(employee.hrId),
      period: `${year}-${String(month).padStart(2, "0")}`,
    });
  }

  return entries;
}

async function ensureCurrentAnnualBalance(employee: EmployeeDirectoryRow, actor: string | null) {
  const policy = await getDefaultLeavePolicy();
  const leaveType = await getAnnualLeaveType();
  const now = new Date();
  const year = now.getUTCFullYear();
  return accrueMonthlyForEmployee(employee, leaveType, policy, year, now.getUTCMonth() + 1, actor);
}

export async function calculateAvailableBalance(employeeHrId: string, leaveTypeId: string, year = new Date().getUTCFullYear()) {
  const policy = await getDefaultLeavePolicy();
  const balance = await getBalanceRow(employeeHrId, leaveTypeId, policy.id, year);
  if (!balance) return 0;
  return calculateLeaveBalanceFromParts(balance);
}

export async function rebuildEmployeeLeaveBalance(employeeHrId: string, leaveTypeId: string, year = new Date().getUTCFullYear()) {
  const policy = await getDefaultLeavePolicy();
  const balance = await getBalanceRow(employeeHrId, leaveTypeId, policy.id, year);
  if (!balance) throw new Error("Leave balance was not found.");

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("leave_transactions")
    .select("*")
    .eq("employee_hr_id", cleanHrId(employeeHrId))
    .eq("leave_type_id", leaveTypeId)
    .eq("policy_id", policy.id)
    .gte("created_at", `${year}-01-01T00:00:00.000Z`)
    .lt("created_at", `${year + 1}-01-01T00:00:00.000Z`)
    .order("created_at", { ascending: true });
  if (error) throw error;

  const summary = summarizeLeaveLedger(((data ?? []) as LeaveTransactionRow[]).map(mapTransaction));
  const { data: updated, error: updateError } = await supabase
    .from("employee_leave_balances")
    .update({
      accrued: summary.accrued,
      adjusted: summary.adjusted,
      available_balance: summary.availableBalance,
      carry_forward: summary.carryForward,
      consumed: summary.consumed,
      opening_balance: summary.openingBalance,
      pending: summary.pending,
      updated_at: new Date().toISOString(),
    })
    .eq("id", balance.id)
    .select("*")
    .single();
  if (updateError) throw updateError;
  return mapBalance(updated as EmployeeLeaveBalanceRow);
}

export async function getEmployeeLeaveWallet(access: AccessContext, employeeHrId = access.hrId ?? ""): Promise<LeaveWallet> {
  await assertPermission(access, "leave", "read");
  if (!isManageRole(access) && !hrIdsMatch(access.hrId, employeeHrId)) {
    throw new Error("Forbidden: employees can only view their own leave wallet.");
  }

  const employee = await getEmployeeOrThrow(employeeHrId);
  const policy = await getDefaultLeavePolicy();
  const balance = await ensureCurrentAnnualBalance(employee, access.hrId);
  const annualEntitlement = getAnnualEntitlement(employee, policy, new Date());

  return {
    accrued: balance.accrued,
    adjusted: balance.adjusted,
    annualEntitlement,
    available: balance.availableBalance,
    balance,
    carryForward: balance.carryForward,
    openingBalance: balance.openingBalance,
    pending: balance.pending,
    used: balance.consumed,
  };
}

async function loadRequestApprovals(requestIds: string[]) {
  if (requestIds.length === 0) return new Map<string, LeaveApproval[]>();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("leave_approvals")
    .select("*")
    .in("request_id", requestIds)
    .order("created_at", { ascending: true });
  if (error) throw error;
  const grouped = new Map<string, LeaveApproval[]>();
  for (const approval of ((data ?? []) as LeaveApprovalRow[]).map(mapApproval)) {
    grouped.set(approval.requestId, [...(grouped.get(approval.requestId) ?? []), approval]);
  }
  return grouped;
}

function applyFilters(requests: LeaveRequest[], filters: LeaveRequestFilters) {
  return requests.filter((request) => {
    const employee = request.employee;
    if (filters.employeeHrId && !cleanHrId(request.employeeHrId).includes(cleanHrId(filters.employeeHrId))) return false;
    if (filters.employee) {
      const needle = filters.employee.trim().toLowerCase();
      const haystack = `${employee?.fullName ?? ""} ${request.employeeHrId}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    if (filters.line && employee?.lineName !== filters.line) return false;
    if (filters.area && employee?.areaName !== filters.area) return false;
    if (filters.managerHrId && !hrIdsMatch(employee?.managerHrId, filters.managerHrId)) return false;
    if (filters.status && request.status !== filters.status) return false;
    if (filters.leaveTypeId && request.leaveTypeId !== filters.leaveTypeId) return false;
    if (filters.year && new Date(`${request.startDate}T00:00:00.000Z`).getUTCFullYear() !== filters.year) return false;
    if (filters.month && new Date(`${request.startDate}T00:00:00.000Z`).getUTCMonth() + 1 !== filters.month) return false;
    if (filters.startDate && request.endDate < filters.startDate) return false;
    if (filters.endDate && request.startDate > filters.endDate) return false;
    return true;
  });
}

export async function listLeaveRequests(access: AccessContext, filters: LeaveRequestFilters = {}) {
  await assertPermission(access, "leave", "read");
  const supabase = getSupabaseAdmin();
  const limit = Math.min(1000, Math.max(1, Math.trunc(Number(filters.limit ?? 1000))));
  const offset = Math.max(0, Math.trunc(Number(filters.offset ?? 0)));
  const { data, error } = await supabase
    .from("leave_requests")
    .select("*,leave_types(code,name,is_paid,affects_payroll)")
    .order("requested_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;

  const { employeeByHrId } = await loadDirectoryMaps();
  const approvalMap = await loadRequestApprovals(((data ?? []) as LeaveRequestRow[]).map((row) => row.id));
  const requests = ((data ?? []) as LeaveRequestRow[])
    .map((row) => mapLeaveRequest(row, employeeByHrId, approvalMap.get(row.id) ?? []))
    .filter(
      (request) =>
        canSeeLeaveEmployee(access, request.employeeHrId, employeeByHrId) ||
        (payrollCanRead(access) && Boolean(request.leaveType?.affectsPayroll)),
    );

  return applyFilters(requests, filters);
}

async function listManagerHierarchyLeaveRequests(access: AccessContext, filters: LeaveRequestFilters = {}) {
  const requests = await listLeaveRequests(access, filters);
  if (isManageRole(access)) return requests;
  const { employeeByHrId } = await loadDirectoryMaps();
  return requests.filter(
    (request) =>
      hrIdsMatch(access.hrId, request.employeeHrId) ||
      employeeIsUnderManager(access.hrId, request.employeeHrId, employeeByHrId),
  );
}

async function loadAllLeaveRequestsForEngine(filters: LeaveRequestFilters = {}) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("leave_requests")
    .select("*,leave_types(code,name,is_paid,affects_payroll)")
    .order("requested_at", { ascending: false })
    .limit(3000);
  if (error) throw error;
  const { employeeByHrId } = await loadDirectoryMaps();
  return applyFilters(
    ((data ?? []) as LeaveRequestRow[]).map((row) => mapLeaveRequest(row, employeeByHrId, [])),
    filters,
  );
}

export async function getLeaveRequestDetails(access: AccessContext, id: string) {
  const requests = await listLeaveRequests(access, {});
  const request = requests.find((item) => item.id === id);
  if (!request) throw new Error("Leave request was not found or is not accessible.");
  return request;
}

export async function getLeaveAttachmentDownloadUrl(access: AccessContext, requestId: string) {
  const request = await getLeaveRequestDetails(access, requestId);
  if (!request.attachmentUrl) throw new Error("This leave request has no attachment.");
  const url = await getLeaveAttachmentUrl(request.attachmentUrl);
  if (!url) throw new Error("Attachment is not available for download.");
  await writeLeaveAuditLog({
    actorHrId: access.hrId,
    actorRole: access.role,
    employeeHrId: request.employeeHrId,
    eventType: "leave.attachment.download_url.created",
    metadata: { storageReference: request.attachmentUrl.startsWith("supabase://") ? "supabase" : "local" },
    requestId,
  });
  return { url };
}

export async function listLeaveAuditLogs(access: AccessContext, limit = 80): Promise<LeaveAuditLog[]> {
  await assertPermission(access, "leave", "read");
  if (!isManageRole(access)) return [];
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("leave_audit_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));
  if (error) throw error;
  return ((data ?? []) as LeaveAuditLogRow[]).map(mapAuditLog);
}

async function notifyLeaveSubmitted(request: LeaveRequest) {
  const employee = request.employee;
  await emitLeaveNotification("request_submitted", {
    ctaHref: "/employee-portals/leave-approvals",
    ctaLabel: "Open leave approval",
    employeeHrId: request.employeeHrId,
    includeHrInbox: true,
    metrics: [
      { label: "Employee", value: employee?.fullName ?? request.employeeHrId },
      { label: "HR ID", value: request.employeeHrId },
      { label: "Title", value: employee?.jobTitle ?? "N/A" },
      { label: "Area", value: employee?.areaName ?? "N/A" },
      { label: "Line", value: employee?.lineName ?? "N/A" },
      { label: "Leave Type", value: request.leaveType?.name ?? "Leave" },
      { label: "From", value: request.startDate },
      { label: "To", value: request.endDate },
      { label: "Duration", value: `${request.totalWorkingDays} working days` },
      { label: "Reason", value: request.reason ?? "N/A" },
    ],
    recipientMode: "manager_chain",
    recipients: extraLeaveRecipients(),
    subject: `Leave approval needed - ${employee?.fullName ?? request.employeeHrId}`,
    summary: `${employee?.fullName ?? request.employeeHrId} submitted ${request.leaveType?.name ?? "a leave request"} from ${request.startDate} to ${request.endDate}.`,
    title: "Leave Approval Needed",
    tone: "warning",
  });
}

async function notifyLeaveDecision(request: LeaveRequest, decision: string) {
  const event = decision.includes("manager approved")
    ? "manager_approved"
    : decision.includes("manager rejected")
      ? "manager_rejected"
      : decision.includes("cancelled")
        ? "cancelled"
        : decision.includes("approved")
          ? "hr_approved"
          : "hr_rejected";
  await emitLeaveNotification(event, {
    ctaHref: "/employee-portals/leave",
    ctaLabel: "Open leave report",
    employeeHrId: request.employeeHrId,
    includeHrInbox: true,
    metrics: [
      { label: "Employee", value: request.employee?.fullName ?? request.employeeHrId },
      { label: "HR ID", value: request.employeeHrId },
      { label: "Leave Type", value: request.leaveType?.name ?? "Leave" },
      { label: "From", value: request.startDate },
      { label: "To", value: request.endDate },
      { label: "Duration", value: `${request.totalWorkingDays} working days` },
      { label: "Status", value: decision },
    ],
    recipientMode: "employee",
    recipients: extraLeaveRecipients(),
    subject: `Leave request ${decision} - ${request.employee?.fullName ?? request.employeeHrId}`,
    summary: `Your leave request from ${request.startDate} to ${request.endDate} is now ${decision}.`,
    title: "Leave Request Updated",
    tone: decision.includes("approved") ? "success" : decision.includes("cancelled") ? "neutral" : "danger",
  });
}

export async function previewLeaveConflicts(
  access: AccessContext,
  input: Pick<SubmitLeaveRequestInput, "endDate" | "startDate">,
): Promise<LeaveConflictResult> {
  await assertPermission(access, "leave", "create");
  if (!access.hrId) throw new Error("A linked employee HR_ID is required to preview leave conflicts.");
  if (!input.startDate || !input.endDate) throw new Error("Start and end dates are required.");
  calculateCalendarLeaveDays(input.startDate, input.endDate);
  const employee = await getEmployeeOrThrow(access.hrId);
  const policy = await getDefaultLeavePolicy();
  const startYear = new Date(`${input.startDate}T00:00:00.000Z`).getUTCFullYear();
  const endYear = new Date(`${input.endDate}T00:00:00.000Z`).getUTCFullYear();
  const holidays = startYear === endYear
    ? await getPublicHolidays(startYear, policy.country)
    : [
        ...(await getPublicHolidays(startYear, policy.country)),
        ...(await getPublicHolidays(endYear, policy.country)),
      ];
  const result = detectLeaveConflicts({
    employee,
    endDate: input.endDate,
    existingRequests: await loadAllLeaveRequestsForEngine(),
    startDate: input.startDate,
  }, {
    publicHolidayDates: holidays.map((holiday) => holiday.date),
    weekendDays: getWeekendDaysForEmployee(employee, policy.weekendDays),
  });
  const { employeeByHrId } = await loadDirectoryMaps();
  const canApprove = await canAccess(access, "leave", "approve");
  const visibleOverlappingRequests = isManageRole(access)
    ? result.overlappingRequests
    : canApprove
      ? result.overlappingRequests.filter((request) => employeeIsUnderManager(access.hrId, request.employeeHrId, employeeByHrId))
      : [];
  return { ...result, overlappingRequests: visibleOverlappingRequests };
}

export async function submitLeaveRequest(access: AccessContext, input: SubmitLeaveRequestInput) {
  await assertPermission(access, "leave", "create");
  if (!access.hrId) throw new Error("A linked employee HR_ID is required to submit leave.");
  if (!input.leaveTypeId || !input.startDate || !input.endDate) throw new Error("Leave type and date range are required.");

  const employee = await getEmployeeOrThrow(access.hrId);
  const leaveType = await getLeaveTypeById(input.leaveTypeId);
  if (!employeeSelectableLeaveCodes.has(leaveType.code) || leaveType.code === unpaidLeaveCode || !leaveType.employeeSelectable) {
    throw new Error("This leave type is not available for employee self-service.");
  }

  const policy = await getDefaultLeavePolicy();
  const startYear = new Date(`${input.startDate}T00:00:00.000Z`).getUTCFullYear();
  const endYear = new Date(`${input.endDate}T00:00:00.000Z`).getUTCFullYear();
  const holidays = startYear === endYear
    ? await getPublicHolidays(startYear, policy.country)
    : [
        ...(await getPublicHolidays(startYear, policy.country)),
        ...(await getPublicHolidays(endYear, policy.country)),
      ];
  const durationUnit = normalizeDurationUnit(input.durationUnit);
  const today = isoToday();

  if (leaveType.code === emergencyLeaveCode && input.startDate !== today) {
    throw new Error("Emergency Leave must start today.");
  }
  if (leaveType.code === annualLeaveCode && input.startDate <= today) {
    throw new Error("Annual Leave must start from tomorrow or a future date.");
  }
  if (leaveType.code === sickLeaveCode && input.startDate < addDaysIso(today, -sickBackdateDays())) {
    throw new Error(`Sick Leave can only be backdated ${sickBackdateDays()} day(s).`);
  }
  if (leaveType.code === sickLeaveCode && input.startDate > today) {
    throw new Error("Sick Leave cannot start in the future.");
  }
  if (leaveType.code === otherLeaveCode && input.startDate < today) {
    throw new Error("Other Leave cannot start in the past.");
  }

  const totalCalendarDays = calculateCalendarLeaveDays(input.startDate, input.endDate);
  const weekendDays = getWeekendDaysForEmployee(employee, policy.weekendDays);
  const totalWorkingDays = calculateLeaveDuration(
    input.startDate,
    input.endDate,
    holidays.map((holiday) => holiday.date),
    weekendDays,
    durationUnit,
  );

  if (totalWorkingDays <= 0) throw new Error("The selected range contains no working leave days.");
  if (leaveType.code === sickLeaveCode && !input.attachmentUrl) throw new Error(sickLeaveCertificateText);
  if (leaveType.requiresAttachment && !input.attachmentUrl) throw new Error(`${leaveType.name} requires an attachment.`);
  await previewLeaveConflicts(access, input);

  const annualLeaveType = await getAnnualLeaveType();
  const balanceCandidate = balanceConsumingSubmitLeaveCodes.has(leaveType.code) || leaveType.code === otherLeaveCode;
  const balanceLeaveTypeId = balanceCandidate ? annualLeaveType.id : null;
  const currentAnnualBalance = balanceCandidate ? await ensureCurrentAnnualBalance(employee, access.hrId) : null;
  const unpaidReasons: string[] = [];
  if (balanceConsumingSubmitLeaveCodes.has(leaveType.code) && isWithinFirstSixMonths(employee.hireDate, input.startDate)) {
    unpaidReasons.push("Probation period: employee is within first 6 months from hire date.");
  }
  if (balanceConsumingSubmitLeaveCodes.has(leaveType.code) && currentAnnualBalance && currentAnnualBalance.availableBalance < totalWorkingDays) {
    unpaidReasons.push(`Insufficient available leave balance. Available: ${currentAnnualBalance.availableBalance} day(s).`);
  }
  const paymentStatus: LeavePaymentStatus = balanceConsumingSubmitLeaveCodes.has(leaveType.code)
    ? unpaidReasons.length ? "unpaid" : "paid"
    : leaveType.code === sickLeaveCode || leaveType.code === otherLeaveCode
      ? "in_review"
      : leaveType.isPaid ? "paid" : "unpaid";
  const paymentReason = paymentStatus === "unpaid"
    ? paymentReasonText(unpaidReasons)
    : leaveType.code === sickLeaveCode
      ? "Sick leave document pending HR review."
      : leaveType.code === otherLeaveCode
        ? "HR deduction decision required."
        : null;
  const shouldConsume = shouldReserveBalanceOnSubmit(leaveType, paymentStatus);
  const throughMonth = new Date().getUTCFullYear() === startYear ? new Date().getUTCMonth() + 1 : 12;
  const accruals = shouldConsume ? buildMonthlyAccrualEntries(employee, policy, startYear, throughMonth) : [];
  const correlationId = createLeaveCorrelationId();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .rpc("phx_leave_submit_request_atomic", {
      p_accruals: accruals,
      p_actor_hr_id: access.hrId,
      p_actor_role: access.role,
      p_allow_negative_balance: policy.allowNegativeBalance,
      p_attachment_url: input.attachmentUrl ?? null,
      p_balance_leave_type_id: balanceLeaveTypeId,
      p_correlation_id: correlationId,
      p_duration_unit: durationUnit,
      p_employee_hr_id: cleanHrId(employee.hrId),
      p_end_date: input.endDate,
      p_hr_status: leaveType.requiresHrApproval ? "pending" : "not_required",
      p_leave_type_id: leaveType.id,
      p_manager_status: leaveType.requiresManagerApproval ? "pending" : "not_required",
      p_payroll_status: leaveType.affectsPayroll ? "pending" : "not_required",
      p_payment_reason: paymentReason,
      p_payment_status: paymentStatus,
      p_policy_id: policy.id,
      p_reason: input.reason?.trim() || null,
      p_should_consume: shouldConsume,
      p_start_date: input.startDate,
      p_status: leaveType.requiresManagerApproval ? "pending_manager" : "pending_hr",
      p_total_calendar_days: totalCalendarDays,
      p_total_working_days: totalWorkingDays,
    })
    .single();
  if (error) {
    await writeLeaveAuditLog({
      actorHrId: access.hrId,
      actorRole: access.role,
      correlationId,
      employeeHrId: employee.hrId,
      eventType: "leave.request.submit.failed",
      metadata: { durationUnit, error: error.message, leaveTypeId: leaveType.id, paymentStatus, startDate: input.startDate, endDate: input.endDate },
    });
    throw error;
  }

  const request = await getLeaveRequestDetails(access, (data as LeaveRequestRow).id);
  await notifyLeaveSubmitted(request).catch(() => undefined);
  return request;
}

async function loadRequestRow(id: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("leave_requests")
    .select("*,leave_types(code,name,is_paid,affects_payroll)")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Leave request was not found.");
  return data as LeaveRequestRow;
}

async function hydrateLeaveRequest(row: LeaveRequestRow) {
  const { employeeByHrId } = await loadDirectoryMaps();
  const approvalMap = await loadRequestApprovals([row.id]);
  return mapLeaveRequest(row, employeeByHrId, approvalMap.get(row.id) ?? []);
}

export async function decideLeaveAsManager(access: AccessContext, requestId: string, input: LeaveDecisionInput) {
  await assertPermission(access, "leave", "approve");
  if (input.decision === "rejected" && !input.comment?.trim()) {
    throw new Error("A rejection comment is required.");
  }

  const row = await loadRequestRow(requestId);
  const { employeeByHrId } = await loadDirectoryMaps();
  if (!isManageRole(access) && !employeeIsUnderManager(access.hrId, row.employee_hr_id, employeeByHrId)) {
    throw new Error("Forbidden: managers can only approve their own team requests.");
  }
  if (row.status !== "pending_manager") throw new Error("This request is not pending manager approval.");

  const correlationId = createLeaveCorrelationId();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .rpc("phx_leave_manager_decision_atomic", {
      p_actor_hr_id: access.hrId,
      p_actor_role: access.role,
      p_comment: input.comment?.trim() || null,
      p_correlation_id: correlationId,
      p_decision: input.decision,
      p_request_id: requestId,
    })
    .single();
  if (error) {
    await writeLeaveAuditLog({
      actorHrId: access.hrId,
      actorRole: access.role,
      correlationId,
      employeeHrId: row.employee_hr_id,
      eventType: "leave.manager.decision.failed",
      metadata: { decision: input.decision, error: error.message, requestId },
      requestId,
    });
    throw error;
  }

  const request = await hydrateLeaveRequest(data as LeaveRequestRow);
  await notifyLeaveDecision(request, input.decision === "approved" ? "manager approved" : "manager rejected").catch(() => undefined);
  return request;
}

export async function decideLeaveAsHr(access: AccessContext, requestId: string, input: LeaveDecisionInput) {
  await assertPermission(access, "leave", "approve");
  if (!isManageRole(access)) throw new Error("Forbidden: HR approval requires HR or Super Admin access.");
  if (input.decision === "rejected" && !input.comment?.trim()) {
    throw new Error("A rejection comment is required.");
  }

  const row = await loadRequestRow(requestId);
  if (row.status !== "pending_hr" && row.status !== "manager_approved") {
    throw new Error("This request is not pending HR approval.");
  }
  const leaveType = await getLeaveTypeById(row.leave_type_id);
  if (input.decision === "approved" && leaveType.code === otherLeaveCode && input.balanceDecision !== "deduct" && input.balanceDecision !== "no_deduct") {
    throw new Error("HR must choose whether Other leave deducts from balance.");
  }
  if (input.decision === "approved" && leaveType.code === otherLeaveCode && input.balanceDecision === "deduct") {
    if (!row.balance_leave_type_id) throw new Error("Other leave cannot deduct balance because no balance leave type is linked.");
    const requestYear = new Date(`${row.start_date}T00:00:00.000Z`).getUTCFullYear();
    const availableBalance = await calculateAvailableBalance(row.employee_hr_id, row.balance_leave_type_id, requestYear);
    if (availableBalance < n(row.total_working_days)) {
      throw new Error(`Insufficient available balance to deduct Other leave. Available: ${availableBalance} day(s).`);
    }
  }

  const correlationId = createLeaveCorrelationId();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .rpc("phx_leave_hr_decision_atomic", {
      p_actor_hr_id: access.hrId,
      p_actor_role: access.role,
      p_balance_decision: input.balanceDecision ?? null,
      p_comment: input.comment?.trim() || null,
      p_correlation_id: correlationId,
      p_decision: input.decision,
      p_request_id: requestId,
    })
    .single();
  if (error) {
    await writeLeaveAuditLog({
      actorHrId: access.hrId,
      actorRole: access.role,
      correlationId,
      employeeHrId: row.employee_hr_id,
      eventType: "leave.hr.decision.failed",
      metadata: { balanceDecision: input.balanceDecision ?? null, decision: input.decision, error: error.message, requestId },
      requestId,
    });
    throw error;
  }

  const request = await hydrateLeaveRequest(data as LeaveRequestRow);
  await notifyLeaveDecision(request, input.decision === "approved" ? "approved" : "rejected").catch(() => undefined);
  return request;
}

export async function cancelLeaveRequest(access: AccessContext, requestId: string, comment?: string | null) {
  const row = await loadRequestRow(requestId);
  if (!isManageRole(access) && !hrIdsMatch(access.hrId, row.employee_hr_id)) {
    throw new Error("Forbidden: employees can only cancel their own leave requests.");
  }
  if (row.status === "hr_approved" && !isManageRole(access)) {
    throw new Error("Approved leave requires HR to cancel.");
  }

  const correlationId = createLeaveCorrelationId();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .rpc("phx_leave_cancel_request_atomic", {
      p_actor_hr_id: access.hrId,
      p_actor_role: access.role,
      p_comment: comment?.trim() || null,
      p_correlation_id: correlationId,
      p_request_id: requestId,
    })
    .single();
  if (error) {
    await writeLeaveAuditLog({
      actorHrId: access.hrId,
      actorRole: access.role,
      correlationId,
      employeeHrId: row.employee_hr_id,
      eventType: "leave.request.cancel.failed",
      metadata: { comment: comment?.trim() || null, error: error.message, requestId },
      requestId,
    });
    throw error;
  }

  const request = await hydrateLeaveRequest(data as LeaveRequestRow);
  await notifyLeaveDecision(request, "cancelled").catch(() => undefined);
  return request;
}

export async function adjustLeaveBalance(access: AccessContext, input: LeaveAdjustmentInput) {
  await assertPermission(access, "leave", "update");
  if (!isManageRole(access)) throw new Error("Forbidden: manual leave adjustment requires HR or Super Admin access.");
  if (!input.reason?.trim()) throw new Error("Manual adjustment reason is required.");
  if (!Number.isFinite(input.amount) || input.amount === 0) throw new Error("Adjustment amount must be a non-zero number.");

  const year = input.year ?? new Date().getUTCFullYear();
  const employee = await getEmployeeOrThrow(input.employeeHrId);
  const leaveType = await getLeaveTypeById(input.leaveTypeId);
  const policy = await getDefaultLeavePolicy();
  const correlationId = createLeaveCorrelationId();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .rpc("phx_leave_adjust_balance_atomic", {
      p_actor_hr_id: access.hrId,
      p_actor_role: access.role,
      p_amount: input.amount,
      p_correlation_id: correlationId,
      p_employee_hr_id: employee.hrId,
      p_leave_type_id: leaveType.id,
      p_policy_id: policy.id,
      p_reason: input.reason,
      p_year: year,
    })
    .single();
  if (error) {
    await writeLeaveAuditLog({
      actorHrId: access.hrId,
      actorRole: access.role,
      correlationId,
      employeeHrId: employee.hrId,
      eventType: "leave.balance.adjust.failed",
      metadata: { amount: input.amount, error: error.message, leaveTypeId: leaveType.id, reason: input.reason, year },
    });
    throw error;
  }
  const adjustedBalance = mapBalance(data as EmployeeLeaveBalanceRow);
  await emitLeaveNotification("balance_adjusted", {
    ctaHref: "/admin/leave",
    ctaLabel: "Open leave management",
    employeeHrId: employee.hrId,
    includeHrInbox: true,
    metrics: [
      { label: "Employee", value: `${employee.fullName} (${employee.hrId})` },
      { label: "Leave Type", value: leaveType.name },
      { label: "Amount", value: input.amount },
      { label: "Reason", value: input.reason },
      { label: "Available Balance", value: adjustedBalance.availableBalance },
    ],
    recipientMode: "hr_notifications",
    subject: `Leave balance adjusted - ${employee.fullName}`,
    summary: `${leaveType.name} balance for ${employee.fullName} was adjusted by ${input.amount} day(s).`,
    title: "Leave Balance Adjusted",
    tone: "neutral",
  }).catch(() => undefined);
  return adjustedBalance;
}

function nextAccrualPeriod(year: number, month: number) {
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}`;
}

export async function getLeaveAccrualPreview(access: AccessContext, input: { month?: number; year?: number } = {}): Promise<LeaveAccrualPreview> {
  await assertPermission(access, "leave", "update");
  if (!isManageRole(access)) throw new Error("Forbidden: leave accrual requires HR or Super Admin access.");

  const now = new Date();
  const year = input.year ?? now.getUTCFullYear();
  const month = input.month ?? now.getUTCMonth() + 1;
  const { directory } = await loadDirectoryMaps();
  const policy = await getDefaultLeavePolicy();
  const leaveType = await getAnnualLeaveType();
  const period = `${year}-${String(month).padStart(2, "0")}`;
  const notes = `monthly-accrual:${period}`;
  const supabase = getSupabaseAdmin();
  const activeEmployees = directory.employees.filter((employee) => (employee.employmentStatus ?? "active").toLowerCase() === "active");
  const { data: existingRows, error: existingError } = await supabase
    .from("leave_transactions")
    .select("employee_hr_id,created_at")
    .eq("leave_type_id", leaveType.id)
    .eq("policy_id", policy.id)
    .eq("transaction_type", "accrual")
    .eq("notes", notes)
    .limit(5000);
  if (existingError) throw existingError;
  const { data: lastRows, error: lastError } = await supabase
    .from("leave_transactions")
    .select("created_at")
    .eq("leave_type_id", leaveType.id)
    .eq("policy_id", policy.id)
    .eq("transaction_type", "accrual")
    .like("notes", "monthly-accrual:%")
    .order("created_at", { ascending: false })
    .limit(1);
  if (lastError) throw lastError;
  const { data: balanceRows, error: balanceError } = await supabase
    .from("employee_leave_balances")
    .select("employee_hr_id,last_accrual_date")
    .eq("leave_type_id", leaveType.id)
    .eq("policy_id", policy.id)
    .eq("year", year)
    .limit(5000);
  if (balanceError) throw balanceError;

  const accruedEmployees = new Set(((existingRows ?? []) as Array<{ employee_hr_id: string }>).map((row) => cleanHrId(row.employee_hr_id)));
  const lastAccrualByEmployee = new Map(
    ((balanceRows ?? []) as Array<{ employee_hr_id: string; last_accrual_date: string | null }>).map((row) => [
      cleanHrId(row.employee_hr_id),
      row.last_accrual_date,
    ]),
  );
  const employees = activeEmployees.map((employee) => {
    const monthlyAccrual = calculateMonthlyAccrual(employee, policy, new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10));
    return {
      alreadyAccrued: accruedEmployees.has(cleanHrId(employee.hrId)),
      employeeHrId: employee.hrId,
      employeeName: employee.fullName,
      lastAccrualDate: lastAccrualByEmployee.get(cleanHrId(employee.hrId)) ?? null,
      lineName: employee.lineName,
      monthlyAccrual,
    };
  });
  const pendingEmployees = employees.filter((employee) => !employee.alreadyAccrued && employee.monthlyAccrual > 0);

  return {
    alreadyAccrued: employees.length - pendingEmployees.length,
    employees,
    lastRunAt: ((lastRows ?? [])[0] as { created_at?: string } | undefined)?.created_at ?? null,
    month,
    period,
    totalAccrualDays: Math.round(pendingEmployees.reduce((sum, employee) => sum + employee.monthlyAccrual, 0) * 100) / 100,
    upcomingPeriod: nextAccrualPeriod(year, month),
    wouldAccrue: pendingEmployees.length,
    year,
  };
}

export async function runMonthlyLeaveAccrual(access: AccessContext, input: { month?: number; year?: number } = {}) {
  const preview = await getLeaveAccrualPreview(access, input);
  const year = preview.year;
  const month = preview.month;
  const { directory } = await loadDirectoryMaps();
  const policy = await getDefaultLeavePolicy();
  const leaveType = await getAnnualLeaveType();
  const entries = [];

  for (const employee of directory.employees) {
    if ((employee.employmentStatus ?? "active").toLowerCase() !== "active") continue;
    entries.push(...buildMonthlyAccrualEntries(employee, policy, year, month));
  }

  const correlationId = createLeaveCorrelationId();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("phx_leave_run_accrual_atomic", {
    p_actor_hr_id: access.hrId,
    p_actor_role: access.role,
    p_correlation_id: correlationId,
    p_entries: entries,
    p_leave_type_id: leaveType.id,
    p_month: month,
    p_policy_id: policy.id,
    p_year: year,
  });
  if (error) {
    await writeLeaveAuditLog({
      actorHrId: access.hrId,
      actorRole: access.role,
      correlationId,
      eventType: "leave.accrual.failed",
      metadata: { error: error.message, month, period: preview.period, year },
    });
    throw error;
  }
  const result = (data ?? {}) as { processed?: number; skipped?: number; totalAmount?: number };

  await emitLeaveNotification("accrual_completed", {
    ctaHref: "/admin/leave",
    ctaLabel: "Open accrual tools",
    includeHrInbox: true,
    metrics: [
      { label: "Period", value: preview.period },
      { label: "Employees Previewed", value: preview.employees.length },
      { label: "Would Accrue", value: preview.wouldAccrue },
      { label: "Estimated Days", value: preview.totalAccrualDays },
      { label: "Processed Transactions", value: result.processed ?? 0 },
    ],
    recipientMode: "hr_notifications",
    subject: `Leave accrual completed - ${preview.period}`,
    summary: `Monthly leave accrual completed for ${preview.period}. The pre-run preview estimated ${preview.totalAccrualDays} day(s).`,
    title: "Monthly Leave Accrual Completed",
    tone: "success",
  }).catch(() => undefined);
  return { month, period: preview.period, processed: result.processed ?? 0, skipped: result.skipped ?? 0, totalAmount: result.totalAmount ?? 0, year };
}

export async function getLeaveCalendar(
  access: AccessContext,
  input: { area?: string; employeeHrId?: string; line?: string; month?: number; status?: string; year?: number } = {},
): Promise<LeaveCalendarItem[]> {
  await assertPermission(access, "leave", "read");
  const month = input.month ?? new Date().getUTCMonth() + 1;
  const year = input.year ?? new Date().getUTCFullYear();
  const policy = await getDefaultLeavePolicy();
  const hasApproveAccess = await canAccess(access, "leave", "approve");
  const [requests, holidays] = await Promise.all([
    hasApproveAccess && !isManageRole(access) ? listManagerHierarchyLeaveRequests(access, {}) : listLeaveRequests(access, {}),
    getPublicHolidays(year, policy.country).catch(() => []),
  ]);
  return buildLeaveCalendarItems(requests, holidays, {
    area: input.area,
    employeeHrId: input.employeeHrId,
    line: input.line,
    month,
    status: input.status,
    year,
  });
}

export async function getLeaveTeamAvailability(
  access: AccessContext,
  input: { area?: string; employeeHrId?: string; endDate?: string; line?: string; startDate?: string } = {},
): Promise<TeamAvailabilityDay[]> {
  await assertPermission(access, "leave", "read");
  const startDate = input.startDate ?? isoToday();
  const endDate = input.endDate ?? new Date(Date.now() + 13 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const year = new Date(`${startDate}T00:00:00.000Z`).getUTCFullYear();
  const policy = await getDefaultLeavePolicy();
  const hasApproveAccess = await canAccess(access, "leave", "approve");
  const [requests, holidays] = await Promise.all([
    hasApproveAccess && !isManageRole(access) ? listManagerHierarchyLeaveRequests(access, {}) : listLeaveRequests(access, {}),
    getPublicHolidays(year, policy.country).catch(() => []),
  ]);
  return buildTeamAvailability(requests, holidays, {
    area: input.area,
    employeeHrId: input.employeeHrId,
    endDate,
    line: input.line,
    startDate,
  });
}

export async function getLeaveDashboard(access: AccessContext) {
  await assertPermission(access, "leave", "read");
  const requests = await listLeaveRequests(access);
  const today = isoToday();
  const policy = await getDefaultLeavePolicy();
  const holidays = await getPublicHolidays(new Date().getUTCFullYear(), policy.country).catch(() => []);
  const analytics: LeaveAnalytics = buildLeaveAnalytics(requests, holidays);
  const approved = requests.filter((request) => request.status === "hr_approved");
  const pending = requests.filter((request) => request.status === "pending_manager" || request.status === "pending_hr");
  const byLine = new Map<string, number>();
  const balanceUtilization = new Map<string, { available: number; used: number }>();

  for (const request of approved) {
    const line = request.employee?.lineName ?? "Unassigned";
    byLine.set(line, (byLine.get(line) ?? 0) + request.totalWorkingDays);
  }

  const annualType = await getAnnualLeaveType().catch(() => null);
  const { directory } = await loadDirectoryMaps();
  if (annualType) {
    for (const employee of directory.employees) {
      if (!canSeeLeaveEmployee(access, employee.hrId, new Map(directory.employees.map((row) => [cleanHrId(row.hrId), row])))) continue;
      const wallet = await getEmployeeLeaveWallet({ ...access, hrId: access.hrId }, employee.hrId).catch(() => null);
      if (!wallet) continue;
      const line = employee.lineName ?? "Unassigned";
      const current = balanceUtilization.get(line) ?? { available: 0, used: 0 };
      current.available += wallet.available;
      current.used += wallet.used;
      balanceUtilization.set(line, current);
    }
  }

  return {
    analytics,
    approvedRequests: approved.length,
    employeesOnLeaveToday: approved.filter((request) => request.startDate <= today && request.endDate >= today).length,
    leaveBalanceUtilization: Array.from(balanceUtilization.entries()).map(([line, value]) => ({
      line,
      available: Math.round(value.available * 100) / 100,
      used: Math.round(value.used * 100) / 100,
      utilization: value.used + value.available > 0 ? Math.round((value.used / (value.used + value.available)) * 100) : 0,
    })),
    leaveDaysByLine: Array.from(byLine.entries()).map(([line, days]) => ({ days, line })),
    pendingRequests: pending.length,
    rejectedRequests: requests.filter((request) => request.status === "manager_rejected" || request.status === "hr_rejected").length,
    totalRequests: requests.length,
    upcomingLeaves: approved.filter((request) => request.startDate > today).length,
  };
}

export async function exportLeaveRequestsToExcel(access: AccessContext, filters: LeaveRequestFilters = {}) {
  await assertPermission(access, "leave", "export");
  const rows = await listLeaveRequests(access, filters);
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Leave Requests");
  worksheet.columns = [
    { header: "Employee HR ID", key: "employeeHrId", width: 18 },
    { header: "Employee Name", key: "employeeName", width: 28 },
    { header: "Title", key: "title", width: 24 },
    { header: "Line", key: "line", width: 18 },
    { header: "Area", key: "area", width: 18 },
    { header: "Direct Manager", key: "manager", width: 24 },
    { header: "Leave Type", key: "type", width: 20 },
    { header: "From Date", key: "from", width: 14 },
    { header: "To Date", key: "to", width: 14 },
    { header: "Duration", key: "duration", width: 12 },
    { header: "Duration Unit", key: "durationUnit", width: 14 },
    { header: "Payment Status", key: "paymentStatus", width: 18 },
    { header: "Payment Reason", key: "paymentReason", width: 34 },
    { header: "Status", key: "status", width: 18 },
    { header: "Manager Decision", key: "managerStatus", width: 18 },
    { header: "HR Decision", key: "hrStatus", width: 18 },
    { header: "Submitted At", key: "submittedAt", width: 22 },
    { header: "Updated At", key: "updatedAt", width: 22 },
  ];

  for (const request of rows) {
    worksheet.addRow({
      area: request.employee?.areaName ?? "",
      duration: request.totalWorkingDays,
      durationUnit: request.durationUnit,
      employeeHrId: request.employeeHrId,
      employeeName: request.employee?.fullName ?? "",
      from: request.startDate,
      hrStatus: request.hrStatus,
      line: request.employee?.lineName ?? "",
      manager: request.employee?.managerName ?? "",
      managerStatus: request.managerStatus,
      paymentReason: request.paymentReason ?? "",
      paymentStatus: paymentStatusLabel(request.paymentStatus),
      status: request.status,
      submittedAt: request.requestedAt,
      title: request.employee?.jobTitle ?? "",
      to: request.endDate,
      type: request.leaveType?.name ?? "",
      updatedAt: request.updatedAt,
    });
  }

  worksheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  worksheet.getRow(1).fill = { fgColor: { argb: "FFF97316" }, pattern: "solid", type: "pattern" };
  return workbook.xlsx.writeBuffer();
}

export async function upsertLeaveType(access: AccessContext, input: Partial<LeaveType> & { code: string; name: string }) {
  await assertPermission(access, "leave", "update");
  if (!isManageRole(access)) throw new Error("Forbidden: leave type settings require HR or Super Admin access.");
  const supabase = getSupabaseAdmin();
  const code = input.code.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const { data, error } = await supabase
    .from("leave_types")
    .upsert({
      affects_payroll: input.affectsPayroll ?? false,
      code,
      employee_selectable: input.employeeSelectable ?? employeeSelectableLeaveCodes.has(code),
      is_active: input.isActive ?? true,
      is_paid: input.isPaid ?? true,
      name: input.name.trim(),
      requires_attachment: input.requiresAttachment ?? false,
      requires_hr_approval: input.requiresHrApproval ?? true,
      requires_manager_approval: input.requiresManagerApproval ?? true,
      updated_at: new Date().toISOString(),
    }, { onConflict: "code" })
    .select("*")
    .single();
  if (error) throw error;
  return mapLeaveType(data as LeaveTypeRow);
}

export async function upsertLeavePolicy(access: AccessContext, input: Partial<LeavePolicy> & { name: string }) {
  await assertPermission(access, "leave", "update");
  if (!isManageRole(access)) throw new Error("Forbidden: leave policy settings require HR or Super Admin access.");
  const supabase = getSupabaseAdmin();
  const payload = {
    accrual_frequency: "monthly",
    accrual_method: "monthly",
    allow_negative_balance: input.allowNegativeBalance ?? false,
    annual_days_after_first_year: input.annualDaysAfterFirstYear ?? 21,
    annual_days_first_year: input.annualDaysFirstYear ?? 15,
    carry_forward_enabled: input.carryForwardEnabled ?? false,
    carry_forward_expiry_months: input.carryForwardExpiryMonths ?? 0,
    carry_forward_limit: input.carryForwardLimit ?? 0,
    country: input.country ?? "EG",
    is_active: input.isActive ?? true,
    is_default: input.isDefault ?? false,
    name: input.name.trim(),
    updated_at: new Date().toISOString(),
    weekend_days: input.weekendDays?.length ? input.weekendDays : [5, 6],
  };
  const query = input.id
    ? supabase.from("leave_policies").update(payload).eq("id", input.id)
    : supabase.from("leave_policies").insert(payload);
  const { data, error } = await query.select("*").single();
  if (error) throw error;
  return mapLeavePolicy(data as LeavePolicyRow);
}

export async function upsertPublicHoliday(access: AccessContext, input: { country?: string; date: string; id?: string; isActive?: boolean; name: string }) {
  await assertPermission(access, "leave", "update");
  if (!isManageRole(access)) throw new Error("Forbidden: public holiday settings require HR or Super Admin access.");
  const year = new Date(`${input.date}T00:00:00.000Z`).getUTCFullYear();
  const supabase = getSupabaseAdmin();
  const payload = {
    country: input.country ?? "EG",
    date: input.date,
    is_active: input.isActive ?? true,
    name: input.name.trim(),
    year,
  };
  const query = input.id
    ? supabase.from("public_holidays").update(payload).eq("id", input.id)
    : supabase.from("public_holidays").upsert(payload, { onConflict: "country,date" });
  const { data, error } = await query.select("*").single();
  if (error) throw error;
  return mapHoliday(data as PublicHolidayRow);
}

export async function getEmployeeLeaveWorkspace(access: AccessContext) {
  if (!access.hrId) throw new Error("A linked employee HR_ID is required.");
  const employee = await getEmployeeOrThrow(access.hrId);
  const policy = await getDefaultLeavePolicy();
  const [wallet, leaveTypes, requests] = await Promise.all([
    getEmployeeLeaveWallet(access),
    getLeaveTypes(false),
    listLeaveRequests(access, { employeeHrId: access.hrId }),
  ]);
  const holidays = await getPublicHolidays(new Date().getUTCFullYear(), policy.country).catch(() => []);
  const calendarItems = buildLeaveCalendarItems(requests, holidays, {
    employeeHrId: access.hrId,
    month: new Date().getUTCMonth() + 1,
    year: new Date().getUTCFullYear(),
  });
  return {
    calendarItems,
    employeePolicy: {
      hireDate: employee.hireDate,
      jobTitle: employee.jobTitle,
      positionTitle: employee.positionTitle,
    },
    holidays,
    leaveTypes: leaveTypes.filter((type) => type.employeeSelectable && employeeSelectableLeaveCodes.has(type.code)),
    policy,
    requests,
    sickBackdateDays: sickBackdateDays(),
    wallet,
    weekendDays: getWeekendDaysForEmployee(employee, policy.weekendDays),
  };
}

export async function getManagerLeaveWorkspace(access: AccessContext) {
  await assertPermission(access, "leave", "approve");
  const policy = await getDefaultLeavePolicy();
  const [leaveTypes, requests] = await Promise.all([
    getLeaveTypes(false),
    listManagerHierarchyLeaveRequests(access, {}),
  ]);
  const holidays = await getPublicHolidays(new Date().getUTCFullYear(), policy.country).catch(() => []);
  const month = new Date().getUTCMonth() + 1;
  const year = new Date().getUTCFullYear();
  const range = getLeaveCalendarRange(month, year);
  return {
    calendarItems: buildLeaveCalendarItems(requests, holidays, { month, year }),
    holidays,
    leaveTypes,
    policy,
    requests,
    teamAvailability: buildTeamAvailability(requests, holidays, range),
  };
}

export async function getAdminLeaveWorkspace(access: AccessContext, filters: LeaveRequestFilters = {}) {
  if (!(await canAccess(access, "leave", "read"))) {
    throw new Error("Forbidden: cannot read leave management.");
  }
  const canManageLeave = isManageRole(access);
  const canExport = await canAccess(access, "leave", "export");
  const year = filters.year ?? new Date().getUTCFullYear();
  const [dashboard, leaveTypes, policies, holidays, requests] = await Promise.all([
    getLeaveDashboard(access),
    getLeaveTypes(true),
    canManageLeave ? getLeavePolicies(true) : Promise.resolve([]),
    getPublicHolidays(year).catch(() => []),
    listLeaveRequests(access, filters),
  ]);
  const month = filters.month ?? new Date().getUTCMonth() + 1;
  const range = getLeaveCalendarRange(month, year);
  const [accrualPreview, activityLogs] = await Promise.all([
    canManageLeave ? getLeaveAccrualPreview(access).catch(() => null) : Promise.resolve(null),
    canManageLeave ? listLeaveAuditLogs(access).catch(() => []) : Promise.resolve([]),
  ]);
  return {
    accrualPreview,
    activityLogs,
    calendarItems: buildLeaveCalendarItems(requests, holidays, { month, year }),
    capabilities: {
      canExport,
      canManageLeave,
    },
    dashboard,
    holidays,
    leaveTypes,
    policies,
    requests,
    teamAvailability: buildTeamAvailability(requests, holidays, range),
  };
}
