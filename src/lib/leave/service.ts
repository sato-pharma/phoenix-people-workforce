import ExcelJS from "exceljs";

import {
  assertPermission,
  canAccess,
  type AccessContext,
} from "@/lib/auth/permissions";
import { getEmployeeDirectory, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import {
  calculateCalendarLeaveDays,
  calculateLeaveBalanceFromParts,
  calculateMonthlyAccrual,
  calculateProratedEntitlement,
  calculateWorkingLeaveDays,
  getAnnualEntitlement,
  summarizeLeaveLedger,
} from "@/lib/leave/calculations";
import type {
  EmployeeLeaveBalance,
  LeaveAdjustmentInput,
  LeaveApproval,
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
} from "@/lib/leave/types";
import { safeSendNotificationEmail } from "@/lib/notifications/email";
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
  annual_days_senior: number | string;
  annual_days_disability: number | string;
  senior_after_years: number;
  senior_after_age: number;
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

const annualLeaveCode = "annual_leave";

function n(value: number | string | null | undefined) {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function isoToday() {
  return new Date().toISOString().slice(0, 10);
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

function mapLeaveType(row: LeaveTypeRow): LeaveType {
  return {
    affectsPayroll: row.affects_payroll,
    code: row.code,
    createdAt: row.created_at,
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
    annualDaysDisability: n(row.annual_days_disability),
    annualDaysFirstYear: n(row.annual_days_first_year),
    annualDaysSenior: n(row.annual_days_senior),
    carryForwardEnabled: row.carry_forward_enabled,
    carryForwardExpiryMonths: row.carry_forward_expiry_months,
    carryForwardLimit: n(row.carry_forward_limit),
    country: row.country,
    createdAt: row.created_at,
    id: row.id,
    isActive: row.is_active,
    isDefault: row.is_default,
    name: row.name,
    seniorAfterAge: row.senior_after_age,
    seniorAfterYears: row.senior_after_years,
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
    createdAt: row.created_at,
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
  return mapBalance(updated as EmployeeLeaveBalanceRow);
}

function shouldConsumeBalance(leaveType: LeaveType) {
  return leaveType.code === annualLeaveCode;
}

async function accrueMonthlyForEmployee(
  employee: EmployeeDirectoryRow,
  leaveType: LeaveType,
  policy: LeavePolicy,
  year: number,
  throughMonth: number,
  actor: string | null,
) {
  if (!shouldConsumeBalance(leaveType) || policy.accrualFrequency !== "monthly") {
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
  const annualEntitlement =
    policy.accrualMethod === "prorated"
      ? calculateProratedEntitlement(employee, policy, new Date().getUTCFullYear())
      : getAnnualEntitlement(employee, policy, new Date());

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
  const { data, error } = await supabase
    .from("leave_requests")
    .select("*,leave_types(code,name,is_paid,affects_payroll)")
    .order("requested_at", { ascending: false })
    .limit(1000);
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

export async function getLeaveRequestDetails(access: AccessContext, id: string) {
  const requests = await listLeaveRequests(access, {});
  const request = requests.find((item) => item.id === id);
  if (!request) throw new Error("Leave request was not found or is not accessible.");
  return request;
}

async function notifyLeaveSubmitted(request: LeaveRequest) {
  const employee = request.employee;
  await safeSendNotificationEmail({
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
    notificationType: "leave",
    recipientMode: "manager_chain",
    recipients: extraLeaveRecipients(),
    subject: `Leave approval needed - ${employee?.fullName ?? request.employeeHrId}`,
    summary: `${employee?.fullName ?? request.employeeHrId} submitted ${request.leaveType?.name ?? "a leave request"} from ${request.startDate} to ${request.endDate}.`,
    title: "Leave Approval Needed",
    tone: "warning",
  });
}

async function notifyLeaveDecision(request: LeaveRequest, decision: string) {
  await safeSendNotificationEmail({
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
    notificationType: "leave",
    recipientMode: "employee",
    recipients: extraLeaveRecipients(),
    subject: `Leave request ${decision} - ${request.employee?.fullName ?? request.employeeHrId}`,
    summary: `Your leave request from ${request.startDate} to ${request.endDate} is now ${decision}.`,
    title: "Leave Request Updated",
    tone: decision.includes("approved") ? "success" : "danger",
  });
}

export async function submitLeaveRequest(access: AccessContext, input: SubmitLeaveRequestInput) {
  await assertPermission(access, "leave", "create");
  if (!access.hrId) throw new Error("A linked employee HR_ID is required to submit leave.");
  if (!input.leaveTypeId || !input.startDate || !input.endDate) throw new Error("Leave type and date range are required.");
  if (input.startDate < isoToday() && !isManageRole(access)) throw new Error("Leave requests cannot start in the past.");

  const employee = await getEmployeeOrThrow(access.hrId);
  const leaveType = await getLeaveTypeById(input.leaveTypeId);
  const policy = await getDefaultLeavePolicy();
  const startYear = new Date(`${input.startDate}T00:00:00.000Z`).getUTCFullYear();
  const holidays = await getPublicHolidays(startYear, policy.country);
  const totalCalendarDays = calculateCalendarLeaveDays(input.startDate, input.endDate);
  const totalWorkingDays = calculateWorkingLeaveDays(
    input.startDate,
    input.endDate,
    holidays.map((holiday) => holiday.date),
    policy.weekendDays,
  );

  if (totalWorkingDays <= 0) throw new Error("The selected range contains no working leave days.");
  if (leaveType.requiresAttachment && !input.attachmentUrl) throw new Error(`${leaveType.name} requires an attachment.`);

  let balance: EmployeeLeaveBalance | null = null;
  if (shouldConsumeBalance(leaveType)) {
    balance = await accrueMonthlyForEmployee(
      employee,
      leaveType,
      policy,
      startYear,
      new Date().getUTCFullYear() === startYear ? new Date().getUTCMonth() + 1 : 12,
      access.hrId,
    );
    if (!policy.allowNegativeBalance && balance.availableBalance < totalWorkingDays) {
      throw new Error(`Insufficient leave balance. Available: ${balance.availableBalance} days.`);
    }
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("leave_requests")
    .insert({
      attachment_url: input.attachmentUrl ?? null,
      employee_hr_id: cleanHrId(employee.hrId),
      end_date: input.endDate,
      hr_status: leaveType.requiresHrApproval ? "pending" : "not_required",
      leave_type_id: leaveType.id,
      manager_status: leaveType.requiresManagerApproval ? "pending" : "not_required",
      payroll_status: leaveType.affectsPayroll ? "pending" : "not_required",
      policy_id: policy.id,
      reason: input.reason?.trim() || null,
      start_date: input.startDate,
      status: leaveType.requiresManagerApproval ? "pending_manager" : "pending_hr",
      total_calendar_days: totalCalendarDays,
      total_working_days: totalWorkingDays,
    })
    .select("*,leave_types(code,name,is_paid,affects_payroll)")
    .single();
  if (error) throw error;

  if (balance) {
    await recordBalanceTransaction({
      amount: totalWorkingDays,
      balance,
      createdBy: access.hrId,
      notes: "Request submitted",
      requestId: (data as LeaveRequestRow).id,
      transactionType: "pending",
    });
  }

  const { employeeByHrId } = await loadDirectoryMaps();
  const request = mapLeaveRequest(data as LeaveRequestRow, employeeByHrId, []);
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

async function releasePendingIfNeeded(request: LeaveRequestRow, actor: string | null) {
  const leaveType = await getLeaveTypeById(request.leave_type_id);
  if (!shouldConsumeBalance(leaveType)) return;
  const balance = await getBalanceRow(
    request.employee_hr_id,
    request.leave_type_id,
    request.policy_id,
    new Date(`${request.start_date}T00:00:00.000Z`).getUTCFullYear(),
  );
  if (!balance || balance.pending <= 0) return;
  await recordBalanceTransaction({
    amount: Math.min(balance.pending, n(request.total_working_days)),
    balance,
    createdBy: actor,
    notes: "Pending request released",
    requestId: request.id,
    transactionType: "pending_reversal",
  });
}

async function consumePendingRequest(request: LeaveRequestRow, actor: string | null) {
  const leaveType = await getLeaveTypeById(request.leave_type_id);
  if (!shouldConsumeBalance(leaveType)) return;
  const year = new Date(`${request.start_date}T00:00:00.000Z`).getUTCFullYear();
  const balance = await getBalanceRow(request.employee_hr_id, request.leave_type_id, request.policy_id, year);
  if (!balance) return;
  const releasedBalance = balance.pending > 0
    ? await recordBalanceTransaction({
        amount: Math.min(balance.pending, n(request.total_working_days)),
        balance,
        createdBy: actor,
        notes: "Pending request approved",
        requestId: request.id,
        transactionType: "pending_reversal",
      })
    : balance;
  await recordBalanceTransaction({
    amount: n(request.total_working_days),
    balance: releasedBalance,
    createdBy: actor,
    notes: "HR approved leave",
    requestId: request.id,
    transactionType: "consumed",
  });
}

async function writeApproval(input: {
  access: AccessContext;
  comment?: string | null;
  requestId: string;
  status: "approved" | "rejected";
  step: "hr" | "manager";
}) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("leave_approvals").insert({
    approval_step: input.step,
    approver_hr_id: cleanHrId(input.access.hrId),
    approver_role: input.access.role,
    comment: input.comment?.trim() || null,
    request_id: input.requestId,
    status: input.status,
  });
  if (error) throw error;
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

  const status = input.decision === "approved" ? "pending_hr" : "manager_rejected";
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("leave_requests")
    .update({
      manager_comment: input.comment?.trim() || null,
      manager_decision_at: new Date().toISOString(),
      manager_status: input.decision,
      status,
      updated_at: new Date().toISOString(),
    })
    .eq("id", requestId)
    .select("*,leave_types(code,name,is_paid,affects_payroll)")
    .single();
  if (error) throw error;
  await writeApproval({ access, comment: input.comment, requestId, status: input.decision, step: "manager" });
  if (input.decision === "rejected") await releasePendingIfNeeded(row, access.hrId);

  const request = mapLeaveRequest(data as LeaveRequestRow, employeeByHrId, []);
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

  if (input.decision === "approved") await consumePendingRequest(row, access.hrId);
  else await releasePendingIfNeeded(row, access.hrId);

  const leaveType = await getLeaveTypeById(row.leave_type_id);
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("leave_requests")
    .update({
      hr_comment: input.comment?.trim() || null,
      hr_decision_at: new Date().toISOString(),
      hr_status: input.decision,
      payroll_status: input.decision === "approved" && leaveType.affectsPayroll ? "pending" : row.payroll_status,
      status: input.decision === "approved" ? "hr_approved" : "hr_rejected",
      updated_at: new Date().toISOString(),
    })
    .eq("id", requestId)
    .select("*,leave_types(code,name,is_paid,affects_payroll)")
    .single();
  if (error) throw error;
  await writeApproval({ access, comment: input.comment, requestId, status: input.decision, step: "hr" });

  const { employeeByHrId } = await loadDirectoryMaps();
  const request = mapLeaveRequest(data as LeaveRequestRow, employeeByHrId, []);
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
  await releasePendingIfNeeded(row, access.hrId);

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("leave_requests")
    .update({
      hr_comment: comment?.trim() || row.hr_comment,
      status: "cancelled",
      updated_at: new Date().toISOString(),
    })
    .eq("id", requestId)
    .select("*,leave_types(code,name,is_paid,affects_payroll)")
    .single();
  if (error) throw error;

  const { employeeByHrId } = await loadDirectoryMaps();
  const request = mapLeaveRequest(data as LeaveRequestRow, employeeByHrId, []);
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
  const balance = await ensureEmployeeBalance(employee, leaveType, policy, year);
  return recordBalanceTransaction({
    amount: input.amount,
    balance,
    createdBy: access.hrId,
    notes: input.reason,
    transactionType: "adjustment",
  });
}

export async function runMonthlyLeaveAccrual(access: AccessContext, input: { month?: number; year?: number } = {}) {
  await assertPermission(access, "leave", "update");
  if (!isManageRole(access)) throw new Error("Forbidden: leave accrual requires HR or Super Admin access.");

  const now = new Date();
  const year = input.year ?? now.getUTCFullYear();
  const month = input.month ?? now.getUTCMonth() + 1;
  const { directory } = await loadDirectoryMaps();
  const policy = await getDefaultLeavePolicy();
  const leaveType = await getAnnualLeaveType();
  let processed = 0;

  for (const employee of directory.employees) {
    if ((employee.employmentStatus ?? "active").toLowerCase() !== "active") continue;
    await accrueMonthlyForEmployee(employee, leaveType, policy, year, month, access.hrId);
    processed += 1;
  }

  return { month, processed, year };
}

export async function getLeaveDashboard(access: AccessContext) {
  await assertPermission(access, "leave", "read");
  const requests = await listLeaveRequests(access);
  const today = isoToday();
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
      employeeHrId: request.employeeHrId,
      employeeName: request.employee?.fullName ?? "",
      from: request.startDate,
      hrStatus: request.hrStatus,
      line: request.employee?.lineName ?? "",
      manager: request.employee?.managerName ?? "",
      managerStatus: request.managerStatus,
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
  const { data, error } = await supabase
    .from("leave_types")
    .upsert({
      affects_payroll: input.affectsPayroll ?? false,
      code: input.code.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_"),
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
    accrual_frequency: input.accrualFrequency ?? "monthly",
    accrual_method: input.accrualMethod ?? "prorated",
    allow_negative_balance: input.allowNegativeBalance ?? false,
    annual_days_after_first_year: input.annualDaysAfterFirstYear ?? 21,
    annual_days_disability: input.annualDaysDisability ?? 45,
    annual_days_first_year: input.annualDaysFirstYear ?? 15,
    annual_days_senior: input.annualDaysSenior ?? 30,
    carry_forward_enabled: input.carryForwardEnabled ?? false,
    carry_forward_expiry_months: input.carryForwardExpiryMonths ?? 0,
    carry_forward_limit: input.carryForwardLimit ?? 0,
    country: input.country ?? "EG",
    is_active: input.isActive ?? true,
    is_default: input.isDefault ?? false,
    name: input.name.trim(),
    senior_after_age: input.seniorAfterAge ?? 50,
    senior_after_years: input.seniorAfterYears ?? 10,
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
  const policy = await getDefaultLeavePolicy();
  const [wallet, leaveTypes, requests] = await Promise.all([
    getEmployeeLeaveWallet(access),
    getLeaveTypes(false),
    listLeaveRequests(access, { employeeHrId: access.hrId }),
  ]);
  const holidays = await getPublicHolidays(new Date().getUTCFullYear(), policy.country).catch(() => []);
  return { holidays, leaveTypes, policy, requests, wallet };
}

export async function getManagerLeaveWorkspace(access: AccessContext) {
  await assertPermission(access, "leave", "approve");
  const policy = await getDefaultLeavePolicy();
  const [leaveTypes, requests] = await Promise.all([
    getLeaveTypes(false),
    listLeaveRequests(access, {}),
  ]);
  const holidays = await getPublicHolidays(new Date().getUTCFullYear(), policy.country).catch(() => []);
  return {
    holidays,
    leaveTypes,
    policy,
    requests: requests.filter((request) => request.status === "pending_manager" || request.status === "pending_hr"),
  };
}

export async function getAdminLeaveWorkspace(access: AccessContext, filters: LeaveRequestFilters = {}) {
  if (!(await canAccess(access, "leave", "read"))) {
    throw new Error("Forbidden: cannot read leave management.");
  }
  const year = filters.year ?? new Date().getUTCFullYear();
  const [dashboard, leaveTypes, policies, holidays, requests] = await Promise.all([
    getLeaveDashboard(access),
    getLeaveTypes(true),
    getLeavePolicies(true),
    getPublicHolidays(year).catch(() => []),
    listLeaveRequests(access, filters),
  ]);
  return { dashboard, holidays, leaveTypes, policies, requests };
}
