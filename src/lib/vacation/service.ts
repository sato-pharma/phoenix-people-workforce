import { createHash, randomUUID } from "node:crypto";

import ExcelJS from "exceljs";

import {
  assertPermission,
  canAccess,
  isHrAuthorityRole,
  normalizeHrIdForAccess,
  normalizeLineName,
  resolveEmployeeIdentityId,
  systemAccessContext,
  type AccessContext,
} from "@/lib/auth/permissions";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { invalidateExecutiveDashboardCache } from "@/lib/dashboard/invalidation";
import {
  getEmployeeDirectory,
  getEmployeeDirectoryRows,
  type EmployeeDirectoryData,
  type EmployeeDirectoryRow,
} from "@/lib/employees/employee-directory";
import { createSystemNotification, type SystemNotificationChannel } from "@/lib/notifications/system";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  isWithinManagerHierarchy,
  reportsToManagerSeat,
  sameWorkforceDepartment,
} from "@/lib/workforce/hierarchy-resolver";
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
  assertLeaveWorkflowTransition,
  vacationDecisionAction,
} from "@/lib/vacation/workflow";
import {
  evaluateStepAction,
  genericStepName,
  isSequentialWorkflowType,
  resolveActionAvailability,
  resolveActiveStep,
  resolveStageLabel,
  stepOrderForStepKey,
} from "@/lib/vacation/approval-flow";
import {
  sendVacationDecisionResultEmail,
  sendVacationManagerDecisionEmail,
  sendVacationManagerStepResultEmail,
  sendVacationResubmitConfirmationEmail,
  sendVacationReturnedEmail,
  sendVacationSubmissionConfirmationEmail,
} from "@/lib/vacation/email";
import { pickDeliverableEmail } from "@/lib/email/email-safety";
import type {
  VacationActionAvailability,
  VacationActionCenterData,
  VacationActionCenterRow,
  VacationApprovalStepState,
  VacationBalanceSnapshot,
  VacationControlData,
  VacationDayPart,
  VacationDecision,
  VacationWorkflowStepKey,
  VacationAuditExportMetadata,
  VacationDashboardData,
  VacationEvidenceReview,
  VacationEvidenceReviewStatus,
  VacationEvidenceType,
  VacationEmployeeSummary,
  VacationEligibilityStatus,
  VacationEmployeeEligibilityRow,
  VacationOverlapWarning,
  VacationReportData,
  VacationReportFilters,
  VacationRequestInput,
  VacationRequestRecord,
  VacationRequestStatus,
  VacationSlaStatus,
  VacationTimelineEvent,
  VacationType,
  VacationWeeklyOffPolicySnapshot,
  VacationWeeklyOffMode,
  VacationWeeklyOffPolicyRecord,
} from "@/lib/vacation/types";
import { VACATION_DAY_PARTS, VACATION_REQUEST_TYPES, VACATION_TYPES, VACATION_WEEKLY_OFF_MODES } from "@/lib/vacation/types";

const vacationRequestsTable = "v2_vacation_requests";
const vacationEventsTable = "v2_vacation_request_events";
const vacationEvidenceReviewsTable = "v2_vacation_evidence_reviews";
const vacationApprovalStepsTable = "v2_vacation_approval_steps";
const vacationSlaRunsTable = "v2_vacation_sla_runs";
const vacationSlaSettingsTable = "v2_vacation_sla_settings";
const vacationTokensTable = "v2_vacation_email_tokens";
const vacationWeeklyOffPoliciesTable = "v2_vacation_weekly_off_policies";
const vacationRetentionPoliciesTable = "v2_vacation_retention_policies";
const vacationRetentionPurgeRunsTable = "v2_vacation_retention_purge_runs";
export const vacationAttachmentBucket = "leave-attachments";
const vacationAuditExportMaxRows = 5000;
const sickAttachmentMaxUploadBytes = 20 * 1024 * 1024;
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
  employee_note?: string | null;
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
  weekly_off_policy_snapshot?: unknown;
};

type VacationEmailTokenDbRow = {
  expires_at: string | null;
  id: string;
  manager_hr_id: string | null;
  request_id: string | null;
  used_at: string | null;
};

type VacationApprovalStepKey = "direct_manager" | "manager_of_manager" | "hr";
type VacationApprovalStepStatus = "pending" | "approved" | "rejected";

type VacationApprovalStepRow = {
  approver_hr_id: string | null;
  approver_user_id: string | null;
  decided_at: string | null;
  decision_comment: string | null;
  id: string;
  request_id: string | null;
  status: string | null;
  step_key: string | null;
  step_order?: number | string | null;
};

type VacationEventDbRow = {
  actor_hr_id: string | null;
  actor_login_id: string | null;
  created_at: string | null;
  event_type: string | null;
  id: number | string;
  message: string | null;
  metadata: unknown;
  request_id: string | null;
};

type VacationEvidenceReviewDbRow = {
  created_at: string | null;
  evidence_type: string | null;
  id: string;
  request_id: string | null;
  review_note: string | null;
  reviewed_at: string | null;
  reviewed_by_hr_id: string | null;
  status: string | null;
  updated_at: string | null;
};

type VacationSlaRunDbRow = {
  finished_at: string | null;
  hr_escalations?: number | string | null;
  hr_reminders?: number | string | null;
  id: string;
  manager_escalations?: number | string | null;
  manager_reminders?: number | string | null;
  run_date: string | null;
  started_at: string | null;
  status: string | null;
};

type VacationSlaSettingsDbRow = {
  hr_pending_business_days?: number | string | null;
  manager_pending_business_days?: number | string | null;
  reminder_interval_days?: number | string | null;
};

type HrRecipient = {
  email: string | null;
  hrId: string;
  name: string;
};

type VacationApprovalRecipient = {
  email: string | null;
  hrId: string;
  name: string;
  stepKey: VacationApprovalStepKey;
  userId: string | null;
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
  employeeNote?: unknown;
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

function integerValue(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
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
  return access.scope === "system" || access.role === "Super Admin";
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
    case "Product Manager":
    case "Group Product Manager":
    case "Marketing Manager":
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
    message.includes(vacationEvidenceReviewsTable) ||
    message.includes(vacationApprovalStepsTable) ||
    message.includes(vacationSlaRunsTable) ||
    message.includes(vacationSlaSettingsTable) ||
    message.includes(vacationTokensTable) ||
    message.includes(vacationWeeklyOffPoliciesTable) ||
    message.includes(vacationRetentionPoliciesTable) ||
    message.includes(vacationRetentionPurgeRunsTable) ||
    message.includes("could not find the table") ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist"))
  );
}

export function isVacationSchemaMissing(error: unknown) {
  return isVacationSchemaMissingError(error);
}

export function vacationErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const candidate = error as {
      code?: unknown;
      details?: unknown;
      hint?: unknown;
      message?: unknown;
    };
    const message = typeof candidate.message === "string" ? candidate.message.trim() : "";
    if (message) return message;
    const parts = [candidate.code, candidate.details, candidate.hint]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim());
    if (parts.length > 0) return parts.join(" ");
    return "Unexpected vacation service error.";
  }
  return String(error);
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
  const target = normalizeHrIdForAccess(hrId);
  if (!target) return false;
  return accessIdentityCandidates(access).some((candidate) => candidate === target);
}

function employeeLineMatches(left: EmployeeDirectoryRow, right: EmployeeDirectoryRow) {
  if (left.lineId !== null && right.lineId !== null) return left.lineId === right.lineId;
  const leftLine = normalizeLineName(left.lineName);
  const rightLine = normalizeLineName(right.lineName);
  return Boolean(leftLine && rightLine && leftLine === rightLine);
}

// Build the HR-ID visibility set with BOTH the canonical lowercase form (used by
// in-memory has() checks via canonicalHrId) AND the stored uppercase form (used by
// Postgres = ANY() comparisons in the RPC and .in() Supabase filters).
// Without both forms the RPC filter drops every request whose employee_hr_id is
// stored as e.g. "A-7" in the DB but the set only contains lowercase "a-7".
function buildVisibleHrIdSet(employees: EmployeeDirectoryRow[]): Set<string> {
  const ids: string[] = [];
  for (const employee of employees) {
    const canonical = canonicalHrId(employee.hrId);
    if (canonical) ids.push(canonical);
    const stored = (employee.hrId ?? "").trim().toUpperCase();
    if (stored && stored !== canonical) ids.push(stored);
  }
  return new Set(ids);
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

  // Pre-compute the viewer's full upward manager chain so we can exclude them
  // in LINE scope. Without this, a TM/PM/GPM/NSM would see their own manager's
  // leave data because the manager shares the same product line + department.
  const viewerManagerIds = new Set<string>();
  if (scope === "LINE") {
    let mgr: EmployeeDirectoryRow | undefined = currentEmployee;
    for (let depth = 0; depth < 12 && mgr?.managerHrId; depth++) {
      const mgrId = canonicalHrId(mgr.managerHrId);
      if (!mgrId || viewerManagerIds.has(mgrId)) break;
      viewerManagerIds.add(mgrId);
      mgr = employeeByHrId.get(mgrId);
    }
  }

  return employees.filter((employee) => {
    const employeeHrId = canonicalHrId(employee.hrId);
    if (employeeHrId === viewerHrId) return true;

    if (scope === "TEAM") {
      // Seat-continuity-aware: a report belongs to this manager's team via the
      // current manager edge OR the vacant-seat continuity marker, so the team
      // stays consistent with the organogram across a manager resignation.
      return reportsToManagerSeat({
        employee,
        viewerCanonicalHrId: viewerHrId,
        canonicalize: canonicalHrId,
      });
    }

    if (scope === "HIERARCHY") {
      // Seat-continuity-aware management-chain climb (see hierarchy-resolver.ts).
      return isWithinManagerHierarchy({
        employee,
        byCanonicalHrId: employeeByHrId,
        viewerCanonicalHrId: viewerHrId,
        canonicalize: canonicalHrId,
      });
    }

    if (scope === "LINE") {
      // Department-safe LINE scope: a LINE-scoped viewer (e.g. National Sales
      // Manager, Product Manager) sees colleagues in the SAME line AND the SAME
      // department only. This stops a Sales NSM from seeing Marketing employees
      // who merely share the same product line, and symmetrically keeps Marketing
      // roles within their own department. See
      // src/lib/workforce/hierarchy-resolver.ts.
      // Upward hierarchy (managers of the viewer) are excluded — employees must
      // never see their manager's leave data regardless of line/department match.
      if (employeeHrId && viewerManagerIds.has(employeeHrId)) return false;
      // Head-office department heads (e.g. a Marketing Manager) sit on the Head
      // Office line while the PM/GPM they supervise sit on the 3 BUSINESS lines —
      // so a LINE-scoped manager's own DIRECT REPORTS are, by design, on a
      // different line. Always include the viewer's direct reports (one level,
      // via the live manager_hr_id edge or the vacant-seat continuity marker)
      // regardless of line, so their leave stays visible and approvable. This uses
      // the authoritative directory edge — NOT the request's stored manager field —
      // so it does not re-open the stale-field cross-department leak guarded against
      // in canSeeVacation(), and it only ever adds the viewer's OWN reports
      // (downward), never broadens to entire business lines.
      if (
        reportsToManagerSeat({
          employee,
          viewerCanonicalHrId: viewerHrId,
          canonicalize: canonicalHrId,
        })
      ) {
        return true;
      }
      return (
        employeeLineMatches(employee, currentEmployee) &&
        sameWorkforceDepartment(currentEmployee, employee)
      );
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

function normalizeEvidenceType(value: unknown): VacationEvidenceType | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "sick" || normalized === "compensatory" ? normalized : null;
}

function normalizeEvidenceReviewStatus(value: unknown): VacationEvidenceReviewStatus | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (
    normalized === "accepted" ||
    normalized === "needs_follow_up" ||
    normalized === "pending" ||
    normalized === "rejected"
  ) {
    return normalized;
  }
  return null;
}

function mapWeeklyOffPolicySnapshot(value: unknown): VacationWeeklyOffPolicySnapshot | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const friday = normalizeWeeklyOffMode(record.friday);
  const saturday = normalizeWeeklyOffMode(record.saturday);
  const thursday = normalizeWeeklyOffMode(record.thursday);
  const capturedAt = text(record.capturedAt);
  const jobTitle = text(record.jobTitle);

  if (!capturedAt || !jobTitle) return null;
  return {
    capturedAt,
    friday,
    jobTitle,
    policyId: nullableText(record.policyId),
    saturday,
    thursday,
    updatedAt: nullableText(record.updatedAt),
  };
}

function buildWeeklyOffPolicySnapshot(policy: VacationWeeklyOffPolicyRecord): VacationWeeklyOffPolicySnapshot {
  return {
    capturedAt: new Date().toISOString(),
    friday: policy.friday,
    jobTitle: policy.jobTitle,
    policyId: policy.id,
    saturday: policy.saturday,
    thursday: policy.thursday,
    updatedAt: policy.updatedAt,
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

  if (error) throwVacationDatabaseError(error);
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

  // Annual vacation may start today; the retroactive guard above still blocks past dates. A
  // single-day same-day annual request is reclassified to "emergency" upstream by
  // resolveSubmittedVacationType, while a multi-day annual starting today stays "annual".
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

function defaultVacationSlaSettings() {
  return {
    hrPendingBusinessDays: 2,
    managerPendingBusinessDays: 1,
    reminderIntervalDays: 1,
  };
}

function mapSlaSettings(row: VacationSlaSettingsDbRow | null | undefined) {
  return {
    hrPendingBusinessDays: integerValue(row?.hr_pending_business_days, 2),
    managerPendingBusinessDays: integerValue(row?.manager_pending_business_days, 1),
    reminderIntervalDays: integerValue(row?.reminder_interval_days, 1),
  };
}

function addBusinessDays(date: Date, days: number) {
  const result = new Date(date);
  let added = 0;
  while (added < days) {
    result.setUTCDate(result.getUTCDate() + 1);
    const day = result.getUTCDay();
    if (day !== 5 && day !== 6) added += 1;
  }
  return result;
}

function businessDaysBetween(start: Date, end: Date) {
  if (end <= start) return 0;
  const cursor = new Date(start);
  let days = 0;
  while (cursor < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const day = cursor.getUTCDay();
    if (day !== 5 && day !== 6 && cursor <= end) days += 1;
  }
  return days;
}

function buildVacationSlaStatus(input: {
  events?: VacationTimelineEvent[];
  now: Date;
  request: Pick<VacationRequestDbRow, "created_at" | "manager_decision_at" | "status">;
  settings: ReturnType<typeof defaultVacationSlaSettings>;
}): VacationSlaStatus {
  const status = input.request.status;
  if (status === "approved" || status === "rejected") {
    return {
      businessDaysPending: 0,
      dueAt: null,
      isOverdue: false,
      lastEscalatedAt: null,
      lastRemindedAt: null,
      stage: status,
    };
  }

  const isHrStage = status === "pending_hr";
  const stageStart = new Date((isHrStage ? input.request.manager_decision_at : input.request.created_at) ?? input.request.created_at ?? Date.now());
  const daysAllowed = isHrStage ? input.settings.hrPendingBusinessDays : input.settings.managerPendingBusinessDays;
  const dueAt = addBusinessDays(stageStart, daysAllowed);
  const events = input.events ?? [];
  const lastReminder = events
    .filter((event) => event.eventType === "sla_reminder")
    .map((event) => event.createdAt)
    .sort()
    .at(-1) ?? null;
  const lastEscalation = events
    .filter((event) => event.eventType === "sla_escalation")
    .map((event) => event.createdAt)
    .sort()
    .at(-1) ?? null;

  return {
    businessDaysPending: businessDaysBetween(stageStart, input.now),
    dueAt: dueAt.toISOString(),
    isOverdue: input.now.getTime() > dueAt.getTime(),
    lastEscalatedAt: lastEscalation,
    lastRemindedAt: lastReminder,
    stage: isHrStage ? "hr" : "manager",
  };
}

function dateRangesOverlap(leftStart: string, leftEnd: string, rightStart: string, rightEnd: string) {
  return leftStart <= rightEnd && rightStart <= leftEnd;
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
    employeeNote: row.employee_note ?? null,
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
      row.status === "approved" ||
      row.status === "rejected" ||
      row.status === "pending_manager" ||
      row.status === "pending_hr" ||
      row.status === "needs_assignment"
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
    evidenceReviews: [],
    overlapWarnings: [],
    slaStatus: buildVacationSlaStatus({ request: row, now: new Date(), settings: defaultVacationSlaSettings() }),
    timelineEventCount: 0,
    weeklyOffPolicySnapshot: mapWeeklyOffPolicySnapshot(row.weekly_off_policy_snapshot),
  };
}

function normalizeAdminVacationStatus(value: unknown): VacationRequestStatus {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "pending_manager" || normalized === "pending_hr" || normalized === "approved" || normalized === "rejected") {
    return normalized;
  }
  return "pending_manager";
}

function adminDecisionPayload(input: {
  actorHrId: string | null;
  actorLoginId?: string | null;
  status: VacationRequestStatus;
}) {
  const now = new Date().toISOString();
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
      manager_decision_by_hr_id: input.actorHrId,
      manager_decision_comment: "Manual admin record update.",
    };
  }

  return {
    ...reset,
    hr_decision: input.status,
    hr_decision_at: now,
    hr_decision_by_hr_id: input.actorHrId,
    hr_decision_comment: "Manual admin record update.",
    manager_decision: "approved",
    manager_decision_at: now,
    manager_decision_by_hr_id: input.actorHrId,
    manager_decision_comment: "Manual admin record update.",
  };
}

function canSeeVacation(access: AccessContext, request: VacationRequestRecord, visibleEmployeeHrIds?: Set<string>) {
  if (isAllVacationVisibility(access)) return true;
  const employeeHrId = canonicalHrId(request.employeeHrId);
  if (employeeHrId && visibleEmployeeHrIds?.has(employeeHrId)) return true;

  // Own request is always visible.
  if (accessMatchesHrId(access, request.employeeHrId)) return true;

  // Management-chain fallback (stored manager / manager-of-manager on the request)
  // is allowed ONLY for management scopes (TEAM / HIERARCHY). LINE and SELF scopes
  // must rely solely on the department-safe `visibleEmployeeHrIds` set above, so a
  // LINE-scoped viewer (e.g. a Sales NSM) cannot use a stale stored manager field
  // to reach a request outside their department boundary.
  const scope = getVacationVisibilityScope(access);
  if (scope === "TEAM" || scope === "HIERARCHY") {
    return (
      accessMatchesHrId(access, request.managerHrId) ||
      accessMatchesHrId(access, request.managerOfManagerHrId)
    );
  }

  return false;
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
  if (error) throwVacationDatabaseError(error);
}

function mapEvidenceReview(row: VacationEvidenceReviewDbRow): VacationEvidenceReview {
  return {
    createdAt: row.created_at ?? "",
    evidenceType: normalizeEvidenceType(row.evidence_type) ?? "sick",
    id: row.id,
    requestId: text(row.request_id),
    reviewNote: row.review_note ?? null,
    reviewedAt: row.reviewed_at ?? null,
    reviewedByHrId: row.reviewed_by_hr_id ?? null,
    status: normalizeEvidenceReviewStatus(row.status) ?? "pending",
    updatedAt: row.updated_at ?? "",
  };
}

async function fetchEvidenceReviewsForRequests(requestIds: string[]) {
  const uniqueIds = Array.from(new Set(requestIds.filter(Boolean)));
  const byRequestId = new Map<string, VacationEvidenceReview[]>();
  if (uniqueIds.length === 0) return byRequestId;

  try {
    const { data, error } = await getSupabaseAdmin()
      .from(vacationEvidenceReviewsTable)
      .select("*")
      .in("request_id", uniqueIds);

    if (error) throwVacationDatabaseError(error);

    for (const row of (data ?? []) as VacationEvidenceReviewDbRow[]) {
      const review = mapEvidenceReview(row);
      const current = byRequestId.get(review.requestId) ?? [];
      current.push(review);
      byRequestId.set(review.requestId, current);
    }
  } catch (error) {
    if (!isVacationSchemaMissingError(error)) throw error;
  }

  return byRequestId;
}

async function upsertRequiredEvidenceReview(input: {
  actorHrId?: string | null;
  actorLoginId?: string | null;
  evidenceType: VacationEvidenceType;
  hasAttachment: boolean;
  requestId: string;
}) {
  if (!input.hasAttachment) return;
  try {
    const { error } = await getSupabaseAdmin()
      .from(vacationEvidenceReviewsTable)
      .upsert({
        evidence_type: input.evidenceType,
        request_id: input.requestId,
        status: "pending",
        updated_at: new Date().toISOString(),
      }, { onConflict: "request_id,evidence_type" });
    if (error) throwVacationDatabaseError(error);

    await insertVacationEvent({
      actorHrId: input.actorHrId,
      actorLoginId: input.actorLoginId,
      eventType: "evidence_uploaded",
      message: `${input.evidenceType === "sick" ? "Sick medical document" : "Compensatory day evidence"} uploaded for HR review.`,
      metadata: { evidenceType: input.evidenceType },
      requestId: input.requestId,
    });
  } catch (error) {
    if (!isVacationSchemaMissingError(error)) throw error;
  }
}

function hasAcceptedRequiredEvidence(request: VacationRequestRecord) {
  const requiredType = request.vacationType === "sick" || request.vacationType === "compensatory"
    ? request.vacationType
    : null;
  if (!requiredType) return true;
  return request.evidenceReviews.some((review) => review.evidenceType === requiredType && review.status === "accepted");
}

function acceptedRequiredEvidenceReviewerHrIds(request: VacationRequestRecord) {
  const requiredType = request.vacationType === "sick" || request.vacationType === "compensatory"
    ? request.vacationType
    : null;
  if (!requiredType) return [];
  return request.evidenceReviews
    .filter((review) => review.evidenceType === requiredType && review.status === "accepted")
    .map((review) => canonicalHrId(review.reviewedByHrId))
    .filter((value): value is string => Boolean(value));
}

// Per explicit owner confirmation (2026-07-04): B-10 (Omar Anwar Gawish) and PHX-1/admin-HR
// (the shared system-administrator login) are operated by the same physical person. Requiring
// a login switch between two accounts controlled by one human is not a real second reviewer, so
// separation-of-duties must treat them as a single identity. Revisit if a second real HR/Super
// Admin hire is ever added.
const SHARED_HR_IDENTITY_GROUPS: string[][] = [["B-10", "PHX-1"]];

function hrIdentityGroup(hrId: string | null): Set<string> {
  const canonical = canonicalHrId(hrId);
  if (!canonical) return new Set();
  const group = SHARED_HR_IDENTITY_GROUPS.find((candidates) =>
    candidates.some((id) => canonicalHrId(id) === canonical));
  return new Set((group ?? [hrId ?? ""]).map((id) => canonicalHrId(id)).filter((id): id is string => Boolean(id)));
}

// The evidence-review/acknowledgement separation-of-duties guard requires a second HR/Super
// Admin account to exist at all. Small orgs can have exactly one such account, which would make
// sick/compensatory leave permanently unapprovable. Owner-approved exception (2026-07-04): only
// enforce the guard when a real alternate account is available; fail closed (keep enforcing) if
// the lookup errors, since that's safer than silently allowing self-acknowledgement.
async function hasAlternateHrApprover(excludeHrId: string | null) {
  const excludedGroup = hrIdentityGroup(excludeHrId);
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("app_auth_users")
      .select("hr_id")
      .eq("role", "Super Admin")
      .eq("is_active", true);
    if (error) throw error;
    return (data ?? []).some((row) => {
      const hrId = canonicalHrId(text((row as Record<string, unknown>).hr_id));
      return hrId ? !excludedGroup.has(hrId) : false;
    });
  } catch (error) {
    console.error("[vacation] alternate HR approver lookup failed; enforcing separation of duties", error);
    return true;
  }
}

function mapVacationEvent(row: VacationEventDbRow): VacationTimelineEvent {
  const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? row.metadata as Record<string, unknown>
    : {};
  return {
    actorHrId: row.actor_hr_id ?? null,
    actorLoginId: row.actor_login_id ?? null,
    createdAt: row.created_at ?? "",
    eventType: text(row.event_type),
    id: `event:${row.id}`,
    message: text(row.message),
    metadata,
    source: "event",
  };
}

async function fetchVacationEventsForRequests(requestIds: string[]) {
  const uniqueIds = Array.from(new Set(requestIds.filter(Boolean)));
  const byRequestId = new Map<string, VacationTimelineEvent[]>();
  if (uniqueIds.length === 0) return byRequestId;

  const { data, error } = await getSupabaseAdmin()
    .from(vacationEventsTable)
    .select("*")
    .in("request_id", uniqueIds)
    .order("created_at", { ascending: true });
  if (error) throwVacationDatabaseError(error);

  for (const row of (data ?? []) as VacationEventDbRow[]) {
    const requestId = text(row.request_id);
    const current = byRequestId.get(requestId) ?? [];
    current.push(mapVacationEvent(row));
    byRequestId.set(requestId, current);
  }
  return byRequestId;
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function getHrRecipients(directory: EmployeeDirectoryData): Promise<HrRecipient[]> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("app_auth_users")
      .select("login_id,hr_id,role,is_active")
      .eq("is_active", true)
      .in("role", ["Super Admin"]);

    if (error) {
      // Fail observable, not silent: returning [] here means HR/Super Admin are
      // notified about nobody. Keep returning [] so a notification-lookup failure
      // never blocks the employee's vacation action, but log it so the dropped
      // notification is diagnosable.
      console.error("[vacation] HR recipient lookup failed; HR notifications skipped", error);
      return [];
    }

    return (data ?? [])
      .map((row) => {
        const hrId = text((row as Record<string, unknown>).hr_id);
        const role = text((row as Record<string, unknown>).role);
        if (!hrId) return null;
        if (role !== "Super Admin") return null;
        const employee = findEmployeeByHrId(directory, hrId);
        return {
          email: employee?.workEmail ?? null,
          hrId,
          name: employee?.fullName ?? hrId,
        };
      })
      .filter((entry): entry is HrRecipient => Boolean(entry));
  } catch (error) {
    console.error("[vacation] HR recipient lookup threw; HR notifications skipped", error);
    return [];
  }
}


function approvalStatus(value: unknown): VacationApprovalStepStatus {
  return value === "approved" || value === "rejected" ? value : "pending";
}

function approvalStepKey(value: unknown): VacationApprovalStepKey {
  return value === "manager_of_manager" || value === "hr" ? value : "direct_manager";
}

function mapVacationApprovalStep(row: VacationApprovalStepRow) {
  const stepKey = approvalStepKey(row.step_key);
  const parsedOrder = Number(row.step_order);
  return {
    approverHrId: text(row.approver_hr_id),
    approverUserId: text(row.approver_user_id) || null,
    decidedAt: row.decided_at,
    decisionComment: row.decision_comment,
    id: row.id,
    requestId: text(row.request_id),
    status: approvalStatus(row.status),
    stepKey,
    stepOrder: Number.isFinite(parsedOrder) && parsedOrder > 0 ? parsedOrder : stepOrderForStepKey(stepKey),
  };
}

async function resolveVacationPilotHrApprovers(directory: EmployeeDirectoryData): Promise<VacationApprovalRecipient[]> {
  // HR-step authority is Super Admin only — this org runs HR acknowledgement through the
  // System Administrator account(s), not a separate "HR Manager" role login. Owner decision
  // 2026-07-04.
  const { data, error } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select("login_id,hr_id,name,auth_email,is_active")
    .eq("role", "Super Admin")
    .eq("is_active", true);

  if (error) throwVacationDatabaseError(error);

  const rows: VacationApprovalRecipient[] = ((data ?? []) as Array<Record<string, unknown>>)
    .flatMap((row) => {
      const hrId = text(row.hr_id);
      const loginId = text(row.login_id);
      if (!hrId) return [];
      const employee = findEmployeeByHrId(directory, hrId);
      return [{
        // Prefer the HR approver's real work mailbox over the synthetic auth_email login key
        // (phx-<hex>@auth.phoenix.local), which is non-deliverable and gets dropped before send.
        email: pickDeliverableEmail(employee?.workEmail, text(row.auth_email)),
        hrId,
        name: text(row.name) || employee?.fullName || hrId,
        stepKey: "hr" as const,
        userId: loginId || null,
      }];
    });

  if (rows.length === 0) {
    throw new Error("Vacation HR approval step is not configured. No active Super Admin account was found.");
  }

  const unique = new Map<string, VacationApprovalRecipient>();
  for (const row of rows) {
    unique.set(`${canonicalHrId(row.hrId) ?? row.hrId}:${row.userId ?? ""}`, row);
  }
  return Array.from(unique.values());
}

async function resolveVacationParallelApprovalRecipients(
  directory: EmployeeDirectoryData,
  employee: EmployeeDirectoryRow,
): Promise<VacationApprovalRecipient[]> {
  const { manager, managerOfManager } = managerChain(directory, employee);
  // The direct manager is required. The manager-of-manager step is included only
  // when one exists — employees who report directly to the top of the org (e.g. the
  // CEO, who has no manager above) still get a valid chain of direct manager + HR.
  if (!manager?.hrId) {
    throw new Error("Vacation approval chain is incomplete. Please contact HR before submitting a vacation request.");
  }

  const hrApprovers = await resolveVacationPilotHrApprovers(directory);
  return [
    {
      email: manager.workEmail,
      hrId: manager.hrId,
      name: manager.fullName,
      stepKey: "direct_manager",
      userId: null,
    },
    ...(managerOfManager?.hrId
      ? [
          {
            email: managerOfManager.workEmail,
            hrId: managerOfManager.hrId,
            name: managerOfManager.fullName,
            stepKey: "manager_of_manager" as const,
            userId: null,
          },
        ]
      : []),
    ...hrApprovers,
  ];
}

async function createVacationApprovalSteps(input: {
  approvers: VacationApprovalRecipient[];
  requestId: string;
}) {
  const now = new Date().toISOString();
  const { error } = await getSupabaseAdmin()
    .from(vacationApprovalStepsTable)
    .insert(input.approvers.map((approver) => ({
      approver_hr_id: approver.hrId,
      approver_user_id: approver.userId,
      created_at: now,
      request_id: input.requestId,
      status: "pending",
      step_key: approver.stepKey,
      step_order: stepOrderForStepKey(approver.stepKey),
      updated_at: now,
    })));
  if (error) throwVacationDatabaseError(error);
}

async function fetchVacationApprovalStepsForRequest(requestId: string) {
  const { data, error } = await getSupabaseAdmin()
    .from(vacationApprovalStepsTable)
    .select("id,request_id,step_key,step_order,approver_hr_id,approver_user_id,status,decision_comment,decided_at")
    .eq("request_id", requestId);
  if (error) throwVacationDatabaseError(error);
  return ((data ?? []) as VacationApprovalStepRow[]).map(mapVacationApprovalStep);
}

async function fetchVacationApprovalStepsForRequests(requestIds: string[]) {
  if (requestIds.length === 0) return new Map<string, Awaited<ReturnType<typeof fetchVacationApprovalStepsForRequest>>>();
  const { data, error } = await getSupabaseAdmin()
    .from(vacationApprovalStepsTable)
    .select("id,request_id,step_key,step_order,approver_hr_id,approver_user_id,status,decision_comment,decided_at")
    .in("request_id", requestIds);
  if (error) {
    if (isVacationSchemaMissingError(error)) return new Map<string, Awaited<ReturnType<typeof fetchVacationApprovalStepsForRequest>>>();
    throwVacationDatabaseError(error);
  }
  const byRequestId = new Map<string, Awaited<ReturnType<typeof fetchVacationApprovalStepsForRequest>>>();
  for (const row of ((data ?? []) as VacationApprovalStepRow[]).map(mapVacationApprovalStep)) {
    const current = byRequestId.get(row.requestId) ?? [];
    current.push(row);
    byRequestId.set(row.requestId, current);
  }
  return byRequestId;
}

function approvalStepMatchesAccess(access: AccessContext, step: Awaited<ReturnType<typeof fetchVacationApprovalStepsForRequest>>[number]) {
  const candidates = accessIdentityCandidates(access);
  // Use normalizeHrIdForAccess (strips hyphens) on BOTH sides so the comparison is
  // consistent — accessIdentityCandidates already normalises via that function, so
  // comparing against canonicalHrId (which keeps hyphens) caused a permanent mismatch
  // for any HR-ID containing a dash (e.g. "A-9" → candidates "a9" ≠ approverHrId "a-9").
  const approverHrId = normalizeHrIdForAccess(step.approverHrId);
  const approverUserId = text(step.approverUserId).toLowerCase();
  return (Boolean(approverHrId) && candidates.some((candidate) => candidate === approverHrId)) ||
    Boolean(approverUserId && text(access.loginId).toLowerCase() === approverUserId);
}

function approvalStepMatchesActor(input: {
  actorHrId?: string | null;
  actorLoginId?: string | null;
  step: Awaited<ReturnType<typeof fetchVacationApprovalStepsForRequest>>[number];
}) {
  const actorHrId = canonicalHrId(input.actorHrId);
  const actorLoginId = text(input.actorLoginId).toLowerCase();
  const approverHrId = canonicalHrId(input.step.approverHrId);
  const approverUserId = text(input.step.approverUserId).toLowerCase();
  return Boolean(actorHrId && actorHrId === approverHrId) ||
    Boolean(actorLoginId && actorLoginId === approverUserId);
}

async function getPendingVacationApprovalStepForAccess(access: AccessContext, request: VacationRequestRecord) {
  const steps = await fetchVacationApprovalStepsForRequest(request.id);
  return steps.find((step) => step.status === "pending" && approvalStepMatchesAccess(access, step)) ?? null;
}

async function getPendingVacationApprovalStepForActor(input: {
  access?: AccessContext;
  actorHrId?: string | null;
  actorLoginId?: string | null;
  request: VacationRequestRecord;
}) {
  const steps = await fetchVacationApprovalStepsForRequest(input.request.id);
  const pendingSteps = steps.filter((step) => step.status === "pending");
  const step = input.access
    ? pendingSteps.find((candidate) => approvalStepMatchesAccess(input.access as AccessContext, candidate))
    : pendingSteps.find((candidate) => approvalStepMatchesActor({
      actorHrId: input.actorHrId,
      actorLoginId: input.actorLoginId,
      step: candidate,
    }));
  return { step: step ?? null, steps };
}

async function recordVacationApprovalStepDecision(input: {
  decision: VacationDecision;
  decisionComment?: string | null;
  stepId: string;
}) {
  const now = new Date().toISOString();
  const status = input.decision === "approve" ? "approved" : "rejected";
  const { data, error } = await getSupabaseAdmin()
    .from(vacationApprovalStepsTable)
    .update({
      decided_at: now,
      decision_comment: nullableText(input.decisionComment),
      status,
      updated_at: now,
    })
    .eq("id", input.stepId)
    .eq("status", "pending")
    .select("id,request_id,step_key,step_order,approver_hr_id,approver_user_id,status,decision_comment,decided_at")
    .maybeSingle();
  if (error) throwVacationDatabaseError(error);
  if (!data) throw new Error("This vacation approval step was already decided.");
  return mapVacationApprovalStep(data as VacationApprovalStepRow);
}

// The "hr" step fans out to every active Super Admin account (so each is notified/can act via
// their own magic-link email), which previously meant a request could be left waiting on a
// second HR/Super Admin to also decide, or a decided request left a phantom "pending" item in
// the other account's queue forever. HR is one conceptual authority: the first Super Admin to
// decide closes the step for everyone else on this request.
async function closeSiblingPendingHrApprovalSteps(input: {
  actorHrId?: string | null;
  decidedStepId: string;
  decisionValue: "approved" | "rejected";
  requestId: string;
}) {
  const now = new Date().toISOString();
  const { error } = await getSupabaseAdmin()
    .from(vacationApprovalStepsTable)
    .update({
      decided_at: now,
      decision_comment: `Auto-completed: HR step already decided by ${input.actorHrId ?? "another HR/Super Admin account"}.`,
      status: input.decisionValue,
      updated_at: now,
    })
    .eq("request_id", input.requestId)
    .eq("step_key", "hr")
    .eq("status", "pending")
    .neq("id", input.decidedStepId);
  if (error) throwVacationDatabaseError(error);
}

async function markVacationDecisionAccess<T extends VacationRequestRecord>(access: AccessContext, rows: T[]) {
  const stepsByRequestId = await fetchVacationApprovalStepsForRequests(rows.map((row) => row.id));
  return rows.map((row) => ({
    ...row,
    canDecide: row.status === "pending_manager" &&
      (stepsByRequestId.get(row.id) ?? []).some((step) => step.status === "pending" && approvalStepMatchesAccess(access, step)),
  }));
}

function isDuplicateActiveVacationError(error: unknown) {
  const record = error as { code?: unknown; message?: unknown };
  const message = String(record?.message ?? "").toLowerCase();
  return (
    record?.code === "23505" ||
    message.includes("duplicate key")
  ) && message.includes("v2_vacation_requests_no_duplicate_active");
}

function throwVacationDatabaseError(error: unknown) {
  if (isDuplicateActiveVacationError(error)) {
    throw new Error("An active vacation request already exists for this employee and date range. Open the existing request instead of creating a duplicate.");
  }
  throw new Error(typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error));
}

/**
 * Build an absolute app URL for email links from the canonical deploy base
 * (NOTIFICATION_DASHBOARD_URL — the same base the notification/email layer uses). Email
 * clients can't follow a relative href, so vacation emails must carry an absolute CTA.
 * Falls back to the relative path locally when the base is unset.
 */
function toAbsoluteAppUrl(path: string): string {
  const base = (process.env.NOTIFICATION_DASHBOARD_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/+$/, "");
  if (!base) return path;
  if (/^https?:\/\//.test(path)) return path;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

async function notifyRecipients(input: {
  channels?: SystemNotificationChannel[];
  href: string;
  message: string;
  metadata?: Record<string, unknown>;
  recipients: Array<string | null | undefined>;
  requestId: string;
  title: string;
  type: string;
}) {
  // Dedup by canonicalHrId (strips hyphens), not raw toUpperCase(), so hyphenated
  // HR_ID aliases (e.g. "A-7" vs "A7") collapse to a single recipient instead of
  // producing duplicate/missed notifications.
  const recipientHrIds = Array.from(
    new Map(
      input.recipients
        .map((recipient) => text(recipient).toUpperCase())
        .filter(Boolean)
        .map((hrId) => [canonicalHrId(hrId) ?? hrId, hrId] as const),
    ).values(),
  );

  await Promise.allSettled(
    recipientHrIds.map((recipientHrId) =>
      createSystemNotification({
        ...(input.channels ? { channels: input.channels } : {}),
        actionUrl: input.href,
        category: "vacation_request",
        eventType: input.type,
        message: input.message,
        metadata: { ...(input.metadata ?? {}), idempotencyKey: `vacation:${input.requestId}:${input.type}:${recipientHrId}` },
        module: "vacation",
        priority: "high",
        recipientHrId,
        title: input.title,
      }),
    ),
  );
}

async function notifyVacationSubmittedByGovernance(input: {
  approvalRecipients: VacationApprovalRecipient[];
  directory: EmployeeDirectoryData;
  href: string;
  message: string;
  metadata?: Record<string, unknown>;
  policyWarnings?: string[];
  request: VacationRequestRecord;
  title: string;
}) {
  const employee = findEmployeeByHrId(input.directory, input.request.employeeHrId);
  const period = `${input.request.startDate} - ${input.request.endDate}`;
  const sequential = isSequentialWorkflowType(input.request.vacationType);
  // Direct approve/reject deep links are used ONLY for the legacy (Sick) flow. Sequential types
  // (Annual/Other/Compensatory/Emergency) must be reviewed inside the Vacation Action Center —
  // email/Telegram never approve or reject directly for them.
  const actionCenterUrl = `/leave-management/vacation-action-center?requestId=${encodeURIComponent(input.request.id)}`;
  const absoluteReviewUrl = toAbsoluteAppUrl(actionCenterUrl);
  const approveUrl = `/leave-management/vacation-decision/${encodeURIComponent(input.request.id)}?decision=approve`;
  const rejectUrl = `/leave-management/vacation-decision/${encodeURIComponent(input.request.id)}?decision=reject`;

  // Role/stage-specific copy for the sequential workflow; legacy keeps the generic submit message.
  const recipientCopy = (stepKey: VacationApprovalStepKey): { message: string; status: string } => {
    if (!sequential) return { message: input.message, status: "Pending your approval" };
    if (stepKey === "direct_manager") {
      return { message: "Action required: a vacation request is waiting for your approval.", status: "Action required" };
    }
    if (stepKey === "manager_of_manager") {
      return {
        message: "FYI: a vacation request was submitted. Your approval will be available after the first management approval is completed.",
        status: "Available after the first management approval",
      };
    }
    return {
      message: "FYI: a vacation request was submitted. You may review or reject it if there is a policy issue. HR acknowledgement will be available after management approvals are completed.",
      status: "Review / reject only until management approves",
    };
  };
  const primaryRecipient = input.approvalRecipients.find((recipient) => recipient.stepKey === "direct_manager")
    ?? input.approvalRecipients[0]
    ?? null;
  const primaryRecipientKey = primaryRecipient
    ? `${canonicalHrId(primaryRecipient.hrId) ?? primaryRecipient.hrId}:${primaryRecipient.userId ?? ""}`
    : "";
  const samePrimaryRecipient = (recipient: VacationApprovalRecipient) =>
    `${canonicalHrId(recipient.hrId) ?? recipient.hrId}:${recipient.userId ?? ""}` === primaryRecipientKey;
  const primaryDeliverableEmail = primaryRecipient ? pickDeliverableEmail(primaryRecipient.email) : null;
  const ccEmails = Array.from(new Set(
    input.approvalRecipients
      .filter((recipient) => !samePrimaryRecipient(recipient))
      .map((recipient) => pickDeliverableEmail(recipient.email))
      .filter((email): email is string => Boolean(email)),
  ));
  const submitEmail = sequential && primaryRecipient && primaryDeliverableEmail
    ? sendVacationManagerDecisionEmail({
        cc: ccEmails,
        managerEmail: primaryDeliverableEmail,
        managerName: primaryRecipient.name,
        policyWarnings: input.policyWarnings,
        request: input.request,
        reviewUrl: absoluteReviewUrl,
      }).catch(() => undefined)
    : Promise.resolve(undefined);

  await Promise.allSettled([
    ...input.approvalRecipients.map((recipient) => {
      const copy = recipientCopy(recipient.stepKey);
      const telegramButtons = sequential
        ? [{ label: "Review Request", url: actionCenterUrl }]
        : [
            { label: "Open Phoenix", url: input.href },
            { label: "Approve in Phoenix", url: approveUrl },
            { label: "Reject in Phoenix", url: rejectUrl },
          ];
      // Sequential submit email is sent once above: primary manager TO, visibility approvers CC.
      // Per-recipient notification records remain in-app/Telegram only.
      const isPrimaryEmailRecipient = !sequential && samePrimaryRecipient(recipient);
      return createSystemNotification({
        actionUrl: sequential ? actionCenterUrl : input.href,
        category: "vacation_request",
        channels: sequential || !isPrimaryEmailRecipient ? ["in_app", "telegram"] : ["in_app", "email", "telegram"],
        ...(!isPrimaryEmailRecipient
          ? {}
          : { email: { cc: ccEmails, recipients: primaryDeliverableEmail ? [primaryDeliverableEmail] : undefined } }),
        eventType: "request_submitted",
        message: copy.message,
        metadata: {
          ...(input.metadata ?? {}),
          actionUrl: sequential ? actionCenterUrl : input.href,
          ...(sequential ? { reviewUrl: actionCenterUrl } : { approveUrl, rejectUrl }),
          approvalStep: recipient.stepKey,
          approverName: recipient.name,
          area: employee?.areaName ?? "",
          department: input.request.departmentName ?? employee?.departmentName ?? "",
          employeeHrId: input.request.employeeHrId,
          employeeName: input.request.employeeName,
          eventDate: new Date().toISOString().slice(0, 10),
          idempotencyKey: `vacation:${input.request.id}:request_submitted:${recipient.stepKey}:${recipient.hrId}:${recipient.userId ?? ""}`,
          line: input.request.lineName ?? employee?.lineName ?? "",
          managerName: input.request.managerName ?? "",
          period,
          policyWarnings: input.policyWarnings ?? [],
          recipientHrId: recipient.hrId,
          recipientName: recipient.name,
          requestId: input.request.id,
          requestType: vacationTypeLabel(input.request.vacationType),
          requestUrl: sequential ? actionCenterUrl : input.href,
          status: copy.status,
          team: employee?.teamName ?? "",
        },
        module: "vacation",
        priority: "high",
        recipientHrId: recipient.hrId,
        recipientUserId: recipient.userId,
        recordId: input.request.id,
        subjectHrId: input.request.employeeHrId,
        telegram: {
          buttons: telegramButtons,
        },
        title: input.title,
      });
    }),
    submitEmail,
  ]);
}

async function dispatchVacationSubmitted(input: {
  approvalRecipients: VacationApprovalRecipient[];
  directory: EmployeeDirectoryData;
  policyWarnings?: string[];
  request: VacationRequestRecord;
}) {
  const reportHref = `/leave-management/vacation-report?requestId=${encodeURIComponent(input.request.id)}`;
  const policyWarningText = (input.policyWarnings ?? []).join(" ");
  await notifyVacationSubmittedByGovernance({
    approvalRecipients: input.approvalRecipients,
    directory: input.directory,
    href: reportHref,
    message: `${input.request.employeeName} submitted ${vacationTypeLabel(input.request.vacationType)} from ${input.request.startDate} to ${input.request.endDate} (${input.request.durationDays} day(s)). Review is pending your decision.${policyWarningText ? ` Policy review: ${policyWarningText}` : ""}`,
    metadata: {
      policyWarnings: input.policyWarnings ?? [],
      requestId: input.request.id,
      status: input.request.status,
      details: [
        { label: "Employee", value: `${input.request.employeeName} (${input.request.employeeHrId})` },
        { label: "Type", value: vacationTypeLabel(input.request.vacationType) },
        { label: "Period", value: `${input.request.startDate} → ${input.request.endDate}` },
        ...(input.request.employeeNote ? [{ label: "Note", value: input.request.employeeNote }] : []),
        { label: "Status", value: "Pending manager decision" },
        { label: "Action", value: "Review request" },
      ],
    },
    policyWarnings: input.policyWarnings ?? [],
    request: input.request,
    title: `${input.request.employeeName} submitted a vacation request`,
  });
  // Submission confirmation to the employee — completes the 3-channel requirement on submit
  // (managers/HR are notified above; the employee previously got zero channels).
  if (input.request.employeeWorkEmail) {
    void sendVacationSubmissionConfirmationEmail({
      employeeEmail: input.request.employeeWorkEmail,
      request: input.request,
    }).catch(() => undefined);
  }
}

async function dispatchVacationManagerReview(input: {
  decision: VacationDecision;
  directory: EmployeeDirectoryData;
  request: VacationRequestRecord;
}) {
  const hrRecipients = await getHrRecipients(input.directory);
  const sequential = isSequentialWorkflowType(input.request.vacationType);
  const reportHref = sequential
    ? `/leave-management/vacation-action-center?requestId=${encodeURIComponent(input.request.id)}`
    : `/leave-management/vacation-report?requestId=${encodeURIComponent(input.request.id)}`;
  await notifyRecipients({
    href: reportHref,
    message: `${input.request.managerName ?? "Direct manager"} ${input.decision === "approve" ? "approved" : "rejected"} ${input.request.employeeName}'s ${vacationTypeLabel(input.request.vacationType)} (${input.request.startDate} to ${input.request.endDate}). ${sequential ? "HR acknowledgement is required." : "HR final decision is required."}`,
    metadata: {
      managerDecision: input.request.managerDecision,
      requestId: input.request.id,
      status: input.request.status,
      details: [
        { label: "Employee", value: `${input.request.employeeName} (${input.request.employeeHrId})` },
        { label: "Manager", value: input.request.managerName ?? "Direct manager" },
        { label: "Type", value: vacationTypeLabel(input.request.vacationType) },
        { label: "Period", value: `${input.request.startDate} → ${input.request.endDate}` },
        { label: "Status", value: sequential ? "Pending HR acknowledgement" : "Pending HR final decision" },
        { label: "Action", value: sequential ? "Acknowledge / record in the Action Center" : "Complete HR decision" },
      ],
    },
    recipients: [
      input.request.employeeHrId,
      input.request.managerHrId,
      input.request.managerOfManagerHrId,
      ...hrRecipients.map((recipient) => recipient.hrId),
    ],
    requestId: input.request.id,
    title: sequential
      ? `${input.request.employeeName}'s vacation request needs HR acknowledgement`
      : `${input.request.employeeName}'s vacation request needs HR final decision`,
    type: `manager_review:${input.decision}`,
  });
  // Email the employee after every manager decision so they get all 3 channels
  // (email + Telegram + in-app), not just Telegram + in-app.
  // CC: HR + direct manager so the manager is informed of every step result.
  if (input.request.employeeWorkEmail) {
    const hrEmails = hrRecipients
      .map((r) => findEmployeeByHrId(input.directory, r.hrId)?.workEmail)
      .filter((e): e is string => Boolean(e));
    const managerEmail = findEmployeeByHrId(input.directory, input.request.managerHrId)?.workEmail;
    const ccEmails = Array.from(new Set([...hrEmails, ...(managerEmail ? [managerEmail] : [])]));
    const nextStep = sequential
      ? "It is now pending HR acknowledgement."
      : "It is now pending HR final decision.";
    await sendVacationManagerStepResultEmail({
      cc: ccEmails,
      decision: input.decision,
      employeeEmail: input.request.employeeWorkEmail,
      managerDecisionComment: input.request.managerDecisionComment ?? null,
      managerName: input.request.managerName ?? "Your manager",
      nextStep,
      request: input.request,
    }).catch(() => undefined);
  }
}

async function dispatchVacationNextManagerStep(input: {
  directory: EmployeeDirectoryData;
  nextApproverHrId: string;
  actingManagerHrId: string | null | undefined;
  request: VacationRequestRecord;
}) {
  const actingManager = findEmployeeByHrId(input.directory, input.actingManagerHrId);
  const actingName = actingManager?.fullName ?? input.request.managerName ?? "Your manager";
  const actionHref = `/leave-management/vacation-action-center?requestId=${encodeURIComponent(input.request.id)}`;
  const detailBase = [
    { label: "Employee", value: `${input.request.employeeName} (${input.request.employeeHrId})` },
    { label: "Type", value: vacationTypeLabel(input.request.vacationType) },
    { label: "Period", value: `${input.request.startDate} → ${input.request.endDate}` },
  ];
  // Gap 3: call createSystemNotification directly (not notifyRecipients) so we can attach
  // a Telegram "Review Request" button — mirroring exactly what the direct manager received
  // on submission. notifyRecipients doesn't expose the telegram.buttons param.
  await createSystemNotification({
    actionUrl: actionHref,
    category: "vacation_request",
    eventType: "next_manager_review",
    message: `${actingName} approved ${input.request.employeeName}'s ${vacationTypeLabel(input.request.vacationType)} request (${input.request.startDate} to ${input.request.endDate}). Your review is now required.`,
    metadata: {
      requestId: input.request.id,
      status: input.request.status,
      details: [
        ...detailBase,
        { label: "Status", value: "Pending your approval" },
        { label: "Action", value: "Review in the Action Center" },
      ],
      idempotencyKey: `vacation:${input.request.id}:next_manager_review:${input.nextApproverHrId.toUpperCase()}`,
    },
    module: "vacation",
    priority: "high",
    recipientHrId: input.nextApproverHrId,
    telegram: { buttons: [{ label: "Review Request", url: actionHref }] },
    title: `${input.request.employeeName}'s vacation request needs your approval`,
  });
  await notifyRecipients({
    channels: ["in_app", "telegram"],
    href: `/employee-portals/vacation-report?requestId=${encodeURIComponent(input.request.id)}`,
    message: `${actingName} approved your ${vacationTypeLabel(input.request.vacationType)} request (${input.request.startDate} → ${input.request.endDate}). It is now pending secondary management review.`,
    metadata: {
      requestId: input.request.id,
      status: input.request.status,
      details: [...detailBase, { label: "Status", value: "Pending secondary management review" }],
    },
    recipients: [input.request.employeeHrId],
    requestId: input.request.id,
    title: "Your vacation request is progressing",
    type: "employee_step_approved",
  });
  // Gap 3: use sendVacationManagerDecisionEmail (the same leave_request WYSIWYG template the
  // direct manager received on submission) so both steps are truly identical.
  const nextApprover = findEmployeeByHrId(input.directory, input.nextApproverHrId);
  const nextManagerEmail = nextApprover?.workEmail;
  if (nextManagerEmail) {
    await sendVacationManagerDecisionEmail({
      managerEmail: nextManagerEmail,
      managerName: nextApprover.fullName,
      request: input.request,
      reviewUrl: toAbsoluteAppUrl(actionHref),
    }).catch(async (error) => {
      await insertVacationEvent({
        actorHrId: input.actingManagerHrId,
        eventType: "notification_failed",
        message: vacationErrorMessage(error),
        requestId: input.request.id,
      }).catch(() => undefined);
    });
  }
}

async function dispatchVacationDecision(input: {
  decision: VacationDecision;
  directory: EmployeeDirectoryData;
  request: VacationRequestRecord;
}) {
  const reportHref = `/leave-management/vacation-report?requestId=${encodeURIComponent(input.request.id)}`;
  const approvalSteps = await fetchVacationApprovalStepsForRequest(input.request.id).catch(() => []);
  const approvalRecipientHrIds = approvalSteps.map((step) => step.approverHrId);
  await notifyRecipients({
    // Email is delivered by the templated sendVacationDecisionResultEmail below
    // (leave_approval / leave_rejection); keep this generic notification to in-app + Telegram
    // so the employee/approvers don't also receive a duplicate generic email.
    channels: ["in_app", "telegram"],
    href: reportHref,
    message: `${input.request.employeeName}'s ${vacationTypeLabel(input.request.vacationType)} (${input.request.startDate} to ${input.request.endDate}) was ${input.decision === "approve" ? "approved" : "rejected"} by the vacation approval workflow.`,
    metadata: {
      requestId: input.request.id,
      status: input.request.status,
      details: [
        { label: "Employee", value: `${input.request.employeeName} (${input.request.employeeHrId})` },
        { label: "Type", value: vacationTypeLabel(input.request.vacationType) },
        { label: "Period", value: `${input.request.startDate} → ${input.request.endDate}` },
        { label: "Status", value: input.decision === "approve" ? "Approved" : "Rejected" },
      ],
    },
    recipients: [
      input.request.employeeHrId,
      ...approvalRecipientHrIds,
    ],
    requestId: input.request.id,
    title: `${input.request.employeeName}'s vacation request was ${input.decision === "approve" ? "approved" : "rejected"}`,
    type: `decision:${input.decision}`,
  });

  if (!input.request.employeeWorkEmail) return;
  await sendVacationDecisionResultEmail({
    cc: (await Promise.all(approvalRecipientHrIds.map((hrId) => resolveManagerEmail(input.directory, hrId))))
      .filter((email): email is string => Boolean(email)),
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
    .eq("employee_hr_id", input.employeeHrId.toUpperCase())
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

export function sanitizeStorageSegment(value: string | null | undefined, fallback: string) {
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
    throw new Error("Sick vacation document is too large. Maximum size is 20MB.");
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
    throw new Error("Compensatory Day event photo is too large. Maximum size is 20MB.");
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
  void options;
  await assertPermission(access, "leave", "create");
  await assertLeaveWorkflowTransition({
    access,
    actionKey: "submit",
    expectedNextStatus: "pending_manager",
    status: "draft",
  });
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
  const employeeNote = nullableText(input.employeeNote);
  const compensatoryDetails = vacationType === "compensatory" ? validateCompensatoryDetails(input) : null;

  const { directory, employee } = await getCurrentEmployee(access);
  const weeklyOffPolicy = await fetchWeeklyOffPolicyForTitle(employeeVacationPolicyTitle(employee));
  const durationDays = calculateVacationDurationDays({
    dayPart,
    endDate,
    startDate,
    weeklyOffPolicy: weeklyOffPolicyForDateCalculation(weeklyOffPolicy),
  });
  const { manager, managerOfManager } = managerChain(directory, employee);
  // Only the direct manager is required; manager-of-manager is optional (top-of-org
  // reports, e.g. direct reports to the CEO, have no manager above their manager).
  const usesSequentialWorkflow = isSequentialWorkflowType(resolvedVacationType);
  let approvalRecipients: VacationApprovalRecipient[];
  let initialRequestStatus: VacationRequestStatus = "pending_manager";
  if (manager?.hrId) {
    approvalRecipients = await resolveVacationParallelApprovalRecipients(directory, employee);
  } else if (usesSequentialWorkflow) {
    // Broken reporting line on a sequential-workflow type (Annual/Other/Compensatory): create
    // only the HR step and park the request in `needs_assignment` so HR can assign the first
    // management approver from the Vacation Action Center and resume the flow — instead of
    // failing the employee with a generic error.
    approvalRecipients = await resolveVacationPilotHrApprovers(directory);
    initialRequestStatus = "needs_assignment";
  } else {
    // Sick keeps the existing hard requirement of a resolvable direct manager.
    throw new Error("Vacation approval chain is incomplete. Please contact HR before submitting a vacation request.");
  }
  const weeklyOffPolicySnapshot = buildWeeklyOffPolicySnapshot(weeklyOffPolicy);

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
      employee_note: employeeNote,
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
      status: initialRequestStatus,
      submitted_by_hr_id: employee.hrId,
      submitted_by_login_id: access.loginId ?? null,
      unpaid_reason: balance.unpaidReason,
      unpaid_duration_days: balance.unpaidDurationDays,
      updated_at: now,
      used_paid_days: balance.usedPaidDays,
      vacation_type: resolvedVacationType,
      weekly_off_policy_snapshot: weeklyOffPolicySnapshot,
    })
    .select("*")
    .single();

  if (error) {
    await deleteSickAttachment(sickAttachment?.objectPath).catch(() => undefined);
    await deleteSickAttachment(compensatoryAttachment?.objectPath).catch(() => undefined);
    throwVacationDatabaseError(error);
  }

  const request = mapVacationRow(data as VacationRequestDbRow);
  try {
    await createVacationApprovalSteps({ approvers: approvalRecipients, requestId: request.id });
  } catch (error) {
    try {
      await getSupabaseAdmin().from(vacationRequestsTable).delete().eq("id", request.id);
    } catch {
      // Best-effort cleanup; the original approval-step error is more useful to the caller.
    }
    await deleteSickAttachment(sickAttachment?.objectPath).catch(() => undefined);
    await deleteSickAttachment(compensatoryAttachment?.objectPath).catch(() => undefined);
    throw error;
  }
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
  await upsertRequiredEvidenceReview({
    actorHrId: employee.hrId,
    actorLoginId: access.loginId,
    evidenceType: request.vacationType === "compensatory" ? "compensatory" : "sick",
    hasAttachment: request.vacationType === "sick"
      ? Boolean(request.sickAttachmentObjectPath)
      : request.vacationType === "compensatory" && Boolean(request.compensatoryAttachmentObjectPath),
    requestId: request.id,
  });

  void dispatchVacationSubmitted({ approvalRecipients, directory, policyWarnings, request }).catch(async (error) => {
    await insertVacationEvent({
      actorHrId: employee.hrId,
      actorLoginId: access.loginId,
      eventType: "notification_failed",
      message: vacationErrorMessage(error),
      requestId: request.id,
    }).catch(() => undefined);
  });

  invalidateExecutiveDashboardCache("leave request submitted", ["leave"]);
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
  const weeklyOffPolicySnapshot = buildWeeklyOffPolicySnapshot(weeklyOffPolicy);
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
      weekly_off_policy_snapshot: weeklyOffPolicySnapshot,
    },
    status,
  };
}

export async function createVacationRequestAsAdmin(access: AccessContext, input: AdminVacationRequestInput) {
  await assertVacationAdminManagement(access, "create");
  const directory = await getEmployeeDirectory();
  const requestId = randomUUID();
  const { payload, status } = await buildAdminVacationMutationPayload({ access, directory, form: input });
  await assertLeaveWorkflowTransition({
    access,
    actionKey: "admin_create",
    status: "draft",
  });

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

  invalidateExecutiveDashboardCache("leave request created by admin", ["leave"]);
  return request;
}

export async function updateVacationRequestAsAdmin(access: AccessContext, input: AdminVacationRequestInput & { requestId: string }) {
  await assertVacationAdminManagement(access, "update");
  const existing = await fetchVacationRequestById(input.requestId);
  if (!existing) throw new Error("Vacation request was not found.");

  const directory = await getEmployeeDirectory();
  const { payload, status } = await buildAdminVacationMutationPayload({ access, directory, existing, form: input });
  await assertLeaveWorkflowTransition({
    access,
    actionKey: "admin_update",
    status: existing.status,
  });
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

  invalidateExecutiveDashboardCache("leave request updated by admin", ["leave"]);
  return request;
}

export async function deleteVacationRequestAsAdmin(access: AccessContext, requestId: string) {
  await assertVacationAdminManagement(access, "delete");
  const existing = await fetchVacationRequestById(requestId);
  if (!existing) throw new Error("Vacation request was not found.");
  await assertLeaveWorkflowTransition({
    access,
    actionKey: "admin_delete",
    expectedNextStatus: "deleted",
    status: existing.status,
  });

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

  invalidateExecutiveDashboardCache("leave request deleted by admin", ["leave"]);
  return existing;
}

async function fetchVacationRequestById(id: string) {
  const { data, error } = await getSupabaseAdmin()
    .from(vacationRequestsTable)
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error));
  if (!data) return null;
  const request = mapVacationRow(data as VacationRequestDbRow);
  const reviews = await fetchEvidenceReviewsForRequests([request.id]);
  return {
    ...request,
    evidenceReviews: reviews.get(request.id) ?? [],
  };
}

export async function getVacationDecisionConfirmationData(access: AccessContext, requestId: string) {
  await assertPermission(access, "leave", "approve");
  const request = await fetchVacationRequestById(requestId);
  if (!request) throw new Error("Vacation request was not found.");
  const pendingStep = await getPendingVacationApprovalStepForAccess(access, request);
  if (!pendingStep) {
    throw new Error("Forbidden: you are not an assigned pending approver for this vacation request.");
  }
  return {
    approvalStep: pendingStep.stepKey,
    request: {
      employeeHrId: request.employeeHrId,
      employeeName: request.employeeName,
      endDate: request.endDate,
      id: request.id,
      startDate: request.startDate,
      status: request.status,
      vacationType: vacationTypeLabel(request.vacationType),
    },
  };
}

type ApplyVacationDecisionInput = {
  access?: AccessContext;
  actorHrId: string | null;
  actorLoginId?: string | null;
  decision: VacationDecision;
  decisionComment?: string | null;
  request: VacationRequestRecord;
};

// Dispatch on workflow type: Annual/Other/Compensatory/Emergency use the sequential flow; only
// Sick keeps the legacy parallel flow (applyVacationDecisionLegacy is the original behavior, intact).
async function applyVacationDecision(input: ApplyVacationDecisionInput) {
  if (isSequentialWorkflowType(input.request.vacationType)) {
    return applyVacationDecisionSequential(input);
  }
  return applyVacationDecisionLegacy(input);
}

async function applyVacationDecisionSequential(input: ApplyVacationDecisionInput) {
  const actionableStatuses = ["pending_manager", "pending_hr", "needs_assignment"];
  if (!actionableStatuses.includes(input.request.status)) {
    throw new Error("This vacation request already has a final decision.");
  }
  if (input.request.status === "needs_assignment" && input.decision === "approve") {
    throw new Error("This vacation request needs a management approver assigned by HR before it can be approved.");
  }
  if (input.request.status === "returned" && input.decision !== "return") {
    throw new Error("This vacation request has been returned to the employee. Wait for them to resubmit before taking action.");
  }
  if ((input.decision === "reject" || input.decision === "return") && !text(input.decisionComment)) {
    throw new Error(input.decision === "return" ? "A return reason is required." : "A rejection reason is required.");
  }

  const directory = await getEmployeeDirectory();
  const { step, steps } = await getPendingVacationApprovalStepForActor({
    access: input.access,
    actorHrId: input.actorHrId,
    actorLoginId: input.actorLoginId,
    request: input.request,
  });
  if (!step) {
    throw new Error("Forbidden: only assigned pending vacation approvers can decide this request.");
  }

  // Enforce the runtime-overridable workflow-registry role authority on the decide path,
  // consistent with submit/admin transitions. Skip the role-less magic-link token path
  // (already authenticated by the signed token + the step resolver above) and the
  // Phoenix-specific "needs_assignment" state, which the leave_requests registry does not
  // model. expectedNextStatus is intentionally omitted: the sequential resolver computes
  // the real next status, so we gate only on the actor's role for this action.
  if (input.access && (input.request.status === "pending_manager" || input.request.status === "pending_hr")) {
    const { actionKey } = vacationDecisionAction({
      decision: input.decision,
      status: input.request.status,
    });
    await assertLeaveWorkflowTransition({
      access: input.access,
      actionKey,
      status: input.request.status,
    });
  }

  const stepStates: VacationApprovalStepState[] = steps.map((candidate) => ({
    order: candidate.stepOrder,
    status: candidate.status,
    stepKey: candidate.stepKey,
  }));
  const evaluation = evaluateStepAction({
    steps: stepStates,
    actorStep: { stepKey: step.stepKey, order: step.stepOrder },
    decision: input.decision,
  });
  if (!evaluation.allowed) {
    throw new Error(`Forbidden: ${evaluation.reason ?? "This action is not available yet."}`);
  }

  // HR acknowledgement keeps the evidence separation-of-duties guard.
  if (step.stepKey === "hr" && input.decision === "approve") {
    if (!hasAcceptedRequiredEvidence(input.request)) {
      throw new Error("Required vacation evidence must be accepted by HR before HR acknowledgement.");
    }
    const reviewerHrId = canonicalHrId(input.actorHrId);
    if (reviewerHrId && acceptedRequiredEvidenceReviewerHrIds(input.request).includes(reviewerHrId)) {
      if (await hasAlternateHrApprover(reviewerHrId)) {
        throw new Error("Separation of duties requires a different HR or Super Admin actor to acknowledge after evidence review.");
      }
      await insertVacationEvent({
        actorHrId: input.actorHrId,
        actorLoginId: input.actorLoginId,
        eventType: "hr_self_acknowledged_sole_admin_exception",
        message: "HR acknowledged after reviewing the evidence themselves: no other active HR/Super Admin account exists to satisfy separation of duties.",
        metadata: { evidenceReviewerHrId: reviewerHrId },
        requestId: input.request.id,
      });
    }
  }

  // "return" is a manager-only action: send the request back to the employee without finalizing
  // the step. The approval step stays "pending" so the workflow can resume after resubmit.
  if (input.decision === "return") {
    const now = new Date().toISOString();
    const { data, error } = await getSupabaseAdmin()
      .from(vacationRequestsTable)
      .update({
        status: "returned",
        manager_decision_comment: nullableText(input.decisionComment),
        manager_decision_by_hr_id: input.actorHrId,
        manager_decision_at: now,
        updated_at: now,
      })
      .eq("id", input.request.id)
      .eq("status", input.request.status)
      .select("*")
      .single();
    if (error) throw new Error(typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error));
    if (!data) throw new Error("Vacation request was updated by another user. Refresh and try again.");
    const returned = mapVacationRow(data as VacationRequestDbRow);
    await insertVacationEvent({
      actorHrId: input.actorHrId,
      actorLoginId: input.actorLoginId,
      eventType: "approval_manager_returned",
      message: "Manager returned the request to the employee for revision.",
      metadata: { decisionComment: input.decisionComment ?? null, stepKey: step.stepKey },
      requestId: returned.id,
    });
    await writeRequiredAuditLog({
      actorLoginId: input.actorLoginId ?? input.actorHrId ?? "system",
      entityId: returned.id,
      entityType: "vacation_request",
      newValues: { decisionComment: input.decisionComment ?? null, status: "returned" },
      oldValues: { status: input.request.status },
      summary: "Vacation request returned to employee for revision.",
    });
    const actorName = findEmployeeByHrId(directory, input.actorHrId)?.fullName
      ?? returned.managerName
      ?? "Your manager";
    const returnReason = input.decisionComment ?? "No reason provided.";
    // Employee: in-app + Telegram (already all 3 once email below fires)
    void notifyRecipients({
      channels: ["in_app", "telegram"],
      href: `/employee-portals/vacation-report?requestId=${encodeURIComponent(returned.id)}`,
      message: `Your ${vacationTypeLabel(returned.vacationType)} vacation request (${returned.startDate} → ${returned.endDate}) was returned by ${actorName} for revision. Reason: ${returnReason}`,
      metadata: { requestId: returned.id, status: "returned" },
      recipients: [returned.employeeHrId],
      requestId: returned.id,
      title: "Vacation request returned for revision",
      type: "return",
    }).catch(() => undefined);
    // HR: in-app + Telegram so they know the request was sent back
    const hrRecipientsForReturn = await getHrRecipients(directory);
    void notifyRecipients({
      channels: ["in_app", "telegram"],
      href: `/leave-management/vacation-action-center?requestId=${encodeURIComponent(returned.id)}`,
      message: `${actorName} returned ${returned.employeeName}'s ${vacationTypeLabel(returned.vacationType)} request (${returned.startDate} → ${returned.endDate}) for revision. Reason: ${returnReason}`,
      metadata: { requestId: returned.id, status: "returned" },
      recipients: hrRecipientsForReturn.map((r) => r.hrId),
      requestId: returned.id,
      title: `${returned.employeeName}'s vacation request was returned for revision`,
      type: "return_hr_notice",
    }).catch(() => undefined);
    // Email the employee (CC: HR) — completes the 3-channel requirement
    if (returned.employeeWorkEmail) {
      const hrEmailsForReturn = hrRecipientsForReturn
        .map((r) => findEmployeeByHrId(directory, r.hrId)?.workEmail)
        .filter((e): e is string => Boolean(e));
      void sendVacationReturnedEmail({
        cc: hrEmailsForReturn,
        decisionComment: input.decisionComment ?? null,
        employeeEmail: returned.employeeWorkEmail,
        managerName: actorName,
        request: returned,
      }).catch(() => undefined);
    }
    invalidateExecutiveDashboardCache("leave request returned", ["leave"]);
    return returned;
  }

  const decisionValue = input.decision === "approve" ? "approved" : "rejected";
  await recordVacationApprovalStepDecision({
    decision: input.decision,
    decisionComment: input.decisionComment,
    stepId: step.id,
  });
  if (step.stepKey === "hr") {
    await closeSiblingPendingHrApprovalSteps({
      actorHrId: input.actorHrId,
      decidedStepId: step.id,
      decisionValue,
      requestId: input.request.id,
    });
  }

  const nextStatus = evaluation.nextStatus;
  const isFinal = evaluation.isFinal;
  const allApproved = nextStatus === "approved";

  let balance: VacationBalanceSnapshot = input.request;
  if (allApproved) {
    balance = await calculatePaymentForRequest({
      durationDays: input.request.durationDays,
      employeeHrId: input.request.employeeHrId,
      excludeRequestId: input.request.id,
      hireDate: input.request.employeeHireDate,
      startDate: input.request.startDate,
      vacationType: input.request.vacationType,
    });
  }

  const now = new Date().toISOString();

  // A final approval is "paid-balance contended" only for annual/emergency requests that
  // reach the paid split (have a period and are not forced-unpaid for first_six_months /
  // missing_hire_date). For those, the used-paid-days read and the write MUST be atomic to
  // stop two concurrent approvals in the same period from both consuming the same balance.
  const isPaidBalanceContended =
    allApproved &&
    (input.request.vacationType === "annual" || input.request.vacationType === "emergency") &&
    balance.unpaidReason !== "first_six_months" &&
    balance.unpaidReason !== "missing_hire_date" &&
    balance.periodStart != null &&
    balance.periodEnd != null;

  let decidedRow: VacationRequestDbRow;
  if (isPaidBalanceContended) {
    // Atomic, per-employee-serialized enforcement — see migration
    // 20260615080500_vacation_paid_approval_atomic.sql. The RPC re-derives used-paid-days
    // under a per-employee advisory lock + status CAS, applies the split, and writes the
    // decision in one transaction. The request-local period/entitlement (computed above by
    // calculatePaymentForRequest) is passed in; the contended values are recomputed inside.
    const { data, error } = await getSupabaseAdmin().rpc("phx_apply_vacation_paid_approval", {
      p_request_id: input.request.id,
      p_expected_status: input.request.status,
      p_next_status: nextStatus,
      p_step: step.stepKey === "hr" ? "hr" : "manager",
      p_decision_by_hr_id: input.actorHrId,
      p_decision_comment: nullableText(input.decisionComment),
      p_now: now,
      p_entitlement_days: balance.entitlementDays,
      p_period_start: balance.periodStart,
      p_period_end: balance.periodEnd,
      p_duration_days: input.request.durationDays,
      p_vacation_type: input.request.vacationType,
    });
    if (error) throw new Error(typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error));
    if (!data) throw new Error("Vacation request was updated by another user. Refresh and try again.");
    decidedRow = data as VacationRequestDbRow;
  } else {
    const updatePayload: Record<string, unknown> = {
      status: nextStatus,
      updated_at: now,
    };
    if (step.stepKey === "hr") {
      updatePayload.hr_decision = decisionValue;
      updatePayload.hr_decision_at = now;
      updatePayload.hr_decision_by_hr_id = input.actorHrId;
      updatePayload.hr_decision_comment = nullableText(input.decisionComment);
    } else {
      updatePayload.manager_decision = decisionValue;
      updatePayload.manager_decision_at = now;
      updatePayload.manager_decision_by_hr_id = input.actorHrId;
      updatePayload.manager_decision_comment = nullableText(input.decisionComment);
    }
    if (allApproved) {
      Object.assign(updatePayload, {
        balance_after_days: balance.balanceAfterDays,
        balance_before_days: balance.balanceBeforeDays,
        entitlement_days: balance.entitlementDays,
        payment_status: balance.paymentStatus,
        paid_duration_days: balance.paidDurationDays,
        period_end: balance.periodEnd,
        period_start: balance.periodStart,
        unpaid_reason: balance.unpaidReason,
        unpaid_duration_days: balance.unpaidDurationDays,
        used_paid_days: balance.usedPaidDays,
      });
    }

    const { data, error } = await getSupabaseAdmin()
      .from(vacationRequestsTable)
      .update(updatePayload)
      .eq("id", input.request.id)
      .eq("status", input.request.status)
      .select("*")
      .single();
    if (error) throw new Error(typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error));
    decidedRow = data as VacationRequestDbRow;
  }
  const updated = mapVacationRow(decidedRow);

  const genericStep = genericStepName(step.stepKey);
  const eventMessage = isFinal
    ? input.decision === "reject"
      ? `Vacation request rejected at ${genericStep}.`
      : "Vacation request recorded by HR."
    : nextStatus === "pending_hr"
      ? "Approved by management - pending HR acknowledgement."
      : `Vacation ${genericStep} approved.`;
  await insertVacationEvent({
    actorHrId: input.actorHrId,
    actorLoginId: input.actorLoginId,
    eventType: `approval_${step.stepKey}_${decisionValue}`,
    message: eventMessage,
    metadata: {
      decisionComment: input.decisionComment ?? null,
      genericStep,
      paymentStatus: updated.paymentStatus,
      stepKey: step.stepKey,
      stepOrder: step.stepOrder,
      unpaidReason: updated.unpaidReason,
    },
    requestId: updated.id,
  });
  await writeRequiredAuditLog({
    actorLoginId: input.actorLoginId ?? input.actorHrId ?? "system",
    entityId: updated.id,
    entityType: "vacation_request",
    newValues: {
      decisionComment: input.decisionComment ?? null,
      genericStep,
      hrDecision: updated.hrDecision,
      managerDecision: updated.managerDecision,
      paymentStatus: updated.paymentStatus,
      stepKey: step.stepKey,
      status: updated.status,
      usedPaidDays: updated.usedPaidDays,
    },
    oldValues: {
      paymentStatus: input.request.paymentStatus,
      status: input.request.status,
      usedPaidDays: input.request.usedPaidDays,
    },
    summary: eventMessage,
  });

  if (isFinal) {
    void dispatchVacationDecision({ decision: input.decision, directory, request: updated }).catch(async (error) => {
      await insertVacationEvent({
        actorHrId: input.actorHrId,
        actorLoginId: input.actorLoginId,
        eventType: "notification_failed",
        message: vacationErrorMessage(error),
        requestId: updated.id,
      }).catch(() => undefined);
    });
  } else if (nextStatus === "pending_hr") {
    // All management steps done — notify HR and employee.
    try {
      await dispatchVacationManagerReview({ decision: input.decision, directory, request: updated });
    } catch (error) {
      await insertVacationEvent({
        actorHrId: input.actorHrId,
        actorLoginId: input.actorLoginId,
        eventType: "notification_failed",
        message: vacationErrorMessage(error),
        requestId: updated.id,
      }).catch(() => undefined);
    }
  } else if (nextStatus === "pending_manager") {
    // A management step approved but another management step is still pending.
    // Notify the next approver it is their turn and notify the employee the request is progressing.
    const nextManagementStep = steps.find(
      (s) => s.stepOrder > step.stepOrder && s.stepKey !== "hr"
    );
    if (nextManagementStep) {
      try {
        await dispatchVacationNextManagerStep({
          actingManagerHrId: step.approverHrId,
          directory,
          nextApproverHrId: nextManagementStep.approverHrId,
          request: updated,
        });
      } catch (error) {
        await insertVacationEvent({
          actorHrId: input.actorHrId,
          actorLoginId: input.actorLoginId,
          eventType: "notification_failed",
          message: vacationErrorMessage(error),
          requestId: updated.id,
        }).catch(() => undefined);
      }
    }
  }

  invalidateExecutiveDashboardCache("leave request decision recorded", ["leave"]);
  return updated;
}

async function applyVacationDecisionLegacy(input: ApplyVacationDecisionInput) {
  if (input.request.status !== "pending_manager") {
    throw new Error("This vacation request already has a final decision.");
  }
  if ((input.decision === "reject" || input.decision === "return") && !text(input.decisionComment)) {
    throw new Error(input.decision === "return" ? "A return reason is required." : "A rejection reason is required.");
  }

  const directory = await getEmployeeDirectory();
  let balance: VacationBalanceSnapshot = input.request;
  const { step, steps } = await getPendingVacationApprovalStepForActor({
    access: input.access,
    actorHrId: input.actorHrId,
    actorLoginId: input.actorLoginId,
    request: input.request,
  });
  if (!step) {
    throw new Error("Forbidden: only assigned pending vacation approvers can decide this request.");
  }

  if (step.stepKey === "hr" && input.decision === "approve") {
    if (!hasAcceptedRequiredEvidence(input.request)) {
      throw new Error("Required vacation evidence must be accepted by HR before final HR approval.");
    }
    const actorHrId = canonicalHrId(input.actorHrId);
    if (actorHrId && acceptedRequiredEvidenceReviewerHrIds(input.request).includes(actorHrId)) {
      if (await hasAlternateHrApprover(actorHrId)) {
        throw new Error("Separation of duties requires a different HR or Super Admin actor to make the final approval after evidence review.");
      }
      await insertVacationEvent({
        actorHrId: input.actorHrId,
        actorLoginId: input.actorLoginId,
        eventType: "hr_self_acknowledged_sole_admin_exception",
        message: "HR gave the final approval after reviewing the evidence themselves: no other active HR/Super Admin account exists to satisfy separation of duties.",
        metadata: { evidenceReviewerHrId: actorHrId },
        requestId: input.request.id,
      });
    }
  }

  const decisionValue = input.decision === "approve" ? "approved" : "rejected";
  const decidedStep = await recordVacationApprovalStepDecision({
    decision: input.decision,
    decisionComment: input.decisionComment,
    stepId: step.id,
  });
  if (step.stepKey === "hr") {
    await closeSiblingPendingHrApprovalSteps({
      actorHrId: input.actorHrId,
      decidedStepId: step.id,
      decisionValue,
      requestId: input.request.id,
    });
  }
  const stepsAfterDecision = steps.map((candidate) =>
    candidate.id === decidedStep.id ? decidedStep : candidate
  );
  const rejected = input.decision === "reject" || stepsAfterDecision.some((candidate) => candidate.status === "rejected");
  // HR fans out to every active Super Admin account as its own parallel "hr" row, but HR is one
  // conceptual authority — only ONE of those rows needs to approve, not all of them. Management
  // steps keep unanimous (AND) semantics.
  const nonHrSteps = stepsAfterDecision.filter((candidate) => candidate.stepKey !== "hr");
  const hrSteps = stepsAfterDecision.filter((candidate) => candidate.stepKey === "hr");
  const allApproved =
    nonHrSteps.every((candidate) => candidate.status === "approved") &&
    (hrSteps.length === 0 || hrSteps.some((candidate) => candidate.status === "approved"));
  const isFinalDecision = rejected || allApproved;
  if (allApproved) {
    balance = await calculatePaymentForRequest({
      durationDays: input.request.durationDays,
      employeeHrId: input.request.employeeHrId,
      excludeRequestId: input.request.id,
      hireDate: input.request.employeeHireDate,
      startDate: input.request.startDate,
      vacationType: input.request.vacationType,
    });
  }
  const now = new Date().toISOString();
  const updatePayload: Record<string, unknown> = {
    status: isFinalDecision ? decisionValue : "pending_manager",
    updated_at: now,
  };
  if (step.stepKey === "direct_manager" || (allApproved && !input.request.managerDecision)) {
    updatePayload.manager_decision = step.stepKey === "direct_manager" ? decisionValue : "approved";
    updatePayload.manager_decision_at = step.stepKey === "direct_manager" ? now : input.request.managerDecisionAt ?? now;
    updatePayload.manager_decision_by_hr_id = step.stepKey === "direct_manager" ? input.actorHrId : input.request.managerDecisionByHrId ?? input.actorHrId;
    updatePayload.manager_decision_comment = step.stepKey === "direct_manager" ? nullableText(input.decisionComment) : input.request.managerDecisionComment;
  }
  if (step.stepKey === "hr" || allApproved) {
    updatePayload.hr_decision = step.stepKey === "hr" ? decisionValue : "approved";
    updatePayload.hr_decision_at = step.stepKey === "hr" ? now : input.request.hrDecisionAt ?? now;
    updatePayload.hr_decision_by_hr_id = step.stepKey === "hr" ? input.actorHrId : input.request.hrDecisionByHrId ?? input.actorHrId;
    updatePayload.hr_decision_comment = step.stepKey === "hr" ? nullableText(input.decisionComment) : input.request.hrDecisionComment;
  }
  if (allApproved) {
    Object.assign(updatePayload, {
      balance_after_days: balance.balanceAfterDays,
      balance_before_days: balance.balanceBeforeDays,
      entitlement_days: balance.entitlementDays,
      payment_status: balance.paymentStatus,
      paid_duration_days: balance.paidDurationDays,
      period_end: balance.periodEnd,
      period_start: balance.periodStart,
      unpaid_reason: balance.unpaidReason,
      unpaid_duration_days: balance.unpaidDurationDays,
      used_paid_days: balance.usedPaidDays,
    });
  }

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
    eventType: `approval_${step.stepKey}_${decisionValue}`,
    message: isFinalDecision
      ? `Vacation request ${decisionValue} by ${step.stepKey}.`
      : `Vacation approval step ${step.stepKey} recorded as ${decisionValue}.`,
    metadata: {
      decisionComment: input.decisionComment ?? null,
      paymentStatus: updated.paymentStatus,
      stepKey: step.stepKey,
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
      hrDecision: updated.hrDecision,
      managerDecision: updated.managerDecision,
      paymentStatus: updated.paymentStatus,
      stepKey: step.stepKey,
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
    summary: isFinalDecision
      ? `Vacation request ${decisionValue} by approval workflow.`
      : `Vacation approval step ${step.stepKey} recorded as ${decisionValue}.`,
  });

  if (isFinalDecision) {
    void dispatchVacationDecision({ decision: input.decision, directory, request: updated }).catch(async (error) => {
      await insertVacationEvent({
        actorHrId: input.actorHrId,
        actorLoginId: input.actorLoginId,
        eventType: "notification_failed",
        message: vacationErrorMessage(error),
        requestId: updated.id,
      }).catch(() => undefined);
    });
  } else if (input.decision === "approve" && step.stepKey === "direct_manager") {
    // Direct manager approved a NON-final step → hand off to HR final review. Previously
    // this fired no notification at all (dispatchVacationManagerReview was dead `void`
    // code), so HR/the employee were never told the request had advanced. Best-effort.
    try {
      await dispatchVacationManagerReview({ decision: input.decision, directory, request: updated });
    } catch (error) {
      await insertVacationEvent({
        actorHrId: input.actorHrId,
        actorLoginId: input.actorLoginId,
        eventType: "notification_failed",
        message: vacationErrorMessage(error),
        requestId: updated.id,
      }).catch(() => undefined);
    }
  }

  invalidateExecutiveDashboardCache("leave request decision recorded", ["leave"]);
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
  // Sequential-workflow types (Annual/Other/Compensatory/Emergency) must be reviewed and actioned
  // inside the Vacation Action Center — token-based direct approval is disabled for them.
  if (isSequentialWorkflowType(request.vacationType)) {
    throw new Error("This request must be reviewed in the Vacation Action Center; email approval links are disabled for it.");
  }
  if (request.status !== "pending_manager") {
    throw new Error("This email approval link is no longer valid because the request is not pending direct manager review.");
  }
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

export async function resubmitVacationRequest(access: AccessContext, input: { requestId: string }) {
  await assertPermission(access, "leave", "create");
  const request = await fetchVacationRequestById(input.requestId);
  if (!request) throw new Error("Vacation request was not found.");
  if (request.status !== "returned") {
    throw new Error("Only returned vacation requests can be resubmitted.");
  }
  const actorHrId = resolveEmployeeIdentityId(access);
  if (!hrIdsMatch(actorHrId, request.employeeHrId)) {
    throw new Error("Forbidden: only the employee who submitted this request can resubmit it.");
  }

  const now = new Date().toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from(vacationRequestsTable)
    .update({ status: "pending_manager", updated_at: now })
    .eq("id", request.id)
    .eq("status", "returned")
    .select("*")
    .single();
  if (error) throw new Error(typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error));
  if (!data) throw new Error("Vacation request was updated by another user. Refresh and try again.");
  const resubmitted = mapVacationRow(data as VacationRequestDbRow);

  await insertVacationEvent({
    actorHrId,
    actorLoginId: access.loginId,
    eventType: "employee_resubmitted",
    message: "Employee resubmitted the vacation request for manager review.",
    requestId: resubmitted.id,
  });
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? actorHrId ?? "system",
    entityId: resubmitted.id,
    entityType: "vacation_request",
    newValues: { status: "pending_manager" },
    oldValues: { status: "returned" },
    summary: "Vacation request resubmitted by employee.",
  });
  void notifyRecipients({
    channels: ["in_app", "telegram"],
    href: `/leave-management/vacation-action-center?requestId=${encodeURIComponent(resubmitted.id)}`,
    message: `${resubmitted.employeeName}'s ${vacationTypeLabel(resubmitted.vacationType)} vacation request (${resubmitted.startDate} → ${resubmitted.endDate}) has been resubmitted and is pending your review.`,
    metadata: { requestId: resubmitted.id, status: "pending_manager" },
    recipients: [resubmitted.managerHrId, resubmitted.managerOfManagerHrId].filter(Boolean) as string[],
    requestId: resubmitted.id,
    title: "Vacation request resubmitted",
    type: "resubmit",
  }).catch(() => undefined);
  // Employee resubmit confirmation — 3-channel requirement (previously zero channels for the employee).
  void notifyRecipients({
    channels: ["in_app", "telegram"],
    href: `/employee-portals/vacation-report?requestId=${encodeURIComponent(resubmitted.id)}`,
    message: `Your ${vacationTypeLabel(resubmitted.vacationType)} request (${resubmitted.startDate} → ${resubmitted.endDate}) has been resubmitted and is pending manager review.`,
    metadata: { requestId: resubmitted.id, status: "pending_manager" },
    recipients: [resubmitted.employeeHrId],
    requestId: resubmitted.id,
    title: "Your vacation request has been resubmitted",
    type: "employee_resubmit_confirm",
  }).catch(() => undefined);
  if (resubmitted.employeeWorkEmail) {
    void sendVacationResubmitConfirmationEmail({
      employeeEmail: resubmitted.employeeWorkEmail,
      request: resubmitted,
    }).catch(() => undefined);
  }

  invalidateExecutiveDashboardCache("leave request resubmitted", ["leave"]);
  return resubmitted;
}

export async function assignVacationManagementApprover(
  access: AccessContext,
  input: { approverHrId: string; requestId: string },
) {
  await assertVacationAdminManagement(access, "update");
  const approverHrId = canonicalHrId(input.approverHrId);
  if (!approverHrId) throw new Error("A valid management approver is required.");

  const request = await fetchVacationRequestById(input.requestId);
  if (!request) throw new Error("Vacation request was not found.");
  if (!isSequentialWorkflowType(request.vacationType)) {
    throw new Error("Approver assignment only applies to Annual, Other, and Compensatory requests.");
  }
  if (request.status !== "needs_assignment") {
    throw new Error("This vacation request does not need an approver assignment.");
  }

  const directory = await getEmployeeDirectory();
  const approver = findEmployeeByHrId(directory, approverHrId);
  if (!approver) {
    throw new Error("The selected approver is not available in the employee directory.");
  }

  // Create the first management approval step, then resume the flow at pending_manager.
  await createVacationApprovalSteps({
    approvers: [
      {
        email: approver.workEmail,
        hrId: approver.hrId,
        name: approver.fullName,
        stepKey: "direct_manager",
        userId: null,
      },
    ],
    requestId: request.id,
  });

  const now = new Date().toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from(vacationRequestsTable)
    .update({
      manager_hr_id: approver.hrId,
      manager_name: approver.fullName,
      status: "pending_manager",
      updated_at: now,
    })
    .eq("id", request.id)
    .eq("status", "needs_assignment")
    .select("*")
    .single();
  if (error) throw new Error(typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error));
  const updated = mapVacationRow(data as VacationRequestDbRow);

  await insertVacationEvent({
    actorHrId: resolveEmployeeIdentityId(access),
    actorLoginId: access.loginId,
    eventType: "manager_assigned",
    message: `HR assigned ${approver.fullName} as the first management approver.`,
    metadata: { approverHrId: approver.hrId, genericStep: "management_approval_1" },
    requestId: updated.id,
  });
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? resolveEmployeeIdentityId(access) ?? "system",
    entityId: updated.id,
    entityType: "vacation_request",
    newValues: { managerHrId: approver.hrId, status: updated.status },
    oldValues: { managerHrId: request.managerHrId, status: request.status },
    summary: `HR assigned management approver ${approver.fullName}.`,
  });

  invalidateExecutiveDashboardCache("leave request approver assigned", ["leave"]);
  return updated;
}

// Returns request IDs where the actor has a pending approval step assignment.
// Used to surface requests that are outside the actor's normal visibility scope
// (e.g. a Marketing Manager assigned as manager_of_manager for an employee on a
// different product line — LINE scope blocks the canSeeVacation fallback, but the
// Approval Hub must still show requests where the actor is explicitly assigned).
async function fetchActorPendingApprovalStepRequestIds(access: AccessContext): Promise<string[]> {
  const candidates = accessIdentityCandidates(access);
  if (candidates.length === 0) return [];
  const { data, error } = await getSupabaseAdmin()
    .from(vacationApprovalStepsTable)
    .select("request_id, approver_hr_id, approver_user_id")
    .eq("status", "pending");
  if (error || !data) return [];
  const requestIds = new Set<string>();
  for (const row of data as Array<{ request_id: string; approver_hr_id: string | null; approver_user_id: string | null }>) {
    const approverHrId = normalizeHrIdForAccess(row.approver_hr_id);
    const approverUserId = (row.approver_user_id ?? "").toLowerCase();
    const hrMatch = Boolean(approverHrId) && candidates.some((c) => c === approverHrId);
    const loginMatch = Boolean(approverUserId) && (access.loginId ?? "").toLowerCase() === approverUserId;
    if (hrMatch || loginMatch) requestIds.add(row.request_id);
  }
  return Array.from(requestIds);
}

export async function getVacationActionCenterData(access: AccessContext): Promise<VacationActionCenterData> {
  await assertPermission(access, "leave", "read");
  const isHrActor = isAllVacationVisibility(access);
  const [report, directory] = await Promise.all([
    getVacationReportData(access, { status: "all" }),
    getEmployeeDirectory(),
  ]);

  const actionableStatuses = new Set(["needs_assignment", "pending_manager", "pending_hr"]);
  const candidateRows: typeof report.rows = report.rows.filter((row) => actionableStatuses.has(row.status));

  // Supplemental: surface requests where the actor is an explicit pending approver
  // but is outside their normal visibility scope (e.g. a LINE-scoped Marketing Manager
  // acting as manager_of_manager for an employee on a different product line).
  // HR actors already see all actionable requests via the scoped report.
  if (!isHrActor) {
    const actorPendingIds = await fetchActorPendingApprovalStepRequestIds(access);
    const existingIds = new Set(candidateRows.map((row) => row.id));
    const extraIds = actorPendingIds.filter((id) => !existingIds.has(id));
    if (extraIds.length > 0) {
      const { data: extraData } = await getSupabaseAdmin()
        .from(vacationRequestsTable)
        .select("*")
        .in("id", extraIds)
        .in("status", Array.from(actionableStatuses));
      if (extraData && extraData.length > 0) {
        const extraMapped = await markVacationDecisionAccess(
          access,
          (extraData as VacationRequestDbRow[]).map((row) => mapVacationRow(row)),
        );
        const extraEnriched = await enrichVacationRows(extraMapped);
        for (const row of extraEnriched) {
          candidateRows.push({ ...row, overlapWarnings: [] });
        }
      }
    }
  }

  const stepsByRequest = await fetchVacationApprovalStepsForRequests(candidateRows.map((row) => row.id));

  const titleOf = (hrId: string | null) => {
    const employee = findEmployeeByHrId(directory, hrId);
    return employee ? employeeVacationPolicyTitle(employee) : null;
  };

  const rows: VacationActionCenterRow[] = [];
  for (const row of candidateRows) {
    // The Action Center governs the sequential workflow (Annual/Other/Compensatory) only.
    if (!isSequentialWorkflowType(row.vacationType)) continue;

    const rawSteps = (stepsByRequest.get(row.id) ?? []).slice().sort((a, b) => a.stepOrder - b.stepOrder);
    const stepStates: VacationApprovalStepState[] = rawSteps.map((step) => ({
      order: step.stepOrder,
      status: step.status,
      stepKey: step.stepKey,
    }));

    const actorRawStep = rawSteps.find((step) => step.status === "pending" && approvalStepMatchesAccess(access, step)) ?? null;
    // Show rows the caller is an assigned pending approver of, or (HR) any actionable row.
    if (!actorRawStep && !isHrActor) continue;

    const titles: Partial<Record<VacationWorkflowStepKey, string | null>> = {};
    for (const step of rawSteps) titles[step.stepKey] = titleOf(step.approverHrId);

    const activeStep = resolveActiveStep(stepStates);
    const activeRawStep = activeStep ? rawSteps.find((step) => step.stepKey === activeStep.stepKey) ?? null : null;

    const actionAvailability: VacationActionAvailability = resolveActionAvailability({
      status: row.status,
      steps: stepStates,
      actorStep: actorRawStep ? { stepKey: actorRawStep.stepKey, order: actorRawStep.stepOrder } : null,
      isHrActor,
    });

    rows.push({
      ...row,
      stageLabel: resolveStageLabel({ status: row.status, vacationType: row.vacationType, steps: stepStates, titles }),
      workflowSequential: true,
      genericActiveStep: activeStep ? genericStepName(activeStep.stepKey) : null,
      approvalSteps: rawSteps.map((step) => ({
        order: step.stepOrder,
        status: step.status,
        stepKey: step.stepKey,
        approverHrId: step.approverHrId,
        approverName: findEmployeeByHrId(directory, step.approverHrId)?.fullName ?? null,
        approverTitle: titleOf(step.approverHrId),
        decidedAt: step.decidedAt,
        decisionComment: step.decisionComment,
        genericStep: genericStepName(step.stepKey),
      })),
      assignedActorName: activeRawStep
        ? findEmployeeByHrId(directory, activeRawStep.approverHrId)?.fullName ?? activeRawStep.approverHrId
        : null,
      assignedActorTitle: activeRawStep ? titleOf(activeRawStep.approverHrId) : null,
      actionAvailability,
      slaAgeDays: row.slaStatus.businessDaysPending,
      viewerStepKind: actorRawStep
        ? actorRawStep.stepKey === "hr"
          ? "hr"
          : "management"
        : isHrActor
          ? "hr"
          : "none",
    });
  }

  return { canAssign: isHrActor, generatedAt: new Date().toISOString(), rows };
}

function assertVacationControlAuthority(access: AccessContext) {
  if (!isHrAuthorityRole(access.role)) {
    throw new Error("Forbidden: only HR authority roles can manage vacation control.");
  }
}

export async function getVacationControlData(access: AccessContext): Promise<VacationControlData> {
  assertVacationControlAuthority(access);
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
  assertVacationControlAuthority(access);
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
    entityType: "vacation_weekly_off_policy",
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
  if (normalized === "return" || normalized === "returned") return "return";
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

  const managerSource = employees
    ? employees
        .filter((employee) => employee.managerHrId)
        .map((employee) => ({
          label: `${employee.managerName ?? employee.managerHrId} (${employee.managerHrId})`,
          value: employee.managerHrId ?? "",
        }))
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

type VacationReportQuery = {
  eq: (column: string, value: unknown) => VacationReportQuery;
  gte: (column: string, value: unknown) => VacationReportQuery;
  ilike: (column: string, value: string) => VacationReportQuery;
  in: (column: string, values: string[]) => VacationReportQuery;
  lte: (column: string, value: unknown) => VacationReportQuery;
};

function applyVacationReportDatabaseFilters(
  query: VacationReportQuery,
  filters: VacationReportFilters,
  visibleEmployeeHrIds: Set<string>,
  shouldScopeEmployees: boolean,
) {
  let scopedQuery = query;

  if (filters.status && filters.status !== "all") scopedQuery = scopedQuery.eq("status", filters.status);
  if (filters.paymentStatus && filters.paymentStatus !== "all") scopedQuery = scopedQuery.eq("payment_status", filters.paymentStatus);
  if (filters.vacationType && filters.vacationType !== "all") scopedQuery = scopedQuery.eq("vacation_type", filters.vacationType);
  if (filters.employee) scopedQuery = scopedQuery.eq("employee_hr_id", filters.employee.toUpperCase());
  if (filters.manager) scopedQuery = scopedQuery.eq("manager_hr_id", filters.manager.toUpperCase());
  if (filters.department) scopedQuery = scopedQuery.eq("department_name", filters.department);
  if (filters.line) scopedQuery = scopedQuery.eq("line_name", filters.line);
  if (filters.dateFrom) scopedQuery = scopedQuery.gte("start_date", filters.dateFrom);
  if (filters.dateTo) scopedQuery = scopedQuery.lte("start_date", filters.dateTo);

  if (shouldScopeEmployees) {
    const employeeIds = Array.from(visibleEmployeeHrIds);
    scopedQuery = scopedQuery.in("employee_hr_id", employeeIds.length > 0 ? employeeIds : ["__no_visible_employees__"]);
  }

  return scopedQuery;
}

async function fetchVacationReportRowsFromDatabase(input: {
  access: AccessContext;
  filters: VacationReportFilters;
  visibleEmployeeHrIds: Set<string>;
}) {
  const pageSize = 1000;
  const rows: VacationRequestDbRow[] = [];
  const shouldScopeEmployees = !isAllVacationVisibility(input.access);
  const scopedEmployeeIds = shouldScopeEmployees ? Array.from(input.visibleEmployeeHrIds) : null;

  try {
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await getSupabaseAdmin().rpc("phx_vacation_report_rows", {
        p_filters: input.filters,
        p_limit: pageSize,
        p_offset: offset,
        p_visible_employee_hr_ids: scopedEmployeeIds,
      });
      if (error) throwVacationDatabaseError(error);
      const page = (data ?? []) as VacationRequestDbRow[];
      rows.push(...page);
      if (page.length < pageSize) return rows;
    }
  } catch (error) {
    if (!isVacationSchemaMissingError(error)) throw error;
    rows.length = 0;
  }

  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const query = applyVacationReportDatabaseFilters(
      getSupabaseAdmin()
        .from(vacationRequestsTable)
        .select("*")
        .order("created_at", { ascending: false })
        .range(from, to) as unknown as VacationReportQuery,
      input.filters,
      input.visibleEmployeeHrIds,
      shouldScopeEmployees,
    );

    const { data, error } = await (query as unknown as PromiseLike<{
      data: VacationRequestDbRow[] | null;
      error: { message?: string } | null;
    }>);
    if (error) throw new Error(typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error));

    const page = (data ?? []) as VacationRequestDbRow[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }

  return rows;
}

async function fetchVacationSlaSettings() {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from(vacationSlaSettingsTable)
      .select("manager_pending_business_days,hr_pending_business_days,reminder_interval_days")
      .eq("id", true)
      .maybeSingle();
    if (error) throwVacationDatabaseError(error);
    return mapSlaSettings(data as VacationSlaSettingsDbRow | null);
  } catch (error) {
    if (!isVacationSchemaMissingError(error)) throw error;
    return defaultVacationSlaSettings();
  }
}

async function fetchLatestVacationSlaRun() {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from(vacationSlaRunsTable)
      .select("*")
      .order("run_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throwVacationDatabaseError(error);
    return data as VacationSlaRunDbRow | null;
  } catch (error) {
    if (!isVacationSchemaMissingError(error)) throw error;
    return null;
  }
}

async function enrichVacationRows(rows: VacationRequestRecord[]) {
  const requestIds = rows.map((row) => row.id);
  const [reviewsByRequest, eventsByRequest, settings] = await Promise.all([
    fetchEvidenceReviewsForRequests(requestIds),
    fetchVacationEventsForRequests(requestIds),
    fetchVacationSlaSettings(),
  ]);
  const now = new Date();
  return rows.map((row) => {
    const events = eventsByRequest.get(row.id) ?? [];
    const reviews = reviewsByRequest.get(row.id) ?? [];
    return {
      ...row,
      evidenceReviews: reviews,
      slaStatus: buildVacationSlaStatus({
        events,
        now,
        request: {
          created_at: row.createdAt,
          manager_decision_at: row.managerDecisionAt,
          status: row.status,
        } as VacationRequestDbRow,
        settings,
      }),
      timelineEventCount: events.length + reviews.length,
    };
  });
}

async function fetchHolidaysForRows(rows: VacationRequestRecord[]) {
  const dates = rows.flatMap((row) => [row.startDate, row.endDate]);
  const holidays: EgyptianNationalHoliday[] = [];
  for (const period of holidayMonthKeysForDates(dates)) {
    const result = await getEgyptianNationalHolidays(period).catch(() => null);
    if (result?.connected) holidays.push(...result.holidays);
  }
  return holidays;
}

// Pure-core overlap rollup. Operates on already-fetched rows/holidays; testable
// without DB (see tests/vacation-overlap-warnings.test.ts).
export function buildVacationOverlapWarnings(input: {
  holidays: EgyptianNationalHoliday[];
  rows: VacationRequestRecord[];
}): Map<string, VacationOverlapWarning[]> {
  const warnings = new Map<string, VacationOverlapWarning[]>();
  const activeRows = input.rows.filter((row) => row.status !== "rejected");
  const push = (requestId: string, warning: VacationOverlapWarning) => {
    warnings.set(requestId, [...(warnings.get(requestId) ?? []), warning]);
  };

  // Index active rows by canonical employeeHrId and canonical managerHrId so each
  // row's overlap checks below only scan that employee's/manager's own small group
  // instead of re-filtering every active row for every row (was O(n^2) on the full
  // vacation report). Bucket membership is exactly equivalent to the hrIdsMatch()
  // checks the previous per-row filters used, since both compare canonical HR_IDs.
  const rowsByEmployeeCanonical = new Map<string, VacationRequestRecord[]>();
  const rowsByManagerCanonical = new Map<string, VacationRequestRecord[]>();
  for (const row of activeRows) {
    const employeeCanonical = canonicalHrId(row.employeeHrId);
    if (employeeCanonical) {
      const bucket = rowsByEmployeeCanonical.get(employeeCanonical);
      if (bucket) bucket.push(row);
      else rowsByEmployeeCanonical.set(employeeCanonical, [row]);
    }
    const managerCanonical = canonicalHrId(row.managerHrId);
    if (managerCanonical) {
      const bucket = rowsByManagerCanonical.get(managerCanonical);
      if (bucket) bucket.push(row);
      else rowsByManagerCanonical.set(managerCanonical, [row]);
    }
  }

  for (const row of activeRows) {
    if ((row.vacationType === "sick" || row.vacationType === "compensatory") && !hasAcceptedRequiredEvidence(row)) {
      push(row.id, {
        code: "evidence_required",
        message: "Required evidence is missing, rejected, or still waiting for HR review.",
        relatedRequestIds: [row.id],
        severity: "warning",
      });
    }

    const adjacentHoliday = input.holidays.find((holiday) => {
      const holidayStart = holiday.startDate;
      const holidayEnd = holiday.endDate ?? holiday.startDate;
      return addDaysToDateOnly(row.endDate, 1) === holidayStart || addDaysToDateOnly(row.startDate, -1) === holidayEnd;
    });
    if (adjacentHoliday) {
      push(row.id, {
        code: "holiday_adjacent",
        message: `Request is adjacent to national holiday: ${adjacentHoliday.name}.`,
        relatedRequestIds: [row.id],
        severity: "info",
      });
    }

    const employeeCanonical = canonicalHrId(row.employeeHrId);
    const managerCanonical = canonicalHrId(row.managerHrId);

    const relatedEmployeeRows = (
      (employeeCanonical ? rowsByEmployeeCanonical.get(employeeCanonical) : undefined) ?? []
    ).filter((other) =>
      other.id !== row.id &&
      dateRangesOverlap(row.startDate, row.endDate, other.startDate, other.endDate)
    );
    if (relatedEmployeeRows.length > 0) {
      push(row.id, {
        code: "employee_overlap",
        message: "Same employee has another active vacation request in this period.",
        relatedRequestIds: relatedEmployeeRows.map((other) => other.id),
        severity: "warning",
      });
    }

    const relatedTeamRows = (
      (managerCanonical ? rowsByManagerCanonical.get(managerCanonical) : undefined) ?? []
    ).filter((other) =>
      other.id !== row.id &&
      !hrIdsMatch(other.employeeHrId, row.employeeHrId) &&
      dateRangesOverlap(row.startDate, row.endDate, other.startDate, other.endDate)
    );
    if (relatedTeamRows.length > 0) {
      push(row.id, {
        code: "team_overlap",
        message: "The same manager/team has concurrent leave requests in this period.",
        relatedRequestIds: relatedTeamRows.map((other) => other.id),
        severity: "info",
      });
    }

    const managerAbsence = (
      (managerCanonical ? rowsByEmployeeCanonical.get(managerCanonical) : undefined) ?? []
    ).filter((other) =>
      other.id !== row.id &&
      dateRangesOverlap(row.startDate, row.endDate, other.startDate, other.endDate)
    );
    if (managerAbsence.length > 0) {
      push(row.id, {
        code: "manager_absent",
        message: "The direct manager appears to be absent during this request period.",
        relatedRequestIds: managerAbsence.map((other) => other.id),
        severity: "warning",
      });
    }
  }

  return warnings;
}

function buildVacationDashboardData(input: {
  latestSlaRun: VacationSlaRunDbRow | null;
  rows: VacationRequestRecord[];
}): VacationDashboardData {
  const rows = input.rows;
  const pendingManager = rows.filter((row) => row.status === "pending_manager");
  const pendingHr = rows.filter((row) => row.status === "pending_hr");
  const overdueManager = pendingManager.filter((row) => row.slaStatus.isOverdue);
  const overdueHr = pendingHr.filter((row) => row.slaStatus.isOverdue);
  const reviews = rows.flatMap((row) => row.evidenceReviews);

  const managerBottleneckMap = new Map<string, { managerHrId: string | null; managerName: string | null; overdue: number; pending: number }>();
  for (const row of [...pendingManager, ...pendingHr]) {
    const key = canonicalHrId(row.managerHrId) ?? row.managerName ?? "unassigned";
    const current = managerBottleneckMap.get(key) ?? { managerHrId: row.managerHrId, managerName: row.managerName, overdue: 0, pending: 0 };
    current.pending += 1;
    if (row.slaStatus.isOverdue) current.overdue += 1;
    managerBottleneckMap.set(key, current);
  }

  const daysBy = (field: "departmentName" | "lineName") => {
    const map = new Map<string, number>();
    for (const row of rows.filter((request) => request.status !== "rejected")) {
      const key = row[field] ?? "Unassigned";
      map.set(key, (map.get(key) ?? 0) + row.durationDays);
    }
    return Array.from(map.entries())
      .map(([name, days]) => field === "departmentName"
        ? { departmentName: name, days }
        : { lineName: name, days })
      .sort((left, right) => right.days - left.days)
      .slice(0, 8);
  };

  return {
    dailyEscalationRunStatus: {
      finishedAt: input.latestSlaRun?.finished_at ?? null,
      runDate: input.latestSlaRun?.run_date ?? null,
      status:
        input.latestSlaRun?.status === "completed" ||
        input.latestSlaRun?.status === "failed" ||
        input.latestSlaRun?.status === "running"
          ? input.latestSlaRun.status
          : "not_run",
    },
    evidence: {
      accepted: reviews.filter((review) => review.status === "accepted").length,
      needsFollowUp: reviews.filter((review) => review.status === "needs_follow_up").length,
      pending: reviews.filter((review) => review.status === "pending").length,
      rejected: reviews.filter((review) => review.status === "rejected").length,
    },
    leaveDaysByDepartment: daysBy("departmentName") as VacationDashboardData["leaveDaysByDepartment"],
    leaveDaysByLine: daysBy("lineName") as VacationDashboardData["leaveDaysByLine"],
    managerBottlenecks: Array.from(managerBottleneckMap.values())
      .sort((left, right) => right.overdue - left.overdue || right.pending - left.pending)
      .slice(0, 8),
    overlapWarnings: rows.reduce((sum, row) => sum + row.overlapWarnings.length, 0),
    overdueBySla: {
      hr: overdueHr.length,
      manager: overdueManager.length,
      total: overdueHr.length + overdueManager.length,
    },
    pendingByStage: {
      hr: pendingHr.length,
      manager: pendingManager.length,
      total: pendingHr.length + pendingManager.length,
    },
  };
}

export async function createVacationAttachmentReviewUrl(access: AccessContext, input: {
  attachmentKind: "compensatory" | "sick";
  requestId: string;
}) {
  await assertPermission(access, "leave", "read");
  if (!isAllVacationVisibility(access)) {
    throw new Error("Forbidden: only HR or Super Admin can review vacation evidence attachments.");
  }

  const request = await fetchVacationRequestById(input.requestId);
  if (!request) throw new Error("Vacation request was not found.");

  const attachment = input.attachmentKind === "sick"
    ? {
        bucket: request.sickAttachmentBucket,
        contentType: request.sickAttachmentContentType,
        fileName: request.sickAttachmentOriginalName,
        objectPath: request.sickAttachmentObjectPath,
      }
    : {
        bucket: request.compensatoryAttachmentBucket,
        contentType: request.compensatoryAttachmentContentType,
        fileName: request.compensatoryAttachmentOriginalName,
        objectPath: request.compensatoryAttachmentObjectPath,
      };

  if (!attachment.objectPath) {
    throw new Error("Vacation evidence attachment was not found for this request.");
  }

  const bucket = attachment.bucket ?? vacationAttachmentBucket;
  const { data, error } = await getSupabaseAdmin().storage
    .from(bucket)
    .createSignedUrl(attachment.objectPath, 5 * 60);

  if (error || !data?.signedUrl) {
    throw new Error(`Unable to open vacation evidence attachment: ${error?.message ?? "signed URL was not created"}`);
  }

  return {
    contentType: attachment.contentType,
    fileName: attachment.fileName,
    signedUrl: data.signedUrl,
  };
}

export async function reviewVacationEvidence(access: AccessContext, input: {
  evidenceType: unknown;
  requestId: string;
  reviewNote?: unknown;
  status: unknown;
}) {
  await assertPermission(access, "leave", "approve");
  if (!isAllVacationVisibility(access)) {
    throw new Error("Forbidden: only HR or Super Admin can review vacation evidence.");
  }

  const evidenceType = normalizeEvidenceType(input.evidenceType);
  const status = normalizeEvidenceReviewStatus(input.status);
  if (!evidenceType) throw new Error("Evidence type is invalid.");
  if (!status || status === "pending") throw new Error("Evidence review decision is invalid.");

  const request = await fetchVacationRequestById(input.requestId);
  if (!request) throw new Error("Vacation request was not found.");

  const hasEvidence = evidenceType === "sick"
    ? Boolean(request.sickAttachmentObjectPath)
    : Boolean(request.compensatoryAttachmentObjectPath);
  if (!hasEvidence) throw new Error("No uploaded evidence was found for this request.");

  const now = new Date().toISOString();
  const actorHrId = resolveEmployeeIdentityId(access);
  const { data, error } = await getSupabaseAdmin()
    .from(vacationEvidenceReviewsTable)
    .upsert({
      evidence_type: evidenceType,
      request_id: request.id,
      review_note: nullableText(input.reviewNote),
      reviewed_at: now,
      reviewed_by_hr_id: actorHrId,
      status,
      updated_at: now,
    }, { onConflict: "request_id,evidence_type" })
    .select("*")
    .single();
  if (error) throwVacationDatabaseError(error);
  const review = mapEvidenceReview(data as VacationEvidenceReviewDbRow);

  await insertVacationEvent({
    actorHrId,
    actorLoginId: access.loginId,
    eventType: "evidence_reviewed",
    message: `Vacation evidence ${status.replace(/_/g, " ")} by HR.`,
    metadata: {
      evidenceType,
      reviewNote: review.reviewNote,
      status,
    },
    requestId: request.id,
  });

  return review;
}

export async function getVacationRequestTimeline(access: AccessContext, requestId: string): Promise<VacationTimelineEvent[]> {
  await assertPermission(access, "leave", "read");
  const request = await fetchVacationRequestById(requestId);
  if (!request) throw new Error("Vacation request was not found.");

  const activeEmployees = await getEmployeeDirectoryRows();
  const visibleEmployees = filterVacationEmployeesForAccess(access, activeEmployees);
  const visibleEmployeeHrIds = buildVisibleHrIdSet(visibleEmployees);
  if (!canSeeVacation(access, request, visibleEmployeeHrIds)) {
    throw new Error("Forbidden: you cannot view this vacation request.");
  }

  const eventMap = await fetchVacationEventsForRequests([request.id]);
  return buildVacationTimelineEntries({
    eventsByRequest: eventMap,
    rows: [request],
  });
}

function buildVacationTimelineEntries(input: {
  eventsByRequest: Map<string, VacationTimelineEvent[]>;
  rows: VacationRequestRecord[];
}) {
  const timeline: VacationTimelineEvent[] = [];

  for (const request of input.rows) {
    timeline.push(...(input.eventsByRequest.get(request.id) ?? []));
    timeline.push(...request.evidenceReviews.map((review) => ({
      actorHrId: review.reviewedByHrId,
      actorLoginId: null,
      createdAt: review.reviewedAt ?? review.createdAt,
      eventType: "evidence_reviewed",
      id: `evidence:${review.id}`,
      message: `${review.evidenceType} evidence review status: ${review.status}.`,
      metadata: {
        evidenceType: review.evidenceType,
        reviewNote: review.reviewNote,
        requestId: request.id,
        status: review.status,
      },
      source: "evidence",
    } satisfies VacationTimelineEvent)));

    if (request.managerDecisionAt) {
      timeline.push({
        actorHrId: request.managerDecisionByHrId,
        actorLoginId: null,
        createdAt: request.managerDecisionAt,
        eventType: `manager_${request.managerDecision ?? "decision"}`,
        id: `decision:manager:${request.id}`,
        message: `Manager decision: ${request.managerDecision ?? "recorded"}.`,
        metadata: { decisionComment: request.managerDecisionComment, requestId: request.id },
        source: "decision",
      });
    }
    if (request.hrDecisionAt) {
      timeline.push({
        actorHrId: request.hrDecisionByHrId,
        actorLoginId: null,
        createdAt: request.hrDecisionAt,
        eventType: `hr_${request.hrDecision ?? "decision"}`,
        id: `decision:hr:${request.id}`,
        message: `HR final decision: ${request.hrDecision ?? "recorded"}.`,
        metadata: { decisionComment: request.hrDecisionComment, requestId: request.id },
        source: "decision",
      });
    }
  }

  return timeline
    .filter((event) => event.createdAt)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function addWorksheetRows<T extends Record<string, unknown>>(workbook: ExcelJS.Workbook, name: string, rows: T[]) {
  const worksheet = workbook.addWorksheet(name);
  const headers = rows.length > 0 ? Object.keys(rows[0]) : ["No data"];
  worksheet.addRow(headers);
  for (const row of rows) worksheet.addRow(headers.map((header) => row[header] ?? ""));
  worksheet.getRow(1).font = { bold: true };
  worksheet.columns = headers.map((header) => ({ header, key: header, width: Math.max(16, header.length + 2) }));
  return worksheet;
}

export async function generateVacationAuditExportWorkbook(access: AccessContext, filters: VacationReportFilters = {}) {
  await assertPermission(access, "leave", "export");
  const report = await getVacationReportData(access, filters);
  if (report.rows.length > vacationAuditExportMaxRows) {
    throw new Error(`Vacation audit export is limited to ${vacationAuditExportMaxRows} rows. Narrow the filters before exporting.`);
  }
  const eventsByRequest = await fetchVacationEventsForRequests(report.rows.map((row) => row.id));
  const timelineEntries = buildVacationTimelineEntries({
    eventsByRequest,
    rows: report.rows,
  });
  const metadata: VacationAuditExportMetadata = {
    actorHrId: resolveEmployeeIdentityId(access),
    actorLoginId: access.loginId ?? null,
    exportedAt: new Date().toISOString(),
    filters: report.filters,
    rowCount: report.rows.length,
    scope: getVacationVisibilityScope(access),
  };

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.company = "Phoenix Workforce";
  workbook.subject = "Vacation Audit Export";
  workbook.title = "Vacation Audit Export";
  workbook.created = new Date(metadata.exportedAt);
  workbook.modified = new Date(metadata.exportedAt);

  addWorksheetRows(workbook, "Requests", report.rows.map((row) => ({
    requestId: row.id,
    displayId: vacationRequestDisplayId(row.id),
    employeeHrId: row.employeeHrId,
    employeeName: row.employeeName,
    department: row.departmentName,
    line: row.lineName,
    managerHrId: row.managerHrId,
    managerName: row.managerName,
    vacationType: row.vacationType,
    status: row.status,
    startDate: row.startDate,
    endDate: row.endDate,
    durationDays: row.durationDays,
    paymentStatus: row.paymentStatus,
    managerDecision: row.managerDecision,
    managerDecisionAt: row.managerDecisionAt,
    hrDecision: row.hrDecision,
    hrDecisionAt: row.hrDecisionAt,
    evidenceStatus: row.evidenceReviews.map((review) => `${review.evidenceType}:${review.status}`).join("; "),
    auditWarnings: row.overlapWarnings.map((warning) => warning.code).join("; "),
  })));

  addWorksheetRows(workbook, "Timeline", timelineEntries.map((event) => ({
    requestId: typeof event.metadata.requestId === "string" ? event.metadata.requestId : "",
    actorHrId: event.actorHrId,
    actorLoginId: event.actorLoginId,
    createdAt: event.createdAt,
    eventType: event.eventType,
    message: event.message,
    source: event.source,
  })));

  addWorksheetRows(workbook, "Evidence Reviews", report.rows.flatMap((row) => row.evidenceReviews.map((review) => ({
    requestId: review.requestId,
    evidenceType: review.evidenceType,
    status: review.status,
    reviewedByHrId: review.reviewedByHrId,
    reviewedAt: review.reviewedAt,
    reviewNote: review.reviewNote,
    createdAt: review.createdAt,
  }))));

  addWorksheetRows(workbook, "Policy Snapshots", report.rows.map((row) => ({
    requestId: row.id,
    capturedAt: row.weeklyOffPolicySnapshot?.capturedAt ?? "",
    jobTitle: row.weeklyOffPolicySnapshot?.jobTitle ?? "",
    thursday: row.weeklyOffPolicySnapshot?.thursday ?? "",
    friday: row.weeklyOffPolicySnapshot?.friday ?? "",
    saturday: row.weeklyOffPolicySnapshot?.saturday ?? "",
    policyUpdatedAt: row.weeklyOffPolicySnapshot?.updatedAt ?? "",
  })));

  addWorksheetRows(workbook, "Export Metadata", [
    {
      actorHrId: metadata.actorHrId,
      actorLoginId: metadata.actorLoginId,
      exportedAt: metadata.exportedAt,
      filters: JSON.stringify(metadata.filters),
      rowCount: metadata.rowCount,
      scope: metadata.scope,
    },
  ]);

  return workbook;
}

export const vacationRetentionPolicyDefaults = {
  decisionTokensDays: 90,
  evidenceAttachmentsDays: 1095,
  requestHistoryDays: 2555,
  slaRunLogsDays: 365,
} as const;

type VacationRetentionPolicyKey = "decision_tokens" | "evidence_attachments" | "request_history" | "sla_run_logs";

type VacationRetentionPolicySnapshot = Record<VacationRetentionPolicyKey, number>;

function retentionCutoff(days: number) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

async function loadVacationRetentionPolicySnapshot(): Promise<VacationRetentionPolicySnapshot> {
  const fallback: VacationRetentionPolicySnapshot = {
    decision_tokens: vacationRetentionPolicyDefaults.decisionTokensDays,
    evidence_attachments: vacationRetentionPolicyDefaults.evidenceAttachmentsDays,
    request_history: vacationRetentionPolicyDefaults.requestHistoryDays,
    sla_run_logs: vacationRetentionPolicyDefaults.slaRunLogsDays,
  };

  try {
    const { data, error } = await getSupabaseAdmin()
      .from(vacationRetentionPoliciesTable)
      .select("policy_key,retention_days");
    if (error) throwVacationDatabaseError(error);

    for (const row of (data ?? []) as Array<{ policy_key?: string | null; retention_days?: number | string | null }>) {
      const key = row.policy_key as VacationRetentionPolicyKey;
      if (key in fallback) fallback[key] = Math.max(1, Number(row.retention_days ?? fallback[key]));
    }
  } catch (error) {
    if (!isVacationSchemaMissingError(error)) throw error;
  }

  return fallback;
}

async function retentionCount(table: string, column: string, cutoff: string) {
  try {
    const { count, error } = await getSupabaseAdmin()
      .from(table)
      .select("id", { count: "exact", head: true })
      .lt(column, cutoff);
    if (error) throwVacationDatabaseError(error);
    return count ?? 0;
  } catch (error) {
    if (!isVacationSchemaMissingError(error)) throw error;
    return 0;
  }
}

async function fetchEvidencePurgeCandidates(cutoff: string) {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from(vacationRequestsTable)
      .select("id,sick_attachment_object_path,compensatory_attachment_object_path,hr_decision_at,updated_at,created_at,status")
      .in("status", ["approved", "rejected"])
      .lt("hr_decision_at", cutoff)
      .or("sick_attachment_object_path.not.is.null,compensatory_attachment_object_path.not.is.null")
      .limit(500);
    if (error) throwVacationDatabaseError(error);
    return (data ?? []) as Array<{
      compensatory_attachment_object_path?: string | null;
      id: string;
      sick_attachment_object_path?: string | null;
    }>;
  } catch (error) {
    if (!isVacationSchemaMissingError(error)) throw error;
    return [];
  }
}

async function recordRetentionPurgeRun(input: {
  actorLoginId: string | null;
  candidates: Record<string, number>;
  deletedCounts: Record<string, number>;
  dryRun: boolean;
  errors: Array<Record<string, unknown>>;
  policySnapshot: VacationRetentionPolicySnapshot;
  status: "completed" | "failed";
}) {
  try {
    await getSupabaseAdmin()
      .from(vacationRetentionPurgeRunsTable)
      .insert({
        actor_login_id: input.actorLoginId,
        candidates: input.candidates,
        deleted_counts: input.deletedCounts,
        dry_run: input.dryRun,
        errors: input.errors,
        finished_at: new Date().toISOString(),
        policy_snapshot: input.policySnapshot,
        status: input.status,
      });
  } catch (error) {
    if (!isVacationSchemaMissingError(error)) throw error;
  }
}

export async function runVacationRetentionPurge(access: AccessContext, input: { dryRun?: boolean } = {}) {
  await assertPermission(access, "leave", "delete");
  if (!isAllVacationVisibility(access)) {
    throw new Error("Forbidden: only HR or Super Admin can run leave retention governance.");
  }

  const dryRun = input.dryRun !== false;
  const policySnapshot = await loadVacationRetentionPolicySnapshot();
  const cutoffs = {
    decision_tokens: retentionCutoff(policySnapshot.decision_tokens),
    evidence_attachments: retentionCutoff(policySnapshot.evidence_attachments),
    request_history: retentionCutoff(policySnapshot.request_history),
    sla_run_logs: retentionCutoff(policySnapshot.sla_run_logs),
  };
  const evidenceCandidates = await fetchEvidencePurgeCandidates(cutoffs.evidence_attachments);
  const candidates = {
    decisionTokens: await retentionCount(vacationTokensTable, "created_at", cutoffs.decision_tokens),
    evidenceAttachments: evidenceCandidates.length,
    requestEvents: await retentionCount(vacationEventsTable, "created_at", cutoffs.request_history),
    requestHistory: await retentionCount(vacationRequestsTable, "created_at", cutoffs.request_history),
    slaRunLogs: await retentionCount(vacationSlaRunsTable, "started_at", cutoffs.sla_run_logs),
  };
  const deletedCounts = {
    decisionTokens: 0,
    evidenceAttachments: 0,
    requestEvents: 0,
    requestHistory: 0,
    slaRunLogs: 0,
  };
  const errors: Array<Record<string, unknown>> = [];

  if (!dryRun) {
    try {
      const evidenceObjectPaths = evidenceCandidates.flatMap((row) => [
        row.sick_attachment_object_path,
        row.compensatory_attachment_object_path,
      ]).filter((value): value is string => Boolean(value));
      if (evidenceObjectPaths.length > 0) {
        const { error } = await getSupabaseAdmin().storage.from(vacationAttachmentBucket).remove(evidenceObjectPaths);
        if (error) throw error;
        deletedCounts.evidenceAttachments = evidenceObjectPaths.length;
      }

      for (const row of evidenceCandidates) {
        const { error } = await getSupabaseAdmin()
          .from(vacationRequestsTable)
          .update({
            compensatory_attachment_bucket: null,
            compensatory_attachment_content_type: null,
            compensatory_attachment_object_path: null,
            compensatory_attachment_original_name: null,
            compensatory_attachment_size_bytes: null,
            compensatory_attachment_uploaded_at: null,
            sick_attachment_bucket: null,
            sick_attachment_content_type: null,
            sick_attachment_object_path: null,
            sick_attachment_original_name: null,
            sick_attachment_size_bytes: null,
            sick_attachment_uploaded_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);
        if (error) throwVacationDatabaseError(error);
      }

      const { count: tokenCount, error: tokenError } = await getSupabaseAdmin()
        .from(vacationTokensTable)
        .delete({ count: "exact" })
        .lt("created_at", cutoffs.decision_tokens);
      if (tokenError) throwVacationDatabaseError(tokenError);
      deletedCounts.decisionTokens = tokenCount ?? 0;

      const { count: slaCount, error: slaError } = await getSupabaseAdmin()
        .from(vacationSlaRunsTable)
        .delete({ count: "exact" })
        .lt("started_at", cutoffs.sla_run_logs);
      if (slaError) throwVacationDatabaseError(slaError);
      deletedCounts.slaRunLogs = slaCount ?? 0;

      const { count: eventCount, error: eventError } = await getSupabaseAdmin()
        .from(vacationEventsTable)
        .delete({ count: "exact" })
        .lt("created_at", cutoffs.request_history);
      if (eventError) throwVacationDatabaseError(eventError);
      deletedCounts.requestEvents = eventCount ?? 0;

      const { count: requestCount, error: requestError } = await getSupabaseAdmin()
        .from(vacationRequestsTable)
        .delete({ count: "exact" })
        .lt("created_at", cutoffs.request_history);
      if (requestError) throwVacationDatabaseError(requestError);
      deletedCounts.requestHistory = requestCount ?? 0;
    } catch (error) {
      errors.push({ message: vacationErrorMessage(error) });
    }
  }

  const status = errors.length > 0 ? "failed" : "completed";
  await recordRetentionPurgeRun({
    actorLoginId: access.loginId ?? resolveEmployeeIdentityId(access),
    candidates,
    deletedCounts,
    dryRun,
    errors,
    policySnapshot,
    status,
  });

  return {
    candidates,
    deletedCounts,
    dryRun,
    errors,
    policySnapshot,
    status,
  };
}

function cairoDateOnly() {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(new Date());
}

async function startVacationSlaRun(runDate: string) {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from(vacationSlaRunsTable)
      .upsert({
        errors: [],
        finished_at: null,
        metadata: {},
        run_date: runDate,
        started_at: new Date().toISOString(),
        status: "running",
      }, { onConflict: "run_date" })
      .select("*")
      .single();
    if (error) throwVacationDatabaseError(error);
    return data as VacationSlaRunDbRow;
  } catch (error) {
    if (!isVacationSchemaMissingError(error)) throw error;
    return null;
  }
}

export async function runVacationSlaDaily(access: AccessContext = systemAccessContext) {
  await assertPermission(access, "leave", "read");
  const runDate = cairoDateOnly();
  const run = await startVacationSlaRun(runDate);
  const report = await getVacationReportData(systemAccessContext, { status: "all" });
  const pendingRows = report.rows.filter(
    (row) => row.status === "pending_manager" || row.status === "pending_hr" || row.status === "needs_assignment",
  );
  const overdueRows = pendingRows.filter((row) => row.slaStatus.isOverdue);
  let managerReminders = 0;
  let managerEscalations = 0;
  let hrReminders = 0;
  let hrEscalations = 0;
  const errors: Array<{ message: string; requestId: string }> = [];
  const directory = await getEmployeeDirectory();
  const hrRecipients = await getHrRecipients(directory);

  for (const row of overdueRows) {
    try {
      const needsAssignment = row.status === "needs_assignment";
      const isManagerStage = row.status === "pending_manager";
      const allHr = hrRecipients.filter((recipient) => recipient.hrId).map((recipient) => recipient.hrId);
      // needs_assignment → remind HR to assign an approver; manager stage → the assigned manager
      // (escalate to manager-of-manager); HR stage → the HR acknowledgement users.
      const escalationRecipients = needsAssignment ? allHr : isManagerStage ? [row.managerOfManagerHrId] : allHr;
      const reminderRecipients = needsAssignment ? allHr : isManagerStage ? [row.managerHrId] : allHr;
      const recipients = Array.from(new Set([...reminderRecipients, ...escalationRecipients].filter(Boolean) as string[]));
      const reviewHref = isSequentialWorkflowType(row.vacationType)
        ? `/leave-management/vacation-action-center?requestId=${encodeURIComponent(row.id)}`
        : `/leave-management/vacation-report?requestId=${encodeURIComponent(row.id)}`;
      const stageWord = needsAssignment ? "HR approver assignment" : isManagerStage ? "manager" : "HR";
      await notifyRecipients({
        href: reviewHref,
        message: `${row.employeeName}'s vacation request is overdue for ${stageWord} review.`,
        metadata: {
          dueAt: row.slaStatus.dueAt,
          requestId: row.id,
          stage: row.slaStatus.stage,
        },
        recipients,
        requestId: row.id,
        title: "Vacation SLA overdue",
        type: `sla:${row.slaStatus.stage}`,
      });
      await insertVacationEvent({
        actorHrId: "system",
        actorLoginId: "daily-dispatcher",
        eventType: "sla_reminder",
        message: `SLA reminder sent for ${row.slaStatus.stage} review.`,
        metadata: { dueAt: row.slaStatus.dueAt, recipients },
        requestId: row.id,
      });
      await insertVacationEvent({
        actorHrId: "system",
        actorLoginId: "daily-dispatcher",
        eventType: "sla_escalation",
        message: `SLA escalation recorded for ${row.slaStatus.stage} review.`,
        metadata: { escalationRecipients, stage: row.slaStatus.stage },
        requestId: row.id,
      });
      if (isManagerStage) {
        managerReminders += reminderRecipients.filter(Boolean).length;
        managerEscalations += escalationRecipients.filter(Boolean).length;
      } else {
        hrReminders += reminderRecipients.filter(Boolean).length;
        hrEscalations += escalationRecipients.filter(Boolean).length;
      }
    } catch (error) {
      errors.push({ message: vacationErrorMessage(error), requestId: row.id });
    }
  }

  if (run) {
    await getSupabaseAdmin()
      .from(vacationSlaRunsTable)
      .update({
        errors,
        finished_at: new Date().toISOString(),
        hr_escalations: hrEscalations,
        hr_reminders: hrReminders,
        manager_escalations: managerEscalations,
        manager_reminders: managerReminders,
        metadata: { overdueRequests: overdueRows.length },
        status: errors.length > 0 ? "failed" : "completed",
      })
      .eq("id", run.id);
  }

  return {
    errors,
    hrEscalations,
    hrReminders,
    managerEscalations,
    managerReminders,
    overdueRequests: overdueRows.length,
    runDate,
  };
}

export async function getVacationReportData(access: AccessContext, filters: VacationReportFilters = {}): Promise<VacationReportData> {
  await assertPermission(access, "leave", "read");
  const clean = cleanFilters(filters);
  const canAdminManage = isAllVacationVisibility(access) && await canManageVacationRecords(access);
  const canExport = await canAccess(access, "leave", "export");
  const canReviewAttachments = isAllVacationVisibility(access);
  const activeEmployees = await getEmployeeDirectoryRows();
  const visibleEmployees = filterVacationEmployeesForAccess(access, activeEmployees);
  const visibleEmployeeHrIds = buildVisibleHrIdSet(visibleEmployees);
  const data = await fetchVacationReportRowsFromDatabase({ access, filters: clean, visibleEmployeeHrIds });

  const visibleRowsBase = await markVacationDecisionAccess(access, (data ?? [])
    .map((row) => mapVacationRow(row as VacationRequestDbRow))
    .filter((row) => canSeeVacation(access, row, visibleEmployeeHrIds)));
  const visibleRows = await enrichVacationRows(visibleRowsBase);
  const holidays = await fetchHolidaysForRows(visibleRows);
  const warningsByRequest = buildVacationOverlapWarnings({ holidays, rows: visibleRows });
  const visibleRowsWithWarnings = visibleRows.map((row) => ({
    ...row,
    overlapWarnings: warningsByRequest.get(row.id) ?? [],
  }));
  const filteredRows = visibleRowsWithWarnings;
  const employeeEligibility = buildEmployeeEligibilityRows({
    employees: visibleEmployees,
    filters: clean,
    rows: visibleRowsWithWarnings,
    today: toDateOnlyString(new Date()) ?? "",
  });
  const latestSlaRun = await fetchLatestVacationSlaRun();

  return {
    canAdminManage,
    canExport,
    canReviewAttachments,
    viewerHrId: access.hrId ?? null,
    dashboard: buildVacationDashboardData({ latestSlaRun, rows: filteredRows }),
    employeeEligibility,
    employeeEligibilitySummary: buildEmployeeEligibilitySummary(employeeEligibility),
    filters: clean,
    options: buildReportOptions(visibleRowsWithWarnings, visibleEmployees),
    rows: filteredRows,
    summary: buildReportSummary(filteredRows),
  };
}

/**
 * Lightweight rows for platform KPI counters (Command Center / overview).
 *
 * Returns the SAME scoped+decision-marked rows that `getVacationReportData`
 * produces, but skips every enrichment the KPIs never read: evidence/timeline
 * hydration (`enrichVacationRows`), sequential holiday fetches, overlap
 * warnings, eligibility tables, SLA runs, and dashboard/report assembly. The
 * resulting numbers from `buildVacationPlatformMetrics` are identical — only the
 * dead weight is removed.
 */
export async function getVacationPlatformMetricRows(access: AccessContext) {
  await assertPermission(access, "leave", "read");
  const activeEmployees = await getEmployeeDirectoryRows();
  const visibleEmployees = filterVacationEmployeesForAccess(access, activeEmployees);
  const visibleEmployeeHrIds = buildVisibleHrIdSet(visibleEmployees);
  const data = await fetchVacationReportRowsFromDatabase({ access, filters: {}, visibleEmployeeHrIds });

  return markVacationDecisionAccess(access, (data ?? [])
    .map((row) => mapVacationRow(row as VacationRequestDbRow))
    .filter((row) => canSeeVacation(access, row, visibleEmployeeHrIds)));
}
