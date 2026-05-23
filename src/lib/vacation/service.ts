import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  assertPermission,
  canAccess,
  designatedHrManagerHrId,
  designatedHrSpecialistHrId,
  isDesignatedHrSpecialist,
  normalizeHrIdForAccess,
  normalizeLineName,
  resolveEmployeeIdentityId,
  type AccessContext,
} from "@/lib/auth/permissions";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import {
  getEmployeeDirectory,
  getEmployeeDirectoryRows,
  type EmployeeDirectoryData,
  type EmployeeDirectoryRow,
} from "@/lib/employees/employee-directory";
import { enqueueInAppNotification } from "@/lib/notifications/in-app";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { addDaysToDateOnly, daysBetweenDateOnly, parseDateOnly, toDateOnlyString } from "@/lib/date-only";
import { getEgyptianNationalHolidays, type EgyptianNationalHoliday } from "@/lib/vacation/national-holidays";
import {
  calculateVacationDurationDays,
  calculateVacationPayment,
  getAnnualVacationMinimumStartDate,
  getVacationPolicyToday,
  getVacationPolicyWarnings,
  getVacationBalancePeriod,
  normalizeVacationDayPart,
  normalizeVacationPaymentStatus,
  normalizeVacationType,
  vacationRequestDisplayId,
  vacationTypeLabel,
} from "@/lib/vacation/calculations";
import { summarizeVacationRequests } from "@/lib/vacation/metrics";
import {
  buildVacationDecisionUrl,
  sendVacationDecisionResultEmail,
  sendVacationManagerDecisionEmail,
} from "@/lib/vacation/email";
import type {
  VacationBalanceSnapshot,
  VacationControlData,
  VacationDayPart,
  VacationDecision,
  VacationEmployeeSummary,
  VacationEligibilityStatus,
  VacationEmployeeEligibilityRow,
  VacationPaymentStatus,
  VacationReportData,
  VacationReportFilters,
  VacationRequestInput,
  VacationRequestRecord,
  VacationRequestStatus,
  VacationType,
  VacationWeeklyOffMode,
  VacationWeeklyOffPolicyRecord,
} from "@/lib/vacation/types";
import { VACATION_DAY_PARTS, VACATION_REQUEST_TYPES, VACATION_TYPES, VACATION_WEEKLY_OFF_MODES } from "@/lib/vacation/types";

const vacationRequestsTable = "v2_vacation_requests";
const vacationEventsTable = "v2_vacation_request_events";
const vacationTokensTable = "v2_vacation_email_tokens";
const vacationWeeklyOffPoliciesTable = "v2_vacation_weekly_off_policies";
const legacyLeaveRequestsTable = "leave_requests";
const vacationAttachmentBucket = "leave-attachments";
const emailTokenTtlDays = 14;
const sickAttachmentMaxUploadBytes = 10 * 1024 * 1024;
const sickAttachmentAllowedContentTypes = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const compensatoryAttachmentAllowedContentTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

type VacationRequestDbRow = {
  balance_after_days: number | string | null;
  balance_before_days: number | string | null;
  compensatory_attachment_bucket?: string | null;
  compensatory_attachment_content_type?: string | null;
  compensatory_attachment_object_path?: string | null;
  compensatory_attachment_original_name?: string | null;
  compensatory_attachment_size_bytes?: number | string | null;
  compensatory_attachment_uploaded_at?: string | null;
  compensatory_event_date?: string | null;
  compensatory_event_location?: string | null;
  compensatory_event_name?: string | null;
  compensatory_manager_1?: string | null;
  compensatory_manager_2?: string | null;
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
  hr_decision?: string | null;
  hr_decision_at?: string | null;
  hr_decision_by_hr_id?: string | null;
  hr_decision_comment?: string | null;
  manager_decision: string | null;
  manager_decision_at: string | null;
  manager_decision_by_hr_id: string | null;
  manager_decision_comment: string | null;
  manager_hr_id: string | null;
  manager_name: string | null;
  manager_of_manager_hr_id: string | null;
  manager_of_manager_name: string | null;
  notes?: string | null;
  payment_status: string | null;
  paid_duration_days?: number | string | null;
  period_end: string | null;
  period_start: string | null;
  sick_attachment_bucket?: string | null;
  sick_attachment_content_type?: string | null;
  sick_attachment_object_path?: string | null;
  sick_attachment_original_name?: string | null;
  sick_attachment_size_bytes?: number | string | null;
  sick_attachment_uploaded_at?: string | null;
  start_date: string | null;
  status: string | null;
  submitted_by_hr_id: string | null;
  unpaid_reason: string | null;
  unpaid_duration_days?: number | string | null;
  used_paid_days: number | string | null;
  vacation_type: string | null;
};

type LegacyLeaveRequestDbRow = {
  approved_or_rejected_by?: string | null;
  created_at: string | null;
  day_type?: string | null;
  direct_manager?: string | null;
  direct_manager_hr_id?: string | null;
  duration_days?: number | string | null;
  duration_unit?: string | null;
  employee_email?: string | null;
  employee_hire_date?: string | null;
  employee_hr_id: string | null;
  employee_line?: string | null;
  employee_name?: string | null;
  end_date: string | null;
  first_year_entitlement_at_submission?: number | string | null;
  hr_comment?: string | null;
  hr_decision_at?: string | null;
  hr_status?: string | null;
  id: string;
  manager_comment?: string | null;
  manager_decision_at?: string | null;
  manager_of_manager_hr_id?: string | null;
  manager_status?: string | null;
  payment_reason?: string | null;
  payment_status?: string | null;
  reason?: string | null;
  remaining_paid_balance_at_submission?: number | string | null;
  requested_at?: string | null;
  request_type?: string | null;
  start_date: string | null;
  status: string | null;
  total_calendar_days?: number | string | null;
  total_entitled_balance_at_submission?: number | string | null;
  total_working_days?: number | string | null;
  unpaid_leave_days_at_submission?: number | string | null;
  used_paid_leave_at_submission?: number | string | null;
  vacation_type?: string | null;
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

type VacationWeeklyOffPolicyDbRow = {
  friday_off: string | null;
  id: string;
  job_title: string | null;
  saturday_off: string | null;
  thursday_off: string | null;
  updated_at: string | null;
};

export type VacationAttachmentUpload = {
  bytes: Buffer;
  contentType: string;
  fileName: string;
  size: number;
};

type CreateVacationRequestInput = Omit<VacationRequestInput, "dayPart" | "endDate" | "startDate" | "vacationType"> & {
  compensatoryAttachment?: VacationAttachmentUpload | null;
  compensatoryEventDate?: unknown;
  compensatoryEventLocation?: unknown;
  compensatoryEventName?: unknown;
  compensatoryManager1?: unknown;
  compensatoryManager2?: unknown;
  dayPart: unknown;
  endDate: unknown;
  otherReason?: unknown;
  sickAttachment?: VacationAttachmentUpload | null;
  startDate: unknown;
  vacationType: unknown;
};

type AdminVacationRequestInput = {
  dayPart: unknown;
  employeeHrId?: unknown;
  endDate: unknown;
  notes?: unknown;
  startDate: unknown;
  status?: unknown;
  vacationType: unknown;
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

function nullableText(value: unknown) {
  const normalized = text(value);
  return normalized || null;
}

function missingRelationMessage(error: unknown, relationName: string) {
  const message = (typeof (error as { message?: unknown })?.message === "string"
    ? (error as { message: string }).message
    : error instanceof Error
      ? error.message
      : String(error)).toLowerCase();
  return (
    message.includes(relationName.toLowerCase()) &&
    (message.includes("could not find the table") ||
      message.includes("schema cache") ||
      message.includes("relation") ||
      message.includes("does not exist"))
  );
}

function normalizeWeeklyOffMode(value: unknown): VacationWeeklyOffMode {
  const normalized = String(value ?? "").trim().toLowerCase();
  return VACATION_WEEKLY_OFF_MODES.some((option) => option.value === normalized)
    ? (normalized as VacationWeeklyOffMode)
    : "working";
}

function employeeVacationPolicyTitle(employee: Pick<EmployeeDirectoryRow, "jobTitle" | "positionTitle">) {
  return text(employee.positionTitle || employee.jobTitle || "Unassigned");
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

function buildEmployeeMapByHrId(employees: EmployeeDirectoryRow[]) {
  const map = new Map<string, EmployeeDirectoryRow>();
  for (const employee of employees) {
    const canonical = canonicalHrId(employee.hrId);
    if (canonical) map.set(canonical, employee);
  }
  return map;
}

function employeeFromMap(
  employeesByHrId: Map<string, EmployeeDirectoryRow>,
  hrId: string | null | undefined,
) {
  const canonical = canonicalHrId(hrId);
  return canonical ? employeesByHrId.get(canonical) ?? null : null;
}

function isAllVacationVisibility(access: AccessContext) {
  return access.scope === "system" || access.role === "Super Admin" || isDesignatedHrSpecialist(access);
}

function canApproveVacationHrFinalDecision(access: AccessContext) {
  return access.scope === "system" || access.role === "Super Admin" || access.role === "CEO";
}

type VacationVisibilityScope = "SELF" | "TEAM" | "HIERARCHY" | "LINE" | "COMPANY";

function getVacationVisibilityScope(access: AccessContext): VacationVisibilityScope {
  if (isAllVacationVisibility(access)) return "COMPANY";

  switch (access.role) {
    case "CEO":
    case "Finance Manager":
    case "SFE Manager":
      return "COMPANY";
    case "National Sales Manager":
      return "HIERARCHY";
    case "Product Manager":
    case "Group Product Manager":
    case "Training Manager":
      return "LINE";
    case "Regional Manager":
      return "HIERARCHY";
    case "District Manager":
    case "Manager":
      return "TEAM";
    default:
      return "SELF";
  }
}

async function assertVacationAdminManagement(access: AccessContext, action: "create" | "update" | "delete") {
  await assertPermission(access, "leave", action);
  if (!isAllVacationVisibility(access)) {
    throw new Error("Forbidden: only HR or Super Admin can manage company vacation records.");
  }
}

async function canManageVacationRecords(access: AccessContext) {
  return (
    isAllVacationVisibility(access) &&
    await canAccess(access, "leave", "create") &&
    await canAccess(access, "leave", "update") &&
    await canAccess(access, "leave", "delete")
  );
}

function isVacationSchemaMissingError(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes(vacationRequestsTable) ||
    message.includes(vacationEventsTable) ||
    message.includes(vacationTokensTable) ||
    message.includes(vacationWeeklyOffPoliciesTable) ||
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

function accessIdentityCandidates(access: AccessContext) {
  const candidates = [
    access.hrId,
    access.loginId,
    resolveEmployeeIdentityId(access),
  ];
  const seen = new Set<string>();
  return candidates
    .map((value) => normalizeHrIdForAccess(value))
    .filter((value): value is string => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
}

function findCurrentEmployee(directory: EmployeeDirectoryData, access: AccessContext) {
  const candidates = accessIdentityCandidates(access);
  for (const candidate of candidates) {
    const employee = findEmployeeByHrId(directory, candidate);
    if (employee) return employee;
  }
  return null;
}

function findCurrentEmployeeRow(rows: EmployeeDirectoryRow[], access: AccessContext) {
  const candidates = accessIdentityCandidates(access);
  for (const candidate of candidates) {
    const employee = rows.find((row) => canonicalHrId(row.hrId) === candidate);
    if (employee) return employee;
  }
  return null;
}

function accessMatchesHrId(access: AccessContext, hrId: string | null | undefined) {
  const target = canonicalHrId(hrId);
  if (!target) return false;
  return accessIdentityCandidates(access).some((candidate) => candidate === target);
}

function employeeLineMatches(left: EmployeeDirectoryRow, right: EmployeeDirectoryRow) {
  if (left.lineId !== null && right.lineId !== null) return left.lineId === right.lineId;
  const leftLine = normalizeLineName(left.lineName);
  const rightLine = normalizeLineName(right.lineName);
  return Boolean(leftLine && rightLine && leftLine === rightLine);
}

function isEmployeeInManagerHierarchy(input: {
  employee: EmployeeDirectoryRow;
  employeeByHrId: Map<string, EmployeeDirectoryRow>;
  viewerHrId: string;
}) {
  let managerHrId = canonicalHrId(input.employee.managerHrId);
  const visited = new Set<string>();

  while (managerHrId && !visited.has(managerHrId)) {
    if (managerHrId === input.viewerHrId) return true;
    visited.add(managerHrId);
    managerHrId = canonicalHrId(input.employeeByHrId.get(managerHrId)?.managerHrId);
  }

  return false;
}

function filterVacationEmployeesForAccess(access: AccessContext, employees: EmployeeDirectoryRow[]) {
  const scope = getVacationVisibilityScope(access);
  if (scope === "COMPANY") return employees;

  const currentEmployee = findCurrentEmployeeRow(employees, access);
  if (!currentEmployee) {
    throw new Error("Your employee profile is not available in the employee directory. Please contact HR.");
  }

  const viewerHrId = canonicalHrId(currentEmployee.hrId);
  if (!viewerHrId) {
    throw new Error("Your employee profile is not linked yet. Please contact HR.");
  }

  const employeeByHrId = new Map(
    employees
      .map((employee) => [canonicalHrId(employee.hrId), employee] as const)
      .filter((entry): entry is [string, EmployeeDirectoryRow] => Boolean(entry[0])),
  );

  return employees.filter((employee) => {
    const employeeHrId = canonicalHrId(employee.hrId);
    if (employeeHrId === viewerHrId) return true;

    if (scope === "TEAM") {
      return hrIdsMatch(currentEmployee.hrId, employee.managerHrId);
    }

    if (scope === "HIERARCHY") {
      return isEmployeeInManagerHierarchy({ employee, employeeByHrId, viewerHrId });
    }

    if (scope === "LINE") {
      return employeeLineMatches(employee, currentEmployee);
    }

    return false;
  });
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

function addMonthsToDateOnly(value: string | null | undefined, months: number) {
  const date = parseDateOnly(value);
  if (!date) return null;
  date.setMonth(date.getMonth() + months);
  return toDateOnlyString(date);
}

function employeeEligibilityFilterMatches(
  employee: EmployeeDirectoryRow,
  filters: VacationReportFilters,
) {
  if (filters.employee && !hrIdsMatch(employee.hrId, filters.employee)) return false;
  if (filters.manager && !hrIdsMatch(employee.managerHrId, filters.manager)) return false;
  if (filters.department && (employee.departmentName ?? "") !== filters.department) return false;
  if (filters.line && (employee.lineName ?? "") !== filters.line) return false;

  const search = text(filters.search).toLowerCase();
  if (!search) return true;

  return [
    employee.hrId,
    employee.fullName,
    employee.departmentName,
    employee.lineName,
    employee.managerName,
    employee.managerHrId,
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(search));
}

function approvedPaidDaysFromRows(input: {
  employeeHrId: string;
  periodEnd: string | null;
  periodStart: string | null;
  rows: VacationRequestRecord[];
  vacationType: VacationType;
}) {
  const periodStart = input.periodStart;
  const periodEnd = input.periodEnd;
  if (!periodStart || !periodEnd) return 0;

  return input.rows.reduce((sum, row) => {
    if (!hrIdsMatch(row.employeeHrId, input.employeeHrId)) return sum;
    if (row.status !== "approved") return sum;
    if (row.startDate < periodStart || row.startDate >= periodEnd) return sum;

    const matchesType = input.vacationType === "annual" || input.vacationType === "emergency"
      ? row.vacationType === "annual" || row.vacationType === "emergency"
      : row.vacationType === input.vacationType;
    if (!matchesType) return sum;

    return sum + (row.paidDurationDays ? row.paidDurationDays : row.paymentStatus === "paid" ? row.durationDays : 0);
  }, 0);
}

function buildEmployeeEligibilityRows(input: {
  employees: EmployeeDirectoryRow[];
  filters: VacationReportFilters;
  rows: VacationRequestRecord[];
  today: string;
}): VacationEmployeeEligibilityRow[] {
  return input.employees
    .filter((employee) => employeeEligibilityFilterMatches(employee, input.filters))
    .map((employee) => {
      const period = getVacationBalancePeriod({
        hireDate: employee.hireDate,
        referenceDate: input.today,
      });
      const usedPaidDays = approvedPaidDaysFromRows({
        employeeHrId: employee.hrId,
        periodEnd: period?.periodEnd ?? null,
        periodStart: period?.periodStart ?? null,
        rows: input.rows,
        vacationType: "annual",
      });
      const annualBalance = calculateVacationPayment({
        approvedPaidDaysInPeriod: usedPaidDays,
        durationDays: 0,
        hireDate: employee.hireDate,
        startDate: input.today,
        vacationType: "annual",
      });
      const sixMonthAnniversary = addMonthsToDateOnly(employee.hireDate, 6);
      const daysSinceHire = daysBetweenDateOnly(employee.hireDate);
      const eligibilityDate = parseDateOnly(sixMonthAnniversary);
      const daysUntilEligibility = sixMonthAnniversary && eligibilityDate && input.today < sixMonthAnniversary
        ? daysBetweenDateOnly(input.today, eligibilityDate)
        : 0;
      const eligibilityStatus: VacationEligibilityStatus = annualBalance.unpaidReason === "missing_hire_date"
        ? "missing_hire_date"
        : annualBalance.unpaidReason === "first_six_months"
          ? "first_six_months"
          : "eligible";
      const reviewFlags = [
        eligibilityStatus === "missing_hire_date" ? "Missing hire date" : null,
        eligibilityStatus === "first_six_months" && daysUntilEligibility && daysUntilEligibility > 0
          ? `${daysUntilEligibility} days until paid eligibility`
          : null,
        employee.managerHrId ? null : "Missing direct manager",
        annualBalance.paymentStatus === "paid" && annualBalance.balanceBeforeDays <= 0
          ? "No paid annual balance remaining"
          : null,
      ].filter((value): value is string => Boolean(value));

      return {
        annualBalanceDays: annualBalance.balanceBeforeDays,
        annualEntitlementDays: annualBalance.entitlementDays,
        annualUsedDays: annualBalance.usedPaidDays,
        daysSinceHire,
        daysUntilEligibility: eligibilityStatus === "first_six_months" ? daysUntilEligibility : 0,
        departmentName: employee.departmentName,
        eligibilityStatus,
        eligibleForAnnualPaidLeave: eligibilityStatus === "eligible",
        employmentStatus: employee.employmentStatus,
        fullName: employee.fullName,
        hireDate: employee.hireDate,
        hrId: employee.hrId,
        lineName: employee.lineName,
        managerHrId: employee.managerHrId,
        managerName: employee.managerName,
        reviewFlags,
        sixMonthAnniversary,
      };
    })
    .sort((left, right) => {
      const priority: Record<VacationEligibilityStatus, number> = { missing_hire_date: 0, first_six_months: 1, eligible: 2 };
      const priorityDiff = priority[left.eligibilityStatus] - priority[right.eligibilityStatus];
      if (priorityDiff !== 0) return priorityDiff;
      return left.fullName.localeCompare(right.fullName);
    });
}

function buildEmployeeEligibilitySummary(
  rows: VacationEmployeeEligibilityRow[],
): VacationReportData["employeeEligibilitySummary"] {
  return {
    activeEmployees: rows.length,
    eligibleNow: rows.filter((row) => row.eligibilityStatus === "eligible").length,
    inFirstSixMonths: rows.filter((row) => row.eligibilityStatus === "first_six_months").length,
    missingHireDate: rows.filter((row) => row.eligibilityStatus === "missing_hire_date").length,
    zeroBalance: rows.filter((row) => row.eligibilityStatus === "eligible" && row.annualBalanceDays <= 0).length,
  };
}

async function getCurrentEmployee(access: AccessContext, directory?: EmployeeDirectoryData) {
  const identityCandidates = accessIdentityCandidates(access);
  if (identityCandidates.length === 0) {
    throw new Error("Your employee profile is not linked yet. Please contact HR.");
  }

  const employeeDirectory = directory ?? await getEmployeeDirectory();
  const employee = findCurrentEmployee(employeeDirectory, access);
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

function mapWeeklyOffPolicy(row: VacationWeeklyOffPolicyDbRow): VacationWeeklyOffPolicyRecord {
  return {
    friday: normalizeWeeklyOffMode(row.friday_off),
    id: row.id,
    jobTitle: text(row.job_title),
    saturday: normalizeWeeklyOffMode(row.saturday_off),
    thursday: normalizeWeeklyOffMode(row.thursday_off),
    updatedAt: row.updated_at,
  };
}

function defaultWeeklyOffPolicy(jobTitle: string): VacationWeeklyOffPolicyRecord {
  return {
    friday: "full_day",
    id: null,
    jobTitle,
    saturday: "working",
    thursday: "working",
    updatedAt: null,
  };
}

function weeklyOffPolicyForDateCalculation(policy: VacationWeeklyOffPolicyRecord | null) {
  return {
    friday: policy?.friday ?? "full_day",
    saturday: policy?.saturday ?? "working",
    thursday: policy?.thursday ?? "working",
  };
}

async function fetchWeeklyOffPolicyForTitle(jobTitle: string) {
  const { data, error } = await getSupabaseAdmin()
    .from(vacationWeeklyOffPoliciesTable)
    .select("*")
    .eq("job_title", jobTitle)
    .maybeSingle();

  if (error) throw new Error(typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error));
  return data ? mapWeeklyOffPolicy(data as VacationWeeklyOffPolicyDbRow) : defaultWeeklyOffPolicy(jobTitle);
}

function resolveSubmittedVacationType(input: {
  endDate: string;
  requestedVacationType: VacationType;
  startDate: string;
}) {
  if (
    input.requestedVacationType === "annual" &&
    input.startDate === input.endDate &&
    input.startDate === getVacationPolicyToday()
  ) {
    return "emergency" satisfies VacationType;
  }

  return input.requestedVacationType;
}

function validateVacationSubmissionDates(input: {
  endDate: string;
  resolvedVacationType: VacationType;
  startDate: string;
}) {
  const today = getVacationPolicyToday();
  if (input.startDate < today || input.endDate < today) {
    throw new Error("Vacation requests cannot be submitted retroactively.");
  }

  if (input.resolvedVacationType === "annual" && input.startDate < getAnnualVacationMinimumStartDate()) {
    throw new Error("Annual vacation requests must start from tomorrow or later.");
  }

  if (input.resolvedVacationType === "emergency" && (input.startDate !== today || input.endDate !== today)) {
    throw new Error("Emergency vacation requests must be submitted for the current day only.");
  }
}

function holidayMonthKeysForDates(dates: string[]) {
  const keys = new Set<string>();
  for (const value of dates) {
    const date = parseDateOnly(value);
    if (!date) continue;
    keys.add(`${date.getFullYear()}-${date.getMonth() + 1}`);
  }
  return [...keys].map((key) => {
    const [year, month] = key.split("-").map(Number);
    return { month, year };
  });
}

async function validateOfficialHolidayAdjacency(input: {
  endDate: string;
  startDate: string;
}) {
  const dayBeforeStart = addDaysToDateOnly(input.startDate, -1);
  const dayAfterEnd = addDaysToDateOnly(input.endDate, 1);
  if (!dayBeforeStart || !dayAfterEnd) return;

  const holidays: EgyptianNationalHoliday[] = [];
  for (const period of holidayMonthKeysForDates([dayBeforeStart, dayAfterEnd])) {
    const result = await getEgyptianNationalHolidays(period);
    if (result.connected) holidays.push(...result.holidays);
  }

  const isHolidayDate = (value: string) =>
    holidays.some((holiday) => value >= holiday.startDate && value <= (holiday.endDate ?? holiday.startDate));

  if (isHolidayDate(dayBeforeStart) || isHolidayDate(dayAfterEnd)) {
    throw new Error("Vacation requests are not allowed directly before or directly after an official national holiday.");
  }
}

function shouldForceUnpaidForPolicy(input: {
  dayPart: VacationDayPart;
  policyWarnings: string[];
  vacationType: VacationType;
}) {
  return (
    input.vacationType === "emergency" &&
    input.dayPart !== "pm_only" &&
    input.policyWarnings.some((warning) => warning.includes("before 10:00 AM"))
  );
}

function mapVacationRow(row: VacationRequestDbRow, canDecide = false): VacationRequestRecord {
  return {
    balanceAfterDays: numberValue(row.balance_after_days),
    balanceBeforeDays: numberValue(row.balance_before_days),
    canDecide,
    compensatoryAttachmentBucket: row.compensatory_attachment_bucket ?? null,
    compensatoryAttachmentContentType: row.compensatory_attachment_content_type ?? null,
    compensatoryAttachmentObjectPath: row.compensatory_attachment_object_path ?? null,
    compensatoryAttachmentOriginalName: row.compensatory_attachment_original_name ?? null,
    compensatoryAttachmentSizeBytes: numberValue(row.compensatory_attachment_size_bytes),
    compensatoryAttachmentUploadedAt: row.compensatory_attachment_uploaded_at ?? null,
    compensatoryEventDate: row.compensatory_event_date ?? null,
    compensatoryEventLocation: row.compensatory_event_location ?? null,
    compensatoryEventName: row.compensatory_event_name ?? null,
    compensatoryManager1: row.compensatory_manager_1 ?? null,
    compensatoryManager2: row.compensatory_manager_2 ?? null,
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
    sickAttachmentBucket: row.sick_attachment_bucket ?? null,
    sickAttachmentContentType: row.sick_attachment_content_type ?? null,
    sickAttachmentObjectPath: row.sick_attachment_object_path ?? null,
    sickAttachmentOriginalName: row.sick_attachment_original_name ?? null,
    sickAttachmentSizeBytes: numberValue(row.sick_attachment_size_bytes),
    sickAttachmentUploadedAt: row.sick_attachment_uploaded_at ?? null,
    lineName: row.line_name,
    hrDecision:
      row.hr_decision === "approved" || row.hr_decision === "rejected"
        ? row.hr_decision
        : null,
    hrDecisionAt: row.hr_decision_at ?? null,
    hrDecisionByHrId: row.hr_decision_by_hr_id ?? null,
    hrDecisionComment: row.hr_decision_comment ?? null,
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
    notes: row.notes ?? null,
    paymentStatus: normalizeVacationPaymentStatus(row.payment_status) ?? "unpaid",
    paidDurationDays: row.paid_duration_days == null
      ? normalizeVacationPaymentStatus(row.payment_status) === "paid"
        ? numberValue(row.duration_days)
        : 0
      : numberValue(row.paid_duration_days),
    periodEnd: row.period_end,
    periodStart: row.period_start,
    startDate: text(row.start_date),
    status:
      row.status === "approved" || row.status === "rejected" || row.status === "pending_manager" || row.status === "pending_hr"
        ? row.status
        : "pending_manager",
    submittedByHrId: row.submitted_by_hr_id,
    unpaidReason:
      row.unpaid_reason === "first_six_months" ||
      row.unpaid_reason === "insufficient_balance" ||
      row.unpaid_reason === "missing_hire_date"
        ? row.unpaid_reason
        : null,
    unpaidDurationDays: row.unpaid_duration_days == null
      ? normalizeVacationPaymentStatus(row.payment_status) === "unpaid"
        ? numberValue(row.duration_days)
        : 0
      : numberValue(row.unpaid_duration_days),
    usedPaidDays: numberValue(row.used_paid_days),
    vacationType: normalizeVacationType(row.vacation_type) ?? "annual",
  };
}

function legacyVacationStatus(row: LegacyLeaveRequestDbRow): VacationRequestStatus {
  const status = text(row.status).toLowerCase();
  const managerStatus = text(row.manager_status).toLowerCase();
  const hrStatus = text(row.hr_status).toLowerCase();

  if (status === "hr_approved" || status === "approved" || hrStatus === "approved") return "approved";
  if (
    status === "hr_rejected" ||
    status === "manager_rejected" ||
    status === "cancelled" ||
    status === "rejected" ||
    managerStatus === "rejected" ||
    hrStatus === "rejected"
  ) {
    return "rejected";
  }
  if (status === "pending_hr" || status === "manager_approved" || managerStatus === "approved") return "pending_hr";
  return "pending_manager";
}

function legacyVacationDecision(value: unknown): "approved" | "rejected" | null {
  const normalized = text(value).toLowerCase();
  if (normalized === "approved") return "approved";
  if (normalized === "rejected") return "rejected";
  return null;
}

function legacyVacationType(row: LegacyLeaveRequestDbRow): VacationType {
  const normalized = [row.vacation_type, row.request_type]
    .map((value) => text(value).toLowerCase().replace(/[_-]/g, " "))
    .join(" ");
  const direct = normalizeVacationType(normalized);
  if (direct) return direct;
  if (normalized.includes("sick")) return "sick";
  if (normalized.includes("compensatory")) return "compensatory";
  if (normalized.includes("emergency")) return "emergency";
  if (normalized.includes("other") || normalized.includes("personal")) return "other";
  return "annual";
}

function legacyDayPart(row: LegacyLeaveRequestDbRow): VacationDayPart {
  const normalized = [row.day_type, row.duration_unit]
    .map((value) => text(value).toLowerCase().replace(/[_-]/g, " "))
    .join(" ");
  if (normalized.includes("am")) return "am_only";
  if (normalized.includes("pm")) return "pm_only";
  if (normalized.includes("half")) return "am_only";
  return normalizeVacationDayPart(row.day_type ?? row.duration_unit) ?? "full_day";
}

function legacyPaymentStatus(value: unknown): VacationPaymentStatus {
  const normalized = text(value).toLowerCase();
  const direct = normalizeVacationPaymentStatus(normalized);
  if (direct) return direct;
  if (normalized.includes("partial")) return "partial";
  if (normalized.includes("unpaid")) return "unpaid";
  return "paid";
}

function mapLegacyLeaveRequestRow(
  row: LegacyLeaveRequestDbRow,
  employeesByHrId: Map<string, EmployeeDirectoryRow>,
  canDecide = false,
): VacationRequestRecord {
  const employee = employeeFromMap(employeesByHrId, row.employee_hr_id);
  const managerHrId = nullableText(row.direct_manager_hr_id) ?? employee?.managerHrId ?? null;
  const manager = employeeFromMap(employeesByHrId, managerHrId);
  const managerOfManagerHrId = nullableText(row.manager_of_manager_hr_id) ?? manager?.managerHrId ?? null;
  const managerOfManager = employeeFromMap(employeesByHrId, managerOfManagerHrId);
  const durationDays = numberValue(row.duration_days ?? row.total_working_days ?? row.total_calendar_days);
  const paymentStatus = legacyPaymentStatus(row.payment_status);
  const unpaidDurationDays = numberValue(row.unpaid_leave_days_at_submission);
  const paidDurationDays = paymentStatus === "unpaid"
    ? 0
    : paymentStatus === "partial"
      ? Math.max(0, durationDays - unpaidDurationDays)
      : durationDays;
  const status = legacyVacationStatus(row);
  const managerDecision = legacyVacationDecision(row.manager_status);
  const hrDecision = legacyVacationDecision(row.hr_status);

  return {
    balanceAfterDays: numberValue(row.remaining_paid_balance_at_submission),
    balanceBeforeDays: numberValue(row.total_entitled_balance_at_submission),
    canDecide,
    compensatoryAttachmentBucket: null,
    compensatoryAttachmentContentType: null,
    compensatoryAttachmentObjectPath: null,
    compensatoryAttachmentOriginalName: null,
    compensatoryAttachmentSizeBytes: 0,
    compensatoryAttachmentUploadedAt: null,
    compensatoryEventDate: null,
    compensatoryEventLocation: null,
    compensatoryEventName: null,
    compensatoryManager1: null,
    compensatoryManager2: null,
    createdAt: row.created_at ?? row.requested_at ?? "",
    dayPart: legacyDayPart(row),
    departmentName: employee?.departmentName ?? null,
    durationDays,
    employeeHireDate: row.employee_hire_date ?? employee?.hireDate ?? null,
    employeeHrId: text(row.employee_hr_id),
    employeeName: text(row.employee_name) || employee?.fullName || text(row.employee_hr_id),
    employeeWorkEmail: row.employee_email ?? employee?.workEmail ?? null,
    endDate: text(row.end_date),
    entitlementDays: numberValue(row.first_year_entitlement_at_submission ?? row.total_entitled_balance_at_submission),
    hrDecision,
    hrDecisionAt: row.hr_decision_at ?? null,
    hrDecisionByHrId: hrDecision ? nullableText(row.approved_or_rejected_by) : null,
    hrDecisionComment: row.hr_comment ?? null,
    id: row.id,
    lineName: row.employee_line ?? employee?.lineName ?? null,
    managerDecision,
    managerDecisionAt: row.manager_decision_at ?? null,
    managerDecisionByHrId: managerDecision ? managerHrId : null,
    managerDecisionComment: row.manager_comment ?? null,
    managerHrId,
    managerName: nullableText(row.direct_manager) ?? manager?.fullName ?? null,
    managerOfManagerHrId,
    managerOfManagerName: managerOfManager?.fullName ?? null,
    notes: nullableText(row.reason) ?? nullableText(row.payment_reason),
    paidDurationDays,
    paymentStatus,
    periodEnd: null,
    periodStart: null,
    sickAttachmentBucket: null,
    sickAttachmentContentType: null,
    sickAttachmentObjectPath: null,
    sickAttachmentOriginalName: null,
    sickAttachmentSizeBytes: 0,
    sickAttachmentUploadedAt: null,
    startDate: text(row.start_date),
    status,
    submittedByHrId: row.employee_hr_id,
    unpaidDurationDays: unpaidDurationDays || (paymentStatus === "unpaid" ? durationDays : 0),
    unpaidReason: paymentStatus === "unpaid" ? "insufficient_balance" : null,
    usedPaidDays: numberValue(row.used_paid_leave_at_submission),
    vacationType: legacyVacationType(row),
  };
}

function canDecideVacation(access: AccessContext, request: Pick<VacationRequestRecord, "managerHrId" | "status">) {
  if (request.status !== "pending_manager" && request.status !== "pending_hr") return false;
  if (access.scope === "system") return true;
  if (request.status === "pending_manager") {
    return accessMatchesHrId(access, request.managerHrId);
  }
  if (request.status === "pending_hr") {
    return canApproveVacationHrFinalDecision(access);
  }
  return false;
}

function normalizeAdminVacationStatus(value: unknown): VacationRequestStatus {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "pending_manager" || normalized === "pending_hr" || normalized === "approved" || normalized === "rejected") {
    return normalized;
  }
  return "approved";
}

function adminDecisionPayload(input: {
  actorHrId: string | null;
  actorLoginId?: string | null;
  status: VacationRequestStatus;
}) {
  const now = new Date().toISOString();
  const actorId = input.actorHrId ?? input.actorLoginId ?? "system";
  const reset = {
    hr_decision: null,
    hr_decision_at: null,
    hr_decision_by_hr_id: null,
    hr_decision_comment: null,
    manager_decision: null,
    manager_decision_at: null,
    manager_decision_by_hr_id: null,
    manager_decision_comment: null,
  };

  if (input.status === "pending_manager") return reset;

  if (input.status === "pending_hr") {
    return {
      ...reset,
      manager_decision: "approved",
      manager_decision_at: now,
      manager_decision_by_hr_id: actorId,
      manager_decision_comment: "Manual admin record update.",
    };
  }

  return {
    ...reset,
    hr_decision: input.status,
    hr_decision_at: now,
    hr_decision_by_hr_id: actorId,
    hr_decision_comment: "Manual admin record update.",
    manager_decision: "approved",
    manager_decision_at: now,
    manager_decision_by_hr_id: actorId,
    manager_decision_comment: "Manual admin record update.",
  };
}

function canSeeVacation(access: AccessContext, request: VacationRequestRecord, visibleEmployeeHrIds?: Set<string>) {
  if (isAllVacationVisibility(access)) return true;
  const employeeHrId = canonicalHrId(request.employeeHrId);
  if (employeeHrId && visibleEmployeeHrIds?.has(employeeHrId)) return true;

  return (
    accessMatchesHrId(access, request.employeeHrId) ||
    accessMatchesHrId(access, request.managerHrId) ||
    accessMatchesHrId(access, request.managerOfManagerHrId)
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
    const hrRecipientIds = new Set([designatedHrSpecialistHrId, designatedHrManagerHrId]);
    const { data, error } = await getSupabaseAdmin()
      .from("app_auth_users")
      .select("login_id,hr_id,role,is_active")
      .eq("is_active", true)
      .in("role", ["HR Specialist", "HR Manager", "Super Admin"]);

    if (error) return [];

    return (data ?? [])
      .map((row) => {
        const hrId = text((row as Record<string, unknown>).hr_id);
        if (!hrRecipientIds.has(normalizeHrIdForAccess(hrId) ?? "")) return null;
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

function vacationNotificationMetadata(
  request: VacationRequestRecord,
  extra: Record<string, unknown> = {},
) {
  return {
    employeeHrId: request.employeeHrId,
    employeeName: request.employeeName,
    endDate: request.endDate,
    managerHrId: request.managerHrId,
    managerName: request.managerName,
    requestDate: request.startDate === request.endDate ? request.startDate : `${request.startDate} to ${request.endDate}`,
    requestId: request.id,
    requestType: vacationTypeLabel(request.vacationType),
    startDate: request.startDate,
    status: request.status,
    vacationType: request.vacationType,
    ...extra,
  };
}

async function dispatchVacationSubmitted(input: {
  baseUrl: string;
  directory: EmployeeDirectoryData;
  policyWarnings?: string[];
  request: VacationRequestRecord;
}) {
  const hrRecipients = await getHrRecipients(input.directory);
  const reportHref = `/leave-management/vacation-report?tab=requests&requestId=${encodeURIComponent(input.request.id)}`;
  const policyWarningText = (input.policyWarnings ?? []).join(" ");
  await notifyRecipients({
    href: reportHref,
    message: `${input.request.employeeName} submitted ${vacationTypeLabel(input.request.vacationType)} for ${input.request.durationDays} day(s).${policyWarningText ? ` Policy review: ${policyWarningText}` : ""}`,
    metadata: vacationNotificationMetadata(input.request, {
      durationDays: input.request.durationDays,
      policyWarnings: input.policyWarnings ?? [],
    }),
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
    policyWarnings: input.policyWarnings ?? [],
    rejectUrl: buildVacationDecisionUrl({
      baseUrl: input.baseUrl,
      decision: "reject",
      requestId: input.request.id,
      token,
    }),
    request: input.request,
  });
}

async function dispatchVacationManagerReview(input: {
  decision: VacationDecision;
  directory: EmployeeDirectoryData;
  request: VacationRequestRecord;
}) {
  const hrRecipients = await getHrRecipients(input.directory);
  const reportHref = `/leave-management/vacation-report?tab=requests&requestId=${encodeURIComponent(input.request.id)}`;
  await notifyRecipients({
    href: reportHref,
    message: `${input.request.managerName ?? "Direct manager"} ${input.decision === "approve" ? "approved" : "rejected"} ${input.request.employeeName}'s vacation request. HR final decision is required.`,
    metadata: vacationNotificationMetadata(input.request, {
      managerDecision: input.request.managerDecision,
    }),
    recipients: [
      input.request.employeeHrId,
      input.request.managerOfManagerHrId,
      ...hrRecipients.map((recipient) => recipient.hrId),
    ],
    requestId: input.request.id,
    title: "Vacation request pending HR final decision",
    type: `manager_review:${input.decision}`,
  });
}

async function dispatchVacationDecision(input: {
  decision: VacationDecision;
  directory: EmployeeDirectoryData;
  request: VacationRequestRecord;
}) {
  const hrRecipients = await getHrRecipients(input.directory);
  const reportHref = `/leave-management/vacation-report?tab=requests&requestId=${encodeURIComponent(input.request.id)}`;
  await notifyRecipients({
    href: reportHref,
    message: `${input.request.employeeName}'s vacation request was ${input.decision === "approve" ? "approved" : "rejected"} by HR final review.`,
    metadata: vacationNotificationMetadata(input.request, {
      hrDecision: input.request.hrDecision,
    }),
    recipients: [
      input.request.employeeHrId,
      input.request.managerOfManagerHrId,
      ...hrRecipients.map((recipient) => recipient.hrId),
    ],
    requestId: input.request.id,
    title: `Vacation request ${input.decision === "approve" ? "approved" : "rejected"} by HR`,
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
  vacationType: VacationType;
}) {
  if (!input.periodStart || !input.periodEnd) return 0;

  let query = getSupabaseAdmin()
    .from(vacationRequestsTable)
    .select("id,duration_days,paid_duration_days,payment_status")
    .ilike("employee_hr_id", input.employeeHrId)
    .eq("status", "approved")
    .gte("start_date", input.periodStart)
    .lt("start_date", input.periodEnd);

  if (input.vacationType === "annual" || input.vacationType === "emergency") {
    query = query.in("vacation_type", ["annual", "emergency"]);
  } else {
    query = query.eq("vacation_type", input.vacationType);
  }

  const { data, error } = await query;

  if (error) throw new Error(typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error));

  return (data ?? [])
    .filter((row) => String((row as Record<string, unknown>).id) !== input.excludeRequestId)
    .reduce((sum, row) => {
      const record = row as Record<string, unknown>;
      if (record.paid_duration_days != null) return sum + numberValue(record.paid_duration_days);
      return record.payment_status === "paid" ? sum + numberValue(record.duration_days) : sum;
    }, 0);
}

async function calculatePaymentForRequest(input: {
  durationDays: number;
  employeeHrId: string;
  excludeRequestId?: string;
  hireDate: string | null;
  startDate: string;
  vacationType: VacationType;
}) {
  if (input.vacationType === "compensatory") {
    return calculateVacationPayment({
      approvedPaidDaysInPeriod: 0,
      durationDays: input.durationDays,
      hireDate: input.hireDate,
      startDate: input.startDate,
      vacationType: input.vacationType,
    });
  }

  const period = getVacationBalancePeriod({
    hireDate: input.hireDate,
    referenceDate: input.startDate,
  });
  const usedPaidDays = await approvedPaidDaysInPeriod({
    employeeHrId: input.employeeHrId,
    excludeRequestId: input.excludeRequestId,
    periodEnd: period?.periodEnd ?? null,
    periodStart: period?.periodStart ?? null,
    vacationType: input.vacationType,
  });

  return calculateVacationPayment({
    approvedPaidDaysInPeriod: usedPaidDays,
    durationDays: input.durationDays,
    hireDate: input.hireDate,
    startDate: input.startDate,
    vacationType: input.vacationType,
  });
}

function sanitizeStorageSegment(value: string | null | undefined, fallback: string) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || fallback;
}

function buildSickAttachmentPath(input: {
  employeeHrId: string;
  fileName: string;
  requestId: string;
}) {
  const employeeHrId = sanitizeStorageSegment(input.employeeHrId, "unknown-employee");
  const requestId = sanitizeStorageSegment(input.requestId, "unknown-request");
  const fileName = sanitizeStorageSegment(input.fileName, "sick-document");
  return `sick/${employeeHrId}/${requestId}/${fileName}`;
}

function buildCompensatoryAttachmentPath(input: {
  employeeHrId: string;
  fileName: string;
  requestId: string;
}) {
  const employeeHrId = sanitizeStorageSegment(input.employeeHrId, "unknown-employee");
  const requestId = sanitizeStorageSegment(input.requestId, "unknown-request");
  const fileName = sanitizeStorageSegment(input.fileName, "compensatory-event-photo");
  return `compensatory/${employeeHrId}/${requestId}/${fileName}`;
}

function validateSickAttachment(attachment: VacationAttachmentUpload | null | undefined) {
  if (!attachment) {
    throw new Error("Sick vacation requires an uploaded medical document.");
  }
  if (attachment.bytes.length === 0) {
    throw new Error("Sick vacation document is empty. Upload a valid file.");
  }
  if (attachment.bytes.length > sickAttachmentMaxUploadBytes) {
    throw new Error("Sick vacation document is too large. Maximum size is 10MB.");
  }
  if (!sickAttachmentAllowedContentTypes.has(attachment.contentType)) {
    throw new Error("Sick vacation document must be a PDF, Word document, JPG, PNG, or WEBP file.");
  }
}

function validateCompensatoryAttachment(attachment: VacationAttachmentUpload | null | undefined) {
  if (!attachment) {
    throw new Error("Compensatory Day requires an uploaded event photo.");
  }
  if (attachment.bytes.length === 0) {
    throw new Error("Compensatory Day event photo is empty. Upload a valid image.");
  }
  if (attachment.bytes.length > sickAttachmentMaxUploadBytes) {
    throw new Error("Compensatory Day event photo is too large. Maximum size is 10MB.");
  }
  if (!compensatoryAttachmentAllowedContentTypes.has(attachment.contentType)) {
    throw new Error("Compensatory Day event photo must be a JPG, PNG, or WEBP image.");
  }
}

function validateCompensatoryDetails(input: CreateVacationRequestInput) {
  const eventName = text(input.compensatoryEventName);
  const eventDate = toDateOnlyString(String(input.compensatoryEventDate ?? ""));
  const requestStartDate = toDateOnlyString(String(input.startDate ?? ""));
  const eventLocation = text(input.compensatoryEventLocation);
  const manager1 = text(input.compensatoryManager1);
  const manager2 = text(input.compensatoryManager2);

  if (!eventName) throw new Error("Compensatory Day requires the event name.");
  if (!eventDate) throw new Error("Compensatory Day requires the event date.");
  if (!eventLocation) throw new Error("Compensatory Day requires the event location.");
  if (!manager1) throw new Error("Compensatory Day requires the first manager name who attended or supervised the event.");
  if (requestStartDate && requestStartDate < eventDate) {
    throw new Error("Compensatory Day cannot be requested before the event date.");
  }
  const expiryDate = addDaysToDateOnly(eventDate, 14);
  if (requestStartDate && expiryDate && requestStartDate > expiryDate) {
    throw new Error("Compensatory Day has expired. It must be used within 14 days from the event date.");
  }
  validateCompensatoryAttachment(input.compensatoryAttachment);

  return { eventDate, eventLocation, eventName, manager1, manager2 };
}

function validateOtherReason(input: CreateVacationRequestInput) {
  const reason = text(input.otherReason);
  if (!reason) {
    throw new Error("Other vacation requires an explanation for HR review.");
  }
  return reason;
}

async function uploadSickAttachment(input: {
  attachment: VacationAttachmentUpload;
  employeeHrId: string;
  requestId: string;
}) {
  validateSickAttachment(input.attachment);
  const objectPath = buildSickAttachmentPath({
    employeeHrId: input.employeeHrId,
    fileName: input.attachment.fileName,
    requestId: input.requestId,
  });

  const { error } = await getSupabaseAdmin().storage
    .from(vacationAttachmentBucket)
    .upload(objectPath, input.attachment.bytes, {
      cacheControl: "31536000",
      contentType: input.attachment.contentType,
      upsert: false,
    });

  if (error) {
    throw new Error(`Unable to store sick vacation document: ${error.message}`);
  }

  return {
    bucket: vacationAttachmentBucket,
    contentType: input.attachment.contentType,
    objectPath,
    originalName: input.attachment.fileName,
    sizeBytes: input.attachment.size,
    uploadedAt: new Date().toISOString(),
  };
}

async function uploadCompensatoryAttachment(input: {
  attachment: VacationAttachmentUpload;
  employeeHrId: string;
  requestId: string;
}) {
  validateCompensatoryAttachment(input.attachment);
  const objectPath = buildCompensatoryAttachmentPath({
    employeeHrId: input.employeeHrId,
    fileName: input.attachment.fileName,
    requestId: input.requestId,
  });

  const { error } = await getSupabaseAdmin().storage
    .from(vacationAttachmentBucket)
    .upload(objectPath, input.attachment.bytes, {
      cacheControl: "31536000",
      contentType: input.attachment.contentType,
      upsert: false,
    });

  if (error) {
    throw new Error(`Unable to store compensatory day event photo: ${error.message}`);
  }

  return {
    bucket: vacationAttachmentBucket,
    contentType: input.attachment.contentType,
    objectPath,
    originalName: input.attachment.fileName,
    sizeBytes: input.attachment.size,
    uploadedAt: new Date().toISOString(),
  };
}

async function deleteSickAttachment(objectPath: string | null | undefined) {
  if (!objectPath) return;
  await getSupabaseAdmin().storage.from(vacationAttachmentBucket).remove([objectPath]);
}

export async function getVacationRequestPageData(access: AccessContext) {
  await assertPermission(access, "leave", "create");
  const { directory, employee } = await getCurrentEmployee(access);
  const today = toDateOnlyString(new Date()) ?? "";
  const { manager, managerOfManager } = managerChain(directory, employee);
  const weeklyOffPolicy = await fetchWeeklyOffPolicyForTitle(employeeVacationPolicyTitle(employee));

  const balanceReferenceDates: Record<VacationType, string> = {
    annual: getAnnualVacationMinimumStartDate(),
    compensatory: today,
    emergency: today,
    other: today,
    sick: today,
  };
  const balances: Partial<Record<VacationType, VacationBalanceSnapshot | null>> = {};
  let balance: VacationBalanceSnapshot | null = null;
  let balanceError: string | null = null;
  try {
    await Promise.all(
      VACATION_TYPES.map(async (option) => {
        balances[option.value] = await calculatePaymentForRequest({
          durationDays: 0,
          employeeHrId: employee.hrId,
          hireDate: employee.hireDate,
          startDate: balanceReferenceDates[option.value],
          vacationType: option.value,
        });
      }),
    );
    balance = balances.annual ?? null;
  } catch (err) {
    balanceError = isVacationSchemaMissingError(err)
      ? "Vacation schema is not ready. Apply the new v2 vacation migration before using this module."
      : (err instanceof Error ? err.message : String(err));
  }

  return {
    balance,
    balances,
    balanceError,
    dayPartOptions: VACATION_DAY_PARTS,
    employee: summarizeEmployee(employee),
    manager: manager ? summarizeEmployee(manager) : null,
    managerOfManager: managerOfManager ? summarizeEmployee(managerOfManager) : null,
    vacationTypeOptions: VACATION_REQUEST_TYPES,
    weeklyOffPolicy,
  };
}

export async function createVacationRequest(access: AccessContext, input: CreateVacationRequestInput, options: { baseUrl: string }) {
  await assertPermission(access, "leave", "create");
  const vacationType = normalizeVacationType(input.vacationType);
  const dayPart = normalizeVacationDayPart(input.dayPart);
  const startDate = toDateOnlyString(String(input.startDate ?? ""));
  const endDate = toDateOnlyString(String(input.endDate ?? ""));

  if (!vacationType) throw new Error("Vacation type is invalid.");
  if (!dayPart) throw new Error("Vacation day part is invalid.");
  if (!startDate || !endDate) throw new Error("Vacation start and end dates are required.");

  const resolvedVacationType = resolveSubmittedVacationType({
    endDate,
    requestedVacationType: vacationType,
    startDate,
  });
  validateVacationSubmissionDates({ endDate, resolvedVacationType, startDate });
  await validateOfficialHolidayAdjacency({ endDate, startDate });
  const policyWarnings = [...getVacationPolicyWarnings({ dayPart, endDate, startDate, vacationType: resolvedVacationType })];
  if (vacationType === "sick") {
    validateSickAttachment(input.sickAttachment);
  }
  const otherReason = vacationType === "other" ? validateOtherReason(input) : null;
  const compensatoryDetails = vacationType === "compensatory" ? validateCompensatoryDetails(input) : null;

  const { directory, employee } = await getCurrentEmployee(access);
  const weeklyOffPolicy = await fetchWeeklyOffPolicyForTitle(employeeVacationPolicyTitle(employee));
  const durationDays = calculateVacationDurationDays({
    dayPart,
    endDate,
    startDate,
    weeklyOffPolicy: weeklyOffPolicyForDateCalculation(weeklyOffPolicy),
  });

  // Guard against duplicate active requests for identical dates.
  // The DB partial unique index enforces this at the storage level too, but
  // a pre-flight check gives a cleaner user-facing error message.
  const { data: existingRequest } = await getSupabaseAdmin()
    .from(vacationRequestsTable)
    .select("id")
    .eq("employee_hr_id", employee.hrId)
    .eq("start_date", startDate)
    .eq("end_date", endDate)
    .not("status", "in", "(rejected,cancelled)")
    .limit(1);
  if (existingRequest && existingRequest.length > 0) {
    throw new Error("A vacation request for these dates is already submitted or under review.");
  }

  const { manager, managerOfManager } = managerChain(directory, employee);
  if (!manager?.hrId) {
    throw new Error("Your direct manager is not assigned. Please contact HR before submitting a vacation request.");
  }

  let balance = await calculatePaymentForRequest({
    durationDays,
    employeeHrId: employee.hrId,
    hireDate: employee.hireDate,
    startDate,
    vacationType: resolvedVacationType,
  });
  if (shouldForceUnpaidForPolicy({ dayPart, policyWarnings, vacationType: resolvedVacationType })) {
    balance = {
      ...balance,
      balanceAfterDays: balance.balanceBeforeDays,
      paidDurationDays: 0,
      paymentStatus: "unpaid",
      unpaidDurationDays: durationDays,
      unpaidReason: null,
    };
  }
  if (balance.unpaidReason === "first_six_months") {
    policyWarnings.push("Payment policy: this request is calculated as unpaid because the employee has not completed the first 6 months.");
  }
  if (balance.unpaidReason === "insufficient_balance") {
    policyWarnings.push("Payment policy: this request is calculated as unpaid because the available paid balance is insufficient.");
  }
  if (balance.unpaidReason === "missing_hire_date") {
    policyWarnings.push("Payment policy: paid eligibility cannot be confirmed because the employee hire date is missing.");
  }

  const requestId = randomUUID();
  const sickAttachment = resolvedVacationType === "sick" && input.sickAttachment
    ? await uploadSickAttachment({ attachment: input.sickAttachment, employeeHrId: employee.hrId, requestId })
    : null;
  const compensatoryAttachment = resolvedVacationType === "compensatory" && input.compensatoryAttachment
    ? await uploadCompensatoryAttachment({ attachment: input.compensatoryAttachment, employeeHrId: employee.hrId, requestId })
    : null;

  const now = new Date().toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from(vacationRequestsTable)
    .insert({
      id: requestId,
      balance_after_days: balance.balanceAfterDays,
      balance_before_days: balance.balanceBeforeDays,
      compensatory_attachment_bucket: compensatoryAttachment?.bucket ?? null,
      compensatory_attachment_content_type: compensatoryAttachment?.contentType ?? null,
      compensatory_attachment_object_path: compensatoryAttachment?.objectPath ?? null,
      compensatory_attachment_original_name: compensatoryAttachment?.originalName ?? null,
      compensatory_attachment_size_bytes: compensatoryAttachment?.sizeBytes ?? null,
      compensatory_attachment_uploaded_at: compensatoryAttachment?.uploadedAt ?? null,
      compensatory_event_date: compensatoryDetails?.eventDate ?? null,
      compensatory_event_location: compensatoryDetails?.eventLocation ?? null,
      compensatory_event_name: compensatoryDetails?.eventName ?? null,
      compensatory_manager_1: compensatoryDetails?.manager1 ?? null,
      compensatory_manager_2: compensatoryDetails?.manager2 ?? null,
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
      notes: otherReason,
      payment_status: balance.paymentStatus,
      paid_duration_days: balance.paidDurationDays,
      period_end: balance.periodEnd,
      period_start: balance.periodStart,
      sick_attachment_bucket: sickAttachment?.bucket ?? null,
      sick_attachment_content_type: sickAttachment?.contentType ?? null,
      sick_attachment_object_path: sickAttachment?.objectPath ?? null,
      sick_attachment_original_name: sickAttachment?.originalName ?? null,
      sick_attachment_size_bytes: sickAttachment?.sizeBytes ?? null,
      sick_attachment_uploaded_at: sickAttachment?.uploadedAt ?? null,
      start_date: startDate,
      status: "pending_manager",
      submitted_by_hr_id: employee.hrId,
      submitted_by_login_id: access.loginId ?? null,
      unpaid_reason: balance.unpaidReason,
      unpaid_duration_days: balance.unpaidDurationDays,
      updated_at: now,
      used_paid_days: balance.usedPaidDays,
      vacation_type: resolvedVacationType,
      weekly_off_policy_snapshot: weeklyOffPolicy ? (weeklyOffPolicy as unknown as Record<string, unknown>) : null,
    })
    .select("*")
    .single();

  if (error) {
    await deleteSickAttachment(sickAttachment?.objectPath).catch(() => undefined);
    await deleteSickAttachment(compensatoryAttachment?.objectPath).catch(() => undefined);
    throw new Error(typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error));
  }

  const request = mapVacationRow(data as VacationRequestDbRow);
  await insertVacationEvent({
    actorHrId: employee.hrId,
    actorLoginId: access.loginId,
    eventType: "submitted",
    message: "Vacation request submitted.",
    metadata: {
      hasSickAttachment: Boolean(request.sickAttachmentObjectPath),
      hasCompensatoryAttachment: Boolean(request.compensatoryAttachmentObjectPath),
      compensatoryEventName: request.compensatoryEventName,
      paymentStatus: request.paymentStatus,
      policyWarnings,
      unpaidReason: request.unpaidReason,
    },
    requestId: request.id,
  });

  await dispatchVacationSubmitted({ baseUrl: options.baseUrl, directory, policyWarnings, request }).catch(async (error) => {
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

async function buildAdminVacationMutationPayload(input: {
  access: AccessContext;
  directory: EmployeeDirectoryData;
  existing?: VacationRequestRecord | null;
  form: AdminVacationRequestInput;
}) {
  const employeeHrId = text(input.form.employeeHrId ?? input.existing?.employeeHrId);
  const employee = findEmployeeByHrId(input.directory, employeeHrId);
  if (!employee) throw new Error("Employee was not found in the employee directory.");

  const vacationType = normalizeVacationType(input.form.vacationType);
  const dayPart = normalizeVacationDayPart(input.form.dayPart);
  const startDate = toDateOnlyString(String(input.form.startDate ?? ""));
  const endDate = toDateOnlyString(String(input.form.endDate ?? ""));
  const status = normalizeAdminVacationStatus(input.form.status);
  const notes = nullableText(input.form.notes);

  if (!vacationType) throw new Error("Vacation type is invalid.");
  if (!dayPart) throw new Error("Vacation day part is invalid.");
  if (!startDate || !endDate) throw new Error("Vacation start and end dates are required.");
  if (endDate < startDate) throw new Error("Vacation end date cannot be before the start date.");
  if (employee.hireDate && startDate < employee.hireDate) {
    throw new Error("Vacation date cannot be before the employee hire date.");
  }
  if (vacationType === "other" && !notes) {
    throw new Error("Other vacation requires an explanation for HR review.");
  }
  if (vacationType === "sick" && !input.existing?.sickAttachmentObjectPath) {
    throw new Error("Manual sick vacation entries require an existing medical document. Ask the employee to submit the sick request with an attachment first.");
  }
  if (vacationType === "compensatory" && !input.existing?.compensatoryAttachmentObjectPath) {
    throw new Error("Manual compensatory day entries require an existing event photo. Ask the employee to submit the compensatory day request with the photo first.");
  }

  const weeklyOffPolicy = await fetchWeeklyOffPolicyForTitle(employeeVacationPolicyTitle(employee));
  const durationDays = calculateVacationDurationDays({
    dayPart,
    endDate,
    startDate,
    weeklyOffPolicy: weeklyOffPolicyForDateCalculation(weeklyOffPolicy),
  });
  const balance = await calculatePaymentForRequest({
    durationDays,
    employeeHrId: employee.hrId,
    excludeRequestId: input.existing?.id,
    hireDate: employee.hireDate,
    startDate,
    vacationType,
  });
  const { manager, managerOfManager } = managerChain(input.directory, employee);
  const actorHrId = resolveEmployeeIdentityId(input.access);
  const decisionPayload = adminDecisionPayload({ actorHrId, actorLoginId: input.access.loginId, status });

  return {
    payload: {
      ...decisionPayload,
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
      manager_hr_id: manager?.hrId ?? null,
      manager_name: manager?.fullName ?? null,
      manager_of_manager_hr_id: managerOfManager?.hrId ?? null,
      manager_of_manager_name: managerOfManager?.fullName ?? null,
      notes,
      payment_status: balance.paymentStatus,
      paid_duration_days: balance.paidDurationDays,
      period_end: balance.periodEnd,
      period_start: balance.periodStart,
      start_date: startDate,
      status,
      submitted_by_hr_id: actorHrId ?? employee.hrId,
      submitted_by_login_id: input.access.loginId ?? null,
      unpaid_duration_days: balance.unpaidDurationDays,
      unpaid_reason: balance.unpaidReason,
      updated_at: new Date().toISOString(),
      used_paid_days: balance.usedPaidDays,
      vacation_type: vacationType,
    },
    status,
  };
}

export async function createVacationRequestAsAdmin(access: AccessContext, input: AdminVacationRequestInput) {
  await assertVacationAdminManagement(access, "create");
  const directory = await getEmployeeDirectory();
  const requestId = randomUUID();
  const { payload, status } = await buildAdminVacationMutationPayload({ access, directory, form: input });

  const { data, error } = await getSupabaseAdmin()
    .from(vacationRequestsTable)
    .insert({ id: requestId, ...payload })
    .select("*")
    .single();

  if (error) throw new Error(typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error));
  const request = mapVacationRow(data as VacationRequestDbRow);

  await insertVacationEvent({
    actorHrId: resolveEmployeeIdentityId(access),
    actorLoginId: access.loginId,
    eventType: "admin_created",
    message: "Vacation request created manually by admin.",
    metadata: { status },
    requestId: request.id,
  });
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? resolveEmployeeIdentityId(access) ?? "system",
    entityId: request.id,
    entityType: "vacation_request",
    newValues: { request },
    oldValues: {},
    summary: "Vacation request created manually by admin.",
  });

  return request;
}

export async function updateVacationRequestAsAdmin(access: AccessContext, input: AdminVacationRequestInput & { requestId: string }) {
  await assertVacationAdminManagement(access, "update");
  const existing = await fetchVacationRequestById(input.requestId);
  if (!existing) throw new Error("Vacation request was not found.");

  const directory = await getEmployeeDirectory();
  const { payload, status } = await buildAdminVacationMutationPayload({ access, directory, existing, form: input });
  const { data, error } = await getSupabaseAdmin()
    .from(vacationRequestsTable)
    .update(payload)
    .eq("id", existing.id)
    .select("*")
    .single();

  if (error) throw new Error(typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error));
  const request = mapVacationRow(data as VacationRequestDbRow);

  await insertVacationEvent({
    actorHrId: resolveEmployeeIdentityId(access),
    actorLoginId: access.loginId,
    eventType: "admin_updated",
    message: "Vacation request updated manually by admin.",
    metadata: { status },
    requestId: request.id,
  });
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? resolveEmployeeIdentityId(access) ?? "system",
    entityId: request.id,
    entityType: "vacation_request",
    newValues: { request },
    oldValues: { request: existing },
    summary: "Vacation request updated manually by admin.",
  });

  return request;
}

export async function deleteVacationRequestAsAdmin(access: AccessContext, requestId: string) {
  await assertVacationAdminManagement(access, "delete");
  const existing = await fetchVacationRequestById(requestId);
  if (!existing) throw new Error("Vacation request was not found.");

  const { error } = await getSupabaseAdmin()
    .from(vacationRequestsTable)
    .delete()
    .eq("id", existing.id);

  if (error) throw new Error(typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error));
  await Promise.all([
    deleteSickAttachment(existing.sickAttachmentObjectPath),
    deleteSickAttachment(existing.compensatoryAttachmentObjectPath),
  ]).catch(() => undefined);

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? resolveEmployeeIdentityId(access) ?? "system",
    entityId: existing.id,
    entityType: "vacation_request",
    newValues: {},
    oldValues: { request: existing },
    summary: "Vacation request deleted manually by admin.",
  });

  return existing;
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

async function fetchLegacyLeaveRequestRows(employeesByHrId: Map<string, EmployeeDirectoryRow>) {
  const { data, error } = await getSupabaseAdmin()
    .from(legacyLeaveRequestsTable)
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error) {
    if (missingRelationMessage(error, legacyLeaveRequestsTable)) return [];
    throw new Error(typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error));
  }

  return (data ?? []).map((row) => mapLegacyLeaveRequestRow(row as LegacyLeaveRequestDbRow, employeesByHrId));
}

async function fetchLegacyLeaveRequestById(
  id: string,
  employeesByHrId?: Map<string, EmployeeDirectoryRow>,
) {
  const employeeMap = employeesByHrId ?? buildEmployeeMapByHrId(await getEmployeeDirectoryRows());
  const { data, error } = await getSupabaseAdmin()
    .from(legacyLeaveRequestsTable)
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    if (missingRelationMessage(error, legacyLeaveRequestsTable)) return null;
    throw new Error(typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error));
  }

  return data ? mapLegacyLeaveRequestRow(data as LegacyLeaveRequestDbRow, employeeMap) : null;
}

async function applyVacationDecision(input: {
  access?: AccessContext;
  actorHrId: string | null;
  actorLoginId?: string | null;
  decision: VacationDecision;
  decisionComment?: string | null;
  request: VacationRequestRecord;
}) {
  if (input.request.status !== "pending_manager" && input.request.status !== "pending_hr") {
    throw new Error("This vacation request already has a final decision.");
  }

  const directory = await getEmployeeDirectory();
  let balance: VacationBalanceSnapshot = input.request;
  if (input.request.status === "pending_hr" && input.decision === "approve") {
    balance = await calculatePaymentForRequest({
      durationDays: input.request.durationDays,
      employeeHrId: input.request.employeeHrId,
      excludeRequestId: input.request.id,
      hireDate: input.request.employeeHireDate,
      startDate: input.request.startDate,
      vacationType: input.request.vacationType,
    });
  }

  const decisionValue = input.decision === "approve" ? "approved" : "rejected";
  const isHrFinalDecision = input.request.status === "pending_hr";
  const actorId = input.actorHrId ?? input.actorLoginId ?? "system";
  const now = new Date().toISOString();
  const updatePayload = isHrFinalDecision
    ? {
        balance_after_days: balance.balanceAfterDays,
        balance_before_days: balance.balanceBeforeDays,
        entitlement_days: balance.entitlementDays,
        hr_decision: decisionValue,
        hr_decision_at: now,
        hr_decision_by_hr_id: actorId,
        hr_decision_comment: nullableText(input.decisionComment),
        payment_status: balance.paymentStatus,
        paid_duration_days: balance.paidDurationDays,
        period_end: balance.periodEnd,
        period_start: balance.periodStart,
        status: decisionValue,
        unpaid_reason: balance.unpaidReason,
        unpaid_duration_days: balance.unpaidDurationDays,
        updated_at: now,
        used_paid_days: balance.usedPaidDays,
      }
    : {
        manager_decision: decisionValue,
        manager_decision_at: now,
        manager_decision_by_hr_id: actorId,
        manager_decision_comment: nullableText(input.decisionComment),
        status: "pending_hr",
        updated_at: now,
      };

  const { data, error } = await getSupabaseAdmin()
    .from(vacationRequestsTable)
    .update(updatePayload)
    .eq("id", input.request.id)
    .eq("status", input.request.status)
    .select("*")
    .single();

  if (error) throw new Error(typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error));
  const updated = mapVacationRow(data as VacationRequestDbRow);

  await insertVacationEvent({
    actorHrId: input.actorHrId,
    actorLoginId: input.actorLoginId,
    eventType: isHrFinalDecision ? `hr_${decisionValue}` : `manager_${decisionValue}`,
    message: isHrFinalDecision
      ? `Vacation request ${decisionValue} by HR final review.`
      : `Vacation request ${decisionValue} by direct manager and sent to HR final review.`,
    metadata: {
      decisionComment: input.decisionComment ?? null,
      paymentStatus: updated.paymentStatus,
      unpaidReason: updated.unpaidReason,
    },
    requestId: updated.id,
  });
  await writeRequiredAuditLog({
    actorLoginId: input.actorLoginId ?? input.actorHrId ?? "system",
    entityId: updated.id,
    entityType: "vacation_request",
    newValues: {
      balanceAfterDays: updated.balanceAfterDays,
      decisionComment: input.decisionComment ?? null,
      hrDecision: isHrFinalDecision ? decisionValue : input.request.hrDecision,
      managerDecision: isHrFinalDecision ? input.request.managerDecision : decisionValue,
      paymentStatus: updated.paymentStatus,
      status: updated.status,
      unpaidReason: updated.unpaidReason,
      usedPaidDays: updated.usedPaidDays,
    },
    oldValues: {
      balanceAfterDays: input.request.balanceAfterDays,
      paymentStatus: input.request.paymentStatus,
      status: input.request.status,
      unpaidReason: input.request.unpaidReason,
      usedPaidDays: input.request.usedPaidDays,
    },
    summary: isHrFinalDecision
      ? `Vacation request ${decisionValue} by HR final review.`
      : `Vacation request ${decisionValue} by direct manager and sent to HR final review.`,
  });

  const dispatch = isHrFinalDecision ? dispatchVacationDecision : dispatchVacationManagerReview;
  await dispatch({ decision: input.decision, directory, request: updated }).catch(async (error) => {
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

async function applyLegacyVacationDecision(input: {
  access?: AccessContext;
  actorHrId: string | null;
  actorLoginId?: string | null;
  decision: VacationDecision;
  decisionComment?: string | null;
  request: VacationRequestRecord;
}) {
  if (input.request.status !== "pending_manager" && input.request.status !== "pending_hr") {
    throw new Error("This vacation request already has a final decision.");
  }

  const decisionValue = input.decision === "approve" ? "approved" : "rejected";
  const isHrFinalDecision = input.request.status === "pending_hr";
  const rpcName = isHrFinalDecision ? "phx_leave_hr_decision_atomic" : "phx_leave_manager_decision_atomic";
  const actorRole = input.access?.role ?? (isHrFinalDecision ? "HR Specialist" : "Manager");
  const actorId = input.actorHrId ?? input.actorLoginId ?? "system";
  const balanceDecision = input.request.vacationType === "other" && input.decision === "approve"
    ? input.request.paymentStatus === "paid"
      ? "deduct"
      : "no_deduct"
    : null;
  const payload = isHrFinalDecision
    ? {
        p_actor_hr_id: actorId,
        p_actor_role: actorRole,
        p_balance_decision: balanceDecision,
        p_comment: nullableText(input.decisionComment),
        p_decision: decisionValue,
        p_request_id: input.request.id,
      }
    : {
        p_actor_hr_id: actorId,
        p_actor_role: actorRole,
        p_comment: nullableText(input.decisionComment),
        p_decision: decisionValue,
        p_request_id: input.request.id,
      };

  const { data, error } = await getSupabaseAdmin().rpc(rpcName, payload);

  if (error) throw new Error(typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error));

  const employees = await getEmployeeDirectoryRows();
  const updated = mapLegacyLeaveRequestRow(data as LegacyLeaveRequestDbRow, buildEmployeeMapByHrId(employees));

  await writeRequiredAuditLog({
    actorLoginId: input.actorLoginId ?? input.actorHrId ?? "system",
    entityId: updated.id,
    entityType: "vacation_request",
    newValues: {
      decisionComment: input.decisionComment ?? null,
      hrDecision: isHrFinalDecision ? decisionValue : input.request.hrDecision,
      managerDecision: isHrFinalDecision ? input.request.managerDecision : decisionValue,
      paymentStatus: updated.paymentStatus,
      status: updated.status,
    },
    oldValues: {
      paymentStatus: input.request.paymentStatus,
      status: input.request.status,
    },
    summary: isHrFinalDecision
      ? `Legacy vacation request ${decisionValue} by HR final review.`
      : `Legacy vacation request ${decisionValue} by direct manager.`,
  });

  const directory = await getEmployeeDirectory();
  const dispatch = isHrFinalDecision
    ? dispatchVacationDecision
    : updated.status === "pending_hr"
      ? dispatchVacationManagerReview
      : null;
  if (dispatch) {
    await dispatch({ decision: input.decision, directory, request: updated }).catch(() => undefined);
  }

  return updated;
}

export async function decideVacationRequest(access: AccessContext, input: {
  decision: VacationDecision;
  decisionComment?: string | null;
  requestId: string;
}) {
  await assertPermission(access, "leave", "approve");
  const request = await fetchVacationRequestById(input.requestId);
  if (request) {
    if (!canDecideVacation(access, request)) {
      throw new Error("Forbidden: only the assigned direct manager can complete manager review, and only HR can make the final decision.");
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

  const legacyRequest = await fetchLegacyLeaveRequestById(input.requestId);
  if (!legacyRequest) throw new Error("Vacation request was not found.");
  if (!canDecideVacation(access, legacyRequest)) {
    throw new Error("Forbidden: only the assigned direct manager can complete manager review, and only HR can make the final decision.");
  }

  return applyLegacyVacationDecision({
    access,
    actorHrId: resolveEmployeeIdentityId(access),
    actorLoginId: access.loginId,
    decision: input.decision,
    decisionComment: input.decisionComment,
    request: legacyRequest,
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

export async function getVacationControlData(access: AccessContext): Promise<VacationControlData> {
  await assertPermission(access, "leave", "update");
  const [directory, policiesResult] = await Promise.all([
    getEmployeeDirectory(),
    getSupabaseAdmin().from(vacationWeeklyOffPoliciesTable).select("*").order("job_title"),
  ]);

  if (policiesResult.error) {
    throw new Error(typeof (policiesResult.error as { message?: unknown }).message === "string"
      ? (policiesResult.error as { message: string }).message
      : String(policiesResult.error));
  }

  const titles = Array.from(
    new Set(directory.employees.map((employee) => employeeVacationPolicyTitle(employee)).filter(Boolean)),
  ).sort((left, right) => left.localeCompare(right));
  const policyMap = new Map(
    ((policiesResult.data ?? []) as VacationWeeklyOffPolicyDbRow[])
      .map(mapWeeklyOffPolicy)
      .map((policy) => [policy.jobTitle, policy] as const),
  );

  return {
    policies: titles.map((title) => policyMap.get(title) ?? defaultWeeklyOffPolicy(title)),
    titles,
  };
}

export async function updateVacationWeeklyOffPolicy(access: AccessContext, input: {
  friday: unknown;
  jobTitle: unknown;
  saturday: unknown;
  thursday: unknown;
}) {
  await assertPermission(access, "leave", "update");
  const jobTitle = text(input.jobTitle);
  if (!jobTitle) throw new Error("Job title is required.");

  const payload = {
    friday_off: normalizeWeeklyOffMode(input.friday),
    job_title: jobTitle,
    saturday_off: normalizeWeeklyOffMode(input.saturday),
    thursday_off: normalizeWeeklyOffMode(input.thursday),
    updated_at: new Date().toISOString(),
    updated_by_login_id: access.loginId ?? null,
  };

  const { data, error } = await getSupabaseAdmin()
    .from(vacationWeeklyOffPoliciesTable)
    .upsert(payload, { onConflict: "job_title" })
    .select("*")
    .single();

  if (error) throw new Error(typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error));
  const policy = mapWeeklyOffPolicy(data as VacationWeeklyOffPolicyDbRow);

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? resolveEmployeeIdentityId(access) ?? "system",
    entityId: policy.jobTitle,
    entityType: "vacation_request",
    newValues: { policy, policyEntity: "vacation_weekly_off_policy" },
    oldValues: {},
    summary: `Vacation weekly-off policy updated for ${policy.jobTitle}.`,
  });

  return policy;
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
      filters.status === "approved" || filters.status === "rejected" || filters.status === "pending_manager" || filters.status === "pending_hr"
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
  if (filters.requestId) {
    const requestFilter = filters.requestId.toLowerCase();
    if (row.id.toLowerCase() !== requestFilter && vacationRequestDisplayId(row.id).toLowerCase() !== requestFilter) return false;
  }
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
      vacationRequestDisplayId(row.id),
      row.id,
    ].join(" ").toLowerCase();
    if (!haystack.includes(search)) return false;
  }

  return true;
}

function buildReportOptions(rows: VacationRequestRecord[], employees?: EmployeeDirectoryRow[] | null): VacationReportData["options"] {
  const unique = (values: Array<string | null | undefined>) =>
    Array.from(new Set(values.map((value) => text(value)).filter(Boolean))).sort((a, b) => a.localeCompare(b));

  const employeeOptions = employees
    ? employees
        .filter((employee) => employee.hrId)
        .map((employee) => ({ label: `${employee.fullName} (${employee.hrId})`, value: employee.hrId }))
        .sort((left, right) => left.label.localeCompare(right.label))
    : Array.from(
        new Map(rows.map((row) => [row.employeeHrId, { label: `${row.employeeName} (${row.employeeHrId})`, value: row.employeeHrId }])).values(),
      ).sort((left, right) => left.label.localeCompare(right.label));

  const visibleEmployeeByHrId = employees
    ? new Map(
        employees
          .map((employee) => [canonicalHrId(employee.hrId), employee] as const)
          .filter((entry): entry is [string, EmployeeDirectoryRow] => Boolean(entry[0])),
      )
    : null;
  const managerSource = employees
    ? employees
        .filter((employee) => {
          const managerHrId = canonicalHrId(employee.managerHrId);
          return Boolean(managerHrId && visibleEmployeeByHrId?.has(managerHrId));
        })
        .map((employee) => {
          const managerHrId = canonicalHrId(employee.managerHrId);
          const manager = managerHrId ? visibleEmployeeByHrId?.get(managerHrId) : null;
          return {
            label: `${manager?.fullName ?? employee.managerName ?? employee.managerHrId} (${employee.managerHrId})`,
            value: employee.managerHrId ?? "",
          };
        })
    : rows
        .filter((row) => row.managerHrId)
        .map((row) => ({
          label: `${row.managerName ?? row.managerHrId} (${row.managerHrId})`,
          value: row.managerHrId ?? "",
        }));
  const managers = Array.from(new Map(managerSource.map((manager) => [manager.value, manager])).values())
    .sort((left, right) => left.label.localeCompare(right.label));

  return {
    departments: unique(employees ? employees.map((employee) => employee.departmentName) : rows.map((row) => row.departmentName)),
    employees: employeeOptions,
    lines: unique(employees ? employees.map((employee) => employee.lineName) : rows.map((row) => row.lineName)),
    managers,
  };
}

function buildReportSummary(rows: VacationRequestRecord[]): VacationReportData["summary"] {
  return summarizeVacationRequests(rows);
}

export async function getVacationReportData(access: AccessContext, filters: VacationReportFilters = {}): Promise<VacationReportData> {
  await assertPermission(access, "leave", "read");
  const clean = cleanFilters(filters);
  const canAdminManage = isAllVacationVisibility(access) && await canManageVacationRecords(access);
  const activeEmployees = await getEmployeeDirectoryRows();
  const employeesByHrId = buildEmployeeMapByHrId(activeEmployees);
  const visibleEmployees = filterVacationEmployeesForAccess(access, activeEmployees);
  const visibleEmployeeHrIds = new Set(visibleEmployees.map((employee) => canonicalHrId(employee.hrId)).filter((value): value is string => Boolean(value)));
  const { data, error } = await getSupabaseAdmin()
    .from(vacationRequestsTable)
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error) throw new Error(typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error));

  const v2Rows = (data ?? []).map((row) => mapVacationRow(row as VacationRequestDbRow));
  const v2Ids = new Set(v2Rows.map((row) => row.id));
  const legacyRows = (await fetchLegacyLeaveRequestRows(employeesByHrId))
    .filter((row) => !v2Ids.has(row.id));
  const reportRows = [...v2Rows, ...legacyRows]
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));

  const visibleRows = reportRows
    .filter((row) => canSeeVacation(access, row, visibleEmployeeHrIds))
    .map((row) => ({ ...row, canDecide: canDecideVacation(access, row) }));
  const filteredRows = visibleRows.filter((row) => rowMatchesFilters(row, clean));
  const employeeEligibility = buildEmployeeEligibilityRows({
    employees: visibleEmployees,
    filters: clean,
    rows: visibleRows,
    today: toDateOnlyString(new Date()) ?? "",
  });

  return {
    canAdminManage,
    employeeEligibility,
    employeeEligibilitySummary: buildEmployeeEligibilitySummary(employeeEligibility),
    filters: clean,
    options: buildReportOptions(visibleRows, visibleEmployees),
    rows: filteredRows,
    summary: buildReportSummary(filteredRows),
  };
}
