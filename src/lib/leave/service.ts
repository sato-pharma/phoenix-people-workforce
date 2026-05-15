import ExcelJS from "exceljs";

import {
  assertPermission,
  canAccess,
  createAccessContext,
  type AccessContext,
  getPermissionMatrix,
  normalizeRole,
  resolveNavigationMode,
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
  defaultWeekendDaysForTitle,
  getWeekendDaysForEmployee,
  normalizeLeaveTitleKey,
  getAnnualEntitlement,
  isWithinFirstSixMonths,
  summarizeLeaveLedger,
} from "@/lib/leave/calculations";
import type {
  ActiveEmployeeAccrualReport,
  ActiveEmployeeAccrualRow,
  EmployeeLeaveBalance,
  HistoricalVacationAcceptedRow,
  HistoricalVacationConfirmResult,
  HistoricalVacationDryRunResult,
  HistoricalVacationRejectedRow,
  HistoricalVacationUploadRow,
  HistoricalVacationUploadValue,
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
  LeaveNotificationDeliveryStatus,
  LeaveNotificationRecipient,
  LeaveNotificationRouteLevel,
  LeavePolicy,
  LeaveRequest,
  LeaveRequestFilters,
  LeaveStatus,
  LeaveTitleWeekendRule,
  LeaveTransaction,
  LeaveTransactionType,
  LeaveType,
  LeaveWallet,
  PublicHoliday,
  PublicHolidaySyncResult,
  SubmitLeaveRequestInput,
  TeamAvailabilityDay,
  VacationReportData,
  VacationReportRow,
  VacationReportScope,
  VacationReportWorkspace,
  LeaveSubmitResponse,
  LeaveDecisionResponse,
} from "@/lib/leave/types";
import { createLeaveCorrelationId, writeLeaveAuditLog } from "@/lib/leave/audit";
import { getLeaveAttachmentUrl } from "@/lib/leave/attachments";
import { emitLeaveNotification } from "@/lib/leave/notifications";
import { enqueueInAppNotification } from "@/lib/notifications/in-app";
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

type LeaveTitleWeekendRuleRow = {
  title_key: string;
  title: string;
  weekend_days: number[] | null;
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
  end_date?: string | null;
  duration_days?: number | string | null;
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
const historicalLeaveTypeCodes = new Set([annualLeaveCode, emergencyLeaveCode, sickLeaveCode, otherLeaveCode, "casual_leave", unpaidLeaveCode]);
const historicalDurationUnits = new Set(["full_day", "am", "pm"]);
const historicalPaymentStatuses = new Set(["paid", "unpaid", "in_review", "non_deducted"]);
const historicalBalanceDecisions = new Set(["deduct", "no_deduct"]);
const historicalFinalStatuses = new Set(["hr_approved", "hr_rejected", "cancelled", "pending_manager", "pending_hr", "manager_rejected"]);
const historicalApprovalStatuses = new Set(["pending", "approved", "rejected", "not_required"]);
const historicalTemplateSheetName = "Historical Vacation Data";
const historicalTemplateInstructionSheetName = "Instructions";

const historicalVacationColumns = [
  { header: "HR_ID", key: "HR_ID", width: 16, required: true },
  { header: "Employee_Name", key: "Employee_Name", width: 28, required: false },
  { header: "Title", key: "Title", width: 24, required: false },
  { header: "Line", key: "Line", width: 22, required: false },
  { header: "Area", key: "Area", width: 22, required: false },
  { header: "Direct_Manager_HR_ID", key: "Direct_Manager_HR_ID", width: 24, required: false },
  { header: "Hiring_Date", key: "Hiring_Date", width: 16, required: true },
  { header: "Leave_Type", key: "Leave_Type", width: 20, required: true },
  { header: "Request_Date", key: "Request_Date", width: 18, required: true },
  { header: "From_Date", key: "From_Date", width: 16, required: true },
  { header: "To_Date", key: "To_Date", width: 16, required: true },
  { header: "Duration", key: "Duration", width: 12, required: true },
  { header: "Duration_Unit", key: "Duration_Unit", width: 18, required: true },
  { header: "Reason", key: "Reason", width: 34, required: false },
  { header: "Notes", key: "Notes", width: 34, required: false },
  { header: "Manager_Approval_Status", key: "Manager_Approval_Status", width: 26, required: true },
  { header: "Manager_Approved_By", key: "Manager_Approved_By", width: 22, required: false },
  { header: "Manager_Decision_Date", key: "Manager_Decision_Date", width: 22, required: false },
  { header: "HR_Approval_Status", key: "HR_Approval_Status", width: 22, required: true },
  { header: "HR_Approved_By", key: "HR_Approved_By", width: 18, required: false },
  { header: "HR_Decision_Date", key: "HR_Decision_Date", width: 20, required: false },
  { header: "Final_Status", key: "Final_Status", width: 20, required: true },
  { header: "Payment_Status", key: "Payment_Status", width: 18, required: true },
  { header: "Balance_Deduction", key: "Balance_Deduction", width: 20, required: true },
  { header: "Balance_Before", key: "Balance_Before", width: 18, required: false },
  { header: "Balance_After", key: "Balance_After", width: 18, required: false },
  { header: "Historical_Adjustment", key: "Historical_Adjustment", width: 22, required: false },
  { header: "Carry_Forward_At_That_Time", key: "Carry_Forward_At_That_Time", width: 28, required: false },
  { header: "External_Reference", key: "External_Reference", width: 24, required: false },
  { header: "Legacy_System", key: "Legacy_System", width: 20, required: false },
  { header: "Import_Notes", key: "Import_Notes", width: 36, required: false },
] as const;

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

function canViewCompanyVacationReport(context: AccessContext) {
  return isManageRole(context);
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

function mapTitleWeekendRule(row: LeaveTitleWeekendRuleRow, employeeCount = 0): LeaveTitleWeekendRule {
  return {
    employeeCount,
    isConfigured: true,
    title: row.title,
    titleKey: row.title_key,
    weekendDays: normalizeWeekendDaysForStorage(row.weekend_days),
  };
}

function normalizeWeekendDaysForStorage(value: number[] | null | undefined) {
  const allowed = new Set([0, 1, 2, 3, 4, 5, 6]);
  const days = Array.from(new Set((value ?? []).map(Number).filter((day) => allowed.has(day)))).sort((left, right) => left - right);
  return days.length ? days : [5];
}

function employeePrimaryLeaveTitle(employee: EmployeeDirectoryRow) {
  return String(employee.positionTitle || employee.jobTitle || "").trim();
}

function collectLeaveTitleCounts(employees: EmployeeDirectoryRow[]) {
  const counts = new Map<string, { count: number; title: string; titleKey: string }>();
  for (const employee of employees) {
    const title = employeePrimaryLeaveTitle(employee);
    const titleKey = normalizeLeaveTitleKey(title);
    if (!titleKey) continue;
    const current = counts.get(titleKey);
    if (current) {
      current.count += 1;
    } else {
      counts.set(titleKey, { count: 1, title, titleKey });
    }
  }
  return counts;
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
  const endDate = row.end_date ?? row.date;
  return {
    country: row.country,
    createdAt: row.created_at,
    date: row.date,
    durationDays: row.duration_days == null ? holidayDurationDays(row.date, endDate) : n(row.duration_days),
    endDate,
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

export async function getLeaveTitleWeekendRules(): Promise<LeaveTitleWeekendRule[]> {
  const { directory } = await loadDirectoryMaps();
  const titleCounts = collectLeaveTitleCounts(directory.employees);
  const supabase = getSupabaseAdmin();
  const configured = new Map<string, LeaveTitleWeekendRule>();

  try {
    const { data, error } = await supabase
      .from("leave_title_weekend_rules")
      .select("*")
      .eq("is_active", true)
      .order("title", { ascending: true });
    if (error) throw error;
    for (const row of (data ?? []) as LeaveTitleWeekendRuleRow[]) {
      const titleKey = normalizeLeaveTitleKey(row.title_key || row.title);
      configured.set(titleKey, mapTitleWeekendRule(row, titleCounts.get(titleKey)?.count ?? 0));
    }
  } catch (error) {
    if (!isMissingLeaveTitleWeekendRulesSchemaError(error)) throw error;
  }

  const rules: LeaveTitleWeekendRule[] = [];
  for (const item of titleCounts.values()) {
    const existing = configured.get(item.titleKey);
    rules.push(existing ?? {
      employeeCount: item.count,
      isConfigured: false,
      title: item.title,
      titleKey: item.titleKey,
      weekendDays: defaultWeekendDaysForTitle(item.title, [5, 6]),
    });
  }

  return rules.sort((left, right) => left.title.localeCompare(right.title));
}

export async function updateLeaveTitleWeekendRules(
  access: AccessContext,
  input: { rules: Array<{ title: string; weekendDays: number[] }> },
) {
  await assertPermission(access, "leave", "update");
  if (!isManageRole(access)) throw new Error("Forbidden: title weekend settings require HR or Super Admin access.");

  const rows = input.rules
    .map((rule) => {
      const title = String(rule.title ?? "").trim();
      const titleKey = normalizeLeaveTitleKey(title);
      if (!title || !titleKey) return null;
      return {
        is_active: true,
        title,
        title_key: titleKey,
        updated_at: new Date().toISOString(),
        weekend_days: normalizeWeekendDaysForStorage(rule.weekendDays),
      };
    })
    .filter(Boolean);

  if (!rows.length) throw new Error("At least one title weekend rule is required.");

  const { error } = await getSupabaseAdmin()
    .from("leave_title_weekend_rules")
    .upsert(rows, { onConflict: "title_key" });
  if (error) {
    if (isMissingLeaveTitleWeekendRulesSchemaError(error)) {
      throw new Error("Title weekend settings need the leave_title_weekend_rules table. Apply migration 20260515195759_leave_title_weekend_rules.sql, then save again.");
    }
    throw error;
  }

  await writeLeaveAuditLog({
    actorHrId: access.hrId,
    actorRole: access.role,
    eventType: "leave.title_weekend_rules.updated",
    metadata: { ruleCount: rows.length },
  });

  return getLeaveTitleWeekendRules();
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

type GoogleHolidayEvent = {
  endDate: string;
  name: string;
  startDate: string;
};

function googleHolidayCalendarId(country: string) {
  const normalizedCountry = country.trim().toUpperCase() || "EG";
  const envKey = `GOOGLE_HOLIDAY_CALENDAR_ID_${normalizedCountry}`;
  const configured = process.env[envKey] ?? process.env.GOOGLE_HOLIDAY_CALENDAR_ID;
  if (configured?.trim()) return configured.trim();
  if (normalizedCountry === "EG") return "en.eg#holiday@group.v.calendar.google.com";
  throw new Error(`Google holiday calendar ID is not configured for country ${normalizedCountry}. Set ${envKey}.`);
}

function googleHolidayIcalUrl(country: string) {
  const normalizedCountry = country.trim().toUpperCase() || "EG";
  const envKey = `GOOGLE_HOLIDAY_ICAL_URL_${normalizedCountry}`;
  const configured = process.env[envKey] ?? process.env.GOOGLE_HOLIDAY_ICAL_URL;
  return configured?.trim() || null;
}

function parseGoogleDate(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(value.includes("T") ? value : `${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function expandHolidayDateRange(startDate: string, endDate: string | null | undefined) {
  const dates: string[] = [];
  const cursor = new Date(`${startDate}T00:00:00.000Z`);
  const inclusiveEnd = endDate ? new Date(`${endDate}T00:00:00.000Z`) : cursor;
  for (let date = cursor; date <= inclusiveEnd; date = new Date(date.getTime() + 86_400_000)) {
    dates.push(date.toISOString().slice(0, 10));
  }
  return dates.length ? dates : [startDate];
}

function previousIsoDate(date: string) {
  const source = new Date(`${date}T00:00:00.000Z`);
  source.setUTCDate(source.getUTCDate() - 1);
  return source.toISOString().slice(0, 10);
}

function inclusiveGoogleEndDate(startDate: string, googleEndDate: string | null | undefined) {
  if (!googleEndDate) return startDate;
  const inclusiveEndDate = previousIsoDate(googleEndDate);
  return inclusiveEndDate < startDate ? startDate : inclusiveEndDate;
}

function holidayOverlapsYear(startDate: string, endDate: string, year: number) {
  return startDate <= `${year}-12-31` && endDate >= `${year}-01-01`;
}

function holidayDurationDays(startDate: string, endDate: string | null | undefined) {
  return expandHolidayDateRange(startDate, endDate ?? startDate).length;
}

function publicHolidayDateList(holidays: PublicHoliday[]) {
  return Array.from(new Set(holidays.flatMap((holiday) => expandHolidayDateRange(holiday.date, holiday.endDate ?? holiday.date))));
}

function cleanGoogleHolidayName(name: string) {
  return name
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function googleHolidayGroupKey(name: string) {
  const cleaned = cleanGoogleHolidayName(name).toLowerCase();
  if (cleaned.includes("arafat") || cleaned.includes("eid al-adha") || cleaned.includes("eid el-adha")) return "eid al-adha";
  if (cleaned.includes("eid el fitr") || cleaned.includes("eid al-fitr")) return "eid el fitr";
  return cleaned.replace(/^day off for\s+/, "").replace(/\s+holiday$/, "").trim();
}

function googleHolidayDisplayName(groupKey: string, fallbackName: string) {
  if (groupKey === "eid al-adha") return "Eid al-Adha";
  if (groupKey === "eid el fitr") return "Eid el Fitr";
  return cleanGoogleHolidayName(fallbackName);
}

function mergeAdjacentGoogleHolidayEvents(events: GoogleHolidayEvent[]) {
  const merged: GoogleHolidayEvent[] = [];
  const sorted = [...events].sort((left, right) => left.startDate.localeCompare(right.startDate) || left.name.localeCompare(right.name));
  for (const event of sorted) {
    const groupKey = googleHolidayGroupKey(event.name);
    const previous = merged[merged.length - 1];
    if (
      previous &&
      googleHolidayGroupKey(previous.name) === groupKey &&
      event.startDate <= addDaysIso(previous.endDate, 1)
    ) {
      previous.endDate = previous.endDate > event.endDate ? previous.endDate : event.endDate;
      previous.name = googleHolidayDisplayName(groupKey, previous.name);
      continue;
    }
    merged.push({
      ...event,
      name: googleHolidayDisplayName(groupKey, event.name),
    });
  }
  return merged;
}

function collapseGoogleHolidayEventsByStartDate(events: GoogleHolidayEvent[]) {
  const byStartDate = new Map<string, GoogleHolidayEvent>();
  for (const event of events) {
    const existing = byStartDate.get(event.startDate);
    if (!existing) {
      byStartDate.set(event.startDate, { ...event });
      continue;
    }
    existing.endDate = existing.endDate > event.endDate ? existing.endDate : event.endDate;
    if (existing.name !== event.name && !existing.name.includes(event.name)) {
      existing.name = `${existing.name} / ${event.name}`;
    }
  }
  return Array.from(byStartDate.values());
}

function isMissingNationalVacationRangeSchemaError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const values = Object.values(error as Record<string, unknown>).map((value) => String(value ?? "").toLowerCase());
  return values.some((value) =>
    (value.includes("end_date") || value.includes("duration_days")) &&
    (value.includes("column") || value.includes("schema cache") || value.includes("could not find"))
  );
}

function missingNationalVacationRangeSchemaMessage() {
  return "National Vacation sync needs the public_holidays.end_date and public_holidays.duration_days columns. Apply migration 20260515173000_public_holidays_duration_columns.sql, then sync again.";
}

function isMissingLeaveTitleWeekendRulesSchemaError(error: unknown) {
  const text = JSON.stringify(error).toLowerCase();
  return text.includes("leave_title_weekend_rules") && (
    text.includes("does not exist") ||
    text.includes("could not find") ||
    text.includes("schema cache") ||
    text.includes("relation")
  );
}

function unfoldIcsLines(raw: string) {
  const lines: string[] = [];
  for (const line of raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

function unescapeIcsText(value: string) {
  return value
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

function icsDateToIso(value: string | null | undefined) {
  if (!value) return null;
  const datePart = value.trim().slice(0, 8);
  if (!/^\d{8}$/.test(datePart)) return null;
  return `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}`;
}

function parseGoogleHolidayIcs(raw: string, year: number): GoogleHolidayEvent[] {
  const events: GoogleHolidayEvent[] = [];
  let current: Record<string, string> | null = null;
  for (const line of unfoldIcsLines(raw)) {
    if (line === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (current) {
        const startDate = icsDateToIso(current.DTSTART);
        const endDate = inclusiveGoogleEndDate(startDate ?? "", icsDateToIso(current.DTEND));
        const name = unescapeIcsText(current.SUMMARY ?? "");
        if (startDate && name && holidayOverlapsYear(startDate, endDate, year)) {
          events.push({ endDate, name, startDate });
        }
      }
      current = null;
      continue;
    }
    if (!current) continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).split(";")[0];
    current[key] = line.slice(separator + 1);
  }
  return events;
}

async function fetchGoogleCalendarHolidays(year: number, country: string): Promise<{ calendarId: string; events: GoogleHolidayEvent[]; source: PublicHolidaySyncResult["source"] }> {
  const calendarId = googleHolidayCalendarId(country);
  const configuredIcalUrl = googleHolidayIcalUrl(country);
  if (configuredIcalUrl) {
    const response = await fetch(configuredIcalUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`Configured Google Calendar iCal returned ${response.status}.`);
    const events = parseGoogleHolidayIcs(await response.text(), year);
    if (!events.length) throw new Error(`Configured Google Calendar returned no national vacations for ${country} ${year}.`);
    return { calendarId: configuredIcalUrl, events, source: "google_calendar_ical" };
  }

  const apiKey = process.env.GOOGLE_CALENDAR_API_KEY;
  if (apiKey?.trim()) {
    const params = new URLSearchParams({
      key: apiKey.trim(),
      maxResults: "250",
      orderBy: "startTime",
      singleEvents: "true",
      timeMax: `${year + 1}-01-01T00:00:00Z`,
      timeMin: `${year}-01-01T00:00:00Z`,
    });
    const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Google Calendar API returned ${response.status}.`);
    const payload = await response.json() as {
      items?: Array<{
        end?: { date?: string; dateTime?: string };
        start?: { date?: string; dateTime?: string };
        status?: string;
        summary?: string;
      }>;
    };
    const events: GoogleHolidayEvent[] = [];
    for (const item of payload.items ?? []) {
      if (item.status === "cancelled") continue;
      const startDate = parseGoogleDate(item.start?.date ?? item.start?.dateTime);
      const endDate = inclusiveGoogleEndDate(startDate ?? "", parseGoogleDate(item.end?.date ?? item.end?.dateTime));
      const name = item.summary?.trim();
      if (!startDate || !name) continue;
      if (holidayOverlapsYear(startDate, endDate, year)) events.push({ endDate, name, startDate });
    }
    if (!events.length) throw new Error(`Google Calendar API returned no national vacations for ${country} ${year}.`);
    return { calendarId, events, source: "google_calendar_api" };
  }

  const icalUrl = `https://calendar.google.com/calendar/ical/${encodeURIComponent(calendarId)}/public/basic.ics`;
  const response = await fetch(icalUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`Google Calendar iCal returned ${response.status}. Set GOOGLE_CALENDAR_API_KEY if public iCal access is unavailable.`);
  const events = parseGoogleHolidayIcs(await response.text(), year);
  if (!events.length) throw new Error(`Google Calendar iCal returned no national vacations for ${country} ${year}.`);
  return { calendarId, events, source: "google_calendar_ical" };
}

async function fetchFallbackNationalVacations(year: number, country: string, warning: string): Promise<{ calendarId: string; events: GoogleHolidayEvent[]; source: PublicHolidaySyncResult["source"]; warning: string }> {
  const response = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/${encodeURIComponent(country)}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`${warning} Fallback national vacation API returned ${response.status}.`);
  const payload = await response.json() as Array<{
    date?: string;
    global?: boolean;
    localName?: string;
    name?: string;
    types?: string[];
  }>;
  const events = payload
    .filter((item) => item.date && (item.global ?? true) && (item.types ?? []).some((type) => type.toLowerCase() === "public"))
    .map((item) => ({
      endDate: String(item.date),
      name: String(item.localName || item.name || "National Vacation"),
      startDate: String(item.date),
    }));
  return {
    calendarId: `nager-date:${country}`,
    events,
    source: "nager_date_fallback",
    warning,
  };
}

export async function syncPublicHolidaysFromGoogleCalendar(access: AccessContext, input: { country?: string; year?: number } = {}): Promise<PublicHolidaySyncResult> {
  await assertPermission(access, "leave", "update");
  if (!isManageRole(access)) throw new Error("Forbidden: public holiday sync requires HR or Super Admin access.");
  const country = (input.country ?? "EG").trim().toUpperCase();
  const year = input.year ?? new Date().getUTCFullYear();
  let warning: string | undefined;
  let calendarId: string;
  let events: GoogleHolidayEvent[];
  let source: PublicHolidaySyncResult["source"];
  try {
    const googleResult = await fetchGoogleCalendarHolidays(year, country);
    calendarId = googleResult.calendarId;
    events = googleResult.events;
    source = googleResult.source;
  } catch (error) {
    warning = error instanceof Error ? error.message : "Google Calendar sync failed.";
    const fallbackResult = await fetchFallbackNationalVacations(year, country, warning);
    calendarId = fallbackResult.calendarId;
    events = fallbackResult.events;
    source = fallbackResult.source;
    warning = fallbackResult.warning;
  }
  const groupedEvents = collapseGoogleHolidayEventsByStartDate(mergeAdjacentGoogleHolidayEvents(events));
  const uniqueEvents = Array.from(new Map(groupedEvents.map((event) => [`${event.startDate}:${event.endDate}:${event.name}`, event])).values())
    .sort((left, right) => left.startDate.localeCompare(right.startDate) || left.name.localeCompare(right.name));
  if (uniqueEvents.length === 0) throw new Error(`No national vacations were found for ${country} ${year}.`);
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("public_holidays")
    .upsert(
      uniqueEvents.map((event) => ({
        country,
        date: event.startDate,
        duration_days: holidayDurationDays(event.startDate, event.endDate),
        end_date: event.endDate,
        is_active: true,
        name: event.name,
        year,
      })),
      { onConflict: "country,date" },
    )
    .select("*");
  if (error) {
    if (isMissingNationalVacationRangeSchemaError(error)) throw new Error(missingNationalVacationRangeSchemaMessage());
    throw error;
  }
  const activeGoogleStartDates = uniqueEvents.map((event) => event.startDate);
  if (activeGoogleStartDates.length) {
    const { error: nonGoogleCleanupError } = await supabase
      .from("public_holidays")
      .update({ is_active: false })
      .eq("country", country)
      .eq("year", year)
      .eq("is_active", true)
      .not("date", "in", `(${activeGoogleStartDates.join(",")})`);
    if (nonGoogleCleanupError) throw nonGoogleCleanupError;
  }
  for (const event of uniqueEvents.filter((item) => holidayDurationDays(item.startDate, item.endDate) > 1)) {
    const { error: cleanupError } = await supabase
      .from("public_holidays")
      .update({ is_active: false })
      .eq("country", country)
      .eq("is_active", true)
      .gt("date", event.startDate)
      .lte("date", event.endDate);
    if (cleanupError) throw cleanupError;
  }
  const holidays = ((data ?? []) as PublicHolidayRow[]).map(mapHoliday).sort((left, right) => left.date.localeCompare(right.date));
  await writeLeaveAuditLog({
    actorHrId: access.hrId,
    actorRole: access.role,
    correlationId: createLeaveCorrelationId(),
    employeeHrId: null,
    eventType: "leave.public_holidays.google_calendar_sync",
    metadata: {
      calendarId,
      country,
      source,
      synced: holidays.length,
      warning,
      year,
    },
  }).catch(() => undefined);
  return {
    calendarId,
    country,
    holidays,
    source,
    synced: holidays.length,
    warning,
    year,
  };
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
    if (filters.paymentStatus && request.paymentStatus !== filters.paymentStatus) return false;
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
    .select("*,leave_types:leave_types!leave_requests_leave_type_id_fkey(code,name,is_paid,affects_payroll)")
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

async function hasReportingEmployees(access: AccessContext) {
  if (!access.hrId) return false;
  const { directory, employeeByHrId } = await loadDirectoryMaps();
  return directory.employees.some(
    (employee) =>
      !hrIdsMatch(employee.hrId, access.hrId) &&
      employeeIsUnderManager(access.hrId, employee.hrId, employeeByHrId),
  );
}

async function listTeamVacationReportRequests(access: AccessContext, filters: LeaveRequestFilters = {}) {
  if (!access.hrId) throw new Error("A linked employee HR_ID is required for team vacation reports.");
  const requests = await listLeaveRequests(access, filters);
  const { employeeByHrId } = await loadDirectoryMaps();
  return requests.filter((request) => employeeIsUnderManager(access.hrId, request.employeeHrId, employeeByHrId));
}

async function loadRequestTransactions(requestIds: string[]) {
  if (requestIds.length === 0) return new Map<string, LeaveTransaction[]>();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("leave_transactions")
    .select("*")
    .in("request_id", requestIds)
    .order("created_at", { ascending: true });
  if (error) throw error;
  const grouped = new Map<string, LeaveTransaction[]>();
  for (const transaction of ((data ?? []) as LeaveTransactionRow[]).map(mapTransaction)) {
    if (!transaction.requestId) continue;
    grouped.set(transaction.requestId, [...(grouped.get(transaction.requestId) ?? []), transaction]);
  }
  return grouped;
}

function latestApproval(request: LeaveRequest, step: LeaveApproval["approvalStep"]) {
  return (request.approvalHistory ?? []).filter((approval) => approval.approvalStep === step).at(-1) ?? null;
}

function mapVacationReportRow(request: LeaveRequest, transactions: LeaveTransaction[]): VacationReportRow {
  const managerApproval = latestApproval(request, "manager");
  const hrApproval = latestApproval(request, "hr");
  const firstTransaction = transactions[0] ?? null;
  const lastTransaction = transactions.at(-1) ?? null;

  return {
    area: request.employee?.areaName ?? null,
    attachmentStatus: request.attachmentUrl ? "attached" : "missing",
    balanceAfter: lastTransaction?.balanceAfter ?? null,
    balanceBefore: firstTransaction?.balanceBefore ?? null,
    createdAt: request.createdAt,
    directManager: request.employee?.managerName ?? request.employee?.managerHrId ?? null,
    directManagerHrId: request.employee?.managerHrId ?? null,
    duration: request.totalWorkingDays,
    durationUnit: request.durationUnit,
    employeeHrId: request.employeeHrId,
    employeeName: request.employee?.fullName ?? null,
    finalStatus: request.status,
    fromDate: request.startDate,
    hrApprovalStatus: request.hrStatus,
    hrApprovedBy: hrApproval?.approverHrId ?? null,
    hrDecisionDate: request.hrDecisionAt ?? hrApproval?.actionDate ?? null,
    id: request.id,
    leaveType: request.leaveType?.name ?? null,
    line: request.employee?.lineName ?? null,
    managerApprovalStatus: request.managerStatus,
    managerApprovedBy: managerApproval?.approverHrId ?? null,
    managerDecisionDate: request.managerDecisionAt ?? managerApproval?.actionDate ?? null,
    paymentStatus: request.paymentStatus,
    reason: request.reason,
    requestDate: request.requestedAt,
    title: request.employee?.jobTitle ?? null,
    toDate: request.endDate,
  };
}

function vacationReportTitle(scope: VacationReportScope) {
  if (scope === "team") return "Team Vacation Report";
  if (scope === "company") return "Company Vacation Report";
  return "My Vacation Report";
}

export async function getVacationReport(access: AccessContext, scope: VacationReportScope, filters: LeaveRequestFilters = {}): Promise<VacationReportData> {
  await assertPermission(access, "leave", "read");

  let requests: LeaveRequest[];
  if (scope === "my") {
    if (!access.hrId) throw new Error("A linked employee HR_ID is required for my vacation report.");
    requests = await listLeaveRequests(access, { ...filters, employeeHrId: access.hrId });
  } else if (scope === "team") {
    if (canViewCompanyVacationReport(access)) throw new Error("Forbidden: HR/Admin users must use the company vacation report scope.");
    if (!(await hasReportingEmployees(access))) throw new Error("Forbidden: no reporting hierarchy is available for team vacation reports.");
    requests = await listTeamVacationReportRequests(access, filters);
  } else {
    if (!canViewCompanyVacationReport(access)) throw new Error("Forbidden: company vacation reports require HR or Super Admin access.");
    requests = await listLeaveRequests(access, filters);
  }

  const transactionMap = await loadRequestTransactions(requests.map((request) => request.id));
  return {
    canExport: scope === "my" || await canAccess(access, "leave", "export"),
    filters,
    rows: requests.map((request) => mapVacationReportRow(request, transactionMap.get(request.id) ?? [])),
    scope,
    title: vacationReportTitle(scope),
  };
}

export async function getVacationReportWorkspace(access: AccessContext, filters: LeaveRequestFilters = {}): Promise<VacationReportWorkspace> {
  const [myReport, teamReport, companyReport] = await Promise.all([
    access.hrId ? getVacationReport(access, "my", filters).catch(() => null) : Promise.resolve(null),
    !canViewCompanyVacationReport(access)
      ? hasReportingEmployees(access).then((hasTeam) => hasTeam ? getVacationReport(access, "team", filters).catch(() => null) : null)
      : Promise.resolve(null),
    canViewCompanyVacationReport(access) ? getVacationReport(access, "company", filters).catch(() => null) : Promise.resolve(null),
  ]);

  return {
    companyReport,
    myReport,
    teamReport,
  };
}

async function loadAllLeaveRequestsForEngine(filters: LeaveRequestFilters = {}) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("leave_requests")
    .select("*,leave_types:leave_types!leave_requests_leave_type_id_fkey(code,name,is_paid,affects_payroll)")
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
  const row = await loadRequestRow(id);
  const request = await hydrateLeaveRequest(row);
  const { employeeByHrId } = await loadDirectoryMaps();

  if (!isManageRole(access) && !canSeeLeaveEmployee(access, request.employeeHrId, employeeByHrId)) {
    throw new Error("Leave request was not found or is not accessible.");
  }

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

export async function listLeaveAuditLogs(
  access: AccessContext,
  options: { eventTypePrefix?: string; limit?: number } | number = 80,
): Promise<LeaveAuditLog[]> {
  await assertPermission(access, "leave", "read");
  if (!isManageRole(access)) return [];
  const limit = typeof options === "number" ? options : options.limit ?? 80;
  const eventTypePrefix = typeof options === "number" ? undefined : options.eventTypePrefix?.trim();

  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("leave_audit_logs")
    .select("*")
    .order("created_at", { ascending: false });
  if (eventTypePrefix) {
    query = query.ilike("event_type", `${eventTypePrefix}%`);
  }
  const { data, error } = await query.limit(Math.min(Math.max(limit, 1), 200));
  if (error) throw error;
  return ((data ?? []) as LeaveAuditLogRow[]).map(mapAuditLog);
}

async function resolveManagerHrChain(startManagerHrId?: string | null): Promise<string[]> {
  const initialManager = cleanHrId(startManagerHrId);
  if (!initialManager) return [];

  const { employeeByHrId } = await loadDirectoryMaps();
  const chain: string[] = [];
  const visited = new Set<string>();
  let currentManagerHrId = initialManager;

  while (currentManagerHrId && !visited.has(currentManagerHrId) && chain.length < 6) {
    visited.add(currentManagerHrId);
    chain.push(currentManagerHrId);
    const manager = employeeByHrId.get(currentManagerHrId);
    if (!manager) break;
    currentManagerHrId = cleanHrId(manager.managerHrId);
  }

  return chain;
}

function getLeaveFallbackApproverRoles() {
  return new Set([
    "Business Development Manager",
    "CEO",
    "District Manager",
    "Finance Manager",
    "HR Specialist",
    "Manager",
    "National Sales Manager",
    "Regional Manager",
    "Regional Sales Manager",
    "SFE Manager",
    "Super Admin",
    "Team Leader",
    "Training Manager",
    "Marketing Manager",
    "Product Manager",
    "Group Product Manager",
  ]);
}

let cachedLeaveApproverRoleSet: Set<string> | null = null;

async function resolveLeaveApproverRoleSet(): Promise<Set<string>> {
  if (cachedLeaveApproverRoleSet) return cachedLeaveApproverRoleSet;

  try {
    const permissionMatrix = await getPermissionMatrix();
    const approverRoles = new Set<string>();
    for (const [role, permissions] of Object.entries(permissionMatrix) as Array<
      [string, { leave?: string[] }]
    >) {
      if (permissions.leave?.includes("approve")) {
        approverRoles.add(role);
      }
    }
    const fallbackRoles = getLeaveFallbackApproverRoles();
    for (const role of fallbackRoles) approverRoles.add(role);
    cachedLeaveApproverRoleSet = approverRoles;
    return approverRoles;
  } catch {
    const fallbackRoles = getLeaveFallbackApproverRoles();
    cachedLeaveApproverRoleSet = fallbackRoles;
    return fallbackRoles;
  }
}

function isLeaveInAppFallbackRole(roleText: string | null | undefined, approverRoles: Set<string>) {
  const role = normalizeRole(roleText);
  if (approverRoles.has(role)) return true;

  const raw = String(roleText ?? "").trim().toLowerCase();
  if (!raw) return false;
  if (raw === "employee" || raw === "medical rep") return false;

  const normalized = raw.replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  const tokens = new Set(normalized.split(" "));
  const normalizedNoSpace = normalized.replace(/\s+/g, "");

  if (tokens.has("admin") || tokens.has("admin.") || tokens.has("super") || tokens.has("ceo")) return true;
  if (tokens.has("finance")) return true;
  if (tokens.has("hr") || tokens.has("human") && tokens.has("resource") || normalizedNoSpace.startsWith("hr") || normalizedNoSpace.endsWith("hr")) return true;
  if (
    tokens.has("manager") ||
    tokens.has("mgr") ||
    tokens.has("mngr") ||
    tokens.has("lead") ||
    tokens.has("leader") ||
    tokens.has("supervisor") ||
    normalized.includes("manager") ||
    normalized.includes("mngr") ||
    normalized.includes("lead") ||
    normalized.includes("supervisor")
  ) return true;
  if (tokens.has("team")) return true;
  if (raw.startsWith("nsm") || raw.startsWith("dsm") || raw.startsWith("rsm")) return true;
  if (normalizedNoSpace.startsWith("teamlead") || normalizedNoSpace.endsWith("teamleader")) return true;

  return false;
}

function leaveSubmittedNotificationHref(roleText: string | null | undefined, requestId: string) {
  const recipientAccess = createAccessContext({
    role: roleText,
    source: "system",
  });
  const mode = resolveNavigationMode(recipientAccess);
  if (mode === "admin") {
    return `/admin/leave?section=approvals&requestId=${encodeURIComponent(requestId)}`;
  }
  return `/employee-portals/leave-approvals?requestId=${encodeURIComponent(requestId)}`;
}

type LeaveFallbackRecipientCache = {
  approverRolesKey: string;
  fetchedAt: number;
  recipients: string[];
};

let cachedLeaveFallbackApproverRecipients: LeaveFallbackRecipientCache | null = null;
const leaveFallbackRecipientCacheMs = 5 * 60_000;

async function resolveLeaveInAppFallbackRecipients(approverRoles: Set<string>): Promise<string[]> {
  const now = Date.now();
  const approverRolesKey = Array.from(approverRoles).sort().join("|");
  if (
    cachedLeaveFallbackApproverRecipients &&
    cachedLeaveFallbackApproverRecipients.approverRolesKey === approverRolesKey &&
    now - cachedLeaveFallbackApproverRecipients.fetchedAt < leaveFallbackRecipientCacheMs
  ) {
    return [...cachedLeaveFallbackApproverRecipients.recipients];
  }

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("app_auth_users")
      .select("hr_id,role")
      .eq("is_active", true);

    if (error) return [];

    const recipients = new Set<string>();
    for (const row of (data ?? []) as Array<{ hr_id?: string | null; role?: string | null }>) {
      if (!isLeaveInAppFallbackRole(row.role, approverRoles)) continue;
      const hrId = cleanHrId(row.hr_id);
      if (hrId) recipients.add(hrId);
    }

    const resolvedRecipients = [...recipients];
    if (resolvedRecipients.length > 0 || cachedLeaveFallbackApproverRecipients) {
      cachedLeaveFallbackApproverRecipients = {
        approverRolesKey,
        fetchedAt: now,
        recipients: resolvedRecipients,
      };
    }
    return resolvedRecipients;
  } catch {
    return [];
  }
}

async function resolveRecipientRoles(hrIds: string[]): Promise<Map<string, string>> {
  const normalizedHrIds = Array.from(new Set(hrIds.map((hrId) => cleanHrId(hrId)).filter(Boolean)));
  if (normalizedHrIds.length === 0) return new Map();

  try {
    const { data, error } = await getSupabaseAdmin()
      .from("app_auth_users")
      .select("hr_id,role")
      .eq("is_active", true)
      .in("hr_id", normalizedHrIds);
    if (error) return new Map();

    const roles = new Map<string, string>();
    for (const row of (data ?? []) as Array<{ hr_id?: string | null; role?: string | null }>) {
      const hrId = cleanHrId(row.hr_id);
      if (!hrId) continue;
      const role = row.role ? String(row.role).trim() : "";
      roles.set(hrId, role);
    }
    return roles;
  } catch {
    return new Map();
  }
}

async function resolveActiveLeaveNotificationRecipients(hrIds: string[]): Promise<string[]> {
  const uniqueHrIds = Array.from(new Set(hrIds.map((id) => cleanHrId(id)).filter(Boolean)));
  if (uniqueHrIds.length === 0) return [];

  try {
    const { data, error } = await getSupabaseAdmin()
      .from("app_auth_users")
      .select("hr_id")
      .eq("is_active", true)
      .in("hr_id", uniqueHrIds);

    if (error) return [];

    const recipients = new Set<string>();
    for (const row of (data ?? []) as Array<{ hr_id?: string | null }>) {
      const hrId = cleanHrId(row.hr_id);
      if (hrId) recipients.add(hrId);
    }
    return [...recipients];
  } catch {
    return [];
  }
}

type LeaveNotificationDispatchRecipient = LeaveNotificationRecipient & {
  reason?: string | null;
};

type LeaveNotificationDispatchResult = {
  notificationQueued: boolean;
  recipients: LeaveNotificationRecipient[];
  warnings: string[];
};

const leaveNotificationRoutePriority = ["direct_manager", "nsm", "hr", "admin"] as const;

function isNsmApproverRole(roleText: string | null | undefined) {
  const normalized = String(roleText ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) return false;
  if (normalized.includes("nsm") || normalized.includes("national sales manager") || normalized.includes("regional sales manager") || normalized.includes("district manager")) return true;
  if (normalized.includes("dsm") || normalized.includes("rsm")) return true;
  return false;
}

function isHrApproverRole(roleText: string | null | undefined) {
  const normalized = String(roleText ?? "").trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.includes("hr") || normalized.includes("human resource")) return true;
  return false;
}

function isAdminApproverRole(roleText: string | null | undefined) {
  const normalized = String(roleText ?? "").trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.includes("admin") || normalized.includes("super") || normalized.includes("ceo") || normalized.includes("finance manager")) return true;
  return false;
}

function isTransientFailure(errorMessage: string) {
  const message = errorMessage.toLowerCase();
  return (
    message.includes("connection") ||
    message.includes("timeout") ||
    message.includes("temporar") ||
    message.includes("unavailable") ||
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("503") ||
    message.includes("502") ||
    message.includes("504")
  );
}

function leaveNotificationEnvelope(status: LeaveNotificationDeliveryStatus, request: LeaveRequest, recipient: LeaveNotificationRecipient, attemptCount: number) {
  return {
    actionUrl: leaveSubmittedNotificationHref(recipient.recipientRole, request.id),
    actorName: leaveNotificationActorName(request),
    deliveryStatus: status,
    requestId: request.id,
    requestType: "leave" as const,
    requestorId: request.employeeHrId,
    routeLevel: recipient.routeLevel,
    attemptCount,
  } satisfies Parameters<typeof writeLeaveAuditLog>[0] & { requestId: string; attemptCount: number };
}

function leaveNotificationActorName(request: LeaveRequest) {
  return request.employee?.fullName ?? request.employeeHrId;
}

function normalizeLeaveDecision(raw: { action?: LeaveDecisionInput["action"]; decision?: LeaveDecisionInput["decision"] }) {
  const decision = raw.action ?? raw.decision;
  if (decision === "approved" || decision === "rejected") return decision;
  throw new Error("Decision is required and must be approved or rejected.");
}

async function resolveLeaveSubmissionRecipients(request: LeaveRequest): Promise<{ recipients: LeaveNotificationDispatchRecipient[]; warnings: string[] }> {
  const warnings: string[] = [];
  const requestedManagerHrId = cleanHrId(request.employee?.managerHrId);

  const directManagerRecipients = requestedManagerHrId ? await resolveActiveLeaveNotificationRecipients([requestedManagerHrId]) : [];
  if (requestedManagerHrId && directManagerRecipients.length === 0) {
    warnings.push("No active direct manager was found for leave submission notification routing.");
  }

  const managerChain = requestedManagerHrId ? await resolveManagerHrChain(requestedManagerHrId) : [];
  const activeManagerChain = await resolveActiveLeaveNotificationRecipients(managerChain);
  const managerChainRoles = await resolveRecipientRoles(activeManagerChain);
  const nsmManagerRecipients = activeManagerChain.filter(
    (recipientHrId) => recipientHrId !== requestedManagerHrId && isNsmApproverRole(managerChainRoles.get(recipientHrId)),
  );
  if (requestedManagerHrId && nsmManagerRecipients.length === 0) {
    warnings.push("No active NSM was found for leave submission notification routing.");
  }

  const approverRoles = await resolveLeaveApproverRoleSet();
  const fallbackApproverIds = await resolveLeaveInAppFallbackRecipients(approverRoles);
  const fallbackApproverRoles = await resolveRecipientRoles(fallbackApproverIds);
  const hrRecipients = fallbackApproverIds.filter((id) => isHrApproverRole(fallbackApproverRoles.get(id)));
  const adminRecipients = fallbackApproverIds.filter((id) => isAdminApproverRole(fallbackApproverRoles.get(id)));

  if (!hrRecipients.length) {
    warnings.push("No active HR approver was found for leave submission notifications.");
  }
  if (!adminRecipients.length) {
    warnings.push("No active admin approver was found for leave submission notifications.");
  }

  const stagedRecipients: Array<{ level: LeaveNotificationRouteLevel; recipients: string[] }> = [
    { level: "direct_manager", recipients: directManagerRecipients },
    { level: "nsm", recipients: nsmManagerRecipients },
    { level: "hr", recipients: hrRecipients },
    { level: "admin", recipients: adminRecipients },
  ];
  const allCandidateIds = [...new Set(stagedRecipients.flatMap((level) => level.recipients))];
  const roleByHrId = await resolveRecipientRoles(allCandidateIds);
  const resolvedRecipients: LeaveNotificationDispatchRecipient[] = [];
  const seen = new Set<string>();

  for (const level of leaveNotificationRoutePriority) {
    const candidates = stagedRecipients.find((item) => item.level === level)?.recipients ?? [];
    for (const recipientHrId of candidates) {
      const normalized = cleanHrId(recipientHrId);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      resolvedRecipients.push({
        deliveryStatus: "queued",
        recipientHrId: normalized,
        recipientRole: roleByHrId.get(normalized) ?? null,
        routeLevel: level,
      });
    }
  }

  return { recipients: resolvedRecipients, warnings };
}

async function dispatchLeaveSubmissionInAppNotifications(
  request: LeaveRequest,
  recipients: LeaveNotificationDispatchRecipient[],
) {
  const actorName = leaveNotificationActorName(request);
  const resolved: LeaveNotificationRecipient[] = [];
  let anyDeliverySucceeded = false;
  let hasFailure = false;

  for (const recipient of recipients) {
    const actionUrl = leaveSubmittedNotificationHref(recipient.recipientRole, request.id);
    let finalDeliveryStatus: LeaveNotificationDeliveryStatus = "queued";
    let lastReason: string | null = null;
    let attemptCount = 1;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      attemptCount = attempt;
      try {
        const result = await enqueueInAppNotification({
          category: "leave",
          dedupeKey: `leave:submitted:${request.id}:${recipient.recipientHrId}:${recipient.routeLevel}`,
          href: actionUrl,
          message: `${actorName} submitted a vacation request from ${request.startDate} to ${request.endDate}.`,
          metadata: {
            actionLabel: "See details",
            leaveRequestId: request.id,
            leaveType: request.leaveType?.name ?? "Leave",
            routeLevel: recipient.routeLevel,
            requestorId: request.employeeHrId,
          },
          recipientHrId: recipient.recipientHrId,
          title: `${actorName} has submitted a vacation request`,
        });

        const deliveryStatus: LeaveNotificationDeliveryStatus = result.skipped ? "skipped" : "sent";
        const now = new Date().toISOString();
        finalDeliveryStatus = deliveryStatus;
        lastReason = result.skipped ? result.reason : null;
        if (deliveryStatus === "sent") anyDeliverySucceeded = true;
        await writeLeaveAuditLog({
          actorHrId: null,
          actorRole: "system",
          employeeHrId: request.employeeHrId,
          eventType: "leave.notification.delivery",
          metadata: {
            actionUrl,
            actorName,
            attemptCount,
            deliveryStatus,
            errorCode: result.skipped ? result.reason : null,
            envelope: leaveNotificationEnvelope(deliveryStatus, request, recipient, attemptCount),
            lastAttemptAt: now,
            metadataAttempt: {
              actionUrl,
              actorName,
              requestId: request.id,
            },
            recipientHrId: recipient.recipientHrId,
            recipientRole: recipient.recipientRole,
            requestId: request.id,
            requestType: "leave",
            routeLevel: recipient.routeLevel,
          },
          requestId: request.id,
        });
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Leave notification failed.";
        lastReason = message;
        const now = new Date().toISOString();
        finalDeliveryStatus = "failed";
        if (!isTransientFailure(message) || attempt >= 3) {
          await writeLeaveAuditLog({
            actorHrId: null,
            actorRole: "system",
            employeeHrId: request.employeeHrId,
            eventType: "leave.notification.delivery",
            metadata: {
              actionUrl,
              actorName,
              attemptCount,
              deliveryStatus: "failed",
              errorCode: message,
              envelope: leaveNotificationEnvelope("failed", request, recipient, attemptCount),
              lastAttemptAt: now,
              metadataAttempt: {
                actionUrl,
                actorName,
                requestId: request.id,
              },
              recipientHrId: recipient.recipientHrId,
              recipientRole: recipient.recipientRole,
              requestId: request.id,
              requestType: "leave",
              routeLevel: recipient.routeLevel,
            },
            requestId: request.id,
          });
          break;
        }
      }
    }

    if (finalDeliveryStatus === "queued") {
      finalDeliveryStatus = "failed";
      lastReason = lastReason ?? "Notification delivery could not be completed.";
      await writeLeaveAuditLog({
        actorHrId: null,
        actorRole: "system",
        employeeHrId: request.employeeHrId,
        eventType: "leave.notification.delivery",
        metadata: {
          actionUrl,
          actorName,
          attemptCount: 3,
          deliveryStatus: "failed",
          errorCode: lastReason,
          envelope: leaveNotificationEnvelope("failed", request, recipient, 3),
          lastAttemptAt: new Date().toISOString(),
          metadataAttempt: {
            actionUrl,
            actorName,
            requestId: request.id,
          },
          recipientHrId: recipient.recipientHrId,
          recipientRole: recipient.recipientRole,
          requestId: request.id,
          requestType: "leave",
          routeLevel: recipient.routeLevel,
        },
        requestId: request.id,
      });
    }

    resolved.push({
      ...recipient,
      deliveryStatus: finalDeliveryStatus,
      reason: finalDeliveryStatus === "sent" ? null : lastReason,
    });

    if (finalDeliveryStatus !== "sent") {
      hasFailure = true;
    }
  }

  if (!anyDeliverySucceeded) {
    await writeLeaveAuditLog({
      actorHrId: null,
      actorRole: "system",
      employeeHrId: request.employeeHrId,
      eventType: "leave.notification.delivery.failed",
      metadata: {
        actionUrl: leaveSubmittedNotificationHref("manager", request.id),
        actorName,
        errorCode: "No submission notification was sent after retries.",
        recipientCount: recipients.length,
      },
      requestId: request.id,
    });
  }

  return {
    notificationQueued: hasFailure,
    recipients: resolved,
  };
}

async function dispatchLeaveDecisionInAppNotification(
  request: LeaveRequest,
  decision: string,
) {
  const actorName = leaveNotificationActorName(request);
  const deliveryStatus: LeaveNotificationDeliveryStatus = "queued";
  try {
    const result = await enqueueInAppNotification({
      category: "leave",
      dedupeKey: `leave:decision:${request.id}:${decision}`,
      href: leaveSubmittedNotificationHref("employee", request.id),
      message: `${actorName} leave request from ${request.startDate} to ${request.endDate} is ${decision}.`,
      metadata: {
        actionLabel: "View request",
        leaveRequestId: request.id,
        leaveType: request.leaveType?.name ?? "Leave",
        requestorId: request.employeeHrId,
      },
      recipientHrId: request.employeeHrId,
      title: `Leave Request ${decision}`,
    });
    return { reason: result.skipped ? result.reason : null, deliveryStatus: result.skipped ? "skipped" : "sent" };
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : "Leave decision notification failed.",
      deliveryStatus,
    } as const;
  }
}
async function notifyLeaveSubmitted(
  request: LeaveRequest,
  recipientsResult?: Awaited<ReturnType<typeof resolveLeaveSubmissionRecipients>>,
) {
  const employee = request.employee;
  const actorName = leaveNotificationActorName(request);
  const resolvedRecipients = recipientsResult ?? await resolveLeaveSubmissionRecipients(request);
  const recipientChain = resolvedRecipients.recipients.map((recipient) => ({
    routeLevel: recipient.routeLevel,
    recipientHrId: recipient.recipientHrId,
    recipientRole: recipient.recipientRole,
  }));

  await writeLeaveAuditLog({
    actorHrId: null,
    actorRole: "system",
    employeeHrId: request.employeeHrId,
    eventType: "leave.notification.intent.created",
    metadata: {
      actorName,
      requestId: request.id,
      recipientChain,
      routeCount: recipientChain.length,
      requestType: "leave",
      routeLevels: [...new Set(resolvedRecipients.recipients.map((recipient) => recipient.routeLevel))],
      warnings: resolvedRecipients.warnings,
    },
    requestId: request.id,
  });
  const inAppResult = await dispatchLeaveSubmissionInAppNotifications(request, resolvedRecipients.recipients);
  const emailResult = await emitLeaveNotification("request_submitted", {
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

  return {
    notificationQueued: inAppResult.notificationQueued || Boolean(emailResult?.skipped),
    recipients: inAppResult.recipients,
    warnings: [
      ...recipientsResult.warnings,
      ...(emailResult && "skipped" in emailResult && emailResult.skipped ? [emailResult.reason] : []),
    ],
  };
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
  const emailResult = await emitLeaveNotification(event, {
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
  const inAppResult = await dispatchLeaveDecisionInAppNotification(request, decision);

  return {
    notificationQueued:
      inAppResult.deliveryStatus !== "sent" || (emailResult !== null && "skipped" in emailResult && emailResult.skipped),
    recipients: [],
    warnings: [
      ...((emailResult && "skipped" in emailResult && emailResult.skipped) ? [emailResult.reason] : []),
      inAppResult.reason ? inAppResult.reason : null,
    ].filter(Boolean) as string[],
  };
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
  const titleWeekendRules = await getLeaveTitleWeekendRules();
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
    publicHolidayDates: publicHolidayDateList(holidays),
    titleWeekendRules,
    weekendDays: getWeekendDaysForEmployee(employee, policy.weekendDays, titleWeekendRules),
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
  const correlationId = createLeaveCorrelationId();
  const startedAt = Date.now();
  await assertPermission(access, "leave", "create");
  if (!access.hrId) throw new Error("A linked employee HR_ID is required to submit leave.");
  if (!input.leaveTypeId || !input.startDate || !input.endDate) throw new Error("Leave type and date range are required.");

  const employee = await getEmployeeOrThrow(access.hrId);
  const leaveType = await getLeaveTypeById(input.leaveTypeId);
  if (!employeeSelectableLeaveCodes.has(leaveType.code) || leaveType.code === unpaidLeaveCode || !leaveType.employeeSelectable) {
    throw new Error("This leave type is not available for employee self-service.");
  }

  const policy = await getDefaultLeavePolicy();
  const titleWeekendRules = await getLeaveTitleWeekendRules();
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
  const weekendDays = getWeekendDaysForEmployee(employee, policy.weekendDays, titleWeekendRules);
  const totalWorkingDays = calculateLeaveDuration(
    input.startDate,
    input.endDate,
    publicHolidayDateList(holidays),
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

  const request = await hydrateLeaveRequest(data as LeaveRequestRow);
  void (async () => {
    try {
      const conflicts = await previewLeaveConflicts(access, input);
      if (conflicts.warnings.length) {
        await writeLeaveAuditLog({
          actorHrId: access.hrId,
          actorRole: access.role,
          correlationId,
          employeeHrId: request.employeeHrId,
          eventType: "leave.request.submit.conflict.warning",
          metadata: {
            requestId: request.id,
            warnings: conflicts.warnings.map((warning) => warning.message),
          },
          requestId: request.id,
        });
      }
    } catch (error) {
      await writeLeaveAuditLog({
        actorHrId: access.hrId,
        actorRole: access.role,
        correlationId,
        employeeHrId: request.employeeHrId,
        eventType: "leave.request.submit.conflict.check_failed",
        metadata: {
          error: error instanceof Error ? error.message : "Unable to compute conflict warnings after submission.",
          requestId: request.id,
        },
        requestId: request.id,
      });
    }
  })().catch(() => undefined);

  const recipientResult = await resolveLeaveSubmissionRecipients(request);
  const notificationPreview = {
    notificationQueued: recipientResult.recipients.length > 0,
    recipients: recipientResult.recipients.map((recipient) => ({ ...recipient, deliveryStatus: "queued" })),
    warnings: [...recipientResult.warnings],
  };
  void notifyLeaveSubmitted(request, recipientResult).catch((error) => {
    void writeLeaveAuditLog({
      actorHrId: access.hrId,
      actorRole: access.role,
      correlationId,
      employeeHrId: request.employeeHrId,
      eventType: "leave.notification.submit.background_failed",
      metadata: { error: error instanceof Error ? error.message : "Leave submission notification workflow failed." },
      requestId: request.id,
    });
  });
  await writeLeaveAuditLog({
    actorHrId: access.hrId,
    actorRole: access.role,
    correlationId,
    employeeHrId: request.employeeHrId,
    eventType: "leave.request.submit.completed",
    metadata: {
      durationMs: Date.now() - startedAt,
      recipientCount: recipientResult.recipients.length,
      requestId: request.id,
      status: request.status,
    },
    requestId: request.id,
  });
  return {
    notificationQueued: notificationPreview.notificationQueued,
    recipients: notificationPreview.recipients,
    request,
    warnings: notificationPreview.warnings,
  };
}

async function loadRequestRow(id: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("leave_requests")
    .select("*,leave_types:leave_types!leave_requests_leave_type_id_fkey(code,name,is_paid,affects_payroll)")
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

export async function decideLeaveAsManager(access: AccessContext, requestId: string, input: LeaveDecisionInput): Promise<LeaveDecisionResponse> {
  await assertPermission(access, "leave", "approve");
  const decision = normalizeLeaveDecision(input);

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
      p_decision: decision,
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
      metadata: { decision, error: error.message, requestId },
      requestId,
    });
    throw error;
  }

  const request = await hydrateLeaveRequest(data as LeaveRequestRow);
  void notifyLeaveDecision(request, decision === "approved" ? "manager approved" : "manager rejected").catch(async (error) => {
    await writeLeaveAuditLog({
      actorHrId: access.hrId,
      actorRole: access.role,
      correlationId,
      employeeHrId: row.employee_hr_id,
      eventType: "leave.manager.decision.notification_failed",
      metadata: { decision, error: error instanceof Error ? error.message : "Leave decision notification failed.", requestId },
      requestId,
    });
  });
  return {
    notificationQueued: true,
    recipients: [],
    request,
    warnings: [],
  };
}

export async function decideLeaveAsHr(access: AccessContext, requestId: string, input: LeaveDecisionInput): Promise<LeaveDecisionResponse> {
  await assertPermission(access, "leave", "approve");
  if (!isManageRole(access)) throw new Error("Forbidden: HR approval requires HR or Super Admin access.");
  const decision = normalizeLeaveDecision(input);

  const row = await loadRequestRow(requestId);
  if (row.status !== "pending_hr" && row.status !== "manager_approved") {
    throw new Error("This request is not pending HR approval.");
  }
  const leaveType = await getLeaveTypeById(row.leave_type_id);
  if (decision === "approved" && leaveType.code === otherLeaveCode && input.balanceDecision !== "deduct" && input.balanceDecision !== "no_deduct") {
    throw new Error("HR must choose whether Other leave deducts from balance.");
  }
  if (decision === "approved" && leaveType.code === otherLeaveCode && input.balanceDecision === "deduct") {
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
      p_decision: decision,
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
      metadata: { balanceDecision: input.balanceDecision ?? null, decision, error: error.message, requestId },
      requestId,
    });
    throw error;
  }

  const request = await hydrateLeaveRequest(data as LeaveRequestRow);
  void notifyLeaveDecision(request, decision === "approved" ? "approved" : "rejected").catch(async (error) => {
    await writeLeaveAuditLog({
      actorHrId: access.hrId,
      actorRole: access.role,
      correlationId,
      employeeHrId: row.employee_hr_id,
      eventType: "leave.hr.decision.notification_failed",
      metadata: { balanceDecision: input.balanceDecision ?? null, decision, error: error instanceof Error ? error.message : "Leave decision notification failed.", requestId },
      requestId,
    });
  });
  return {
    notificationQueued: true,
    recipients: [],
    request,
    warnings: [],
  };
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
    ctaLabel: "Open leave management",
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

type AutomaticAccrualNotificationSummary = {
  failed: number;
  sent: number;
  skipped: number;
  totalRecipients: number;
};

type AutomaticAccrualPeriodResult = {
  month: number;
  notification?: AutomaticAccrualNotificationSummary | null;
  period: string;
  processed: number;
  skipped: number;
  status: "processed" | "skipped";
  totalAmount: number;
  wouldAccrue: number;
  year: number;
};

const automaticAccrualAccess: AccessContext = {
  hrId: null,
  role: "Super Admin",
  scope: "system",
  source: "system",
};

function normalizeAccrualMonth(value: number | undefined, fallback: number) {
  const month = Number(value ?? fallback);
  if (!Number.isFinite(month)) return fallback;
  return Math.max(1, Math.min(12, Math.trunc(month)));
}

async function notifyEmployeesAboutAutomaticAccrual(input: {
  period: string;
  processed: number;
  totalAmount: number;
  year: number;
}): Promise<AutomaticAccrualNotificationSummary> {
  const { directory } = await loadDirectoryMaps();
  const activeEmployees = directory.employees.filter(
    (employee) => (employee.employmentStatus ?? "active").toLowerCase() === "active" && cleanHrId(employee.hrId),
  );
  const summary: AutomaticAccrualNotificationSummary = {
    failed: 0,
    sent: 0,
    skipped: 0,
    totalRecipients: activeEmployees.length,
  };

  for (const employee of activeEmployees) {
    try {
      const notification = await enqueueInAppNotification({
        category: "leave",
        dedupeKey: `leave:automatic-accrual:${input.period}:${cleanHrId(employee.hrId)}`,
        href: "/employee-portals/leave",
        message: `Monthly vacation accrual for ${input.period} has been posted to employee leave balances.`,
        metadata: {
          period: input.period,
          processedTransactions: input.processed,
          source: "automatic_monthly_accrual",
          totalAmount: input.totalAmount,
          year: input.year,
        },
        recipientHrId: employee.hrId,
        title: "Vacation Balance Updated",
      });
      if (notification.skipped) {
        summary.skipped += 1;
      } else {
        summary.sent += 1;
      }
    } catch {
      summary.failed += 1;
    }
  }

  await writeLeaveAuditLog({
    actorRole: automaticAccrualAccess.role,
    eventType: "leave.accrual.employee_notifications.completed",
    metadata: {
      ...summary,
      period: input.period,
      processedTransactions: input.processed,
      source: "automatic_monthly_accrual",
      totalAmount: input.totalAmount,
    },
  });

  return summary;
}

export async function runAutomaticMonthlyLeaveAccrual(input: {
  notifyEmployees?: boolean;
  throughMonth?: number;
  year?: number;
} = {}) {
  const now = new Date();
  const year = Number.isFinite(Number(input.year)) ? Number(input.year) : now.getUTCFullYear();
  const throughMonth = normalizeAccrualMonth(input.throughMonth, now.getUTCMonth() + 1);
  const notifyEmployees = input.notifyEmployees !== false;
  const periods: AutomaticAccrualPeriodResult[] = [];

  for (let month = 1; month <= throughMonth; month += 1) {
    const preview = await getLeaveAccrualPreview(automaticAccrualAccess, { month, year });
    if (preview.wouldAccrue <= 0) {
      periods.push({
        month,
        notification: null,
        period: preview.period,
        processed: 0,
        skipped: preview.alreadyAccrued,
        status: "skipped",
        totalAmount: 0,
        wouldAccrue: preview.wouldAccrue,
        year,
      });
      continue;
    }

    const run = await runMonthlyLeaveAccrual(automaticAccrualAccess, { month, year });
    const notification = notifyEmployees && run.processed > 0
      ? await notifyEmployeesAboutAutomaticAccrual({
        period: run.period,
        processed: run.processed,
        totalAmount: run.totalAmount,
        year: run.year,
      })
      : null;

    periods.push({
      month: run.month,
      notification,
      period: run.period,
      processed: run.processed,
      skipped: run.skipped,
      status: run.processed > 0 ? "processed" : "skipped",
      totalAmount: run.totalAmount,
      wouldAccrue: preview.wouldAccrue,
      year: run.year,
    });
  }

  const result = {
    generatedAt: new Date().toISOString(),
    notificationMode: notifyEmployees ? "all_active_employees" : "disabled",
    periods,
    processedPeriods: periods.filter((period) => period.processed > 0).length,
    skippedPeriods: periods.filter((period) => period.processed <= 0).length,
    throughMonth,
    totalAmount: Math.round(periods.reduce((sum, period) => sum + period.totalAmount, 0) * 100) / 100,
    totalProcessed: periods.reduce((sum, period) => sum + period.processed, 0),
    year,
  };

  await writeLeaveAuditLog({
    actorRole: automaticAccrualAccess.role,
    eventType: "leave.accrual.automatic.completed",
    metadata: result,
  });

  return result;
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
  const [requests, holidays, titleWeekendRules] = await Promise.all([
    hasApproveAccess && !isManageRole(access) ? listManagerHierarchyLeaveRequests(access, {}) : listLeaveRequests(access, {}),
    getPublicHolidays(year, policy.country).catch(() => []),
    getLeaveTitleWeekendRules().catch(() => []),
  ]);
  return buildTeamAvailability(requests, holidays, {
    area: input.area,
    employeeHrId: input.employeeHrId,
    endDate,
    line: input.line,
    startDate,
    titleWeekendRules,
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
  const { directory, employeeByHrId } = await loadDirectoryMaps();
  if (annualType) {
    const year = new Date().getUTCFullYear();
    const supabase = getSupabaseAdmin();
    const { data: balanceRows } = await supabase
      .from("employee_leave_balances")
      .select("employee_hr_id,available_balance,consumed")
      .eq("leave_type_id", annualType.id)
      .eq("year", year);

    const balancesByHrId = new Map((balanceRows ?? []).map((b) => [cleanHrId(b.employee_hr_id), b]));

    for (const employee of directory.employees) {
      if (!canSeeLeaveEmployee(access, employee.hrId, employeeByHrId)) continue;
      const wallet = balancesByHrId.get(cleanHrId(employee.hrId));
      if (!wallet) continue;

      const line = employee.lineName?.trim();
      if (!line) continue;
      const current = balanceUtilization.get(line) ?? { available: 0, used: 0 };
      current.available += n(wallet.available_balance);
      current.used += n(wallet.consumed);
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

function paymentStatusLabelForReport(status: LeavePaymentStatus) {
  return paymentStatusLabel(status);
}

function reportStatusText(status: string | null | undefined) {
  return status ? prettyReportStatus(status) : "";
}

function prettyReportStatus(status: string) {
  return status.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function reportDate(value: string | null | undefined) {
  return value ? value.slice(0, 10) : "";
}

function reportDateTime(value: string | null | undefined) {
  return value ? new Date(value).toISOString().replace("T", " ").slice(0, 16) : "";
}

function reportNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : "Unavailable";
}

const vacationReportColumns = [
  { header: "Employee HR ID", key: "employeeHrId", width: 18 },
  { header: "Employee Name", key: "employeeName", width: 28 },
  { header: "Title", key: "title", width: 24 },
  { header: "Line", key: "line", width: 20 },
  { header: "Area", key: "area", width: 20 },
  { header: "Direct Manager", key: "directManager", width: 26 },
  { header: "Direct Manager HR ID", key: "directManagerHrId", width: 22 },
  { header: "Request Date", key: "requestDate", width: 16 },
  { header: "Leave Type", key: "leaveType", width: 20 },
  { header: "From Date", key: "fromDate", width: 16 },
  { header: "To Date", key: "toDate", width: 16 },
  { header: "Duration", key: "duration", width: 12 },
  { header: "Duration Unit", key: "durationUnit", width: 16 },
  { header: "Balance Before", key: "balanceBefore", width: 18 },
  { header: "Balance After", key: "balanceAfter", width: 18 },
  { header: "Payment Status", key: "paymentStatus", width: 18 },
  { header: "Manager Approval Status", key: "managerApprovalStatus", width: 24 },
  { header: "Manager Approved By", key: "managerApprovedBy", width: 22 },
  { header: "Manager Decision Date", key: "managerDecisionDate", width: 22 },
  { header: "HR Approval Status", key: "hrApprovalStatus", width: 20 },
  { header: "HR Approved By", key: "hrApprovedBy", width: 18 },
  { header: "HR Decision Date", key: "hrDecisionDate", width: 20 },
  { header: "Final Status", key: "finalStatus", width: 18 },
  { header: "Reason", key: "reason", width: 36 },
  { header: "Attachment Status", key: "attachmentStatus", width: 20 },
  { header: "Created At", key: "createdAt", width: 22 },
];

function addVacationReportWorksheet(workbook: ExcelJS.Workbook, report: VacationReportData) {
  const worksheet = workbook.addWorksheet(report.title.slice(0, 31));
  worksheet.mergeCells("A1:Z1");
  worksheet.getCell("A1").value = "Phoenix Workforce Vacation Report";
  worksheet.getCell("A1").font = { bold: true, color: { argb: "FFFFFFFF" }, size: 16 };
  worksheet.getCell("A1").fill = { fgColor: { argb: "FF0F172A" }, pattern: "solid", type: "pattern" };
  worksheet.getCell("A1").alignment = { horizontal: "center" };

  worksheet.mergeCells("A2:Z2");
  worksheet.getCell("A2").value = `${report.title} | Generated ${new Date().toISOString().slice(0, 10)} | Scope: ${report.scope.toUpperCase()}`;
  worksheet.getCell("A2").font = { bold: true, color: { argb: "FF9A3412" } };
  worksheet.getCell("A2").fill = { fgColor: { argb: "FFFFEDD5" }, pattern: "solid", type: "pattern" };
  worksheet.getCell("A2").alignment = { horizontal: "center" };

  worksheet.columns = vacationReportColumns.map(({ key, width }) => ({ key, width }));
  worksheet.spliceRows(3, 0, vacationReportColumns.map((column) => column.header));
  worksheet.getRow(3).height = 24;
  worksheet.getRow(3).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { fgColor: { argb: "FFF97316" }, pattern: "solid", type: "pattern" };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = {
      bottom: { color: { argb: "FFEA580C" }, style: "thin" },
      left: { color: { argb: "FFFFEDD5" }, style: "thin" },
      right: { color: { argb: "FFFFEDD5" }, style: "thin" },
      top: { color: { argb: "FFFFEDD5" }, style: "thin" },
    };
  });

  for (const row of report.rows) {
    worksheet.addRow({
      area: row.area ?? "",
      attachmentStatus: row.attachmentStatus === "attached" ? "Attached" : "Missing",
      balanceAfter: reportNumber(row.balanceAfter),
      balanceBefore: reportNumber(row.balanceBefore),
      createdAt: reportDateTime(row.createdAt),
      directManager: row.directManager ?? "",
      directManagerHrId: row.directManagerHrId ?? "",
      duration: row.duration,
      durationUnit: row.durationUnit === "full_day" ? "Full Day" : row.durationUnit.toUpperCase(),
      employeeHrId: row.employeeHrId,
      employeeName: row.employeeName ?? "",
      finalStatus: reportStatusText(row.finalStatus),
      fromDate: reportDate(row.fromDate),
      hrApprovalStatus: reportStatusText(row.hrApprovalStatus),
      hrApprovedBy: row.hrApprovedBy ?? "",
      hrDecisionDate: reportDateTime(row.hrDecisionDate),
      leaveType: row.leaveType ?? "",
      line: row.line ?? "",
      managerApprovalStatus: reportStatusText(row.managerApprovalStatus),
      managerApprovedBy: row.managerApprovedBy ?? "",
      managerDecisionDate: reportDateTime(row.managerDecisionDate),
      paymentStatus: paymentStatusLabelForReport(row.paymentStatus),
      reason: row.reason ?? "",
      requestDate: reportDateTime(row.requestDate),
      title: row.title ?? "",
      toDate: reportDate(row.toDate),
    });
  }

  worksheet.views = [{ state: "frozen", ySplit: 3 }];
  worksheet.autoFilter = { from: "A3", to: `Z${Math.max(3, report.rows.length + 3)}` };
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber <= 3) return;
    row.eachCell((cell) => {
      cell.alignment = { vertical: "top", wrapText: true };
      cell.border = { bottom: { color: { argb: "FFE2E8F0" }, style: "thin" } };
    });
  });
  return worksheet;
}

export async function exportVacationReportToExcel(access: AccessContext, scope: VacationReportScope, filters: LeaveRequestFilters = {}) {
  await assertPermission(access, "leave", scope === "my" ? "read" : "export");
  const report = await getVacationReport(access, scope, filters);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();
  addVacationReportWorksheet(workbook, report);
  return workbook.xlsx.writeBuffer();
}

function excelDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function excelNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

async function getAllActiveEmployeesAccrualRows(access: AccessContext, year: number, filters: LeaveRequestFilters) {
  const rows: ActiveEmployeeAccrualRow[] = [];
  let offset = 0;
  const limit = 100;
  let totalRows = 0;
  do {
    const page = await getActiveEmployeesAccrualReport(access, year, { ...filters, limit, offset });
    rows.push(...page.rows);
    totalRows = page.pagination.totalRows;
    offset += limit;
  } while (rows.length < totalRows);
  return rows;
}

function styleActiveAccrualWorksheet(worksheet: ExcelJS.Worksheet, lastRow: number) {
  worksheet.getRow(4).height = 30;
  worksheet.getRow(4).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { fgColor: { argb: "FFF97316" }, pattern: "solid", type: "pattern" };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = {
      bottom: { color: { argb: "FFEA580C" }, style: "thin" },
      left: { color: { argb: "FFFFEDD5" }, style: "thin" },
      right: { color: { argb: "FFFFEDD5" }, style: "thin" },
      top: { color: { argb: "FFFFEDD5" }, style: "thin" },
    };
  });
  worksheet.views = [{ state: "frozen", ySplit: 4 }];
  worksheet.autoFilter = { from: "A4", to: `W${Math.max(4, lastRow)}` };
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber <= 4) return;
    row.eachCell((cell) => {
      cell.alignment = { vertical: "top", wrapText: true };
      cell.border = { bottom: { color: { argb: "FFE2E8F0" }, style: "thin" } };
    });
  });
  for (const column of ["G", "V"]) worksheet.getColumn(column).numFmt = "dd mmm yyyy";
  for (const column of ["J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T"]) worksheet.getColumn(column).numFmt = "0.00";
  for (let row = 5; row <= lastRow; row += 1) {
    worksheet.getCell(`T${row}`).fill = { fgColor: { argb: "FFF8FAFC" }, pattern: "solid", type: "pattern" };
    worksheet.getCell(`T${row}`).font = { bold: true, color: { argb: "FF475569" } };
  }
}

export async function exportActiveEmployeesAccrualToExcel(access: AccessContext, filters: LeaveRequestFilters = {}) {
  await assertPermission(access, "leave", "export");
  if (!isManageRole(access)) throw new Error("Forbidden: active employee accrual export requires HR or Super Admin access.");
  const year = filters.year ?? new Date().getUTCFullYear();
  const [policy, rows] = await Promise.all([
    getDefaultLeavePolicy(),
    getAllActiveEmployeesAccrualRows(access, year, filters),
  ]);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;

  const inputs = workbook.addWorksheet("Formula Inputs");
  inputs.columns = [{ width: 34 }, { width: 22 }, { width: 54 }];
  inputs.addRows([
    ["Phoenix Workforce Employees Accrual Sheet Export", "", "Formula source sheet. Values here drive workbook formulas."],
    ["Generated Date", new Date(), "Used by service-duration and policy-basis formulas."],
    ["Report Year", { formula: `${year}`, result: year }, ""],
    ["Annual Entitlement - Less Than 1 Year", { formula: `${policy.annualDaysFirstYear}`, result: policy.annualDaysFirstYear }, ""],
    ["Annual Entitlement - 1 Year Or More", { formula: `${policy.annualDaysAfterFirstYear}`, result: policy.annualDaysAfterFirstYear }, ""],
    ["Monthly Accrual Divisor", { formula: "12", result: 12 }, "Monthly Accrual = Annual Entitlement / 12."],
  ]);
  inputs.getCell("B2").numFmt = "dd mmm yyyy";
  inputs.getColumn(1).font = { bold: true, color: { argb: "FF0F172A" } };
  inputs.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" }, size: 14 };
  inputs.getRow(1).fill = { fgColor: { argb: "FF0F172A" }, pattern: "solid", type: "pattern" };

  const source = workbook.addWorksheet("Accrual Source Data");
  source.state = "veryHidden";
  source.columns = [
    { key: "employeeHrId", width: 16 },
    { key: "employeeName", width: 28 },
    { key: "title", width: 24 },
    { key: "line", width: 20 },
    { key: "area", width: 20 },
    { key: "directManager", width: 26 },
    { key: "hiringDate", width: 16 },
    { key: "serviceDuration", width: 24 },
    { key: "policyBasis", width: 26 },
    { key: "annualEntitlement", width: 18 },
    { key: "monthlyAccrual", width: 18 },
    { key: "openingBalance", width: 18 },
    { key: "accruedToDate", width: 18 },
    { key: "usedConsumed", width: 18 },
    { key: "pending", width: 14 },
    { key: "carryForward", width: 18 },
    { key: "adjustments", width: 16 },
    { key: "availableBalanceFormula", width: 22 },
    { key: "systemAvailableBalance", width: 24 },
    { key: "variance", width: 14 },
    { key: "lastAccrualMonth", width: 18 },
    { key: "lastLeaveTransactionDate", width: 24 },
    { key: "status", width: 16 },
  ];
  source.spliceRows(4, 0, [
    "HR ID",
    "Employee Name",
    "Title",
    "Line",
    "Area",
    "Direct Manager",
    "Hiring Date",
    "Service Duration",
    "Policy Basis",
    "Annual Entitlement",
    "Monthly Accrual",
    "Opening Balance",
    "Accrued To Date",
    "Used / Consumed",
    "Pending",
    "Carry Forward",
    "Adjustments",
    "Formula Available Balance",
    "System Available Balance",
    "Variance",
    "Last Accrual Month",
    "Last Leave Transaction Date",
    "Status",
  ]);
  rows.forEach((row) => {
    source.addRow({
      accruedToDate: String(excelNumber(row.accruedToDate)),
      adjustments: String(excelNumber(row.adjustments)),
      area: row.area ?? "",
      availableBalanceFormula: String(excelNumber(row.availableBalance)),
      carryForward: String(excelNumber(row.carryForward)),
      directManager: row.directManager ?? "",
      employeeHrId: row.employeeHrId,
      employeeName: row.employeeName,
      hiringDate: excelDate(row.hiringDate),
      lastAccrualMonth: row.lastAccrualMonth ?? "",
      lastLeaveTransactionDate: excelDate(row.lastLeaveTransactionDate),
      line: row.line ?? "",
      monthlyAccrual: String(excelNumber(row.monthlyAccrual)),
      openingBalance: String(excelNumber(row.openingBalance)),
      pending: String(excelNumber(row.pending)),
      policyBasis: row.policyBasis,
      serviceDuration: row.serviceDuration,
      status: row.status,
      systemAvailableBalance: String(excelNumber(row.availableBalance)),
      title: row.title ?? "",
      usedConsumed: String(excelNumber(row.usedConsumed)),
      variance: "0",
    });
  });

  const worksheet = workbook.addWorksheet("Employees Accrual");
  worksheet.mergeCells("A1:W1");
  worksheet.getCell("A1").value = "Phoenix Workforce - Employees Accrual";
  worksheet.getCell("A1").font = { bold: true, color: { argb: "FFFFFFFF" }, size: 16 };
  worksheet.getCell("A1").fill = { fgColor: { argb: "FF0F172A" }, pattern: "solid", type: "pattern" };
  worksheet.getCell("A1").alignment = { horizontal: "center" };
  worksheet.mergeCells("A2:W2");
  worksheet.getCell("A2").value = `Generated ${new Date().toISOString().slice(0, 10)} | Year ${year} | Formula-driven entitlement, accrual, available balance, and variance checks`;
  worksheet.getCell("A2").font = { bold: true, color: { argb: "FF9A3412" } };
  worksheet.getCell("A2").fill = { fgColor: { argb: "FFFFEDD5" }, pattern: "solid", type: "pattern" };
  worksheet.getCell("A2").alignment = { horizontal: "center" };

  worksheet.columns = [
    { key: "employeeHrId", width: 16 },
    { key: "employeeName", width: 28 },
    { key: "title", width: 24 },
    { key: "line", width: 20 },
    { key: "area", width: 20 },
    { key: "directManager", width: 26 },
    { key: "hiringDate", width: 16 },
    { key: "serviceDuration", width: 24 },
    { key: "policyBasis", width: 26 },
    { key: "annualEntitlement", width: 18 },
    { key: "monthlyAccrual", width: 18 },
    { key: "openingBalance", width: 18 },
    { key: "accruedToDate", width: 18 },
    { key: "usedConsumed", width: 18 },
    { key: "pending", width: 14 },
    { key: "carryForward", width: 18 },
    { key: "adjustments", width: 16 },
    { key: "availableBalanceFormula", width: 22 },
    { key: "systemAvailableBalance", width: 24 },
    { key: "variance", width: 14 },
    { key: "lastAccrualMonth", width: 18 },
    { key: "lastLeaveTransactionDate", width: 24 },
    { key: "status", width: 16 },
  ];
  worksheet.spliceRows(4, 0, [
    "HR ID",
    "Employee Name",
    "Title",
    "Line",
    "Area",
    "Direct Manager",
    "Hiring Date",
    "Service Duration",
    "Policy Basis",
    "Annual Entitlement",
    "Monthly Accrual",
    "Opening Balance",
    "Accrued To Date",
    "Used / Consumed",
    "Pending",
    "Carry Forward",
    "Adjustments",
    "Formula Available Balance",
    "System Available Balance",
    "Variance",
    "Last Accrual Month",
    "Last Leave Transaction Date",
    "Status",
  ]);

  const formulaLastRow = Math.max(rows.length + 4, 1004);
  for (let rowNumber = 5; rowNumber <= formulaLastRow; rowNumber += 1) {
    const row = rows[rowNumber - 5];
    worksheet.addRow({});
    worksheet.getCell(`A${rowNumber}`).value = { formula: `IF('Accrual Source Data'!A${rowNumber}="","",'Accrual Source Data'!A${rowNumber})`, result: row?.employeeHrId ?? "" };
    worksheet.getCell(`B${rowNumber}`).value = { formula: `IF('Accrual Source Data'!B${rowNumber}="","",'Accrual Source Data'!B${rowNumber})`, result: row?.employeeName ?? "" };
    worksheet.getCell(`C${rowNumber}`).value = { formula: `IF('Accrual Source Data'!C${rowNumber}="","",'Accrual Source Data'!C${rowNumber})`, result: row?.title ?? "" };
    worksheet.getCell(`D${rowNumber}`).value = { formula: `IF('Accrual Source Data'!D${rowNumber}="","",'Accrual Source Data'!D${rowNumber})`, result: row?.line ?? "" };
    worksheet.getCell(`E${rowNumber}`).value = { formula: `IF('Accrual Source Data'!E${rowNumber}="","",'Accrual Source Data'!E${rowNumber})`, result: row?.area ?? "" };
    worksheet.getCell(`F${rowNumber}`).value = { formula: `IF('Accrual Source Data'!F${rowNumber}="","",'Accrual Source Data'!F${rowNumber})`, result: row?.directManager ?? "" };
    worksheet.getCell(`G${rowNumber}`).value = { formula: `IF('Accrual Source Data'!G${rowNumber}="","",'Accrual Source Data'!G${rowNumber})`, result: row ? excelDate(row.hiringDate) ?? undefined : undefined };
    worksheet.getCell(`H${rowNumber}`).value = {
      formula: `IF(G${rowNumber}="","Unavailable",DATEDIF(G${rowNumber},'Formula Inputs'!$B$2,"Y")&" year"&IF(DATEDIF(G${rowNumber},'Formula Inputs'!$B$2,"Y")=1,"","s")&", "&DATEDIF(G${rowNumber},'Formula Inputs'!$B$2,"YM")&" month"&IF(DATEDIF(G${rowNumber},'Formula Inputs'!$B$2,"YM")=1,"","s"))`,
      result: row?.serviceDuration ?? "Unavailable",
    };
    worksheet.getCell(`I${rowNumber}`).value = {
      formula: `IF(G${rowNumber}="","Unavailable",IF(DATEDIF(G${rowNumber},'Formula Inputs'!$B$2,"Y")>=1,"1 year or more of service","Less than 1 year of service"))`,
      result: row?.policyBasis ?? "Unavailable",
    };
    worksheet.getCell(`J${rowNumber}`).value = {
      formula: `IF(G${rowNumber}="","",IF(DATEDIF(G${rowNumber},'Formula Inputs'!$B$2,"Y")>=1,'Formula Inputs'!$B$5,'Formula Inputs'!$B$4))`,
      result: row ? excelNumber(row.annualEntitlement) : 0,
    };
    worksheet.getCell(`K${rowNumber}`).value = {
      formula: `IF(J${rowNumber}="","",ROUND(J${rowNumber}/'Formula Inputs'!$B$6,2))`,
      result: row ? excelNumber(row.monthlyAccrual) : 0,
    };
    worksheet.getCell(`L${rowNumber}`).value = { formula: `IF(G${rowNumber}="","",IFERROR(VALUE('Accrual Source Data'!L${rowNumber}),0))`, result: row ? excelNumber(row.openingBalance) : 0 };
    worksheet.getCell(`M${rowNumber}`).value = {
      formula: `IF(G${rowNumber}="","",ROUND(K${rowNumber}*MAX(0,DATEDIF(MAX(G${rowNumber},DATE('Formula Inputs'!$B$3,1,1)),'Formula Inputs'!$B$2,"M")+1),2))`,
      result: row ? excelNumber(row.accruedToDate) : 0,
    };
    worksheet.getCell(`N${rowNumber}`).value = { formula: `IF(G${rowNumber}="","",IFERROR(VALUE('Accrual Source Data'!N${rowNumber}),0))`, result: row ? excelNumber(row.usedConsumed) : 0 };
    worksheet.getCell(`O${rowNumber}`).value = { formula: `IF(G${rowNumber}="","",IFERROR(VALUE('Accrual Source Data'!O${rowNumber}),0))`, result: row ? excelNumber(row.pending) : 0 };
    worksheet.getCell(`P${rowNumber}`).value = { formula: `IF(G${rowNumber}="","",IFERROR(VALUE('Accrual Source Data'!P${rowNumber}),0))`, result: row ? excelNumber(row.carryForward) : 0 };
    worksheet.getCell(`Q${rowNumber}`).value = { formula: `IF(G${rowNumber}="","",IFERROR(VALUE('Accrual Source Data'!Q${rowNumber}),0))`, result: row ? excelNumber(row.adjustments) : 0 };
    worksheet.getCell(`R${rowNumber}`).value = {
      formula: `IF(G${rowNumber}="","",ROUND(L${rowNumber}+M${rowNumber}+P${rowNumber}+Q${rowNumber}-N${rowNumber}-O${rowNumber},2))`,
      result: row ? excelNumber(row.availableBalance) : 0,
    };
    worksheet.getCell(`S${rowNumber}`).value = { formula: `IF(G${rowNumber}="","",IFERROR(VALUE('Accrual Source Data'!S${rowNumber}),R${rowNumber}))`, result: row ? excelNumber(row.availableBalance) : 0 };
    worksheet.getCell(`T${rowNumber}`).value = {
      formula: `IF(G${rowNumber}="","",ROUND(R${rowNumber}-S${rowNumber},2))`,
      result: 0,
    };
    worksheet.getCell(`U${rowNumber}`).value = { formula: `IF('Accrual Source Data'!U${rowNumber}="","",'Accrual Source Data'!U${rowNumber})`, result: row?.lastAccrualMonth ?? "" };
    worksheet.getCell(`V${rowNumber}`).value = { formula: `IF('Accrual Source Data'!V${rowNumber}="","",'Accrual Source Data'!V${rowNumber})`, result: row ? excelDate(row.lastLeaveTransactionDate) ?? undefined : undefined };
    worksheet.getCell(`W${rowNumber}`).value = { formula: `IF(A${rowNumber}="","","active")`, result: row?.status ?? "" };
  }
  const lastRow = formulaLastRow;
  styleActiveAccrualWorksheet(worksheet, lastRow);

  const summary = workbook.addWorksheet("Summary");
  summary.columns = [{ width: 34 }, { width: 22 }, { width: 52 }];
  summary.addRows([
    ["Phoenix Workforce - Employees Accrual Summary", "", ""],
    ["Metric", "Formula Value", "Notes"],
    ["Active Employees", { formula: `COUNTIF('Employees Accrual'!G5:G${lastRow},"<>")`, result: rows.length }, "Count of rows with a hiring date."],
    ["Formula Available Balance Total", { formula: `SUM('Employees Accrual'!R5:R${lastRow})`, result: rows.reduce((sum, row) => sum + row.availableBalance, 0) }, "Uses workbook formula balance column."],
    ["System Available Balance Total", { formula: `SUM('Employees Accrual'!S5:S${lastRow})`, result: rows.reduce((sum, row) => sum + row.availableBalance, 0) }, "Source value from Phoenix ledger/balance rows."],
    ["Variance Total", { formula: `SUM('Employees Accrual'!T5:T${lastRow})`, result: 0 }, "Should be 0.00 when formulas reconcile to system balance."],
    ["Variance Rows", { formula: `COUNTIF('Employees Accrual'!T5:T${lastRow},"<>0")`, result: 0 }, "Rows where workbook formula differs from system balance."],
  ]);
  summary.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" }, size: 14 };
  summary.getRow(1).fill = { fgColor: { argb: "FF0F172A" }, pattern: "solid", type: "pattern" };
  summary.getRow(2).font = { bold: true, color: { argb: "FFFFFFFF" } };
  summary.getRow(2).fill = { fgColor: { argb: "FFF97316" }, pattern: "solid", type: "pattern" };
  summary.getColumn(2).numFmt = "0.00";

  return workbook.xlsx.writeBuffer();
}

function assertHistoricalVacationManageAccess(access: AccessContext) {
  if (!isManageRole(access)) throw new Error("Forbidden: historical vacation upload requires HR or Super Admin access.");
}

function styleHistoricalHeader(row: ExcelJS.Row) {
  row.height = 26;
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { fgColor: { argb: "FFF97316" }, pattern: "solid", type: "pattern" };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = {
      bottom: { color: { argb: "FFEA580C" }, style: "thin" },
      left: { color: { argb: "FFFFEDD5" }, style: "thin" },
      right: { color: { argb: "FFFFEDD5" }, style: "thin" },
      top: { color: { argb: "FFFFEDD5" }, style: "thin" },
    };
  });
}

function addValidationList(worksheet: ExcelJS.Worksheet, column: string, values: string[]) {
  for (let row = 4; row <= 1000; row += 1) {
    worksheet.getCell(`${column}${row}`).dataValidation = {
      allowBlank: true,
      formulae: [`"${values.join(",")}"`],
      showErrorMessage: true,
      type: "list",
    };
  }
}

export async function exportHistoricalVacationTemplateToExcel(access: AccessContext) {
  await assertPermission(access, "leave", "export");
  assertHistoricalVacationManageAccess(access);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();

  const instructions = workbook.addWorksheet(historicalTemplateInstructionSheetName);
  instructions.mergeCells("A1:D1");
  instructions.getCell("A1").value = "Historical Vacation Template Download";
  instructions.getCell("A1").font = { bold: true, color: { argb: "FFFFFFFF" }, size: 18 };
  instructions.getCell("A1").fill = { fgColor: { argb: "FF0F172A" }, pattern: "solid", type: "pattern" };
  instructions.getCell("A1").alignment = { horizontal: "center" };
  instructions.columns = [
    { key: "topic", width: 30 },
    { key: "details", width: 90 },
    { key: "allowed", width: 54 },
    { key: "required", width: 18 },
  ];
  instructions.addRow(["Purpose", "Use this workbook for historical leave/vacation records only. It does not change current new-request business logic, entitlement, accrual, approval, attachments, or payroll.", "", ""]);
  instructions.addRow(["Historical payment behavior", "Uploaded historical rows preserve the HR decision that happened at the time. Paid + deduct consumes balance. Unpaid or non_deducted + no_deduct does not consume balance. The current automatic unpaid policy is not reapplied to old rows.", "paid, unpaid, in_review, non_deducted", "Yes"]);
  instructions.addRow(["Dry-run first", "Upload is validated in dry-run before confirmation. Dry-run does not mutate leave requests, leave balances, leave transactions, or payroll.", "", ""]);
  instructions.addRow(["Confirmation", "Confirmation imports accepted rows only after validation, records rejected rows and warnings, and writes centralized master audit events. No payroll tables are mutated.", "", ""]);
  instructions.addRow(["Duplicates", "Rows can be rejected as duplicates when the same employee, dates, leave type, and external reference already exist or repeat in the same workbook.", "", ""]);
  instructions.addRow(["AM/PM rules", "Duration_Unit am or pm is allowed for a single day only and should use Duration 0.5. full_day can span multiple dates.", "full_day, am, pm", "Yes"]);
  instructions.addRow(["Date rules", "Request_Date, From_Date, To_Date, Hiring_Date, Manager_Decision_Date, and HR_Decision_Date must be valid dates. To_Date cannot be before From_Date. Decision dates cannot be before Request_Date.", "", "Yes"]);
  instructions.addRow(["Approval statuses", "Manager and HR status show the reconstructed approval step. Final_Status is the final workflow state to preserve historically.", "pending, approved, rejected, not_required", "Yes"]);
  instructions.addRow(["Final statuses", "Use hr_approved only for records that should be considered finally approved. Deducting balance is only valid for hr_approved rows.", Array.from(historicalFinalStatuses).join(", "), "Yes"]);
  instructions.addRow(["Leave types", "Use active system leave types where possible. casual_leave and unpaid_leave are accepted only for historical compatibility.", Array.from(historicalLeaveTypeCodes).join(", "), "Yes"]);
  instructions.addRow(["Balance fields", "Balance_Before and Balance_After are required when Balance_Deduction is deduct. Do not invent values; leave no_deduct rows blank if ledger values are not available.", "", "Conditional"]);
  instructions.addRow(["Import traceability", "External_Reference and Legacy_System help duplicate detection and audit traceability.", "", "Recommended"]);
  instructions.getRow(2).font = { bold: true };
  instructions.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.eachCell((cell) => {
      cell.alignment = { vertical: "top", wrapText: true };
      cell.border = { bottom: { color: { argb: "FFE2E8F0" }, style: "thin" } };
    });
  });
  instructions.views = [{ state: "frozen", ySplit: 1 }];

  const worksheet = workbook.addWorksheet(historicalTemplateSheetName);
  worksheet.mergeCells("A1:AE1");
  worksheet.getCell("A1").value = "Historical Vacation Template Download";
  worksheet.getCell("A1").font = { bold: true, color: { argb: "FFFFFFFF" }, size: 16 };
  worksheet.getCell("A1").fill = { fgColor: { argb: "FF0F172A" }, pattern: "solid", type: "pattern" };
  worksheet.getCell("A1").alignment = { horizontal: "center" };
  worksheet.mergeCells("A2:AE2");
  worksheet.getCell("A2").value = "Historical data only. Preserve uploaded paid/unpaid and deduct/no-deduct decisions. Dry-run and confirmation are required before import.";
  worksheet.getCell("A2").font = { bold: true, color: { argb: "FF9A3412" } };
  worksheet.getCell("A2").fill = { fgColor: { argb: "FFFFEDD5" }, pattern: "solid", type: "pattern" };
  worksheet.columns = historicalVacationColumns.map(({ key, width }) => ({ key, width }));
  worksheet.spliceRows(3, 0, historicalVacationColumns.map((column) => column.header));
  worksheet.addRow({
    HR_ID: "EMP001",
    Employee_Name: "Sample Employee",
    Title: "Medical Rep",
    Line: "Example Line",
    Area: "Example Area",
    Direct_Manager_HR_ID: "MGR001",
    Hiring_Date: "2025-01-01",
    Leave_Type: "annual_leave",
    Request_Date: "2025-02-10",
    From_Date: "2025-02-15",
    To_Date: "2025-02-15",
    Duration: 1,
    Duration_Unit: "full_day",
    Reason: "Historical approved annual leave",
    Notes: "Sample row. Replace with real historical data.",
    Manager_Approval_Status: "approved",
    Manager_Approved_By: "MGR001",
    Manager_Decision_Date: "2025-02-11",
    HR_Approval_Status: "approved",
    HR_Approved_By: "HR001",
    HR_Decision_Date: "2025-02-12",
    Final_Status: "hr_approved",
    Payment_Status: "paid",
    Balance_Deduction: "deduct",
    Balance_Before: 15,
    Balance_After: 14,
    Historical_Adjustment: 0,
    Carry_Forward_At_That_Time: 0,
    External_Reference: "LEGACY-0001",
    Legacy_System: "Old HR Sheet",
    Import_Notes: "Paid historical leave during first six months still deducts because uploaded HR decision says paid + deduct.",
  });
  worksheet.addRow({
    HR_ID: "EMP002",
    Employee_Name: "Sample Employee 2",
    Title: "Medical Rep",
    Line: "Example Line",
    Area: "Example Area",
    Direct_Manager_HR_ID: "MGR002",
    Hiring_Date: "2025-01-01",
    Leave_Type: "annual_leave",
    Request_Date: "2025-02-10",
    From_Date: "2025-02-15",
    To_Date: "2025-02-15",
    Duration: 1,
    Duration_Unit: "full_day",
    Reason: "Historical unpaid annual leave",
    Notes: "Sample row. Replace with real historical data.",
    Manager_Approval_Status: "approved",
    Manager_Approved_By: "MGR002",
    Manager_Decision_Date: "2025-02-11",
    HR_Approval_Status: "approved",
    HR_Approved_By: "HR001",
    HR_Decision_Date: "2025-02-12",
    Final_Status: "hr_approved",
    Payment_Status: "unpaid",
    Balance_Deduction: "no_deduct",
    Balance_Before: "",
    Balance_After: "",
    Historical_Adjustment: 0,
    Carry_Forward_At_That_Time: 0,
    External_Reference: "LEGACY-0002",
    Legacy_System: "Old HR Sheet",
    Import_Notes: "Unpaid historical leave during first six months does not deduct balance.",
  });
  styleHistoricalHeader(worksheet.getRow(3));
  worksheet.views = [{ state: "frozen", ySplit: 3 }];
  worksheet.autoFilter = { from: "A3", to: `AE${worksheet.rowCount}` };
  addValidationList(worksheet, "H", Array.from(historicalLeaveTypeCodes));
  addValidationList(worksheet, "M", Array.from(historicalDurationUnits));
  addValidationList(worksheet, "P", Array.from(historicalApprovalStatuses));
  addValidationList(worksheet, "S", Array.from(historicalApprovalStatuses));
  addValidationList(worksheet, "V", Array.from(historicalFinalStatuses));
  addValidationList(worksheet, "W", Array.from(historicalPaymentStatuses));
  addValidationList(worksheet, "X", Array.from(historicalBalanceDecisions));
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber <= 3) return;
    row.eachCell((cell) => {
      cell.alignment = { vertical: "top", wrapText: true };
      cell.border = { bottom: { color: { argb: "FFE2E8F0" }, style: "thin" } };
    });
  });

  return workbook.xlsx.writeBuffer();
}

export async function exportVacationReportTemplateToExcel(access: AccessContext) {
  return exportHistoricalVacationTemplateToExcel(access);
}

function workbookCellValue(value: ExcelJS.CellValue): HistoricalVacationUploadValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "object" && "text" in value && typeof value.text === "string") return value.text;
  if (typeof value === "object" && "result" in value) return workbookCellValue(value.result as ExcelJS.CellValue);
  return String(value);
}

function normalizeHistoricalText(value: HistoricalVacationUploadValue) {
  return String(value ?? "").trim();
}

function normalizeHistoricalCode(value: HistoricalVacationUploadValue) {
  return normalizeHistoricalText(value).toLowerCase().replace(/\s+/g, "_");
}

function parseHistoricalDate(value: HistoricalVacationUploadValue) {
  if (value === null || value === "") return null;
  if (typeof value === "number") {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    excelEpoch.setUTCDate(excelEpoch.getUTCDate() + value);
    return excelEpoch.toISOString().slice(0, 10);
  }
  const source = normalizeHistoricalText(value);
  const parsed = new Date(source.includes("T") ? source : `${source}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function parseHistoricalNumber(value: HistoricalVacationUploadValue) {
  if (value === null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function daysBetweenInclusive(startDate: string, endDate: string) {
  const start = new Date(`${startDate}T00:00:00.000Z`).getTime();
  const end = new Date(`${endDate}T00:00:00.000Z`).getTime();
  return Math.max(1, Math.round((end - start) / 86_400_000) + 1);
}

function mapHistoricalFinalToApprovalStatus(finalStatus: string): LeaveStatus {
  if (finalStatus === "hr_approved") return "hr_approved";
  if (finalStatus === "hr_rejected") return "hr_rejected";
  if (finalStatus === "cancelled") return "cancelled";
  if (finalStatus === "pending_hr") return "pending_hr";
  if (finalStatus === "manager_rejected") return "manager_rejected";
  return "pending_manager";
}

function mapHistoricalApprovalStepStatus(status: string) {
  if (status === "approved") return "approved" as const;
  if (status === "rejected") return "rejected" as const;
  return null;
}

function getHistoricalHeaderMap(worksheet: ExcelJS.Worksheet) {
  for (let rowNumber = 1; rowNumber <= Math.min(10, worksheet.rowCount); rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const headers = new Map<string, number>();
    row.eachCell((cell, colNumber) => {
      const header = normalizeHistoricalText(workbookCellValue(cell.value)).toLowerCase();
      if (header) headers.set(header, colNumber);
    });
    if (headers.has("hr_id") && headers.has("leave_type") && headers.has("from_date")) {
      return { headerRow: rowNumber, headers };
    }
  }
  throw new Error("Historical Vacation Data sheet is missing the required header row.");
}

async function readHistoricalVacationWorkbook(file: File) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const worksheet = workbook.getWorksheet(historicalTemplateSheetName) ?? workbook.worksheets.find((sheet) => sheet.name !== historicalTemplateInstructionSheetName) ?? workbook.worksheets[0];
  if (!worksheet) throw new Error("Workbook does not contain a readable historical vacation sheet.");
  const { headerRow, headers } = getHistoricalHeaderMap(worksheet);
  const rows: Array<{ row: HistoricalVacationUploadRow; rowNumber: number }> = [];
  for (let rowNumber = headerRow + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const excelRow = worksheet.getRow(rowNumber);
    const row: HistoricalVacationUploadRow = {};
    let hasValue = false;
    for (const column of historicalVacationColumns) {
      const index = headers.get(column.header.toLowerCase());
      const value = index ? workbookCellValue(excelRow.getCell(index).value) : null;
      row[column.key] = typeof value === "string" ? value.trim() : value;
      if (value !== null && String(value).trim().length > 0) hasValue = true;
    }
    if (hasValue) rows.push({ row, rowNumber });
  }
  return rows;
}

async function detectExistingHistoricalDuplicate(input: {
  employeeHrId: string;
  externalReference: string | null;
  fromDate: string;
  leaveTypeId: string;
  legacySystem: string | null;
  toDate: string;
}) {
  const supabase = getSupabaseAdmin();
  if (input.externalReference) {
    let query = supabase
      .from("leave_historical_import_rows")
      .select("id")
      .eq("employee_hr_id", input.employeeHrId)
      .eq("external_reference", input.externalReference)
      .limit(1);
    query = input.legacySystem ? query.eq("legacy_system", input.legacySystem) : query.is("legacy_system", null);
    const { data, error } = await query;
    if (!error && (data ?? []).length > 0) return true;
  }
  const { data: existingRequests, error: requestError } = await supabase
    .from("leave_requests")
    .select("id")
    .eq("employee_hr_id", input.employeeHrId)
    .eq("leave_type_id", input.leaveTypeId)
    .eq("start_date", input.fromDate)
    .eq("end_date", input.toDate)
    .limit(1);
  if (requestError) throw requestError;
  return (existingRequests ?? []).length > 0;
}

async function validateHistoricalVacationRows(
  fileName: string,
  rows: Array<{ row: HistoricalVacationUploadRow; rowNumber: number }>,
): Promise<HistoricalVacationDryRunResult> {
  const { employeeByHrId } = await loadDirectoryMaps();
  const leaveTypes = await getLeaveTypes(true);
  const leaveTypeByCode = new Map(leaveTypes.map((type) => [type.code, type]));
  const seenKeys = new Set<string>();
  const acceptedRows: HistoricalVacationAcceptedRow[] = [];
  const rejectedRows: HistoricalVacationRejectedRow[] = [];
  const warnings: string[] = [];

  for (const item of rows) {
    const row = item.row;
    const errors: string[] = [];
    const rowWarnings: string[] = [];
    const employeeHrId = cleanHrId(normalizeHistoricalText(row.HR_ID));
    const employee = employeeByHrId.get(employeeHrId);
    const leaveTypeCode = normalizeHistoricalCode(row.Leave_Type);
    const leaveType = leaveTypeByCode.get(leaveTypeCode);
    const requestDate = parseHistoricalDate(row.Request_Date);
    const fromDate = parseHistoricalDate(row.From_Date);
    const toDate = parseHistoricalDate(row.To_Date);
    const hiringDate = parseHistoricalDate(row.Hiring_Date);
    const duration = parseHistoricalNumber(row.Duration);
    const durationUnit = normalizeHistoricalCode(row.Duration_Unit);
    const managerStatus = normalizeHistoricalCode(row.Manager_Approval_Status);
    const hrStatus = normalizeHistoricalCode(row.HR_Approval_Status);
    const finalStatus = normalizeHistoricalCode(row.Final_Status);
    const paymentStatus = normalizeHistoricalCode(row.Payment_Status);
    const balanceDecision = normalizeHistoricalCode(row.Balance_Deduction);
    const managerDecisionDate = parseHistoricalDate(row.Manager_Decision_Date);
    const hrDecisionDate = parseHistoricalDate(row.HR_Decision_Date);
    const balanceBefore = parseHistoricalNumber(row.Balance_Before);
    const balanceAfter = parseHistoricalNumber(row.Balance_After);
    const externalReference = normalizeHistoricalText(row.External_Reference) || null;
    const legacySystem = normalizeHistoricalText(row.Legacy_System) || null;

    for (const column of historicalVacationColumns.filter((column) => column.required)) {
      if (!normalizeHistoricalText(row[column.key])) errors.push(`${column.header} is required.`);
    }
    if (!employee) errors.push(`HR_ID ${employeeHrId || "(blank)"} was not found in the employee directory.`);
    if (!employee?.hireDate && !hiringDate) errors.push("Hiring_Date is required because employee hire date is missing.");
    if (hiringDate && employee?.hireDate && hiringDate !== employee.hireDate) {
      rowWarnings.push(`Uploaded Hiring_Date ${hiringDate} differs from employee directory hire date ${employee.hireDate}. Directory value remains authoritative.`);
    }
    if (!leaveType || !historicalLeaveTypeCodes.has(leaveTypeCode)) errors.push(`Leave_Type ${leaveTypeCode || "(blank)"} is not allowed.`);
    if (!requestDate) errors.push("Request_Date is not a valid date.");
    if (!fromDate) errors.push("From_Date is not a valid date.");
    if (!toDate) errors.push("To_Date is not a valid date.");
    if (fromDate && toDate && toDate < fromDate) errors.push("To_Date cannot be before From_Date.");
    if (duration === null || duration <= 0) errors.push("Duration must be a positive number.");
    if (!historicalDurationUnits.has(durationUnit)) errors.push(`Duration_Unit must be one of ${Array.from(historicalDurationUnits).join(", ")}.`);
    if ((durationUnit === "am" || durationUnit === "pm") && fromDate && toDate && fromDate !== toDate) errors.push("AM/PM historical rows must be single-day rows.");
    if ((durationUnit === "am" || durationUnit === "pm") && duration !== null && duration !== 0.5) rowWarnings.push("AM/PM rows normally use Duration 0.5.");
    if (!historicalApprovalStatuses.has(managerStatus)) errors.push(`Manager_Approval_Status must be one of ${Array.from(historicalApprovalStatuses).join(", ")}.`);
    if (!historicalApprovalStatuses.has(hrStatus)) errors.push(`HR_Approval_Status must be one of ${Array.from(historicalApprovalStatuses).join(", ")}.`);
    if (!historicalFinalStatuses.has(finalStatus)) errors.push(`Final_Status must be one of ${Array.from(historicalFinalStatuses).join(", ")}.`);
    if (!historicalPaymentStatuses.has(paymentStatus)) errors.push(`Payment_Status must be one of ${Array.from(historicalPaymentStatuses).join(", ")}.`);
    if (!historicalBalanceDecisions.has(balanceDecision)) errors.push("Balance_Deduction must be deduct or no_deduct.");
    if (requestDate && managerDecisionDate && managerDecisionDate < requestDate) errors.push("Manager_Decision_Date cannot be before Request_Date.");
    if (requestDate && hrDecisionDate && hrDecisionDate < requestDate) errors.push("HR_Decision_Date cannot be before Request_Date.");
    if (managerDecisionDate && hrDecisionDate && hrDecisionDate < managerDecisionDate) errors.push("HR_Decision_Date cannot be before Manager_Decision_Date.");
    if ((managerStatus === "approved" || managerStatus === "rejected") && !normalizeHistoricalText(row.Manager_Approved_By)) {
      errors.push("Manager_Approved_By is required when Manager_Approval_Status is approved or rejected.");
    }
    if ((managerStatus === "approved" || managerStatus === "rejected") && !managerDecisionDate) {
      errors.push("Manager_Decision_Date is required when Manager_Approval_Status is approved or rejected.");
    }
    if ((hrStatus === "approved" || hrStatus === "rejected") && !normalizeHistoricalText(row.HR_Approved_By)) {
      errors.push("HR_Approved_By is required when HR_Approval_Status is approved or rejected.");
    }
    if ((hrStatus === "approved" || hrStatus === "rejected") && !hrDecisionDate) {
      errors.push("HR_Decision_Date is required when HR_Approval_Status is approved or rejected.");
    }
    if (paymentStatus === "paid" && balanceDecision !== "deduct") errors.push("Payment_Status paid must use Balance_Deduction deduct for historical reconstruction.");
    if ((paymentStatus === "unpaid" || paymentStatus === "non_deducted") && balanceDecision !== "no_deduct") {
      errors.push("Payment_Status unpaid/non_deducted must use Balance_Deduction no_deduct.");
    }
    if (balanceDecision === "deduct" && finalStatus !== "hr_approved") errors.push("Only hr_approved historical rows can deduct balance.");
    if (balanceDecision === "deduct" && (balanceBefore === null || balanceAfter === null)) {
      errors.push("Balance_Before and Balance_After are required when Balance_Deduction is deduct.");
    }
    if (balanceDecision === "deduct" && duration !== null && balanceBefore !== null && balanceAfter !== null) {
      const expectedAfter = Math.round((balanceBefore - duration) * 100) / 100;
      if (Math.abs(expectedAfter - balanceAfter) > 0.01) {
        rowWarnings.push(`Balance_After does not equal Balance_Before minus Duration (${expectedAfter}). Uploaded values will be preserved in the ledger.`);
      }
    }

    const duplicateKey = [
      employeeHrId,
      leaveTypeCode,
      fromDate,
      toDate,
      externalReference ?? "",
      legacySystem ?? "",
    ].join("|");
    if (seenKeys.has(duplicateKey)) errors.push("Duplicate row inside this workbook.");
    seenKeys.add(duplicateKey);
    if (employee && leaveType && fromDate && toDate && await detectExistingHistoricalDuplicate({
      employeeHrId,
      externalReference,
      fromDate,
      leaveTypeId: leaveType.id,
      legacySystem,
      toDate,
    })) {
      errors.push("Duplicate row already exists in leave history or historical import tracking.");
    }

    if (errors.length > 0) {
      rejectedRows.push({ errors, row, rowNumber: item.rowNumber, warnings: rowWarnings });
      continue;
    }

    const projectedBalanceImpact = balanceDecision === "deduct" && paymentStatus === "paid" && finalStatus === "hr_approved" ? duration ?? 0 : 0;
    acceptedRows.push({
      employeeHrId,
      externalReference,
      legacySystem,
      projectedBalanceImpact,
      row,
      rowNumber: item.rowNumber,
      warnings: rowWarnings,
    });
  }

  const affectedEmployees = new Set(acceptedRows.map((row) => row.employeeHrId));
  const duplicateRows = rejectedRows.filter((row) => row.errors.some((error) => error.toLowerCase().includes("duplicate"))).length;
  return {
    acceptedRows,
    fileName,
    rejectedRows,
    summary: {
      acceptedRows: acceptedRows.length,
      affectedEmployees: affectedEmployees.size,
      duplicateRows,
      projectedBalanceImpact: Math.round(acceptedRows.reduce((sum, row) => sum + row.projectedBalanceImpact, 0) * 100) / 100,
      rejectedRows: rejectedRows.length,
      totalRows: rows.length,
    },
    warnings,
  };
}

export async function dryRunHistoricalVacationImport(access: AccessContext, file: File): Promise<HistoricalVacationDryRunResult> {
  await assertPermission(access, "leave", "update");
  assertHistoricalVacationManageAccess(access);
  const rows = await readHistoricalVacationWorkbook(file);
  const result = await validateHistoricalVacationRows(file.name || "historical-vacations.xlsx", rows);
  await writeLeaveAuditLog({
    actorHrId: access.hrId,
    actorRole: access.role,
    correlationId: createLeaveCorrelationId(),
    employeeHrId: null,
    eventType: "leave.historical_import.dry_run",
    metadata: {
      fileName: result.fileName,
      summary: result.summary,
    },
  }).catch(() => undefined);
  return result;
}

async function insertHistoricalImportRow(batchId: string, row: HistoricalVacationAcceptedRow | HistoricalVacationRejectedRow, status: string, leaveRequestId?: string | null) {
  const supabase = getSupabaseAdmin();
  const accepted = "employeeHrId" in row ? row : null;
  const { error } = await supabase.from("leave_historical_import_rows").insert({
    batch_id: batchId,
    employee_hr_id: accepted?.employeeHrId ?? (cleanHrId(normalizeHistoricalText(row.row.HR_ID)) || null),
    external_reference: normalizeHistoricalText(row.row.External_Reference) || null,
    legacy_system: normalizeHistoricalText(row.row.Legacy_System) || null,
    leave_request_id: leaveRequestId ?? null,
    row_data: row.row,
    row_number: row.rowNumber,
    row_status: status,
    validation_errors: "errors" in row ? row.errors : [],
    warnings: row.warnings,
  });
  if (error) throw error;
}

async function applyHistoricalBalanceTransaction(input: {
  access: AccessContext;
  employee: EmployeeDirectoryRow;
  leaveType: LeaveType;
  policy: LeavePolicy;
  requestId: string;
  row: HistoricalVacationUploadRow;
}) {
  const duration = parseHistoricalNumber(input.row.Duration) ?? 0;
  const paymentStatus = normalizeHistoricalCode(input.row.Payment_Status);
  const balanceDecision = normalizeHistoricalCode(input.row.Balance_Deduction);
  const finalStatus = normalizeHistoricalCode(input.row.Final_Status);
  if (paymentStatus !== "paid" || balanceDecision !== "deduct" || finalStatus !== "hr_approved" || duration <= 0) return null;
  const balanceBefore = parseHistoricalNumber(input.row.Balance_Before);
  const balanceAfter = parseHistoricalNumber(input.row.Balance_After);
  if (balanceBefore === null || balanceAfter === null) throw new Error("Deducting historical rows require Balance_Before and Balance_After.");
  const year = new Date(`${parseHistoricalDate(input.row.From_Date)}T00:00:00.000Z`).getUTCFullYear();
  const balance = await ensureEmployeeBalance(input.employee, input.leaveType, input.policy, year);
  const supabase = getSupabaseAdmin();
  const { error: transactionError } = await supabase.from("leave_transactions").insert({
    amount: duration,
    balance_after: balanceAfter,
    balance_before: balanceBefore,
    created_by: input.access.hrId,
    employee_hr_id: cleanHrId(input.employee.hrId),
    leave_type_id: input.leaveType.id,
    notes: `historical-vacation-import:${normalizeHistoricalText(input.row.External_Reference) || input.requestId}`,
    policy_id: input.policy.id,
    request_id: input.requestId,
    transaction_type: "consumed",
  });
  if (transactionError) throw transactionError;
  const next = applyBalanceDelta(balance, "consumed", duration);
  const { error: balanceError } = await supabase
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
    .eq("id", balance.id);
  if (balanceError) throw balanceError;
  return { balanceAfter, balanceBefore, duration };
}

export async function confirmHistoricalVacationImport(access: AccessContext, file: File): Promise<HistoricalVacationConfirmResult> {
  await assertPermission(access, "leave", "update");
  assertHistoricalVacationManageAccess(access);
  const dryRun = await validateHistoricalVacationRows(file.name || "historical-vacations.xlsx", await readHistoricalVacationWorkbook(file));
  const supabase = getSupabaseAdmin();
  const { employeeByHrId } = await loadDirectoryMaps();
  const leaveTypes = await getLeaveTypes(true);
  const leaveTypeByCode = new Map(leaveTypes.map((type) => [type.code, type]));
  const policy = await getDefaultLeavePolicy();
  const { data: batch, error: batchError } = await supabase
    .from("leave_historical_import_batches")
    .insert({
      accepted_rows: dryRun.summary.acceptedRows,
      affected_employees: dryRun.summary.affectedEmployees,
      duplicate_rows: dryRun.summary.duplicateRows,
      metadata: { summary: dryRun.summary },
      rejected_rows: dryRun.summary.rejectedRows,
      source_filename: dryRun.fileName,
      status: "confirmed",
      total_rows: dryRun.summary.totalRows,
      uploaded_by_hr_id: access.hrId,
      uploaded_by_role: access.role,
    })
    .select("id")
    .single();
  if (batchError) throw new Error(`Historical import tracking tables are not ready: ${batchError.message}`);
  const batchId = (batch as { id: string }).id;

  for (const rejected of dryRun.rejectedRows) {
    await insertHistoricalImportRow(batchId, rejected, "rejected");
  }

  let importedRows = 0;
  for (const accepted of dryRun.acceptedRows) {
    const row = accepted.row;
    const employee = employeeByHrId.get(accepted.employeeHrId);
    const leaveType = leaveTypeByCode.get(normalizeHistoricalCode(row.Leave_Type));
    if (!employee || !leaveType) {
      await insertHistoricalImportRow(batchId, { ...accepted, errors: ["Employee or leave type disappeared before confirmation."] }, "rejected");
      continue;
    }
    const requestDate = parseHistoricalDate(row.Request_Date) ?? isoToday();
    const fromDate = parseHistoricalDate(row.From_Date) ?? requestDate;
    const toDate = parseHistoricalDate(row.To_Date) ?? fromDate;
    const managerStatus = normalizeHistoricalCode(row.Manager_Approval_Status) as LeaveRequest["managerStatus"];
    const hrStatus = normalizeHistoricalCode(row.HR_Approval_Status) as LeaveRequest["hrStatus"];
    const finalStatus = mapHistoricalFinalToApprovalStatus(normalizeHistoricalCode(row.Final_Status));
    const duration = parseHistoricalNumber(row.Duration) ?? 0;
    const paymentStatus = normalizeHistoricalCode(row.Payment_Status) as LeavePaymentStatus;
    const balanceDecision = normalizeHistoricalCode(row.Balance_Deduction) as LeaveRequest["hrBalanceDecision"];
    const { data: request, error: requestError } = await supabase
      .from("leave_requests")
      .insert({
        attachment_url: null,
        balance_leave_type_id: balanceDecision === "deduct" ? leaveType.id : null,
        duration_unit: normalizeHistoricalCode(row.Duration_Unit) as LeaveDurationUnit,
        employee_hr_id: accepted.employeeHrId,
        end_date: toDate,
        hr_balance_decision: balanceDecision,
        hr_comment: normalizeHistoricalText(row.Notes) || null,
        hr_decision_at: parseHistoricalDate(row.HR_Decision_Date),
        hr_status: hrStatus,
        leave_type_id: leaveType.id,
        manager_comment: null,
        manager_decision_at: parseHistoricalDate(row.Manager_Decision_Date),
        manager_status: managerStatus,
        payment_reason: `Historical import preserved uploaded ${paymentStatus}/${balanceDecision} decision.`,
        payment_status: paymentStatus,
        payroll_status: "not_required",
        policy_id: policy.id,
        reason: normalizeHistoricalText(row.Reason) || null,
        requested_at: requestDate,
        start_date: fromDate,
        status: finalStatus,
        total_calendar_days: daysBetweenInclusive(fromDate, toDate),
        total_working_days: duration,
      })
      .select("id")
      .single();
    if (requestError) throw requestError;
    const requestId = (request as { id: string }).id;
    const managerApprovalStatus = mapHistoricalApprovalStepStatus(managerStatus);
    const hrApprovalStatus = mapHistoricalApprovalStepStatus(hrStatus);
    if (managerApprovalStatus) {
      const { error } = await supabase.from("leave_approvals").insert({
        action_date: parseHistoricalDate(row.Manager_Decision_Date) ?? requestDate,
        approval_step: "manager",
        approver_hr_id: cleanHrId(normalizeHistoricalText(row.Manager_Approved_By)),
        approver_role: "manager",
        comment: "Historical vacation import",
        request_id: requestId,
        status: managerApprovalStatus,
      });
      if (error) throw error;
    }
    if (hrApprovalStatus) {
      const { error } = await supabase.from("leave_approvals").insert({
        action_date: parseHistoricalDate(row.HR_Decision_Date) ?? requestDate,
        approval_step: "hr",
        approver_hr_id: cleanHrId(normalizeHistoricalText(row.HR_Approved_By)),
        approver_role: "hr",
        comment: "Historical vacation import",
        request_id: requestId,
        status: hrApprovalStatus,
      });
      if (error) throw error;
    }
    await applyHistoricalBalanceTransaction({ access, employee, leaveType, policy, requestId, row });
    await insertHistoricalImportRow(batchId, accepted, "imported", requestId);
    importedRows += 1;
  }

  await writeLeaveAuditLog({
    actorHrId: access.hrId,
    actorRole: access.role,
    correlationId: createLeaveCorrelationId(),
    employeeHrId: null,
    eventType: "leave.historical_import.confirmed",
    metadata: {
      batchId,
      fileName: dryRun.fileName,
      importedRows,
      summary: dryRun.summary,
    },
  });

  return {
    ...dryRun,
    batchId,
    importedRows,
  };
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

export async function upsertPublicHoliday(access: AccessContext, input: { country?: string; date: string; durationDays?: number; endDate?: string; id?: string; isActive?: boolean; name: string }) {
  await assertPermission(access, "leave", "update");
  if (!isManageRole(access)) throw new Error("Forbidden: public holiday settings require HR or Super Admin access.");
  const year = new Date(`${input.date}T00:00:00.000Z`).getUTCFullYear();
  const endDate = input.endDate && input.endDate >= input.date ? input.endDate : input.date;
  const supabase = getSupabaseAdmin();
  const payload = {
    country: input.country ?? "EG",
    date: input.date,
    duration_days: input.durationDays ?? holidayDurationDays(input.date, endDate),
    end_date: endDate,
    is_active: input.isActive ?? true,
    name: input.name.trim(),
    year,
  };
  const query = input.id
    ? supabase.from("public_holidays").update(payload).eq("id", input.id)
    : supabase.from("public_holidays").upsert(payload, { onConflict: "country,date" });
  const { data, error } = await query.select("*").single();
  if (error) {
    if (isMissingNationalVacationRangeSchemaError(error)) throw new Error(missingNationalVacationRangeSchemaMessage());
    throw error;
  }
  return mapHoliday(data as PublicHolidayRow);
}

async function getEmployeeLeaveRequestWorkspace(access: AccessContext) {
  if (!access.hrId) throw new Error("A linked employee HR_ID is required.");
  const employee = await getEmployeeOrThrow(access.hrId);
  const policy = await getDefaultLeavePolicy();
  const [wallet, leaveTypes, requests, titleWeekendRules] = await Promise.all([
    getEmployeeLeaveWallet(access),
    getLeaveTypes(false),
    listLeaveRequests(access, { employeeHrId: access.hrId }),
    getLeaveTitleWeekendRules(),
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
    weekendDays: getWeekendDaysForEmployee(employee, policy.weekendDays, titleWeekendRules),
  };
}

export async function getEmployeeLeaveWorkspace(access: AccessContext, filters: LeaveRequestFilters = {}) {
  const [workspace, vacationReports] = await Promise.all([
    getEmployeeLeaveRequestWorkspace(access),
    getVacationReportWorkspace(access, filters),
  ]);
  return {
    ...workspace,
    vacationReports,
  };
}

export async function getManagerLeaveWorkspace(access: AccessContext) {
  await assertPermission(access, "leave", "approve");
  const policy = await getDefaultLeavePolicy();
  const [leaveTypes, requests, titleWeekendRules] = await Promise.all([
    getLeaveTypes(false),
    listManagerHierarchyLeaveRequests(access, {}),
    getLeaveTitleWeekendRules().catch(() => []),
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
    teamAvailability: buildTeamAvailability(requests, holidays, { ...range, titleWeekendRules }),
  };
}

function serviceDurationText(hireDate: string | null) {
  if (!hireDate) return "Unavailable";
  const start = new Date(`${hireDate}T00:00:00.000Z`);
  const now = new Date();
  if (Number.isNaN(start.getTime())) return "Unavailable";
  const months = Math.max(0, (now.getUTCFullYear() - start.getUTCFullYear()) * 12 + now.getUTCMonth() - start.getUTCMonth());
  const years = Math.floor(months / 12);
  const remainingMonths = months % 12;
  if (years <= 0) return `${remainingMonths} month${remainingMonths === 1 ? "" : "s"}`;
  return `${years} year${years === 1 ? "" : "s"}, ${remainingMonths} month${remainingMonths === 1 ? "" : "s"}`;
}

function policyBasisText(employee: EmployeeDirectoryRow, policy: LeavePolicy) {
  const referenceDate = isoToday();
  const entitlement = getAnnualEntitlement(employee, policy, referenceDate);
  return entitlement === policy.annualDaysAfterFirstYear
    ? "1 year or more of service"
    : "Less than 1 year of service";
}

export async function getActiveEmployeesAccrualReport(
  access: AccessContext,
  year = new Date().getUTCFullYear(),
  filters: LeaveRequestFilters = {},
): Promise<ActiveEmployeeAccrualReport> {
  await assertPermission(access, "leave", "read");
  assertHistoricalVacationManageAccess(access);
  const { directory } = await loadDirectoryMaps();
  const policy = await getDefaultLeavePolicy();
  const leaveType = await getAnnualLeaveType();
  const supabase = getSupabaseAdmin();

  let activeEmployees = directory.employees.filter(
    (employee) => (employee.employmentStatus ?? "active").toLowerCase() === "active",
  );

  // Apply filters
  if (filters.employeeHrId) {
    const hrId = cleanHrId(filters.employeeHrId);
    activeEmployees = activeEmployees.filter((e) => cleanHrId(e.hrId).includes(hrId));
  }
  if (filters.employee) {
    const needle = filters.employee.toLowerCase();
    activeEmployees = activeEmployees.filter((e) => e.fullName.toLowerCase().includes(needle));
  }
  if (filters.line) {
    const needle = filters.line.toLowerCase();
    activeEmployees = activeEmployees.filter((e) => (e.lineName ?? "").toLowerCase().includes(needle));
  }
  if (filters.area) {
    const needle = filters.area.toLowerCase();
    activeEmployees = activeEmployees.filter((e) => (e.areaName ?? "").toLowerCase().includes(needle));
  }

  const allActiveHrIds = activeEmployees.map((e) => cleanHrId(e.hrId));
  const [{ data: balanceRows, error: balanceError }, { data: transactionRows, error: transactionError }] =
    await Promise.all([
      supabase
        .from("employee_leave_balances")
        .select("*")
        .eq("leave_type_id", leaveType.id)
        .eq("policy_id", policy.id)
        .eq("year", year)
        .in("employee_hr_id", allActiveHrIds.length ? allActiveHrIds : ["__none__"])
        .limit(5000),
      supabase
        .from("leave_transactions")
        .select("employee_hr_id,created_at")
        .eq("leave_type_id", leaveType.id)
        .eq("policy_id", policy.id)
        .in("employee_hr_id", allActiveHrIds.length ? allActiveHrIds : ["__none__"])
        .order("created_at", { ascending: false })
        .limit(10000),
    ]);
  if (balanceError) throw balanceError;
  if (transactionError) throw transactionError;

  const balanceByEmployee = new Map(
    ((balanceRows ?? []) as EmployeeLeaveBalanceRow[]).map((row) => [
      cleanHrId(row.employee_hr_id),
      mapBalance(row),
    ]),
  );
  const lastTransactionByEmployee = new Map<string, string>();
  for (const row of (transactionRows ?? []) as Array<{ employee_hr_id: string; created_at: string }>) {
    const hrId = cleanHrId(row.employee_hr_id);
    if (!lastTransactionByEmployee.has(hrId)) lastTransactionByEmployee.set(hrId, row.created_at);
  }

  // Map to accrual rows with actual data
  const allRows: ActiveEmployeeAccrualRow[] = activeEmployees.map((employee) => {
    const balance = balanceByEmployee.get(cleanHrId(employee.hrId));
    const referenceDate = isoToday();
    return {
      accruedToDate: balance?.accrued ?? 0,
      adjustments: balance?.adjusted ?? 0,
      annualEntitlement: getAnnualEntitlement(employee, policy, referenceDate),
      area: employee.areaName,
      availableBalance: balance?.availableBalance ?? 0,
      carryForward: balance?.carryForward ?? 0,
      directManager: employee.managerName ?? employee.managerHrId,
      employeeHrId: employee.hrId,
      employeeName: employee.fullName,
      hiringDate: employee.hireDate,
      lastAccrualMonth: balance?.lastAccrualDate ? balance.lastAccrualDate.slice(0, 7) : null,
      lastLeaveTransactionDate: lastTransactionByEmployee.get(cleanHrId(employee.hrId)) ?? null,
      line: employee.lineName,
      monthlyAccrual: calculateMonthlyAccrual(employee, policy, referenceDate),
      openingBalance: balance?.openingBalance ?? 0,
      pending: balance?.pending ?? 0,
      policyBasis: policyBasisText(employee, policy),
      serviceDuration: serviceDurationText(employee.hireDate),
      status: employee.employmentStatus ?? "active",
      title: employee.jobTitle ?? employee.positionTitle,
      usedConsumed: balance?.consumed ?? 0,
    };
  });

  // Apply sorting
  if (filters.sortBy) {
    const field = filters.sortBy as keyof ActiveEmployeeAccrualRow;
    const order = filters.sortOrder === "desc" ? -1 : 1;
    allRows.sort((a, b) => {
      const valA = a[field];
      const valB = b[field];
      if (valA === null || valA === undefined) return 1;
      if (valB === null || valB === undefined) return -1;
      if (valA < valB) return -order;
      if (valA > valB) return order;
      return 0;
    });
  }

  const totalRows = allRows.length;
  const limit = Math.min(100, Math.max(1, Number(filters.limit ?? 25)));
  const offset = Math.max(0, Number(filters.offset ?? 0));
  const pageRows = allRows.slice(offset, offset + limit);

  return {
    generatedAt: new Date().toISOString(),
    pagination: {
      limit,
      offset,
      totalRows,
    },
    rows: pageRows,
    year,
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
  const [activeEmployeesAccrual, activityLogs, titleWeekendRules] = await Promise.all([
    canManageLeave ? getActiveEmployeesAccrualReport(access, year, filters).catch(() => null) : Promise.resolve(null),
    canManageLeave ? listLeaveAuditLogs(access, { eventTypePrefix: "leave.notification", limit: 100 }).catch(() => []) : Promise.resolve([]),
    canManageLeave ? getLeaveTitleWeekendRules().catch(() => []) : Promise.resolve([]),
  ]);
  const [employeeRequestWorkspace, vacationReports] = await Promise.all([
    access.hrId ? getEmployeeLeaveRequestWorkspace(access).catch(() => null) : Promise.resolve(null),
    getVacationReportWorkspace(access, filters),
  ]);
  return {
    activeEmployeesAccrual,
    activityLogs,
    calendarItems: buildLeaveCalendarItems(requests, holidays, { month, year }),
    capabilities: {
      canExport,
      canManageLeave,
    },
    dashboard,
    employeeRequestWorkspace,
    holidays,
    leaveTypes,
    policies,
    requests,
    teamAvailability: buildTeamAvailability(requests, holidays, { ...range, titleWeekendRules }),
    titleWeekendRules,
    vacationReports,
  };
}

