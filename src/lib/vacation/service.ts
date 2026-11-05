import { randomUUID } from "node:crypto";
import { getVacationVisibilityScope, isAllVacationVisibilityAccess } from "@/lib/vacation/visibility-scope";

import ExcelJS from "exceljs";
import { unstable_cache } from "next/cache";
import { cache } from "react";

import {
  assertPermission,
  canAccess,
  isHrAuthorityRole,
  normalizeHrIdForAccess,
  normalizeLineName,
  resolveEmployeeIdentityId,
  systemAccessContext,
  type AccessContext,
  type PhoenixRole,
} from "@/lib/auth/permissions";
import { sharedIdentityKeys } from "@/lib/auth/identity-aliases";
import { canonicalHrIdKey, hrIdForStorage } from "@/lib/hr-id";
import { resolveViewerAllowedLines } from "@/lib/auth/scope-visibility";
import { hasDepartedEmployment } from "@/lib/auth/session-lifecycle";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { resolveNotificationRoleRecipients } from "@/lib/notifications/role-recipients";
import { invalidateExecutiveDashboardCache, VACATION_REPORT_ROWS_CACHE_TAG } from "@/lib/dashboard/invalidation";
import {
  getEmployeeDirectory,
  getEmployeeDirectoryRows,
  isActiveLifecycleStatus,
  type EmployeeDirectoryData,
  type EmployeeDirectoryRow,
} from "@/lib/employees/employee-directory";
import { continuousServiceStartDate, ownAndEarlierRecordHrIds } from "@/lib/employees/continuous-service";
import { createSystemNotification, createSystemNotificationForRecipients, type SystemNotificationChannel } from "@/lib/notifications/system";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { afterResponse } from "@/lib/http/after-response";
import { isUuid } from "@/lib/http/uuid";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  isWithinManagerHierarchy,
  reportsToManagerSeat,
  sameWorkforceDepartment,
} from "@/lib/workforce/hierarchy-resolver";
import { addDaysToDateOnly, daysBetweenDateOnly, parseDateOnly, toDateOnlyString } from "@/lib/date-only";
import { getConfirmedNationalHolidays, getConfirmedNationalHolidaysForPeriods, type EgyptianNationalHoliday } from "@/lib/vacation/national-holidays";
import {
  calculateVacationDurationDays,
  calculateVacationPayment,
  compareDateOnly,
  getAnnualVacationMinimumStartDate,
  getCompletedVacationPeriodEntitlementDays,
  getVacationPolicyToday,
  getVacationPolicyWarnings,
  getVacationBalancePeriod,
  normalizeVacationDayPart,
  normalizeVacationPaymentStatus,
  normalizeVacationRequestStatus,
  normalizeVacationType,
  roundDays,
  vacationTypeLabel,
} from "@/lib/vacation/calculations";
import { summarizeVacationRequests } from "@/lib/vacation/metrics";
import {
  assertLeaveWorkflowTransition,
  vacationDecisionAction,
} from "@/lib/vacation/workflow";
import {
  ADMIN_OVERRIDE_STALL_DAYS,
  evaluateAdminOverride,
  evaluateStepAction,
  genericStepName,
  isSequentialWorkflowType,
  resolveActionAvailability,
  resolveActiveStep,
  resolveStageLabel,
  shouldIncludeManagerOfManagerStep,
  shouldIncludeThirdManagementStep,
  sickLeaveTurnForViewer,
  stepOrderForStepKey,
} from "@/lib/vacation/approval-flow";
import {
  sendVacationDecisionResultEmail,
  sendVacationManagerDecisionEmail,
  sendVacationManagerStepResultEmail,
  sendVacationReturnedEmail,
} from "@/lib/vacation/email";
import { pickDeliverableEmail } from "@/lib/email/email-safety";
import type { AdminOverrideEvaluation, VacationOverrideStep } from "@/lib/vacation/approval-flow";
import type {
  VacationActionAvailability,
  VacationActionCenterData,
  VacationAdminOverrideState,
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
  VacationRequestAttachment,
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
import { VACATION_DAY_PARTS, VACATION_REQUEST_TYPES, VACATION_STATUSES, VACATION_TYPES, VACATION_WEEKLY_OFF_MODES } from "@/lib/vacation/types";
import { filterVacationRowsInMemory } from "@/lib/vacation/report-filter";
import { packVacationReportRows, unpackVacationReportRows } from "@/lib/vacation/report-rows-pack";
import { resolveVacationInformedHrIds, VACATION_INFORMED_SEAT, isVacationInformedType } from "@/lib/vacation/informed-recipients";
import { resolveSeatOrStandInHrIds } from "@/lib/notifications/vacant-seat";
import { listLeaveBalanceChargesForEmployees } from "@/lib/deductions/leave-balance-ledger";
import { PRIVATE_FILE_CACHE_CONTROL_SECONDS } from "@/lib/uploads/private-file-cache";

const vacationRequestsTable = "v2_vacation_requests";
const vacationEventsTable = "v2_vacation_request_events";
const vacationEvidenceReviewsTable = "v2_vacation_evidence_reviews";
// One row per uploaded evidence FILE, append-only, each carrying its own upload date. A sick request
// takes several files at submit and accepts more afterwards; a later upload ADDS to the earlier ones
// and never replaces them (owner, 2026-10-03). The legacy sick_attachment_* / compensatory_attachment_*
// columns on v2_vacation_requests still name the FIRST file, so every older read path is untouched.
const vacationAttachmentsTable = "v2_vacation_request_attachments";
const vacationApprovalStepsTable = "v2_vacation_approval_steps";
const vacationSlaRunsTable = "v2_vacation_sla_runs";
const vacationSlaSettingsTable = "v2_vacation_sla_settings";
/**
 * RETAINED ON PURPOSE, THOUGH IT HAS NEVER HELD A ROW. Do not propose dropping it again without
 * reading this first.
 *
 * It backed the one-click approve/reject link in a vacation email. Nothing ever issued a token —
 * production has held ZERO rows for the life of the table — so the GET that consumed them could
 * only ever answer "Vacation approval link is invalid". That GET, its renderer and
 * `decideVacationRequestByToken` were removed on 2026-09-05 (#3274); managers review in the Action
 * Center instead, which the manager email's own `reviewUrl` documents as "no direct approve/reject".
 *
 * The TABLE stayed, owner's decision the same day, after the cost was measured: it is empty, 64 kB,
 * and nothing references it in the database (0 inbound foreign keys). Dropping it is safe in
 * isolation but is NOT a one-line change — the retention purge below deletes from it BEFORE it
 * purges SLA runs, so a missing table aborts that cron mid-sequence and silently stops SLA-log
 * cleanup too, and a nightly-failing cron alerts nobody here. It would need a code PR, a deploy, a
 * production DDL and a second migration for the vestigial 'decision_tokens' retention policy row.
 *
 * The excuse copy (`v2_excuse_email_tokens`) went the same way on 2026-10-26: it minted tokens but
 * put none in an email. Its table stays too.
 */
const vacationTokensTable = "v2_vacation_email_tokens";
const vacationWeeklyOffPoliciesTable = "v2_vacation_weekly_off_policies";
const vacationRetentionPoliciesTable = "v2_vacation_retention_policies";
const vacationRetentionPurgeRunsTable = "v2_vacation_retention_purge_runs";
export const vacationAttachmentBucket = "leave-attachments";
const vacationAuditExportMaxRows = 5000;

// PostgREST folds every .in() value into the request URL; an unbatched array of a few hundred ids
// can push the URL past undici's ~16KB header limit and throw "TypeError: fetch failed" /
// HeadersOverflowError. getVacationReportData pages through the ENTIRE matching request set with
// no upper bound, so any .in() keyed off its row ids must be chunked.
function chunk<T>(items: T[], size = 100): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
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
  request_code: string;
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

type VacationApprovalStepKey = "direct_manager" | "manager_of_manager" | "manager_level_3" | "hr";
type VacationApprovalStepStatus = "pending" | "approved" | "rejected";

type VacationApprovalStepRow = {
  approver_hr_id: string | null;
  approver_user_id: string | null;
  created_at?: string | null;
  decided_at: string | null;
  decision_comment: string | null;
  id: string;
  overridden_at?: string | null;
  overridden_by_hr_id?: string | null;
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

export type HrRecipient = {
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

type VacationAttachmentDbRow = {
  bucket?: string | null;
  content_type?: string | null;
  id: string;
  kind?: string | null;
  object_path?: string | null;
  original_name?: string | null;
  request_id?: string | null;
  size_bytes?: number | string | null;
  uploaded_at?: string | null;
  uploaded_by_hr_id?: string | null;
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
  // Every sick document AFTER the first one, in the order the employee picked them. The first file
  // stays in `sickAttachment` so the legacy columns, the evidence gate and the approver emails are
  // unchanged; these ride alongside it into the attachments table.
  sickAttachmentsExtra?: VacationAttachmentUpload[] | null;
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

/**
 * The value of a read that was started alongside others, or its failure rethrown. Reads that used
 * to run one after another are now started together (2026-10-01, "slow to transfer between page and
 * page"); unwrapping them with this, in the order they used to run, makes a failure throw the same
 * error the one-at-a-time code met first.
 */
function settledValueOrThrow<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "rejected") throw result.reason;
  return result.value;
}

function integerValue(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function canonicalHrId(value: string | null | undefined) {
  return normalizeHrIdForAccess(value) ?? null;
}

/**
 * The HR id of whoever DECIDES a request, in the form the database keeps it (`B-118`).
 * `resolveEmployeeIdentityId` returns the LOWERCASE comparison key, which is right for matching and
 * wrong for persisting: 85 manager and 77 HR decisions were stored as `b-118` and then missed by every
 * name lookup and "decided by me" filter. Only the HR id branch is upper-cased; the login id and the
 * audit fallback stay untouched. Pinned by `tests/vacation-decider-hr-id-storage.test.ts`.
 */
function resolveStoredDeciderHrId(access: AccessContext) {
  return hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access);
}

function hrIdsMatch(left: string | null | undefined, right: string | null | undefined) {
  const leftCanonical = canonicalHrId(left);
  const rightCanonical = canonicalHrId(right);
  return Boolean(leftCanonical && rightCanonical && leftCanonical === rightCanonical);
}

// Exported for the Approvals Hub responder service, which must apply the EXACT same HR-authority
// rule (Super Admin / system only) as the rest of the vacation module — not the broader
// isHrAuthorityRole set (which also includes Talent Acquisition, a confirmed NON-approver for
// leave/excuse). Keeping one function avoids the two drifting apart again.
export function isAllVacationVisibility(access: AccessContext) {
  return isAllVacationVisibilityAccess(access);
}

async function assertVacationAdminManagement(access: AccessContext, action: "create" | "update" | "delete") {
  await assertPermission(access, "leave", action);
  if (!isAllVacationVisibility(access)) {
    throw new Error("Forbidden: only HR or Super Admin can manage company vacation records.");
  }
}

export async function canManageVacationRecords(access: AccessContext) {
  return (
    isAllVacationVisibility(access) &&
    await canAccess(access, "leave", "create") &&
    await canAccess(access, "leave", "update") &&
    await canAccess(access, "leave", "delete")
  );
}

/**
 * True only when a table really is missing: PostgREST's PGRST205 ("Could not find the table … in the
 * schema cache") or Postgres's 42P01 ("relation … does not exist"). The code is read when the error
 * still carries it; throwVacationDatabaseError keeps only the message, so both shapes are matched too.
 *
 * NOT "schema cache" on its own, and NOT any message that merely names a vacation table (cache audit,
 * 2026-10-26). PostgREST answers PGRST002 ("Could not query the database for the schema cache") while
 * the database restarts, and the callers turn a missing table into an EMPTY answer — which the
 * report's 60 s cache then kept: the Vacation Report and the approval badges showed no requests, and
 * the portal's leave tile showed the whole entitlement as remaining. A permission, constraint or
 * missing-column error that names a table is a real failure too, and must surface as one.
 */
function isVacationSchemaMissingError(error: unknown) {
  const code = typeof (error as { code?: unknown } | null)?.code === "string" ? (error as { code: string }).code : "";
  if (code === "PGRST205" || code === "42P01") return true;
  // Any other code is what it says it is — 42703 is a missing COLUMN ("column … of relation … does not
  // exist"), never a missing table.
  if (code) return false;
  const raw = (error as { message?: unknown } | null)?.message;
  const message = (typeof raw === "string" ? raw : String(error)).toLowerCase();
  return (
    message.includes("could not find the table") ||
    (message.includes("relation") && message.includes("does not exist") && !message.includes("column"))
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

// Active-status check mirroring the D4 drift semantics (employment_status IN active/on_leave;
// empty treated as active). Used to confirm a stuck approver has genuinely resigned before
// allowing HR to reassign a pending_manager request.
function isVacationEmployeeActive(employee: EmployeeDirectoryRow) {
  const status = (employee.employmentStatus ?? "").trim().toLowerCase();
  return status === "" || status === "active" || status === "on_leave";
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

/** The viewer's own request, or one filed under an earlier record of theirs (continuous-service.ts). */
function accessOwnsVacationHrId(access: AccessContext, hrId: string | null | undefined) {
  if (accessMatchesHrId(access, hrId)) return true;
  const target = normalizeHrIdForAccess(hrId);
  if (!target) return false;
  return accessIdentityCandidates(access).some((candidate) =>
    ownAndEarlierRecordHrIds(candidate).slice(1).some((earlier) => normalizeHrIdForAccess(earlier) === target));
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

/**
 * No employee stands behind this viewer — an empty office seat opened through View as Seat, or a login
 * with no directory row. Same message as before, so every page that prints it reads the same; the class
 * only lets a caller that merely COUNTS (the Approvals Hub badge) tell "nobody to count for" apart from a
 * read that failed (System Audit APP-FEAFFD50: three false errors from empty seats, 20 Oct 2026).
 */
export class VacationViewerHasNoEmployeeProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VacationViewerHasNoEmployeeProfileError";
  }
}

async function filterVacationEmployeesForAccess(access: AccessContext, employees: EmployeeDirectoryRow[]) {
  const scope = getVacationVisibilityScope(access);
  if (scope === "COMPANY") return employees;

  const currentEmployee = findCurrentEmployeeRow(employees, access);
  if (!currentEmployee) {
    throw new VacationViewerHasNoEmployeeProfileError("Your employee profile is not available in the employee directory. Please contact HR.");
  }

  const viewerHrId = canonicalHrId(currentEmployee.hrId);
  if (!viewerHrId) {
    throw new VacationViewerHasNoEmployeeProfileError("Your employee profile is not linked yet. Please contact HR.");
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
  // A per-user line_scope_override (e.g. a Group PM or Marketing Manager spanning
  // several product lines — see src/lib/auth/scope-visibility.ts) replaces the
  // own-single-line comparison below with its explicit multi-line set. Only
  // fetched for LINE scope; null when no override is configured, in which case
  // the own-single-line fallback below is unchanged.
  let allowedLineKeys: ReadonlySet<string> | null = null;
  if (scope === "LINE") {
    let mgr: EmployeeDirectoryRow | undefined = currentEmployee;
    for (let depth = 0; depth < 12 && mgr?.managerHrId; depth++) {
      const mgrId = canonicalHrId(mgr.managerHrId);
      if (!mgrId || viewerManagerIds.has(mgrId)) break;
      viewerManagerIds.add(mgrId);
      mgr = employeeByHrId.get(mgrId);
    }
    const overrideLines = await resolveViewerAllowedLines(access);
    if (overrideLines && overrideLines.length > 0) {
      allowedLineKeys = new Set(overrideLines.map((line) => normalizeLineName(line)).filter(Boolean));
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
      // An override only ever widens WHICH of the viewer's own-department lines
      // are visible — it must still pass sameWorkforceDepartment, never cross
      // into another department's employees who happen to sit on the same
      // overridden line (e.g. Sales' NSM chain on a line Marketing also covers).
      if (allowedLineKeys) {
        const employeeLineKey = normalizeLineName(employee.lineName);
        return (
          employeeLineKey !== "" &&
          allowedLineKeys.has(employeeLineKey) &&
          sameWorkforceDepartment(currentEmployee, employee)
        );
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
    displayName: employee.displayName,
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
    // The person's own rows and those of an earlier record of theirs (continuous-service.ts).
    if (!ownAndEarlierRecordHrIds(input.employeeHrId).some((hrId) => hrIdsMatch(row.employeeHrId, hrId))) return sum;
    if (row.status !== "approved") return sum;
    if (row.startDate < periodStart || row.startDate >= periodEnd) return sum;

    const matchesType = input.vacationType === "annual" || input.vacationType === "emergency"
      ? row.vacationType === "annual" || row.vacationType === "emergency"
      : row.vacationType === input.vacationType;
    if (!matchesType) return sum;

    return sum + (row.paidDurationDays ? row.paidDurationDays : row.paymentStatus === "paid" ? row.durationDays : 0);
  }, 0);
}

/** Date-only, printed through the engine-independent en-GB formatter so the month never shifts. */
const departedDayFormatter = stableEnGbFormatter({ day: "2-digit", month: "short", timeZone: "UTC", year: "numeric" });

/**
 * "Left the company on 17 Sep 2026" for someone who has gone, null for everyone else.
 *
 * `hasDepartedEmployment` is the repo's one vocabulary for this (resigned · terminated ·
 * not_renewed), deliberately NOT the complement of active: production carries 15
 * `historical_payroll_record` and 2 `system_placeholder` rows that are nobody's leaver.
 */
function departedLabel(employee: EmployeeDirectoryRow): string | null {
  if (!hasDepartedEmployment(employee.employmentStatus)) return null;
  const iso = employee.lastWorkingDate ? employee.lastWorkingDate.slice(0, 10) : null;
  const parts = iso ? iso.split("-").map(Number) : null;
  if (!parts || parts.length !== 3 || parts.some((part) => !part)) return "Left the company";
  return `Left the company on ${departedDayFormatter.format(new Date(Date.UTC(parts[0]!, parts[1]! - 1, parts[2]!)))}`;
}

/**
 * The report's Entitlements table.
 *
 * `allScopedRows` MUST be the access-scoped but otherwise UNFILTERED request set. The Used and
 * Balance columns sum every approved paid day inside each employee's own balance period, so a
 * report filter that reaches this argument silently removes days from that sum and inflates the
 * balance — a Status = Pending filter left the whole company reading a full, untouched
 * entitlement, which is what "the balance never decreases" looked like on screen. The filters
 * ARE applied here, but to the employee LIST only (employeeEligibilityFilterMatches), which is
 * what the tab's department/line/manager pickers are for.
 */
export function buildEmployeeEligibilityRows(input: {
  allScopedRows: VacationRequestRecord[];
  employees: EmployeeDirectoryRow[];
  filters: VacationReportFilters;
  today: string;
  /**
   * EVERY annual-balance ledger day, from `annualBalanceLedgerDays()` — counted as used when its
   * work date falls in the employee's own balance period, so the Entitlements tab and the portal's
   * "annual leave left" agree with the balance a leave request is actually priced against.
   *
   * 🔴 It was the `source = 'deductions'` fold alone, which is only one of the three pools
   * `approvedPaidDaysInPeriod` counts: a day the WEEKLY ATTENDANCE REVIEW had charged, or a day
   * payroll had SETTLED against the balance, was missing from Used and left Balance reading HIGHER
   * than the figure a request is priced against. Negative reversal rows net themselves.
   */
  balanceCharges?: ReadonlyArray<{ employeeHrId: string; workDate: string; days: number }>;
  /**
   * That ledger read FAILED (see `annualBalanceLedgerDays`). Every row then carries a review flag
   * saying so, because the Used and Balance columns otherwise read as though nothing had been spent
   * — the very screen the charge feature exists to remove — with nothing on this tab to say the
   * figure is incomplete. The charges section carries its own separate banner.
   */
  balanceChargesUnavailable?: boolean;
}): VacationEmployeeEligibilityRow[] {
  return input.employees
    .filter((employee) => employeeEligibilityFilterMatches(employee, input.filters))
    .map((employee) => {
      const period = getVacationBalancePeriod({
        employeeHrId: employee.hrId,
        hireDate: employee.hireDate,
        referenceDate: input.today,
      });
      const leaveChargedDays = (input.balanceCharges ?? [])
        .filter(
          (charge) =>
            Boolean(period) &&
            hrIdsMatch(charge.employeeHrId, employee.hrId) &&
            charge.workDate >= (period?.periodStart ?? "") &&
            charge.workDate < (period?.periodEnd ?? ""),
        )
        .reduce((sum, charge) => sum + charge.days, 0);
      const usedPaidDays =
        approvedPaidDaysFromRows({
          employeeHrId: employee.hrId,
          periodEnd: period?.periodEnd ?? null,
          periodStart: period?.periodStart ?? null,
          rows: input.allScopedRows,
          vacationType: "annual",
        }) + leaveChargedDays;
      const annualBalance = calculateVacationPayment({
        approvedPaidDaysInPeriod: usedPaidDays,
        durationDays: 0,
        employeeHrId: employee.hrId,
        hireDate: employee.hireDate,
        startDate: input.today,
        vacationType: "annual",
      });
      // THE BALANCE COLUMN CARRIES WHAT HAS ACCRUED, SO SPENDING A DAY VISIBLY SUBTRACTS FROM IT
      // (owner, 2026-10-09: "make the entitlments of the peoplw qho got this decrease by number of
      // days", then "in vacation report"). Inside the first six months calculateVacationPayment
      // answers balanceBeforeDays: 0 flat - the right answer when PRICING A REQUEST - so the column
      // read 0 for the whole cohort while the charged days sat in Used, and Entitlement - Used never
      // added up. Every live charge is on someone inside that window, so the feature was invisible.
      //
      // 🔴 THE FIRST DRAFT OVERRODE THIS ONLY FOR SOMEONE WHO ALREADY HAD A CHARGE, WHICH MOVED THE
      // NUMBER THE WRONG WAY: an uncharged joiner read 0 and a charged one 0.25, so pressing the
      // button RAISED the Balance column and the colleague who had spent nothing looked poorer. The
      // accrued balance is what every first-six-months row carries now, charged or not - 1.25 goes to
      // 0.25 when a day is charged, which is the decrease he asked to see.
      //
      // ONLY this figure moves: eligibilityStatus, daysUntilEligibility, eligibleForAnnualPaidLeave
      // and reviewFlags all stay on the snapshot below, so the row still reads "First 6 months" and
      // still says the employee cannot request paid leave. What an employee may actually TAKE is a
      // different question and a different function - requestableAnnualLeaveDays, which the portal
      // tile reads.
      //
      // It is READ OFF THE SNAPSHOT, not calculated a second time. The annual path of the calculator
      // answers roundDays(max(0, entitlementDays - usedPaidDays)) and carries both of those fields on
      // the snapshot already, identical with the flag and without it, so a second call with a copy of
      // the same six arguments only created two argument lists to keep in lockstep. `allowFirstSixMonths`
      // is left to the Deductions balance read alone, which is the one caller the flag was added for.
      const annualBalanceDays = annualBalance.unpaidReason === "first_six_months"
        ? roundDays(Math.max(0, annualBalance.entitlementDays - annualBalance.usedPaidDays))
        : annualBalance.balanceBeforeDays;
      // Counted from the person's unbroken service when an earlier record of theirs is linked
      // (src/lib/employees/continuous-service.ts), the same date the balance above counts from.
      const serviceStartDate = continuousServiceStartDate(employee.hrId, employee.hireDate);
      const sixMonthAnniversary = addMonthsToDateOnly(serviceStartDate, 6);
      const daysSinceHire = daysBetweenDateOnly(serviceStartDate);
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
        // 🔴 THE ROW SAYS THE PERSON HAS LEFT (owner, 2026-10-09: "show the charged leavers on the
        // vacation report entitlements tab"). A leaver only reaches this table when a charge has
        // been taken from their balance — loadVacationReportData adds exactly those — and without
        // these words the row reads as an ordinary employee with a strangely short balance. It is a
        // review flag rather than a new column because the flag already reaches all four places a
        // row is rendered: the desktop table, the mobile card, the self-only card and the CSV.
        departedLabel(employee),
        input.balanceChargesUnavailable ? "Balance charges could not be read" : null,
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
        annualBalanceDays,
        annualEntitlementDays: annualBalance.entitlementDays,
        annualUsedDays: annualBalance.usedPaidDays,
        daysSinceHire,
        daysUntilEligibility: eligibilityStatus === "first_six_months" ? daysUntilEligibility : 0,
        departmentName: employee.departmentName,
        eligibilityStatus,
        eligibleForAnnualPaidLeave: eligibilityStatus === "eligible",
        employmentStatus: employee.employmentStatus,
        fullName: employee.fullName,
        displayName: employee.displayName,
        hireDate: serviceStartDate,
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
      return left.displayName.localeCompare(right.displayName);
    });
}

/**
 * The days an employee may actually TAKE as paid annual leave today — what a portal tile answering
 * "Annual leave left" must show, and NOT the same question as the Entitlements tab's Balance column.
 *
 * Inside the first six months the row carries the ACCRUED balance, so that a deduction charged
 * against it is visible on the report (buildEmployeeEligibilityRows above). The six-month rule still
 * refuses every paid request from that employee — calculatePaymentForRequest is never passed
 * `allowFirstSixMonths` — so offering those days to the employee as leave they have left would
 * promise a day the request screen then prices unpaid, on two screens one click apart. 0 is the
 * honest answer until they are eligible. For an eligible employee the two figures are one number.
 */
export function requestableAnnualLeaveDays(
  row: Pick<VacationEmployeeEligibilityRow, "annualBalanceDays" | "eligibleForAnnualPaidLeave">,
): number {
  return row.eligibleForAnnualPaidLeave ? row.annualBalanceDays : 0;
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
  const thirdManager = managerOfManager ? findEmployeeByHrId(directory, managerOfManager.managerHrId) : null;
  return { manager, managerOfManager, thirdManager };
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

export async function validateOfficialHolidayAdjacency(input: {
  endDate: string;
  startDate: string;
}) {
  const dayBeforeStart = addDaysToDateOnly(input.startDate, -1);
  const dayAfterEnd = addDaysToDateOnly(input.endDate, 1);
  if (!dayBeforeStart || !dayAfterEnd) return;

  // Fails closed on a Google Calendar outage (owner, 2026-09-16). Company and fixed-date holidays
  // still load during one, so this check would otherwise run against a calendar missing both Eids,
  // Islamic New Year, the Prophet's Birthday and Coptic Easter, and would let a request through
  // right beside a holiday it cannot see. The wording deliberately avoids "national holiday",
  // which the company-report approve route maps to its own adjacency message.
  const { calendarReachable, holidays } = await getConfirmedNationalHolidaysForPeriods(
    holidayMonthKeysForDates([dayBeforeStart, dayAfterEnd]),
  );
  if (!calendarReachable) {
    throw new Error(
      "The public holiday calendar could not be read just now, so this request cannot be checked against the official holidays. Nothing was saved — try again shortly.",
    );
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

// Egypt's weekend is Friday/Saturday in Africa/Cairo terms. A real timestamp's UTC weekday can
// disagree with its Cairo weekday for the few hours before UTC midnight where Cairo has already
// rolled over to the next calendar day — resolve the weekend check via Cairo, not getUTCDay().
function cairoDayOfWeek(date: Date): number {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Cairo", weekday: "short" }).format(date);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
}

function addBusinessDays(date: Date, days: number) {
  const result = new Date(date);
  let added = 0;
  while (added < days) {
    result.setUTCDate(result.getUTCDate() + 1);
    const day = cairoDayOfWeek(result);
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
    const day = cairoDayOfWeek(cursor);
    if (day !== 5 && day !== 6 && cursor <= end) days += 1;
  }
  return days;
}

export function buildVacationSlaStatus(input: {
  events?: VacationTimelineEvent[];
  now: Date;
  request: Pick<VacationRequestDbRow, "created_at" | "manager_decision_at" | "status">;
  settings: ReturnType<typeof defaultVacationSlaSettings>;
}): VacationSlaStatus {
  const status = input.request.status;
  // A returned request waits on the employee, not an approver, so no approver's clock runs on it.
  if (status === "approved" || status === "rejected" || status === "returned" || status === "cancelled") {
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

/**
 * 🔒 A MANAGER IS PRINTED BY THEIR DISPLAY NAME (owner, 2026-11-03). `manager_name` and
 * `manager_of_manager_name` stay the raw snapshot the request was written with; they are resolved here
 * at READ, by HR id, for the screens and emails. An unknown id or a failed read keeps the stored name,
 * and a failed name read never fails the page. The directory read is TTL-cached and request-deduped.
 */
async function withManagerDisplayNames<
  T extends Pick<VacationRequestRecord, "managerHrId" | "managerName" | "managerOfManagerHrId" | "managerOfManagerName">,
>(rows: T[]): Promise<T[]> {
  if (rows.length === 0) return rows;
  try {
    const nameByKey = new Map<string, string>();
    for (const employee of await getEmployeeDirectoryRows({ includeInactive: true })) {
      const key = canonicalHrIdKey(employee.hrId);
      if (key && employee.displayName) nameByKey.set(key, employee.displayName);
    }
    const nameFor = (hrId: string | null, stored: string | null) =>
      nameByKey.get(canonicalHrIdKey(hrId) ?? "") ?? stored;
    return rows.map((row) => ({
      ...row,
      managerName: nameFor(row.managerHrId, row.managerName),
      managerOfManagerName: nameFor(row.managerOfManagerHrId, row.managerOfManagerName),
    }));
  } catch {
    return rows;
  }
}

/** One row read for an email or a decision screen, its managers already in their display names. */
async function mapVacationRowForDisplay(row: VacationRequestDbRow): Promise<VacationRequestRecord> {
  const [mapped] = await withManagerDisplayNames([mapVacationRow(row)]);
  return mapped;
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
    requestCode: text(row.request_code),
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
    status: normalizeVacationRequestStatus(row.status),
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
    attachments: [],
    evidenceReviews: [],
    overlapWarnings: [],
    slaStatus: buildVacationSlaStatus({ request: row, now: new Date(), settings: defaultVacationSlaSettings() }),
    timelineEventCount: 0,
    weeklyOffPolicySnapshot: mapWeeklyOffPolicySnapshot(row.weekly_off_policy_snapshot),
  };
}

/**
 * The status the Admin controls panel saves. It offers every status in VACATION_STATUSES, and this
 * used to accept only four of them, so "Returned to Employee" and "Needs assignment" were saved as
 * Pending Manager without a word. Every defined status now saves as chosen; a blank one keeps the
 * old Pending Manager default, and an unknown one is refused rather than guessed.
 */
export function normalizeAdminVacationStatus(value: unknown): VacationRequestStatus {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return "pending_manager";
  const status = normalizeVacationRequestStatus(normalized);
  if (status !== normalized) throw new Error("Vacation status is invalid.");
  return status;
}

export function adminDecisionPayload(input: {
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

  if (input.status === "pending_manager" || input.status === "needs_assignment") return reset;

  // Returned to the employee: no HR decision stands, and the manager's decision is left exactly as
  // it was — a request can be returned before or after its manager approved it.
  if (input.status === "returned") {
    return {
      hr_decision: null,
      hr_decision_at: null,
      hr_decision_by_hr_id: null,
      hr_decision_comment: null,
    };
  }

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

  // Own request is always visible — an earlier record's too.
  if (accessOwnsVacationHrId(access, request.employeeHrId)) return true;

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

/**
 * Record when a templated vacation email was NOT sent.
 *
 * WHY THIS EXISTS. `sendPhoenixEmail` has seven paths that return `{ skipped: true, reason }`
 * rather than throwing — email globally disabled, no provider, no sender, no deliverable
 * recipient, every recipient suppressed, blocked before sending, and one more. Every vacation
 * caller wrote `send(...).catch(...)`, which only ever sees a THROW. A skip returned normally was
 * discarded, and these sends do not go through `notification_outbox` either, so a skipped vacation
 * email left **no trace anywhere**: no outbox row, no provider id, no event.
 *
 * That is not a small gap. On 2026-09-05 the question "are vacation emails firing?" could not be
 * answered from this database at all — it took reading the provider's own API to establish that
 * they were. A silent skip and a healthy send are indistinguishable from the inside, which is
 * exactly the shape that lets a real outage sit unnoticed for weeks.
 *
 * Only skips are recorded. A successful send already leaves a trail at the provider, and logging
 * every success would bury the signal in a table people read by eye.
 */
/**
 * The pure half, exported so a test can reach it: given whatever a templated sender returned, was
 * this a SKIP, and why? Returns null for a real send.
 *
 * `skipped !== true` rather than `!skipped` on purpose — a sender that returns a success object,
 * `undefined` (the `void` branch of a `.catch`-typed chain), or anything unexpected must read as
 * "sent", never as a silent skip. Only an explicit `skipped: true` is a skip.
 */
export function describeSkippedVacationEmail(result: unknown): string | null {
  const value = result as { reason?: string; skipped?: boolean } | null | undefined;
  if (!value || value.skipped !== true) return null;
  return value.reason ?? "no reason given";
}

async function recordVacationEmailSkip(input: {
  actorHrId?: string | null;
  label: string;
  recipient?: string | null;
  requestId: string;
  result: unknown;
}) {
  const reason = describeSkippedVacationEmail(input.result);
  if (reason === null) return;
  await insertVacationEvent({
    actorHrId: input.actorHrId ?? null,
    eventType: "notification_skipped",
    message: `${input.label} email was NOT sent — ${reason}`,
    metadata: { label: input.label, reason, recipient: input.recipient ?? null },
    requestId: input.requestId,
  }).catch(() => undefined);
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

/**
 * Raise the notice a decision causes AFTER the reply has gone, so the approver who pressed Approve is
 * never kept waiting for it (2026-10-23 slow-buttons audit). A manager's Approve on production took
 * 6.1 s, of which 0.8 s was the decision itself: the other 5.3 s were the notice to HR and the next
 * approver — profiles, preferences, event and audit rows, Telegram, the phone push and the templated
 * email — one wave after another, all awaited before the answer left. The decision is already saved
 * when this runs, so a failed notice never changes the answer; it is recorded on the request's own
 * timeline exactly as it was before. Outside a request (the unit suite, a script) `afterResponse`
 * simply awaits the task, as every caller did before.
 */
function deferVacationNotice(input: {
  actorHrId?: string | null;
  actorLoginId?: string | null;
  label: string;
  requestId: string;
  task: () => Promise<unknown>;
}): Promise<void> {
  return afterResponse(`vacation_notice:${input.label}`, async () => {
    try {
      await input.task();
    } catch (error) {
      await insertVacationEvent({
        actorHrId: input.actorHrId,
        actorLoginId: input.actorLoginId,
        eventType: "notification_failed",
        message: vacationErrorMessage(error),
        requestId: input.requestId,
      }).catch(() => undefined);
    }
  });
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

function mapVacationAttachment(row: VacationAttachmentDbRow): VacationRequestAttachment {
  return {
    bucket: row.bucket ?? vacationAttachmentBucket,
    contentType: row.content_type ?? null,
    id: row.id,
    kind: row.kind === "compensatory" ? "compensatory" : "sick",
    objectPath: text(row.object_path),
    originalName: row.original_name ?? null,
    requestId: text(row.request_id),
    sizeBytes: numberValue(row.size_bytes),
    uploadedAt: row.uploaded_at ?? "",
    uploadedByHrId: row.uploaded_by_hr_id ?? null,
  };
}

/**
 * Every uploaded evidence file of each request, OLDEST FIRST — the order the admin reads them in
 * ("3 October he uploaded this, by 10 October he uploaded those").
 *
 * Tolerant of the table being absent, exactly like fetchEvidenceReviewsForRequests: a deploy that
 * reaches an environment before the migration does must still render the request, with the legacy
 * single-attachment link, rather than failing the whole page.
 */
async function fetchVacationAttachmentsForRequests(requestIds: string[]) {
  const uniqueIds = Array.from(new Set(requestIds.filter(Boolean)));
  const byRequestId = new Map<string, VacationRequestAttachment[]>();
  if (uniqueIds.length === 0) return byRequestId;

  try {
    for (const batch of chunk(uniqueIds)) {
      const { data, error } = await getSupabaseAdmin()
        .from(vacationAttachmentsTable)
        .select("*")
        .in("request_id", batch)
        .order("uploaded_at", { ascending: true });

      if (error) throwVacationDatabaseError(error);

      for (const row of (data ?? []) as VacationAttachmentDbRow[]) {
        const attachment = mapVacationAttachment(row);
        if (!attachment.objectPath) continue;
        const current = byRequestId.get(attachment.requestId) ?? [];
        current.push(attachment);
        byRequestId.set(attachment.requestId, current);
      }
    }
  } catch (error) {
    if (!isVacationSchemaMissingError(error)) throw error;
  }

  return byRequestId;
}

async function fetchEvidenceReviewsForRequests(requestIds: string[]) {
  const uniqueIds = Array.from(new Set(requestIds.filter(Boolean)));
  const byRequestId = new Map<string, VacationEvidenceReview[]>();
  if (uniqueIds.length === 0) return byRequestId;

  try {
    for (const batch of chunk(uniqueIds)) {
      const { data, error } = await getSupabaseAdmin()
        .from(vacationEvidenceReviewsTable)
        .select("*")
        .in("request_id", batch);

      if (error) throwVacationDatabaseError(error);

      for (const row of (data ?? []) as VacationEvidenceReviewDbRow[]) {
        const review = mapEvidenceReview(row);
        const current = byRequestId.get(review.requestId) ?? [];
        current.push(review);
        byRequestId.set(review.requestId, current);
      }
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

// Accounts operated by one physical person are not two reviewers, so separation-of-duties has to
// treat them as a single identity. The groups themselves live in `@/lib/auth/identity-aliases`,
// which every other module (private calendar, weekly sales, probation) now shares — this used to
// be a local list here that drifted from the others.

// The evidence-review/acknowledgement separation-of-duties guard requires a second HR/Super
// Admin account to exist at all. Small orgs can have exactly one such account, which would make
// sick/compensatory leave permanently unapprovable. Owner-approved exception (2026-07-04): only
// enforce the guard when a real alternate account is available; fail closed (keep enforcing) if
// the lookup errors, since that's safer than silently allowing self-acknowledgement.
async function hasAlternateHrApprover(excludeHrId: string | null | undefined) {
  const excludedGroup = sharedIdentityKeys(excludeHrId);
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("app_auth_users")
      .select("hr_id")
      .eq("role", "Super Admin")
      .eq("is_active", true);
    if (error) throw error;
    return (data ?? []).some((row) => {
      // sharedIdentityKeys()/excludedGroup key on canonicalHrIdKey (lowercased, HYPHENS KEPT —
      // "b-10", "phx-1"). The local canonicalHrId() strips hyphens ("b10", "phx1") for a different
      // purpose (self-review-detection matching) and must not be reused here: comparing a
      // hyphen-stripped id against a hyphen-keeping Set never matches, which silently defeated the
      // B-10/PHX-1 sole-admin exception below for every hyphenated HR_ID.
      const hrId = canonicalHrIdKey(text((row as Record<string, unknown>).hr_id));
      return hrId ? !excludedGroup.has(hrId) : false;
    });
  } catch (error) {
    logError("Alternate HR approver lookup failed; enforcing separation of duties", { labels: { event: "vacation_alternate_hr_approver_lookup_failed" }, error });
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

  for (const batch of chunk(uniqueIds)) {
    const { data, error } = await getSupabaseAdmin()
      .from(vacationEventsTable)
      .select("*")
      .in("request_id", batch)
      .order("created_at", { ascending: true });
    if (error) throwVacationDatabaseError(error);

    for (const row of (data ?? []) as VacationEventDbRow[]) {
      const requestId = text(row.request_id);
      const current = byRequestId.get(requestId) ?? [];
      current.push(mapVacationEvent(row));
      byRequestId.set(requestId, current);
    }
  }
  return byRequestId;
}

/**
 * Exported so other domains (Payroll Copilot's Unpaid Vacation review tab)
 * can CC HR the same way every vacation notification already does, without
 * duplicating the "who is HR" resolution query. `roles` defaults to
 * `["Super Admin"]` — every existing caller keeps that default and is
 * therefore byte-identical to before; only the vacation SLA cron passes an
 * admin-configurable override (see resolveNotificationRoleRecipients,
 * "vacation_sla_hr_escalation").
 */
export async function getHrRecipients(
  directory: EmployeeDirectoryData,
  roles: PhoenixRole[] = ["Super Admin"],
): Promise<HrRecipient[]> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("app_auth_users")
      .select("login_id,hr_id,role,is_active")
      .eq("is_active", true)
      .in("role", roles);

    if (error) {
      // Fail observable, not silent: returning [] here means HR/Super Admin are
      // notified about nobody. Keep returning [] so a notification-lookup failure
      // never blocks the employee's vacation action, but log it so the dropped
      // notification is diagnosable.
      logError("HR recipient lookup failed; HR notifications skipped", { labels: { event: "vacation_hr_recipient_lookup_failed" }, error });
      return [];
    }

    return (data ?? [])
      .map((row) => {
        const hrId = text((row as Record<string, unknown>).hr_id);
        const role = text((row as Record<string, unknown>).role) as PhoenixRole;
        if (!hrId) return null;
        if (!roles.includes(role)) return null;
        const employee = findEmployeeByHrId(directory, hrId);
        return {
          email: employee?.workEmail ?? null,
          hrId,
          name: employee?.displayName ?? hrId,
        };
      })
      .filter((entry): entry is HrRecipient => Boolean(entry));
  } catch (error) {
    logError("HR recipient lookup threw; HR notifications skipped", { labels: { event: "vacation_hr_recipient_lookup_threw" }, error });
    return [];
  }
}


function approvalStatus(value: unknown): VacationApprovalStepStatus {
  return value === "approved" || value === "rejected" ? value : "pending";
}

function approvalStepKey(value: unknown): VacationApprovalStepKey {
  return value === "manager_of_manager" || value === "manager_level_3" || value === "hr" ? value : "direct_manager";
}

function mapVacationApprovalStep(row: VacationApprovalStepRow) {
  const stepKey = approvalStepKey(row.step_key);
  const parsedOrder = Number(row.step_order);
  return {
    approverHrId: text(row.approver_hr_id),
    approverUserId: text(row.approver_user_id) || null,
    createdAt: row.created_at ?? null,
    decidedAt: row.decided_at,
    decisionComment: row.decision_comment,
    id: row.id,
    overriddenAt: row.overridden_at ?? null,
    overriddenByHrId: row.overridden_by_hr_id ?? null,
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
        name: text(row.name) || employee?.displayName || hrId,
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
  requesterRole: PhoenixRole,
): Promise<VacationApprovalRecipient[]> {
  const { manager, managerOfManager, thirdManager } = managerChain(directory, employee);
  // The direct manager is required. The manager-of-manager step is included only
  // when one exists — employees who report directly to the top of the org (e.g. the
  // CEO, who has no manager above) still get a valid chain of direct manager + HR.
  if (!manager?.hrId) {
    throw new Error("Vacation approval chain is incomplete. Please contact HR before submitting a vacation request.");
  }

  // Owner rule (2026-08-15, corrected 2026-08-19): a District Manager's chain drops the CEO but
  // must always keep the National Sales Manager — see shouldIncludeManagerOfManagerStep. A DM
  // reporting straight to the NSM ends at that one management step; a DM reporting through a
  // Regional Sales Manager still escalates RSM -> NSM before HR.
  const includeManagerOfManager = shouldIncludeManagerOfManagerStep({ managerOfManager, requesterRole });
  // Owner rule (2026-10-08): a Regional Manager between the District Manager and the NSM must not
  // end the chain — the NSM is approver number three, then HR. Never the CEO.
  const includeThirdManager = shouldIncludeThirdManagementStep({
    includesManagerOfManagerStep: includeManagerOfManager,
    managerOfManager,
    thirdManager,
  });

  const hrApprovers = await resolveVacationPilotHrApprovers(directory);
  return [
    {
      email: manager.workEmail,
      hrId: manager.hrId,
      name: manager.displayName,
      stepKey: "direct_manager",
      userId: null,
    },
    ...(includeManagerOfManager && managerOfManager?.hrId
      ? [
          {
            email: managerOfManager.workEmail,
            hrId: managerOfManager.hrId,
            name: managerOfManager.displayName,
            stepKey: "manager_of_manager" as const,
            userId: null,
          },
        ]
      : []),
    ...(includeThirdManager && thirdManager?.hrId
      ? [
          {
            email: thirdManager.workEmail,
            hrId: thirdManager.hrId,
            name: thirdManager.displayName,
            stepKey: "manager_level_3" as const,
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
    .select("id,request_id,step_key,step_order,approver_hr_id,approver_user_id,status,decision_comment,decided_at,created_at,overridden_by_hr_id,overridden_at")
    .eq("request_id", requestId);
  if (error) throwVacationDatabaseError(error);
  return ((data ?? []) as VacationApprovalStepRow[]).map(mapVacationApprovalStep);
}

async function fetchVacationApprovalStepsForRequests(requestIds: string[]) {
  const byRequestId = new Map<string, Awaited<ReturnType<typeof fetchVacationApprovalStepsForRequest>>>();
  if (requestIds.length === 0) return byRequestId;
  for (const batch of chunk(requestIds)) {
    const { data, error } = await getSupabaseAdmin()
      .from(vacationApprovalStepsTable)
      .select("id,request_id,step_key,step_order,approver_hr_id,approver_user_id,status,decision_comment,decided_at,created_at,overridden_by_hr_id,overridden_at")
      .in("request_id", batch);
    if (error) {
      if (isVacationSchemaMissingError(error)) return byRequestId;
      throwVacationDatabaseError(error);
    }
    for (const row of ((data ?? []) as VacationApprovalStepRow[]).map(mapVacationApprovalStep)) {
      const current = byRequestId.get(row.requestId) ?? [];
      current.push(row);
      byRequestId.set(row.requestId, current);
    }
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
  let step = input.access
    ? pendingSteps.find((candidate) => approvalStepMatchesAccess(input.access as AccessContext, candidate))
    : pendingSteps.find((candidate) => approvalStepMatchesActor({
      actorHrId: input.actorHrId,
      actorLoginId: input.actorLoginId,
      step: candidate,
    }));
  // HR authority (Super Admin / system) may act on the pending HR step for ANY request — HR is one
  // conceptual authority (see closeSiblingPendingHrApprovalSteps), so it must not be gated to the
  // specific approver_hr_id on the row. evaluateStepAction still enforces the sequencing:
  // acknowledgement waits for management approvals; reject is allowed at any time.
  if (!step && input.access && isAllVacationVisibility(input.access)) {
    step = pendingSteps.find((candidate) => candidate.stepKey === "hr");
  }
  return { step: step ?? null, steps };
}

/** Narrow a fetched approval step to the fields the override rule reads. */
function toOverrideStep(
  step: Awaited<ReturnType<typeof fetchVacationApprovalStepsForRequest>>[number],
): VacationOverrideStep {
  return {
    createdAt: step.createdAt,
    decidedAt: step.decidedAt,
    order: step.stepOrder,
    status: step.status,
    stepKey: step.stepKey,
  };
}

async function recordVacationApprovalStepDecision(input: {
  decision: VacationDecision;
  decisionComment?: string | null;
  /** Set ONLY on the stalled-approver override — the Super Admin who decided in their place. */
  overriddenByHrId?: string | null;
  stepId: string;
}) {
  const now = new Date().toISOString();
  const status = input.decision === "approve" ? "approved" : "rejected";
  // The row keeps approver_hr_id pointing at the assigned approver, because that IS who the step
  // belonged to. Without these two columns the decided row would read as if that person answered
  // it — the one thing an override must never be able to look like.
  const overriddenByHrId = hrIdForStorage(input.overriddenByHrId) || null;
  const { data, error } = await getSupabaseAdmin()
    .from(vacationApprovalStepsTable)
    .update({
      decided_at: now,
      decision_comment: nullableText(input.decisionComment),
      overridden_at: overriddenByHrId ? now : null,
      overridden_by_hr_id: overriddenByHrId,
      status,
      updated_at: now,
    })
    .eq("id", input.stepId)
    .eq("status", "pending")
    .select("id,request_id,step_key,step_order,approver_hr_id,approver_user_id,status,decision_comment,decided_at,created_at,overridden_by_hr_id,overridden_at")
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
  // The vacation request's own employee — every vacation email is an "official workflow
  // email" that requires a subject employee HR ID (see emailSubjectIdentityRequired in
  // notifications/system.ts); omitting this trips that guard and silently skips the email
  // for every recipient, not just the employee themselves.
  subjectHrId?: string | null;
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

  await createSystemNotificationForRecipients(
    {
      ...(input.channels ? { channels: input.channels } : {}),
      actionUrl: input.href,
      category: "vacation_request",
      eventType: input.type,
      message: input.message,
      metadata: {
        ...(input.metadata ?? {}),
        ...(input.subjectHrId ? { employeeHrId: input.subjectHrId } : {}),
        idempotencyKey: `vacation:${input.requestId}:${input.type}`,
      },
      module: "vacation",
      priority: "high",
      subjectHrId: input.subjectHrId ?? undefined,
      title: input.title,
    },
    recipientHrIds,
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
  // Every leave type — sequential AND legacy Sick — is reviewed on the dedicated per-request
  // Vacation Approvals page. No one-click approve/reject links: notifications always redirect
  // the responder to the page to respond explicitly.
  const actionCenterUrl = `/admin/approvals/vacation/${encodeURIComponent(input.request.id)}`;
  const absoluteReviewUrl = toAbsoluteAppUrl(actionCenterUrl);

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
    if (stepKey === "manager_level_3") {
      return {
        message: "FYI: a vacation request was submitted. Your approval will be available after the earlier management approvals are completed.",
        status: "Available after the earlier management approvals",
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
      }).then(async (result) => {
        await recordVacationEmailSkip({
          actorHrId: input.request.employeeHrId,
          label: "Manager approval request (on submit)",
          recipient: primaryDeliverableEmail,
          requestId: input.request.id,
          result,
        });
      }).catch(async (error) => {
        await insertVacationEvent({
          actorHrId: input.request.employeeHrId,
          eventType: "notification_failed",
          message: vacationErrorMessage(error),
          requestId: input.request.id,
        }).catch(() => undefined);
      })
    : Promise.resolve(undefined);

  await Promise.allSettled([
    ...input.approvalRecipients.map((recipient) => {
      const copy = recipientCopy(recipient.stepKey);
      const telegramButtons = [{ label: "Review Request", url: actionCenterUrl }];
      // Sequential submit email is sent once above: primary manager TO, visibility approvers CC.
      // Per-recipient notification records remain in-app/Telegram only.
      const isPrimaryEmailRecipient = !sequential && samePrimaryRecipient(recipient);
      return createSystemNotification({
        actionUrl: actionCenterUrl,
        category: "vacation_request",
        channels: sequential || !isPrimaryEmailRecipient ? ["in_app", "telegram"] : ["in_app", "email", "telegram"],
        ...(!isPrimaryEmailRecipient
          ? {}
          : { email: { cc: ccEmails, recipients: primaryDeliverableEmail ? [primaryDeliverableEmail] : undefined } }),
        eventType: "request_submitted",
        message: copy.message,
        metadata: {
          ...(input.metadata ?? {}),
          actionUrl: actionCenterUrl,
          reviewUrl: actionCenterUrl,
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
          requestUrl: actionCenterUrl,
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

/**
 * The INFORMED party's copy of a submitted annual vacation (owner, 2026-09-29: "in any av request
 * on phx make yasmeena informed").
 *
 * THE INFORMED PARTY IS A SEAT (owner, 2026-10-20: "Both to you until the hire") — whoever holds the
 * HR Generalist seat, and while nobody does, the Super Admin standing in for it
 * (`resolveSeatOrStandInHrIds`, src/lib/notifications/vacant-seat.ts). A seat that could not be
 * read informs nobody this time rather than guessing; the request and its approvals are untouched.
 *
 * THE INFORMED PARTY IS NOT AN APPROVER, and this function is where that distinction lives. It is
 * deliberately NOT a line added to `approvalRecipients` — every name in that list gets an approval
 * step, an SLA clock and Approve/Reject buttons, so putting the seat there would have made every
 * annual vacation in the company wait on a third signature. This is one notification per informed
 * person that says so in its own copy: no action is needed.
 *
 * ALL THREE CHANNELS — in-app, email and Telegram (owner, 2026-09-30, asked and answered: "yasmine
 * informed in app email telegram"). It shipped on 2026-09-29 as in-app + Telegram only, because §4
 * requires an email recipient to be asked about before it is wired; he was asked, and this is the
 * answer. It still carries no Telegram approve/reject button: there is nothing to decide.
 *
 * NO `email` BLOCK IS PASSED, deliberately. With only `recipientHrId` set, the notification layer
 * resolves the person's OWN work address from the employee record and sets `recipientMode: "candidate"` — and
 * when an address cannot be resolved it records `recipientAddressUnresolved` and skips. Writing an
 * address here, or leaving `recipients` empty for the stored policy to fill, is how the shared
 * `hr_notifications` inbox ends up standing in for a person and the send is logged as a success.
 *
 * THE LINK IS THE VACATION REPORT. `/hr/leave-management/vacation-report` is the row the HR
 * Generalist's sidebar offers, and the same address opens for the Super Admin standing in (under the
 * HR chrome, by AppShell's design); `/admin/approvals/vacation/<id>` is the approver's page and would open on a
 * decision surface that is not the informed party's.
 */
async function dispatchVacationInformed(input: {
  approvalRecipients: VacationApprovalRecipient[];
  request: VacationRequestRecord;
}) {
  // Annual only, decided before the seat is read, so no other request type costs a lookup.
  if (!isVacationInformedType(input.request.vacationType)) return;
  const seat = await resolveSeatOrStandInHrIds(VACATION_INFORMED_SEAT, "Vacation informed recipients");
  const informedHrIds = resolveVacationInformedHrIds({
    // Everyone this request already notifies. An informed person who is one of them — raised it, or
    // sits in its chain — is dropped rather than sent a second, weaker copy.
    alreadyNotifiedHrIds: [
      input.request.employeeHrId,
      input.request.managerHrId,
      input.request.managerOfManagerHrId,
      ...input.approvalRecipients.map((recipient) => recipient.hrId),
    ],
    informedHrIds: seat.hrIds,
    vacationType: input.request.vacationType,
  });
  if (informedHrIds.length === 0) return;

  const href = `/hr/leave-management/vacation-report?requestId=${encodeURIComponent(input.request.id)}`;
  for (const informedHrId of informedHrIds) {
    await createSystemNotification({
      actionUrl: href,
      category: "vacation_request",
      channels: ["in_app", "email", "telegram"],
      eventType: "request_submitted_informed",
      message: `${input.request.employeeName} submitted ${vacationTypeLabel(input.request.vacationType)} from ${input.request.startDate} to ${input.request.endDate} (${input.request.durationDays} day(s)). No decision is needed from you — you are informed so leave administration has it on the day it is raised.`,
      metadata: {
        details: [
          { label: "Employee", value: `${input.request.employeeName} (${input.request.employeeHrId})` },
          { label: "Type", value: vacationTypeLabel(input.request.vacationType) },
          { label: "Period", value: `${input.request.startDate} → ${input.request.endDate}` },
          { label: "Manager", value: input.request.managerName ?? "Direct manager" },
          { label: "Status", value: "Informed — no action needed" },
        ],
        employeeHrId: input.request.employeeHrId,
        employeeName: input.request.employeeName,
        // Per (request, informed recipient), so a re-dispatch tells each informed person once, not twice.
        idempotencyKey: `vacation:${input.request.id}:request_submitted_informed:${informedHrId.toUpperCase()}`,
        requestId: input.request.id,
        status: input.request.status,
      },
      module: "vacation",
      // `normal`, not `high`: a high-priority notification is one somebody has to act on, and the
      // whole point of this one is that nobody does.
      priority: "normal",
      recipientHrId: informedHrId,
      recordId: input.request.id,
      subjectHrId: input.request.employeeHrId,
      title: `${input.request.employeeName} requested ${vacationTypeLabel(input.request.vacationType)}`,
    });
  }
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
  // AFTER the approval chain's own notifications, never instead of them: this is the informed
  // copy (owner, 2026-09-29) and it must never be able to displace a decision-maker's.
  await dispatchVacationInformed({
    approvalRecipients: input.approvalRecipients,
    request: input.request,
  });
}

async function dispatchVacationManagerReview(input: {
  decision: VacationDecision;
  directory: EmployeeDirectoryData;
  request: VacationRequestRecord;
}) {
  const hrRecipients = await getHrRecipients(input.directory);
  const sequential = isSequentialWorkflowType(input.request.vacationType);
  const reportHref = sequential
    ? `/admin/approvals/vacation/${encodeURIComponent(input.request.id)}`
    : `/leave-management/vacation-report?requestId=${encodeURIComponent(input.request.id)}`;
  await notifyRecipients({
    // Email is delivered by the templated sendVacationManagerStepResultEmail below; keep this
    // generic notification to in-app + Telegram + push so the recipients don't also receive a
    // duplicate generic email.
    channels: ["in_app", "telegram", "push"],
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
    subjectHrId: input.request.employeeHrId,
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
      employeeDisplayName: findEmployeeByHrId(input.directory, input.request.employeeHrId)?.displayName,
      employeeEmail: input.request.employeeWorkEmail,
      managerDecisionComment: input.request.managerDecisionComment ?? null,
      managerName: input.request.managerName ?? "Your manager",
      nextStep,
      request: input.request,
    }).then(async (result) => {
      await recordVacationEmailSkip({
        actorHrId: input.request.managerHrId,
        label: `Manager step result (${input.decision})`,
        recipient: input.request.employeeWorkEmail,
        requestId: input.request.id,
        result,
      });
    }).catch(async (error) => {
      await insertVacationEvent({
        actorHrId: input.request.managerHrId,
        eventType: "notification_failed",
        message: vacationErrorMessage(error),
        requestId: input.request.id,
      }).catch(() => undefined);
    });
  }
}

async function dispatchVacationNextManagerStep(input: {
  directory: EmployeeDirectoryData;
  nextApproverHrId: string;
  actingManagerHrId: string | null | undefined;
  request: VacationRequestRecord;
}) {
  const actingManager = findEmployeeByHrId(input.directory, input.actingManagerHrId);
  const actingName = actingManager?.displayName ?? input.request.managerName ?? "Your manager";
  const actionHref = `/admin/approvals/vacation/${encodeURIComponent(input.request.id)}`;
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
    // Email is delivered by the templated sendVacationManagerDecisionEmail below; keep this
    // generic notification to in-app + Telegram + push so the next approver doesn't also
    // receive a duplicate generic email.
    channels: ["in_app", "telegram", "push"],
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
    subjectHrId: input.request.employeeHrId,
    telegram: { buttons: [{ label: "Review Request", url: actionHref }] },
    title: `${input.request.employeeName}'s vacation request needs your approval`,
  });
  await notifyRecipients({
    channels: ["in_app", "telegram", "push"],
    href: `/employee-portals/vacation-report?requestId=${encodeURIComponent(input.request.id)}`,
    message: `${actingName} approved your ${vacationTypeLabel(input.request.vacationType)} request (${input.request.startDate} → ${input.request.endDate}). It is now pending secondary management review.`,
    metadata: {
      requestId: input.request.id,
      status: input.request.status,
      details: [...detailBase, { label: "Status", value: "Pending secondary management review" }],
    },
    recipients: [input.request.employeeHrId],
    requestId: input.request.id,
    subjectHrId: input.request.employeeHrId,
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
      managerName: nextApprover.displayName,
      request: input.request,
      reviewUrl: toAbsoluteAppUrl(actionHref),
    }).then(async (result) => {
      await recordVacationEmailSkip({
        actorHrId: input.actingManagerHrId,
        label: "Next approver hand-off",
        recipient: nextManagerEmail,
        requestId: input.request.id,
        result,
      });
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
    channels: ["in_app", "telegram", "push"],
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
    subjectHrId: input.request.employeeHrId,
    title: `${input.request.employeeName}'s vacation request was ${input.decision === "approve" ? "approved" : "rejected"}`,
    type: `decision:${input.decision}`,
  });

  if (!input.request.employeeWorkEmail) return;
  await sendVacationDecisionResultEmail({
    cc: (await Promise.all(approvalRecipientHrIds.map((hrId) => resolveManagerEmail(input.directory, hrId))))
      .filter((email): email is string => Boolean(email)),
    decision: input.decision,
    employeeDisplayName: findEmployeeByHrId(input.directory, input.request.employeeHrId)?.displayName,
    employeeEmail: input.request.employeeWorkEmail,
    request: input.request,
  });
}

async function resolveManagerEmail(directory: EmployeeDirectoryData, managerHrId: string | null | undefined) {
  const manager = findEmployeeByHrId(directory, managerHrId);
  return manager?.workEmail ?? null;
}

/**
 * Days already settled against vacation balance via the Payroll Copilot's
 * Unpaid Vacation tab (src/lib/payroll/copilot/vacation-settlement.ts) whose
 * underlying request start_date falls in the same balance-period window —
 * these must count as "used" for any later balance check the same way an
 * ordinary paid v2_vacation_requests row does. Defensive: table may not
 * exist yet on every environment; a missing-relation error is treated as
 * zero rather than breaking every vacation balance calculation.
 */
/**
 * Balance days already spent in this period, from the settlement ledger.
 *
 * Exported for its test: it carries the exclusion rule below, and that rule is the difference
 * between a payroll step that can be confirmed twice safely and one that gives leave days back.
 */
export async function balanceSettledDaysInPeriod(input: {
  employeeHrId: string;
  periodStart: string;
  periodEnd: string;
  /**
   * Ignore settlements written by THIS payroll run.
   *
   * A payroll run that is about to re-decide how much balance it consumes must not read back its
   * OWN previous answer as though somebody else had spent those days. Without this, confirming the
   * Part 2 vacation step a second time sees a balance already drawn down by the first confirm,
   * concludes the balance covers nothing, and supersedes the row that consumed it — handing the
   * days back while the payroll deduction stays where it was. A third confirm sees the restored
   * balance and consumes it again. The figure oscillates, and each swing is a real change to
   * somebody's leave entitlement.
   *
   * Only rows carrying THIS run id are set aside. A settlement written outside any payroll run
   * (`run_id` IS NULL — the Copilot's settle workflow, a one-off correction) is somebody else's
   * spending and still counts.
   */
  excludeSettlementRunId?: string | null;
  /**
   * Throw instead of reading a failed lookup as 0. Only a caller that SPENDS balance on the answer
   * passes this (the weekly attendance review's "pay from annual balance"): a zero there lets the
   * same days be spent twice. Everything else keeps the fail-open read so a page still renders.
   */
  failClosed?: boolean;
},
  /** Injected only by the test — production always uses the admin client. */
  client: Pick<ReturnType<typeof getSupabaseAdmin>, "from"> = getSupabaseAdmin(),
): Promise<number> {
  const compactHrId = input.employeeHrId.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!compactHrId) return 0;

  try {
    let query = client
      .from("payroll_copilot_vacation_settlements")
      .select("balance_days_consumed")
      .eq("employee_hr_id_compact", compactHrId)
      .in("settlement_method", ["balance", "partial_balance", "defer_to_balance"])
      .is("superseded_at", null)
      .gte("start_date", input.periodStart)
      .lt("start_date", input.periodEnd);
    const excludedRunId = input.excludeSettlementRunId;
    if (excludedRunId && isUuid(excludedRunId)) {
      // NOT `.neq("run_id", id)`. PostgREST's `neq` is SQL `<>`, and `NULL <> id` is NULL, never
      // true, so it also dropped every settlement written outside a payroll run. The run then
      // believed more balance remained than really did and settled more leave against it than was
      // left — spending days that were already spent. Keep the NULLs explicitly.
      // The id is written into the filter's text, which is safe only because a uuid is hex and
      // hyphens: a comma, a dot or a parenthesis would split, rewrite or widen the expression.
      query = query.or(`run_id.is.null,run_id.neq.${excludedRunId}`);
    } else if (excludedRunId) {
      // Never written into the filter. `run_id` is a uuid column and every run id this code is
      // given comes back from Postgres as one, so anything else is a caller's defect: the exclusion
      // is left off — this run's own rows then count against it — and the error log says so.
      logError("Balance-settled days lookup ignored a run id that is not a uuid", {
        labels: {
          event: "vacation_balance_settled_days_run_id_not_uuid",
          employeeHrId: input.employeeHrId,
          excludeSettlementRunId: excludedRunId.slice(0, 64),
        },
      });
    }
    const { data, error } = await query;

    if (error) {
      const message = String((error as { message?: unknown }).message ?? "").toLowerCase();
      if (message.includes("could not find the table") || message.includes("schema cache")) return 0;
      throw error;
    }
    return (data ?? []).reduce(
      (sum, row) => sum + numberValue((row as { balance_days_consumed?: unknown }).balance_days_consumed),
      0,
    );
  } catch (error) {
    logError("Balance-settled days lookup failed", { labels: { event: "vacation_balance_settled_days_lookup_failed", employeeHrId: input.employeeHrId }, error });
    if (input.failClosed) throw error;
    return 0;
  }
}

/**
 * The statuses a request passes through after the employee has submitted it and before anyone has
 * decided it. The leave has been taken (or is booked) but no approver has clicked yet. `returned`
 * is deliberately absent: the ball is back with the employee and the request is not live.
 */
const IN_FLIGHT_VACATION_STATUSES = ["needs_assignment", "pending_manager", "pending_hr"] as const;

/**
 * Paid days already committed by in-flight requests, for the balance a HUMAN is shown.
 *
 * DISPLAY ONLY, and deliberately a separate function from approvedPaidDaysInPeriod rather than a
 * widened status filter inside it. That one feeds calculatePaymentForRequest, which decides paid vs
 * unpaid, writes paid_duration_days onto the row, and is read again by automated payroll, the
 * deduction connector and the Payroll Copilot settlement tab. Reserving inside it would change what
 * people are PAID, not just what they see — and would make two requests pending at once starve each
 * other at approval time. Pricing stays approved-only; only the number on screen counts leave that
 * has been taken but not yet clicked through.
 */
async function pendingPaidDaysInPeriod(input: {
  employeeHrId: string;
  periodEnd: string | null;
  periodStart: string | null;
  vacationType: VacationType;
}) {
  if (!input.periodStart || !input.periodEnd) return 0;

  // The person's own rows and an earlier record's (continuous-service.ts); a plain eq otherwise.
  const ownAndEarlier = ownAndEarlierRecordHrIds(input.employeeHrId.toUpperCase());
  const requestsForPerson = getSupabaseAdmin()
    .from(vacationRequestsTable)
    .select("id,duration_days,paid_duration_days,payment_status");
  let query = (ownAndEarlier.length > 1
    ? requestsForPerson.in("employee_hr_id", ownAndEarlier)
    : requestsForPerson.eq("employee_hr_id", input.employeeHrId.toUpperCase()))
    .in("status", IN_FLIGHT_VACATION_STATUSES as unknown as string[])
    .gte("start_date", input.periodStart)
    .lt("start_date", input.periodEnd);

  // Same pooling as the approved sum: annual and emergency draw on one balance, everything else
  // stands alone, so a reserved day is subtracted from exactly the pool it will land in.
  if (input.vacationType === "annual" || input.vacationType === "emergency") {
    query = query.in("vacation_type", ["annual", "emergency"]);
  } else {
    query = query.eq("vacation_type", input.vacationType);
  }

  const { data, error } = await query;
  if (error) {
    // A balance that cannot read its reservations must not blank the page — fall back to showing
    // the approved-only figure, which is what this screen showed before reservations existed.
    logError("Pending vacation days lookup failed", { labels: { event: "vacation_pending_days_lookup_failed", employeeHrId: input.employeeHrId }, error });
    return 0;
  }

  return (data ?? []).reduce((sum, row) => {
    const record = row as Record<string, unknown>;
    if (record.paid_duration_days != null) return sum + numberValue(record.paid_duration_days);
    return record.payment_status === "paid" ? sum + numberValue(record.duration_days) : sum;
  }, 0);
}

/** Reaches only `.from` — the admin client in production, a fake in the tests. */
type VacationBalanceReadClient = Pick<ReturnType<typeof getSupabaseAdmin>, "from">;

/**
 * Exported for its test (tests/vacation-reads-started-together.test.ts). Production reaches
 * it only through calculatePaymentForRequest and the carried-debt walk below, and `client` is
 * injected only by that test — left out, every read uses the admin client exactly as before.
 */
export async function approvedPaidDaysInPeriod(input: {
  employeeHrId: string;
  excludeRequestId?: string;
  /** Passed straight to balanceSettledDaysInPeriod — see the note there. */
  excludeSettlementRunId?: string | null;
  /** Passed straight to balanceSettledDaysInPeriod's `failClosed`. */
  failClosedLedgerRead?: boolean;
  periodEnd: string | null;
  periodStart: string | null;
  vacationType: VacationType;
}, client?: VacationBalanceReadClient) {
  if (!input.periodStart || !input.periodEnd) return 0;

  const reader: VacationBalanceReadClient = client ?? getSupabaseAdmin();
  // The person's own rows and an earlier record's (continuous-service.ts). A plain eq for everyone
  // without one, so their read is unchanged.
  const ownAndEarlier = ownAndEarlierRecordHrIds(input.employeeHrId.toUpperCase());
  const requestsForPerson = reader
    .from(vacationRequestsTable)
    .select("id,duration_days,paid_duration_days,payment_status");
  let query = (ownAndEarlier.length > 1
    ? requestsForPerson.in("employee_hr_id", ownAndEarlier)
    : requestsForPerson.eq("employee_hr_id", input.employeeHrId.toUpperCase()))
    .eq("status", "approved")
    .gte("start_date", input.periodStart)
    .lt("start_date", input.periodEnd);

  if (input.vacationType === "annual" || input.vacationType === "emergency") {
    query = query.in("vacation_type", ["annual", "emergency"]);
  } else {
    query = query.eq("vacation_type", input.vacationType);
  }

  // STARTED TOGETHER (2026-10-01, "slow to transfer between page and page"): the Copilot ledger and
  // the attendance charges never depended on the request read, yet each waited for the one before
  // it. All three now start at once — the two ledgers still only for the annual/emergency pool. They
  // are unwrapped in the order they used to run (a failed request read throws first, then a
  // fail-closed ledger read, then the attendance read), so the sum and every thrown error are the
  // ones the one-after-another version produced.
  const pooledWithAnnual = input.vacationType === "annual" || input.vacationType === "emergency";
  const [requestRead, settledRead, attendanceRead] = await Promise.allSettled([
    query,
    pooledWithAnnual
      ? balanceSettledDaysInPeriod({
          employeeHrId: input.employeeHrId,
          excludeSettlementRunId: input.excludeSettlementRunId,
          failClosed: input.failClosedLedgerRead,
          periodEnd: input.periodEnd,
          periodStart: input.periodStart,
        }, client)
      : Promise.resolve(0),
    pooledWithAnnual
      ? attendanceChargedDaysInPeriod({
          employeeHrId: input.employeeHrId,
          periodEnd: input.periodEnd,
          periodStart: input.periodStart,
        }, client)
      : Promise.resolve(0),
  ]);

  const { data, error } = settledValueOrThrow(requestRead);

  if (error) throw new Error(typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error));

  const requestDays = (data ?? [])
    .filter((row) => String((row as Record<string, unknown>).id) !== input.excludeRequestId)
    .reduce((sum, row) => {
      const record = row as Record<string, unknown>;
      if (record.paid_duration_days != null) return sum + numberValue(record.paid_duration_days);
      return record.payment_status === "paid" ? sum + numberValue(record.duration_days) : sum;
    }, 0);

  // Only annual/emergency balance is settleable via the Copilot's Unpaid
  // Vacation tab today — matches the vacation_type grouping just above.
  if (input.vacationType !== "annual" && input.vacationType !== "emergency") return requestDays;

  const settledDays = settledValueOrThrow(settledRead);
  const attendanceDays = settledValueOrThrow(attendanceRead);
  return requestDays + settledDays + attendanceDays;
}

/**
 * Annual leave days an employee chose to spend on attendance deductions (weekly attendance
 * review, owner decision 2026-09-15). Same pool as annual and emergency requests.
 *
 * Unlike balanceSettledDaysInPeriod this does NOT swallow a read failure into 0: a balance that
 * silently forgets days already spent lets the same days be spent twice. Only a table that does
 * not exist yet (the migration not applied) reads as 0, because then no charge can exist either.
 */
export async function attendanceChargedDaysInPeriod(
  input: { employeeHrId: string; periodStart: string; periodEnd: string },
  client: Pick<ReturnType<typeof getSupabaseAdmin>, "from"> = getSupabaseAdmin(),
): Promise<number> {
  const hrId = input.employeeHrId.trim();
  if (!hrId) return 0;
  const { data, error } = await client
    .from("attendance_annual_balance_charges")
    .select("days")
    .ilike("employee_hr_id", hrId.replace(/[\\%_]/g, (char) => `\\${char}`))
    .gte("work_date", input.periodStart)
    .lt("work_date", input.periodEnd);
  if (error) {
    const code = String((error as { code?: unknown }).code ?? "");
    const message = String((error as { message?: unknown }).message ?? "").toLowerCase();
    if (code === "PGRST205" || code === "42P01" || message.includes("could not find the table")) return 0;
    throw new Error(typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error));
  }
  return (data ?? []).reduce((sum, row) => sum + numberValue((row as { days?: unknown }).days), 0);
}

/**
 * A full ledger read past this many rows is refused rather than silently truncated: a balance that
 * forgot days already spent says more is left than there is.
 */
const ANNUAL_BALANCE_LEDGER_READ_LIMIT = 20_000;

/**
 * EVERY annual-balance ledger day, for `buildEmployeeEligibilityRows` — the Entitlements tab's
 * counterpart to `attendanceChargedDaysInPeriod` and `balanceSettledDaysInPeriod` above, which take
 * one employee and one period each and would be two round trips per row of the report.
 *
 * 🔴 BOTH POOLS, AND `attendance_annual_balance_charges` WITH NO `source` FILTER. The tab used to be
 * handed `listLeaveBalanceChargesForEmployees` — the `source = 'deductions'` fold — so a day the
 * weekly attendance review had charged, or a day payroll had settled, never reached Used, and the
 * Balance column read higher than the figure `calculatePaymentForRequest` prices a request against.
 * `approvedPaidDaysInPeriod` counts request days plus BOTH of these, and this is the same arithmetic
 * on the same rows: negative reversal rows net themselves, exactly as they do there.
 *
 * Rows come back with no employee or period filter, the way `readDeductionsRows` already reads this
 * ledger: the caller matches on `hrIdsMatch` (the ledger carries the same HR_ID case drift the
 * per-employee readers use `ilike` for) and on each employee's own balance period. A missing table
 * means the migration has not run, so no such day can exist and it reads as none; anything else
 * throws, and the caller decides what to show.
 */
export async function annualBalanceLedgerDays(
  client: Pick<ReturnType<typeof getSupabaseAdmin>, "from"> = getSupabaseAdmin(),
): Promise<Array<{ employeeHrId: string; workDate: string; days: number }>> {
  const tableMissing = (error: unknown) => {
    const code = String((error as { code?: unknown } | null)?.code ?? "");
    const message = String((error as { message?: unknown } | null)?.message ?? "").toLowerCase();
    return code === "PGRST205" || code === "42P01" || code === "42703" || message.includes("could not find the table");
  };
  const rowsOf = (label: string, result: { data?: unknown; error?: unknown }) => {
    if (result.error) {
      if (tableMissing(result.error)) return [];
      const message = (result.error as { message?: unknown }).message;
      throw new Error(`Failed to read ${label}: ${typeof message === "string" ? message : String(result.error)}`);
    }
    const rows = (result.data ?? []) as Array<Record<string, unknown>>;
    if (rows.length >= ANNUAL_BALANCE_LEDGER_READ_LIMIT) {
      throw new Error(`${label} returned ${rows.length} rows or more, so the balance would be understated`);
    }
    return rows;
  };

  const [chargeRead, settlementRead] = await Promise.all([
    client
      .from("attendance_annual_balance_charges")
      .select("employee_hr_id,work_date,days")
      .limit(ANNUAL_BALANCE_LEDGER_READ_LIMIT),
    client
      .from("payroll_copilot_vacation_settlements")
      .select("employee_hr_id_compact,start_date,balance_days_consumed")
      .in("settlement_method", ["balance", "partial_balance", "defer_to_balance"])
      .is("superseded_at", null)
      .limit(ANNUAL_BALANCE_LEDGER_READ_LIMIT),
  ]);

  return [
    ...rowsOf("the annual balance charges", chargeRead as { data?: unknown; error?: unknown }).map((row) => ({
      employeeHrId: String(row.employee_hr_id ?? ""),
      workDate: String(row.work_date ?? ""),
      days: numberValue(row.days),
    })),
    ...rowsOf("the vacation balance settlements", settlementRead as { data?: unknown; error?: unknown }).map((row) => ({
      employeeHrId: String(row.employee_hr_id_compact ?? ""),
      workDate: String(row.start_date ?? ""),
      days: numberValue(row.balance_days_consumed),
    })),
  ].filter((row) => row.employeeHrId && row.workDate);
}

/** How many past balance periods the carried-debt walk reads at once — each is up to three reads. */
const DEFERRED_DEBT_PERIODS_READ_TOGETHER = 6;

/**
 * Exported for its test, with approvedPaidDaysInPeriod above; `client` is injected only there.
 */
export async function getDeferredDebtFromPreviousPeriods(input: {
  employeeHrId: string;
  hireDate: string;
  currentPeriodStart: string;
  failClosedLedgerRead?: boolean;
}, client?: VacationBalanceReadClient): Promise<number> {
  if (compareDateOnly(input.currentPeriodStart, input.hireDate) <= 0) return 0;

  // THE PERIODS FIRST, THEN THEIR READS TOGETHER (2026-10-01, "slow to transfer between page and
  // page"). Which periods the walk visits is decided by dates alone — the same loop and the same
  // 50-period cap as before — never by what a period's read returned, so the list is built up front.
  // The reads then run six periods at a time instead of one after another, and the debt is folded
  // in period order with the same max(0, debt + used − entitlement) step, so the figure is the same
  // to the last digit. A failed read throws only when the fold reaches it, so the error is the one
  // the one-at-a-time walk met first; once a batch holds a failure, no later batch is started.
  const periods: Array<NonNullable<ReturnType<typeof getVacationBalancePeriod>>> = [];
  let periodStart = input.hireDate;
  let iterations = 0;
  while (compareDateOnly(periodStart, input.currentPeriodStart) < 0 && iterations < 50) {
    iterations++;
    const period = getVacationBalancePeriod({ employeeHrId: input.employeeHrId, hireDate: input.hireDate, referenceDate: periodStart });
    if (!period) break;
    periods.push(period);
    periodStart = period.periodEnd;
  }

  const usedPaidDaysReads: Array<PromiseSettledResult<number>> = [];
  for (let first = 0; first < periods.length; first += DEFERRED_DEBT_PERIODS_READ_TOGETHER) {
    const batch = await Promise.allSettled(
      periods.slice(first, first + DEFERRED_DEBT_PERIODS_READ_TOGETHER).map((period) =>
        approvedPaidDaysInPeriod({
          employeeHrId: input.employeeHrId,
          failClosedLedgerRead: input.failClosedLedgerRead,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          vacationType: "annual",
        }, client),
      ),
    );
    usedPaidDaysReads.push(...batch);
    if (batch.some((read) => read.status === "rejected")) break;
  }

  let currentDebt = 0;
  for (let index = 0; index < usedPaidDaysReads.length; index += 1) {
    const period = periods[index];
    const usedPaidDays = settledValueOrThrow(usedPaidDaysReads[index]);

    const entitlementDays = getCompletedVacationPeriodEntitlementDays({
      employeeHrId: input.employeeHrId,
      hireDate: input.hireDate,
      period,
    });
    currentDebt = Math.max(0, currentDebt + usedPaidDays - entitlementDays);
  }

  return currentDebt;
}

/**
 * Exported so other domains (Payroll Copilot's Unpaid Vacation review tab)
 * can ask "does this employee currently have enough balance for N days" the
 * same way a live request submission would be evaluated, without
 * duplicating the balance-period/approved-days query logic above.
 */
export async function calculatePaymentForRequest(input: {
  /**
   * Read the accrued balance even inside the employee's first six months — see
   * calculateVacationPayment. Only the Deductions "Deduct from leave balance" button passes it.
   */
  allowFirstSixMonths?: boolean;
  durationDays: number;
  employeeHrId: string;
  excludeRequestId?: string;
  /**
   * Ignore balance settlements written by this payroll run when reading the balance.
   *
   * Only a payroll run re-deciding its own settlement passes this. Everything else leaves it unset
   * and sees every live settlement, which is what a balance check should normally do.
   */
  excludeSettlementRunId?: string | null;
  /**
   * Refuse (throw) when the payroll balance ledger cannot be read, in this period or any earlier
   * one the carried debt walks, instead of counting it as 0. See balanceSettledDaysInPeriod.
   */
  failClosedLedgerRead?: boolean;
  hireDate: string | null;
  startDate: string;
  vacationType: VacationType;
}) {
  if (input.vacationType === "compensatory") {
    const payment = calculateVacationPayment({
      approvedPaidDaysInPeriod: 0,
      durationDays: input.durationDays,
      employeeHrId: input.employeeHrId,
      hireDate: input.hireDate,
      startDate: input.startDate,
      vacationType: input.vacationType,
    });
    return { ...payment, carriedOverDebtDays: 0 };
  }

  const period = getVacationBalancePeriod({
    employeeHrId: input.employeeHrId,
    hireDate: input.hireDate,
    referenceDate: input.startDate,
  });
  const usedPaidDays = await approvedPaidDaysInPeriod({
    employeeHrId: input.employeeHrId,
    excludeRequestId: input.excludeRequestId,
    excludeSettlementRunId: input.excludeSettlementRunId,
    failClosedLedgerRead: input.failClosedLedgerRead,
    periodEnd: period?.periodEnd ?? null,
    periodStart: period?.periodStart ?? null,
    vacationType: input.vacationType,
  });

  let carriedOverDebtDays = 0;
  if ((input.vacationType === "annual" || input.vacationType === "emergency") && period?.periodStart && input.hireDate) {
    carriedOverDebtDays = await getDeferredDebtFromPreviousPeriods({
      employeeHrId: input.employeeHrId,
      failClosedLedgerRead: input.failClosedLedgerRead,
      hireDate: input.hireDate,
      currentPeriodStart: period.periodStart,
    });
  }

  const payment = calculateVacationPayment({
    allowFirstSixMonths: input.allowFirstSixMonths,
    approvedPaidDaysInPeriod: usedPaidDays + carriedOverDebtDays,
    durationDays: input.durationDays,
    employeeHrId: input.employeeHrId,
    hireDate: input.hireDate,
    startDate: input.startDate,
    vacationType: input.vacationType,
  });
  // `usedPaidDays` on the payment includes the debt. Returned apart so a caller comparing it with
  // this period's own ledgers can take the debt back out — otherwise debt masks a missing day.
  return { ...payment, carriedOverDebtDays };
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
  // Owner rule, 2026-10-08: the request needs a photo of the event, which cannot exist before the
  // event has taken place. Checked against the day the request is SUBMITTED, not the leave day.
  if (eventDate > getVacationPolicyToday()) {
    throw new Error("Compensatory Day cannot be submitted before the event has taken place. Submit it on or after the event date, with the event photo.");
  }
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
      cacheControl: PRIVATE_FILE_CACHE_CONTROL_SECONDS,
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
      cacheControl: PRIVATE_FILE_CACHE_CONTROL_SECONDS,
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

/**
 * The storage path of an evidence file that is NOT the request's first.
 *
 * `uniqueId` is what makes a repeated FILE NAME safe: two phone photos both called `IMG_0001.jpg`,
 * or the same certificate sent again a week later, must land BESIDE the earlier file, never on top
 * of it — the append-only rule is worth nothing if the object store silently overwrites.
 */
export function buildAdditionalVacationEvidenceObjectPath(input: {
  employeeHrId: string;
  fileName: string;
  kind: VacationEvidenceType;
  requestId: string;
  uniqueId: string;
}) {
  const employeeHrId = sanitizeStorageSegment(input.employeeHrId, "unknown-employee");
  const requestId = sanitizeStorageSegment(input.requestId, "unknown-request");
  const fallbackName = input.kind === "compensatory" ? "compensatory-event-photo" : "sick-document";
  const fileName = sanitizeStorageSegment(input.fileName, fallbackName);
  const uniqueId = sanitizeStorageSegment(input.uniqueId, "file") || "file";
  return `${input.kind}/${employeeHrId}/${requestId}/${uniqueId}-${fileName}`;
}

/**
 * Store one evidence file that is NOT the request's first — a second document picked at submit, or
 * one uploaded days later. Upsert stays false: an append must never overwrite a stored object.
 */
async function uploadAdditionalVacationEvidenceFile(input: {
  attachment: VacationAttachmentUpload;
  employeeHrId: string;
  kind: VacationEvidenceType;
  requestId: string;
}) {
  if (input.kind === "compensatory") validateCompensatoryAttachment(input.attachment);
  else validateSickAttachment(input.attachment);

  const objectPath = buildAdditionalVacationEvidenceObjectPath({
    employeeHrId: input.employeeHrId,
    fileName: input.attachment.fileName,
    kind: input.kind,
    requestId: input.requestId,
    uniqueId: randomUUID().slice(0, 8),
  });

  const { error } = await getSupabaseAdmin().storage
    .from(vacationAttachmentBucket)
    .upload(objectPath, input.attachment.bytes, {
      cacheControl: PRIVATE_FILE_CACHE_CONTROL_SECONDS,
      contentType: input.attachment.contentType,
      upsert: false,
    });

  if (error) {
    throw new Error(`Unable to store the uploaded document: ${error.message}`);
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

type StoredVacationEvidenceFile = {
  bucket: string;
  contentType: string | null;
  objectPath: string;
  originalName: string | null;
  sizeBytes: number | null;
  uploadedAt: string;
};

/**
 * Append stored files to a request's attachment history. APPEND ONLY — nothing here updates or
 * deletes an existing row, which is the owner's ruling of 2026-10-03 expressed in the one place the
 * rule can actually be broken.
 *
 * Tolerant of the table being absent so a deploy that lands before the migration still files the
 * request through the legacy columns; the rows are back-fillable from them.
 */
async function insertVacationAttachmentRows(input: {
  actorHrId: string | null;
  actorLoginId?: string | null;
  files: { file: StoredVacationEvidenceFile; kind: VacationEvidenceType }[];
  requestId: string;
}) {
  const rows = input.files
    .filter((entry) => Boolean(entry.file?.objectPath))
    .map((entry) => ({
      bucket: entry.file.bucket ?? vacationAttachmentBucket,
      content_type: entry.file.contentType ?? null,
      kind: entry.kind,
      object_path: entry.file.objectPath,
      original_name: entry.file.originalName ?? null,
      request_id: input.requestId,
      size_bytes: entry.file.sizeBytes ?? null,
      uploaded_at: entry.file.uploadedAt,
      uploaded_by_hr_id: input.actorHrId,
      uploaded_by_login_id: input.actorLoginId ?? null,
    }));
  if (rows.length === 0) return [] as VacationRequestAttachment[];

  try {
    const { data, error } = await getSupabaseAdmin()
      .from(vacationAttachmentsTable)
      .insert(rows)
      .select("*");
    if (error) throwVacationDatabaseError(error);
    return ((data ?? []) as VacationAttachmentDbRow[]).map(mapVacationAttachment);
  } catch (error) {
    if (!isVacationSchemaMissingError(error)) throw error;
    return [] as VacationRequestAttachment[];
  }
}

export async function getVacationRequestPageData(access: AccessContext) {
  await assertPermission(access, "leave", "create");
  const { directory, employee } = await getCurrentEmployee(access);
  // Africa/Cairo calendar day — matches getAnnualVacationMinimumStartDate() below (also
  // Cairo-anchored), so every key in balanceReferenceDates resolves "today" consistently
  // instead of "annual" alone being correct and the other four types using the server's own
  // local/UTC clock.
  const today = currentCairoDateOnlyIso();
  const { manager, managerOfManager, thirdManager } = managerChain(directory, employee);
  const previewIncludesManagerOfManager = shouldIncludeManagerOfManagerStep({ managerOfManager, requesterRole: access.role });
  const previewIncludesThirdManager = shouldIncludeThirdManagementStep({
    includesManagerOfManagerStep: previewIncludesManagerOfManager,
    managerOfManager,
    thirdManager,
  });
  // STARTED ALONGSIDE THE BALANCES (2026-10-01, "slow to transfer between page and page"): the
  // weekly-off policy is one read the balances never use, and it used to hold all of them up. It is
  // awaited below, after them; its failure still fails the page with the same error, because the
  // balances' own failures are caught into balanceError and never thrown. The no-op catch only stops
  // a failure from reading as UNHANDLED while the balances run — the await below still throws it.
  const weeklyOffPolicyRead = fetchWeeklyOffPolicyForTitle(employeeVacationPolicyTitle(employee));
  void weeklyOffPolicyRead.catch(() => undefined);

  const balanceReferenceDates: Record<VacationType, string> = {
    annual: getAnnualVacationMinimumStartDate(),
    compensatory: today,
    emergency: today,
    other: today,
    sick: today,
  };
  const balances: Partial<Record<VacationType, VacationBalanceSnapshot | null>> = {};
  // Days held by requests the employee has already submitted but nobody has decided yet. Kept
  // BESIDE the snapshot rather than folded into it: the snapshot is what gets written to
  // v2_vacation_requests and read by payroll, so it must keep meaning "approved only".
  const pendingPaidDaysByType: Partial<Record<VacationType, number>> = {};
  let balance: VacationBalanceSnapshot | null = null;
  let balanceError: string | null = null;
  try {
    await Promise.all(
      VACATION_TYPES.map(async (option) => {
        const snapshot = await calculatePaymentForRequest({
          durationDays: 0,
          employeeHrId: employee.hrId,
          hireDate: employee.hireDate,
          startDate: balanceReferenceDates[option.value],
          vacationType: option.value,
        });
        balances[option.value] = snapshot;
        pendingPaidDaysByType[option.value] = await pendingPaidDaysInPeriod({
          employeeHrId: employee.hrId,
          periodEnd: snapshot.periodEnd,
          periodStart: snapshot.periodStart,
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
  const weeklyOffPolicy = await weeklyOffPolicyRead;

  return {
    balance,
    balances,
    balanceError,
    dayPartOptions: VACATION_DAY_PARTS,
    pendingPaidDaysByType,
    employee: summarizeEmployee(employee),
    manager: manager ? summarizeEmployee(manager) : null,
    // Same gate as the chain that will actually be created on submit, so the preview can never
    // promise (or hide) a second approver the request will not (or will) get.
    managerOfManager: previewIncludesManagerOfManager && managerOfManager
      ? summarizeEmployee(managerOfManager)
      : null,
    thirdManager: previewIncludesThirdManager && thirdManager ? summarizeEmployee(thirdManager) : null,
    vacationTypeOptions: VACATION_REQUEST_TYPES,
    weeklyOffPolicy,
  };
}

export async function createVacationRequest(access: AccessContext, input: CreateVacationRequestInput) {
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
  // A District Manager's chain drops the CEO but always keeps the National Sales Manager
  // (owner rule, 2026-08-15 corrected 2026-08-19) — see shouldIncludeManagerOfManagerStep.
  const includesManagerOfManagerStep = shouldIncludeManagerOfManagerStep({ managerOfManager, requesterRole: access.role });
  const usesSequentialWorkflow = isSequentialWorkflowType(resolvedVacationType);
  let approvalRecipients: VacationApprovalRecipient[];
  let initialRequestStatus: VacationRequestStatus = "pending_manager";
  if (manager?.hrId) {
    approvalRecipients = await resolveVacationParallelApprovalRecipients(directory, employee, access.role);
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
  // Sick documents beyond the first. The first one stays in the legacy columns above, so every
  // existing read path keeps working; these exist only in the attachments table. Uploaded one at a
  // time so a failure on the third file reports which file, and so the earlier ones are in the
  // cleanup list below.
  const extraSickAttachments: StoredVacationEvidenceFile[] = [];
  if (resolvedVacationType === "sick") {
    for (const extra of input.sickAttachmentsExtra ?? []) {
      if (!extra) continue;
      extraSickAttachments.push(
        await uploadAdditionalVacationEvidenceFile({
          attachment: extra,
          employeeHrId: employee.hrId,
          kind: "sick",
          requestId,
        }),
      );
    }
  }
  const uploadedObjectPaths = [
    sickAttachment?.objectPath,
    compensatoryAttachment?.objectPath,
    ...extraSickAttachments.map((file) => file.objectPath),
  ];

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
      manager_of_manager_hr_id: includesManagerOfManagerStep ? managerOfManager?.hrId ?? null : null,
      manager_of_manager_name: includesManagerOfManagerStep ? managerOfManager?.fullName ?? null : null,
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
    for (const objectPath of uploadedObjectPaths) {
      await deleteSickAttachment(objectPath).catch(() => undefined);
    }
    throwVacationDatabaseError(error);
  }

  const request = await mapVacationRowForDisplay(data as VacationRequestDbRow);
  try {
    await createVacationApprovalSteps({ approvers: approvalRecipients, requestId: request.id });
  } catch (error) {
    try {
      await getSupabaseAdmin().from(vacationRequestsTable).delete().eq("id", request.id);
    } catch {
      // Best-effort cleanup; the original approval-step error is more useful to the caller.
    }
    for (const objectPath of uploadedObjectPaths) {
      await deleteSickAttachment(objectPath).catch(() => undefined);
    }
    throw error;
  }
  // The attachment history, first file included, so the admin reads every document and its own
  // upload date from one place. Deleting the request cascades these rows, so there is nothing extra
  // to unwind above.
  const createdAttachments = await insertVacationAttachmentRows({
    actorHrId: employee.hrId,
    actorLoginId: access.loginId,
    files: [
      ...(sickAttachment ? [{ file: sickAttachment, kind: "sick" as const }] : []),
      ...(compensatoryAttachment ? [{ file: compensatoryAttachment, kind: "compensatory" as const }] : []),
      ...extraSickAttachments.map((file) => ({ file, kind: "sick" as const })),
    ],
    requestId: request.id,
  });
  request.attachments = createdAttachments;
  await insertVacationEvent({
    actorHrId: employee.hrId,
    actorLoginId: access.loginId,
    eventType: "submitted",
    message: "Vacation request submitted.",
    metadata: {
      attachmentCount: createdAttachments.length,
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
  const actorHrId = resolveStoredDeciderHrId(input.access);
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
  const request = await mapVacationRowForDisplay(data as VacationRequestDbRow);

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
    .eq("status", existing.status)
    .select("*")
    .single();

  if (error) throw new Error(typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error));
  if (!data) throw new Error("Vacation request was updated by another user. Refresh and try again.");
  const request = await mapVacationRowForDisplay(data as VacationRequestDbRow);

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
  // Every stored object, not only the two the legacy columns name: a sick request may carry several
  // documents, and the attachment rows cascade away with the request, so anything missed here is an
  // orphan in Storage with nothing left pointing at it. `existing` was read before the delete, so
  // its attachment history is still the full list.
  await Promise.all([
    deleteSickAttachment(existing.sickAttachmentObjectPath),
    deleteSickAttachment(existing.compensatoryAttachmentObjectPath),
    ...existing.attachments.map((attachment) => deleteSickAttachment(attachment.objectPath)),
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

// ── Stranded returned vacations — the employee has left, so nobody can resubmit ─────────────
//
// WHY THIS EXISTS (2026-10-15). `returned` is answerable by exactly one person:
// `resubmitVacationRequest` refuses anyone who is not the employee who submitted the request. When
// that employee resigns their login is disabled, nothing expires a `returned` request and it is in
// nobody's queue. The Needs You board (`src/lib/approvals/orphaned-requests.ts`) finds these; until
// now it could only say "no screen in Phoenix can clear it yet". The direct-order twin is
// `closeOrphanedDirectOrder`, written after five orders had to be cleared by hand-written SQL.
//
// CLOSED, NEVER DELETED AND NEVER REJECTED. `admin_delete` would erase the request, its events and
// who approved what; `rejected` would count against an approver who turned nothing down. The result
// is `cancelled`. No balance moves — a returned request was never approved — and the approval steps
// are left exactly as they are, because an approver can only act on `pending_manager` / `pending_hr`.

/** A returned vacation request whose employee the employee master reports as no longer active. */
export type StrandedVacationRow = {
  id: string;
  requestCode: string;
  employeeHrId: string;
  employeeName: string;
  employeeEmploymentStatus: string | null;
  vacationType: string;
  startDate: string;
  endDate: string;
  /** The approver's own words, never shortened — it is the question that went unanswered. */
  returnReason: string | null;
  returnedAt: string | null;
};

function assertStrandedVacationAccess(access: AccessContext) {
  if (!isAllVacationVisibility(access)) {
    throw new Error("Forbidden: only a Super Admin can list or close stranded vacation requests.");
  }
}

/**
 * Every returned vacation request whose employee has left the company, oldest first. Super Admin /
 * system only. "Left" is `isActiveLifecycleStatus` — `active` and `on_leave` only, a blank reading
 * active — over the includeInactive directory, and an HR id the master does not hold at all is left
 * alone (a directory problem, not a departure), matching `selectOrphanedRequests`.
 */
export async function listStrandedVacationRequests(access: AccessContext): Promise<StrandedVacationRow[]> {
  await assertPermission(access, "leave", "read");
  assertStrandedVacationAccess(access);
  const { data, error } = await getSupabaseAdmin()
    .from(vacationRequestsTable)
    .select("*")
    .eq("status", "returned")
    .order("updated_at", { ascending: true });
  if (error) throwVacationDatabaseError(error);
  // An arrow, never `.map(mapVacationRow)`: map hands the index to mapVacationRow's second
  // parameter, which is `canDecide`.
  const requests = ((data ?? []) as VacationRequestDbRow[]).map((row) => mapVacationRow(row));
  if (requests.length === 0) return [];

  const directory = await getEmployeeDirectoryRows({ includeInactive: true });
  const byKey = new Map<string, EmployeeDirectoryRow>();
  for (const employee of directory) {
    const key = canonicalHrIdKey(employee.hrId);
    if (key) byKey.set(key, employee);
  }

  const stranded: StrandedVacationRow[] = [];
  for (const request of requests) {
    const employee = byKey.get(canonicalHrIdKey(request.employeeHrId) ?? "");
    if (!employee) continue;
    if (isActiveLifecycleStatus(employee.employmentStatus)) continue;
    stranded.push({
      employeeEmploymentStatus: employee.employmentStatus ?? null,
      employeeHrId: request.employeeHrId,
      employeeName: employee.fullName.trim() || request.employeeName || request.employeeHrId,
      endDate: request.endDate,
      id: request.id,
      requestCode: request.requestCode,
      returnReason: request.managerDecisionComment?.trim() || null,
      returnedAt: request.managerDecisionAt ?? null,
      startDate: request.startDate,
      vacationType: vacationTypeLabel(request.vacationType),
    });
  }
  return stranded;
}

/**
 * Close one returned vacation request whose employee has left — the way out that did not exist.
 * Result `cancelled`, a written reason is mandatory, and it REFUSES while the employee can still
 * log in: that guard is the difference between clearing a dead end and deleting a live request.
 */
export async function closeOrphanedVacationRequest(
  access: AccessContext,
  input: { requestId: string; reason: string },
): Promise<{ requestId: string; status: "cancelled" }> {
  await assertPermission(access, "leave", "read");
  assertStrandedVacationAccess(access);

  const reason = input.reason?.trim();
  if (!reason) {
    throw new Error("Say why this request is being closed — it is the only record of the decision.");
  }

  const request = await fetchVacationRequestById(input.requestId);
  if (!request) throw new Error("Vacation request was not found.");
  if (request.status !== "returned") {
    throw new Error(
      `Only a request an approver sent back can be closed this way — this one is ${request.status.replace(/_/g, " ")}. ` +
        "A request still in the approval chain is decided by its approver.",
    );
  }

  const directory = await getEmployeeDirectoryRows({ includeInactive: true });
  const employeeKey = canonicalHrIdKey(request.employeeHrId);
  const employee = directory.find((row) => canonicalHrIdKey(row.hrId) === employeeKey) ?? null;
  const employeeLabel = employee?.fullName.trim() || request.employeeName || request.employeeHrId;
  if (!employee) {
    throw new Error(
      `${request.employeeHrId} is not in the employee master at all, so this is a directory problem rather ` +
        "than a departure. Fix the employee record first; this action only clears a request whose employee " +
        "the master reports as having left.",
    );
  }
  if (isActiveLifecycleStatus(employee.employmentStatus)) {
    throw new Error(
      `${employeeLabel} is still employed, so this return is theirs to answer — they can correct and ` +
        "resubmit it themselves. This action only clears a request whose employee has left the company.",
    );
  }

  await assertLeaveWorkflowTransition({
    access,
    actionKey: "close_orphaned",
    expectedNextStatus: "cancelled",
    status: request.status,
  });

  const actorHrId = resolveEmployeeIdentityId(access);
  const { data: updated, error } = await getSupabaseAdmin()
    .from(vacationRequestsTable)
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", request.id)
    .eq("status", "returned")
    .select("id");
  if (error) throwVacationDatabaseError(error);
  // A lost race is an error, never a success: the request may have been edited and resubmitted a
  // moment ago, which moves it to pending and makes this update match nothing.
  if (!updated || updated.length === 0) {
    throw new Error("This request is no longer in the returned lane. Reload the list and check its current state.");
  }

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? actorHrId ?? "system",
    entityId: request.id,
    entityType: "vacation_request",
    newValues: { status: "cancelled" },
    oldValues: { employeeHrId: request.employeeHrId, status: "returned" },
    summary:
      `Vacation request closed as stranded by ${actorHrId ?? "system"} — its employee ${employeeLabel} ` +
      `(${employee.employmentStatus ?? "not active"}) can no longer answer the return — ${reason}`,
  });
  await insertVacationEvent({
    actorHrId,
    actorLoginId: access.loginId,
    eventType: "closed_stranded",
    message:
      `Closed as stranded: ${reason} The request was sent back for editing, and ${employeeLabel}, who ` +
      "submitted it, has left the company — only the employee can resubmit a returned request. It was " +
      "not rejected by any approver.",
    metadata: {
      closedReason: "employee_left_cannot_resubmit",
      employeeEmploymentStatus: employee.employmentStatus ?? null,
      previousStatus: "returned",
      strandedEmployeeHrId: request.employeeHrId,
    },
    requestId: request.id,
  });

  invalidateExecutiveDashboardCache("stranded vacation request closed", ["leave"]);
  return { requestId: request.id, status: "cancelled" };
}

async function fetchVacationRequestById(id: string) {
  const { data, error } = await getSupabaseAdmin()
    .from(vacationRequestsTable)
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error));
  if (!data) return null;
  const request = await mapVacationRowForDisplay(data as VacationRequestDbRow);
  const [reviews, attachments] = await Promise.all([
    fetchEvidenceReviewsForRequests([request.id]),
    fetchVacationAttachmentsForRequests([request.id]),
  ]);
  return {
    ...request,
    attachments: attachments.get(request.id) ?? [],
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
  override?: boolean;
  request: VacationRequestRecord;
};

/** What the employee reads when an approver returns a request without typing a comment. */
const DEFAULT_RETURN_PROMPT = "Please review your request, correct what is needed, and resubmit it.";

/**
 * Send a request back to the employee to edit. Shared by the sequential flow and the legacy Sick
 * flow, which had no return branch at all — a "return" there fell through to the rejection path.
 * The comment is optional: "Return for edit" and "Return for edit with comment" are two buttons.
 */
async function returnVacationToEmployee(args: {
  directory: Awaited<ReturnType<typeof getEmployeeDirectory>>;
  input: ApplyVacationDecisionInput;
  step: { stepKey: VacationWorkflowStepKey };
}) {
  const { directory, input, step } = args;
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
  const returned = await mapVacationRowForDisplay(data as VacationRequestDbRow);
  await insertVacationEvent({
    actorHrId: input.actorHrId,
    actorLoginId: input.actorLoginId,
    eventType: step.stepKey === "hr" ? "approval_hr_returned" : "approval_manager_returned",
    message: step.stepKey === "hr"
      ? "HR returned the request to the employee for editing."
      : "Manager returned the request to the employee for editing.",
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
  const actorName = findEmployeeByHrId(directory, input.actorHrId)?.displayName
    ?? returned.managerName
    ?? "Your manager";
  const returnReason = text(input.decisionComment) || DEFAULT_RETURN_PROMPT;
  // Employee: in-app + Telegram (already all 3 once email below fires)
  void notifyRecipients({
    channels: ["in_app", "telegram", "push"],
    href: `/employee-portals/vacation-report?requestId=${encodeURIComponent(returned.id)}`,
    message: `Your ${vacationTypeLabel(returned.vacationType)} vacation request (${returned.startDate} → ${returned.endDate}) was returned by ${actorName} for revision. Reason: ${returnReason}`,
    metadata: { requestId: returned.id, status: "returned" },
    recipients: [returned.employeeHrId],
    requestId: returned.id,
    title: "Vacation request returned for revision",
    type: "return",
  }).catch(async (error) => {
    await insertVacationEvent({
      actorHrId: input.actorHrId,
      actorLoginId: input.actorLoginId,
      eventType: "notification_failed",
      message: vacationErrorMessage(error),
      requestId: returned.id,
    }).catch(() => undefined);
  });
  // HR: in-app + Telegram so they know the request was sent back
  const hrRecipientsForReturn = await getHrRecipients(directory);
  void notifyRecipients({
    channels: ["in_app", "telegram", "push"],
    href: `/admin/approvals/vacation/${encodeURIComponent(returned.id)}`,
    message: `${actorName} returned ${returned.employeeName}'s ${vacationTypeLabel(returned.vacationType)} request (${returned.startDate} → ${returned.endDate}) for revision. Reason: ${returnReason}`,
    metadata: { requestId: returned.id, status: "returned" },
    recipients: hrRecipientsForReturn.map((r) => r.hrId),
    requestId: returned.id,
    title: `${returned.employeeName}'s vacation request was returned for revision`,
    type: "return_hr_notice",
  }).catch(async (error) => {
    await insertVacationEvent({
      actorHrId: input.actorHrId,
      actorLoginId: input.actorLoginId,
      eventType: "notification_failed",
      message: vacationErrorMessage(error),
      requestId: returned.id,
    }).catch(() => undefined);
  });
  // Email the employee (CC: HR) — completes the 3-channel requirement
  if (returned.employeeWorkEmail) {
    const hrEmailsForReturn = hrRecipientsForReturn
      .map((r) => findEmployeeByHrId(directory, r.hrId)?.workEmail)
      .filter((e): e is string => Boolean(e));
    void sendVacationReturnedEmail({
      cc: hrEmailsForReturn,
      decisionComment: input.decisionComment ?? null,
      employeeDisplayName: findEmployeeByHrId(directory, returned.employeeHrId)?.displayName,
      employeeEmail: returned.employeeWorkEmail,
      managerName: actorName,
      request: returned,
    }).catch(async (error) => {
      await insertVacationEvent({
        actorHrId: input.actorHrId,
        actorLoginId: input.actorLoginId,
        eventType: "notification_failed",
        message: vacationErrorMessage(error),
        requestId: returned.id,
      }).catch(() => undefined);
    });
  }
  invalidateExecutiveDashboardCache("leave request returned", ["leave"]);
  return returned;
}

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
  // A return needs no comment: "Return for edit" and "Return for edit with comment" are two buttons,
  // and the button that carries a comment makes the screen demand it. A rejection always needs one.
  if (input.decision === "reject" && !text(input.decisionComment)) {
    throw new Error("A rejection reason is required.");
  }

  const directory = await getEmployeeDirectory();
  const resolved = await getPendingVacationApprovalStepForActor({
    access: input.access,
    actorHrId: input.actorHrId,
    actorLoginId: input.actorLoginId,
    request: input.request,
  });
  const steps = resolved.steps;
  let step = resolved.step;

  // Stalled-approver override (owner instruction 2026-09-10). Re-binds the actor from their own
  // step to the STALLED MANAGEMENT step so the rest of this function runs unchanged — including
  // evaluateStepAction, which still enforces the sequencing. The override widens WHO may decide
  // the active step, never WHICH step may be decided or in what order.
  let overrideContext: { approverHrId: string; approverName: string; daysPending: number } | null = null;
  if (input.override) {
    if (!input.access || !isAllVacationVisibility(input.access)) {
      throw new Error("Forbidden: only the System Administrator can respond on an unanswered request.");
    }
    if (input.decision === "return") {
      throw new Error("Forbidden: a transferred approval can approve or reject, not return the request to the employee.");
    }
    const evaluation = evaluateAdminOverride({
      isAdminActor: true,
      isOwnRequest: hrIdsMatch(input.actorHrId, input.request.employeeHrId),
      now: new Date(),
      status: input.request.status,
      steps: steps.map(toOverrideStep),
    });
    if (!evaluation.available || !evaluation.step) {
      throw new Error(`Forbidden: ${evaluation.reason ?? "This request is not waiting on a management response."}`);
    }
    const stalled = steps.find(
      (candidate) =>
        candidate.stepOrder === evaluation.step?.order && candidate.stepKey === evaluation.step?.stepKey,
    );
    if (!stalled) {
      throw new Error("Forbidden: the unanswered approval step could not be resolved.");
    }
    step = stalled;
    overrideContext = {
      approverHrId: stalled.approverHrId,
      approverName: findEmployeeByHrId(directory, stalled.approverHrId)?.displayName ?? stalled.approverHrId,
      daysPending: evaluation.daysPending,
    };
  }

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
      if (await hasAlternateHrApprover(input.actorHrId)) {
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

  // Any approver may send the request back for the employee to edit (owner, 2026-10-08). The step
  // stays "pending" so the workflow resumes where it stopped after the employee resubmits.
  if (input.decision === "return") {
    return returnVacationToEmployee({ directory, input, step });
  }

  const decisionValue = input.decision === "approve" ? "approved" : "rejected";

  // The wording is the owner's own (2026-09-10): state that the request went unanswered and that
  // the approval TRANSFERRED to the System Administrator, and name him as the responder. It never
  // says anyone was "overridden" and never names the approver who did not reply — the employee
  // reads this comment, and so does that approver. Neutral about why, explicit about who answered.
  //
  // A rejection already demands a typed reason above. An approve stays one click by the owner's
  // design, so the system writes the sentence itself rather than making him type it.
  const adminName = findEmployeeByHrId(directory, input.actorHrId)?.displayName ?? input.actorHrId ?? "the System Administrator";
  const effectiveDecisionComment = overrideContext
    ? `This request was not responded to within ${ADMIN_OVERRIDE_STALL_DAYS} days, so its approval was transferred to the System Administrator. ${input.decision === "approve" ? "Approved" : "Rejected"} by ${adminName}, System Administrator.${text(input.decisionComment) ? ` ${text(input.decisionComment)}` : ""}`
    : input.decisionComment ?? null;

  await recordVacationApprovalStepDecision({
    decision: input.decision,
    decisionComment: effectiveDecisionComment,
    overriddenByHrId: overrideContext ? input.actorHrId : null,
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
      p_decision_comment: nullableText(effectiveDecisionComment),
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
      updatePayload.hr_decision_comment = nullableText(effectiveDecisionComment);
    } else {
      updatePayload.manager_decision = decisionValue;
      updatePayload.manager_decision_at = now;
      updatePayload.manager_decision_by_hr_id = input.actorHrId;
      updatePayload.manager_decision_comment = nullableText(effectiveDecisionComment);
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
  const updated = await mapVacationRowForDisplay(decidedRow);

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
      decisionComment: effectiveDecisionComment,
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
      decisionComment: effectiveDecisionComment,
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

  if (overrideContext) {
    // A second, dedicated event. The generic approval_* event above already carries the admin as
    // actorHrId, but it reads exactly like a normal decision — the override has to be findable on
    // its own, by type, without parsing a comment string.
    await insertVacationEvent({
      actorHrId: input.actorHrId,
      actorLoginId: input.actorLoginId,
      eventType: "approval_admin_override",
      message: `Not responded to within ${ADMIN_OVERRIDE_STALL_DAYS} days, so the approval transferred to the System Administrator and was ${decisionValue} by ${adminName}.`,
      metadata: {
        daysPending: overrideContext.daysPending,
        decision: decisionValue,
        genericStep,
        overriddenApproverHrId: overrideContext.approverHrId,
        overriddenApproverName: overrideContext.approverName,
        stallThresholdDays: ADMIN_OVERRIDE_STALL_DAYS,
        stepKey: step.stepKey,
      },
      requestId: updated.id,
    });
    // Let the assigned approver know where the request went. Courteous by the owner's instruction:
    // it reports the transfer, not a failing. Explicit channels — no email: this is an internal
    // workflow notice, and resolveBasePolicyChannels only ever REMOVES from an explicit list, so
    // naming three non-email channels cannot reach anyone's inbox.
    void notifyRecipients({
      channels: ["in_app", "telegram", "push"],
      href: `/admin/approvals/vacation/${encodeURIComponent(updated.id)}`,
      message: `${updated.employeeName}'s ${vacationTypeLabel(updated.vacationType)} request (${updated.startDate} → ${updated.endDate}) was not responded to within ${ADMIN_OVERRIDE_STALL_DAYS} days, so its approval was transferred to the System Administrator and ${adminName} has ${decisionValue} it. No action is needed from you.`,
      metadata: { override: true, requestId: updated.id, status: updated.status },
      recipients: [overrideContext.approverHrId],
      requestId: updated.id,
      title: "Approval transferred to the System Administrator",
      type: "admin_override",
    }).catch(async (error) => {
      await insertVacationEvent({
        actorHrId: input.actorHrId,
        actorLoginId: input.actorLoginId,
        eventType: "notification_failed",
        message: vacationErrorMessage(error),
        requestId: updated.id,
      }).catch(() => undefined);
    });
  }

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
    // All management steps done — notify HR and employee, after the reply (deferVacationNotice).
    await deferVacationNotice({
      actorHrId: input.actorHrId,
      actorLoginId: input.actorLoginId,
      label: "manager_review",
      requestId: updated.id,
      task: () => dispatchVacationManagerReview({ decision: input.decision, directory, request: updated }),
    });
  } else if (nextStatus === "pending_manager") {
    // A management step approved but another management step is still pending.
    // Notify the next approver it is their turn and notify the employee the request is progressing.
    const nextManagementStep = steps.find(
      (s) => s.stepOrder > step.stepOrder && s.stepKey !== "hr"
    );
    if (nextManagementStep) {
      await deferVacationNotice({
        actorHrId: input.actorHrId,
        actorLoginId: input.actorLoginId,
        label: "next_manager_step",
        requestId: updated.id,
        task: () =>
          dispatchVacationNextManagerStep({
            actingManagerHrId: step.approverHrId,
            directory,
            nextApproverHrId: nextManagementStep.approverHrId,
            request: updated,
          }),
      });
    }
  }

  invalidateExecutiveDashboardCache("leave request decision recorded", ["leave"]);
  return updated;
}

async function applyVacationDecisionLegacy(input: ApplyVacationDecisionInput) {
  if (input.request.status !== "pending_manager") {
    throw new Error("This vacation request already has a final decision.");
  }
  if (input.decision === "reject" && !text(input.decisionComment)) {
    throw new Error("A rejection reason is required.");
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

  // Enforce the runtime-overridable workflow-registry role authority on the direct-manager step,
  // same as the sequential flow's pending_manager decision. This does NOT cover the "hr" step:
  // Sick leave is a parallel flow whose overall status stays "pending_manager" for its entire
  // lifecycle (it never transitions to "pending_hr" the way the sequential flow does), but the
  // registry's hr_approve/hr_reject actions are only defined `from: ["pending_hr"]` — calling them
  // here would incorrectly reject every legitimate Sick HR decision. Wiring the HR step in requires
  // a registry-seed migration adding Sick-specific actions (e.g. an hr_approve variant with
  // `from: ["pending_manager"]`), tracked separately rather than guessed at here.
  if (input.access && step.stepKey === "direct_manager") {
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

  if (step.stepKey === "hr" && input.decision === "approve") {
    if (!hasAcceptedRequiredEvidence(input.request)) {
      throw new Error("Required vacation evidence must be accepted by HR before final HR approval.");
    }
    const actorHrId = canonicalHrId(input.actorHrId);
    if (actorHrId && acceptedRequiredEvidenceReviewerHrIds(input.request).includes(actorHrId)) {
      if (await hasAlternateHrApprover(input.actorHrId)) {
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

  // Sick leave had no return branch: a "return" fell through to the line below and REJECTED the
  // request. Any pending approver, manager or HR, may now send it back for the employee to edit.
  if (input.decision === "return") {
    return returnVacationToEmployee({ directory, input, step });
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
  const updated = await mapVacationRowForDisplay(data as VacationRequestDbRow);

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
    // code), so HR/the employee were never told the request had advanced. Best-effort, and sent
    // after the reply (deferVacationNotice).
    await deferVacationNotice({
      actorHrId: input.actorHrId,
      actorLoginId: input.actorLoginId,
      label: "manager_review",
      requestId: updated.id,
      task: () => dispatchVacationManagerReview({ decision: input.decision, directory, request: updated }),
    });
  }

  invalidateExecutiveDashboardCache("leave request decision recorded", ["leave"]);
  return updated;
}

export async function decideVacationRequest(access: AccessContext, input: {
  decision: VacationDecision;
  decisionComment?: string | null;
  /**
   * Stalled-approver override. Deliberately an EXPLICIT flag rather than a silent fallback: the
   * Super Admin is normally the assigned approver of the pending HR step, so a "try the override
   * when nothing else matched" rule would never fire for them — they would just hit the ordinary
   * HR gate and be told to wait. The button asks for the override; nothing else does.
   */
  override?: boolean;
  requestId: string;
}) {
  await assertPermission(access, "leave", "approve");
  const request = await fetchVacationRequestById(input.requestId);
  if (!request) throw new Error("Vacation request was not found.");

  return applyVacationDecision({
    access,
    actorHrId: resolveStoredDeciderHrId(access),
    actorLoginId: access.loginId,
    decision: input.decision,
    decisionComment: input.decisionComment,
    override: input.override === true,
    request,
  });
}

/**
 * What an employee may change while a returned request is in their hands. Every field is optional:
 * an omitted one keeps the stored value, so "Resubmit without changes" sends nothing at all. The
 * leave type is not editable — it decides the evidence, the approval chain and the balance bucket,
 * so a wrong type is a new request, not an edit.
 */
export type ResubmitVacationEdits = {
  dayPart?: unknown;
  employeeNote?: unknown;
  endDate?: unknown;
  otherReason?: unknown;
  startDate?: unknown;
};

export async function resubmitVacationRequest(
  access: AccessContext,
  input: { edits?: ResubmitVacationEdits | null; requestId: string },
) {
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

  const edits = input.edits ?? {};
  const now = new Date().toISOString();
  const steps = await fetchVacationApprovalStepsForRequest(request.id);

  const startDate = edits.startDate === undefined ? request.startDate : toDateOnlyString(String(edits.startDate ?? ""));
  const endDate = edits.endDate === undefined ? request.endDate : toDateOnlyString(String(edits.endDate ?? ""));
  const dayPart = edits.dayPart === undefined ? request.dayPart : normalizeVacationDayPart(edits.dayPart);
  if (!startDate || !endDate) throw new Error("Vacation start and end dates are required.");
  if (!dayPart) throw new Error("Vacation day part is invalid.");
  if (endDate < startDate) throw new Error("Vacation end date cannot be before the start date.");
  const datesChanged = startDate !== request.startDate || endDate !== request.endDate || dayPart !== request.dayPart;

  const update: Record<string, unknown> = { updated_at: now };
  const changedFields: string[] = [];
  if (edits.employeeNote !== undefined) {
    const employeeNote = nullableText(edits.employeeNote);
    if (employeeNote !== request.employeeNote) {
      update.employee_note = employeeNote;
      changedFields.push("note");
    }
  }
  if (edits.otherReason !== undefined && request.vacationType === "other") {
    const reason = text(edits.otherReason);
    if (!reason) throw new Error("Other vacation requires an explanation for HR review.");
    if (reason !== request.notes) {
      update.notes = reason;
      changedFields.push("reason");
    }
  }

  if (datesChanged) {
    // The same checks a new submission passes, run again on the new dates — an edit is not a way
    // round the retroactive, holiday and balance rules. An Emergency request is stored as such only
    // because it was for today, so it is re-resolved from the dates like a fresh Annual one.
    const resolvedVacationType = resolveSubmittedVacationType({
      endDate,
      requestedVacationType: request.vacationType === "emergency" ? "annual" : request.vacationType,
      startDate,
    });
    validateVacationSubmissionDates({ endDate, resolvedVacationType, startDate });
    await validateOfficialHolidayAdjacency({ endDate, startDate });
    const policyWarnings = [...getVacationPolicyWarnings({ dayPart, endDate, startDate, vacationType: resolvedVacationType })];
    const { employee } = await getCurrentEmployee(access);
    if (employee.hireDate && startDate < employee.hireDate) {
      throw new Error("Vacation date cannot be before the employee hire date.");
    }
    const weeklyOffPolicy = await fetchWeeklyOffPolicyForTitle(employeeVacationPolicyTitle(employee));
    const durationDays = calculateVacationDurationDays({
      dayPart,
      endDate,
      startDate,
      weeklyOffPolicy: weeklyOffPolicyForDateCalculation(weeklyOffPolicy),
    });
    let balance = await calculatePaymentForRequest({
      durationDays,
      employeeHrId: employee.hrId,
      excludeRequestId: request.id,
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
    Object.assign(update, {
      balance_after_days: balance.balanceAfterDays,
      balance_before_days: balance.balanceBeforeDays,
      day_part: dayPart,
      duration_days: durationDays,
      end_date: endDate,
      entitlement_days: balance.entitlementDays,
      payment_status: balance.paymentStatus,
      paid_duration_days: balance.paidDurationDays,
      period_end: balance.periodEnd,
      period_start: balance.periodStart,
      start_date: startDate,
      unpaid_duration_days: balance.unpaidDurationDays,
      unpaid_reason: balance.unpaidReason,
      used_paid_days: balance.usedPaidDays,
      vacation_type: resolvedVacationType,
      weekly_off_policy_snapshot: buildWeeklyOffPolicySnapshot(weeklyOffPolicy),
      // Approvals given for the old dates do not carry over to the new ones.
      hr_decision: null,
      hr_decision_at: null,
      hr_decision_by_hr_id: null,
      hr_decision_comment: null,
      manager_decision: null,
      manager_decision_at: null,
      manager_decision_by_hr_id: null,
      manager_decision_comment: null,
    });
    changedFields.push("dates");
  }

  // Where the request goes back to. Changed dates start the whole chain again. Otherwise it resumes
  // at the stage it was returned from: the first management step still pending, else HR. Sick leave
  // runs its approvers in parallel and keeps `pending_manager` for its whole life.
  let nextStatus: VacationRequestStatus = "pending_manager";
  if (!datesChanged && isSequentialWorkflowType(request.vacationType)) {
    const managementPending = steps.some((step) => step.stepKey !== "hr" && step.status === "pending");
    const hrPending = steps.some((step) => step.stepKey === "hr" && step.status === "pending");
    if (!managementPending && hrPending) nextStatus = "pending_hr";
  }
  update.status = nextStatus;

  const { data, error } = await getSupabaseAdmin()
    .from(vacationRequestsTable)
    .update(update)
    .eq("id", request.id)
    .eq("status", "returned")
    .select("*")
    .single();
  if (error) throwVacationDatabaseError(error);
  if (!data) throw new Error("Vacation request was updated by another user. Refresh and try again.");
  const resubmitted = await mapVacationRowForDisplay(data as VacationRequestDbRow);

  if (datesChanged) {
    const { error: resetError } = await getSupabaseAdmin()
      .from(vacationApprovalStepsTable)
      .update({
        decided_at: null,
        decision_comment: null,
        overridden_at: null,
        overridden_by_hr_id: null,
        status: "pending",
        updated_at: now,
      })
      .eq("request_id", resubmitted.id);
    if (resetError) throwVacationDatabaseError(resetError);
  }

  await insertVacationEvent({
    actorHrId,
    actorLoginId: access.loginId,
    eventType: "employee_resubmitted",
    message: changedFields.length > 0
      ? `Employee edited the request (${changedFields.join(", ")}) and resubmitted it for review.`
      : "Employee resubmitted the vacation request for review without changes.",
    metadata: {
      changedFields,
      nextStatus,
      previous: datesChanged
        ? { dayPart: request.dayPart, endDate: request.endDate, startDate: request.startDate }
        : null,
    },
    requestId: resubmitted.id,
  });
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? actorHrId ?? "system",
    entityId: resubmitted.id,
    entityType: "vacation_request",
    newValues: {
      changedFields,
      dayPart: resubmitted.dayPart,
      endDate: resubmitted.endDate,
      startDate: resubmitted.startDate,
      status: nextStatus,
    },
    oldValues: {
      dayPart: request.dayPart,
      endDate: request.endDate,
      startDate: request.startDate,
      status: "returned",
    },
    summary: "Vacation request resubmitted by employee.",
  });
  const directory = await getEmployeeDirectory();
  const reviewerIds = nextStatus === "pending_hr"
    ? (await getHrRecipients(directory)).map((recipient) => recipient.hrId)
    : ([resubmitted.managerHrId, resubmitted.managerOfManagerHrId].filter(Boolean) as string[]);
  void notifyRecipients({
    channels: ["in_app", "telegram", "push"],
    href: `/admin/approvals/vacation/${encodeURIComponent(resubmitted.id)}`,
    message: `${resubmitted.employeeName}'s ${vacationTypeLabel(resubmitted.vacationType)} vacation request (${resubmitted.startDate} → ${resubmitted.endDate}) has been ${changedFields.length > 0 ? "edited and " : ""}resubmitted and is pending your review.`,
    metadata: { requestId: resubmitted.id, status: nextStatus },
    recipients: reviewerIds,
    requestId: resubmitted.id,
    title: "Vacation request resubmitted",
    type: "resubmit",
  }).catch(async (error) => {
    await insertVacationEvent({
      actorHrId,
      actorLoginId: access.loginId,
      eventType: "notification_failed",
      message: vacationErrorMessage(error),
      requestId: resubmitted.id,
    }).catch(() => undefined);
  });
  // Employee resubmit confirmation — 3-channel requirement (previously zero channels for the employee).
  void notifyRecipients({
    channels: ["in_app", "telegram", "push"],
    href: `/employee-portals/vacation-report?requestId=${encodeURIComponent(resubmitted.id)}`,
    message: `Your ${vacationTypeLabel(resubmitted.vacationType)} request (${resubmitted.startDate} → ${resubmitted.endDate}) has been resubmitted and is pending review.`,
    metadata: { requestId: resubmitted.id, status: nextStatus },
    recipients: [resubmitted.employeeHrId],
    requestId: resubmitted.id,
    title: "Your vacation request has been resubmitted",
    type: "employee_resubmit_confirm",
  }).catch(async (error) => {
    await insertVacationEvent({
      actorHrId,
      actorLoginId: access.loginId,
      eventType: "notification_failed",
      message: vacationErrorMessage(error),
      requestId: resubmitted.id,
    }).catch(() => undefined);
  });
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
  // Widened guard. `needs_assignment` is the original no-approver-yet case. A request already at
  // `pending_manager` is ALSO reassignable, but ONLY when its assigned first-management approver
  // (manager_hr_id) has since resigned / gone inactive AND that first step is still pending —
  // otherwise the record is pinned to a dead approver with no route forward and no one can act.
  // We never touch a request whose approver is still active (that would yank a live pending
  // decision, out of scope), and never reopen an approver who already decided.
  const isResignedManagerReassignment = request.status === "pending_manager";
  if (request.status !== "needs_assignment" && !isResignedManagerReassignment) {
    throw new Error("This vacation request does not need an approver assignment.");
  }

  const directory = await getEmployeeDirectory();
  const approver = findEmployeeByHrId(directory, approverHrId);
  if (!approver) {
    throw new Error("The selected approver is not available in the employee directory.");
  }

  if (isResignedManagerReassignment) {
    const currentManager = findEmployeeByHrId(directory, request.managerHrId);
    if (currentManager && isVacationEmployeeActive(currentManager)) {
      throw new Error(
        "The current approver is still active. Reassignment is only for a resigned or inactive approver.",
      );
    }
    const existingSteps = await fetchVacationApprovalStepsForRequest(request.id);
    const pendingFirstStep = existingSteps.find(
      (step) => step.stepKey === "direct_manager" && step.status === "pending",
    );
    if (!pendingFirstStep) {
      throw new Error("This request has no pending first-management step to reassign.");
    }
    // Drop the stale pending first-management step so the fresh assignment below leaves exactly
    // one (same end state as the needs_assignment path); later manager-of-manager / HR steps and
    // any already-decided steps are preserved.
    const { error: deleteStepError } = await getSupabaseAdmin()
      .from(vacationApprovalStepsTable)
      .delete()
      .eq("request_id", request.id)
      .eq("step_key", "direct_manager")
      .eq("status", "pending");
    if (deleteStepError) throwVacationDatabaseError(deleteStepError);
  }

  // Create the first management approval step, then resume the flow at pending_manager.
  await createVacationApprovalSteps({
    approvers: [
      {
        email: approver.workEmail,
        hrId: approver.hrId,
        name: approver.displayName,
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
    .eq("status", request.status)
    .select("*")
    .single();
  if (error) throw new Error(typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error));
  const updated = await mapVacationRowForDisplay(data as VacationRequestDbRow);

  await insertVacationEvent({
    actorHrId: resolveEmployeeIdentityId(access),
    actorLoginId: access.loginId,
    eventType: "manager_assigned",
    message: isResignedManagerReassignment
      ? `HR reassigned the stuck approver to ${approver.displayName} (previous approver resigned).`
      : `HR assigned ${approver.displayName} as the first management approver.`,
    metadata: {
      approverHrId: approver.hrId,
      genericStep: "management_approval_1",
      reassignment: isResignedManagerReassignment,
    },
    requestId: updated.id,
  });
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? resolveEmployeeIdentityId(access) ?? "system",
    entityId: updated.id,
    entityType: "vacation_request",
    newValues: { managerHrId: approver.hrId, status: updated.status },
    oldValues: { managerHrId: request.managerHrId, status: request.status },
    summary: isResignedManagerReassignment
      ? `HR reassigned stuck management approver to ${approver.displayName}.`
      : `HR assigned management approver ${approver.displayName}.`,
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

const VACATION_ACTIONABLE_STATUSES: ReadonlySet<string> = new Set(["needs_assignment", "pending_manager", "pending_hr"]);

export async function getVacationActionCenterData(access: AccessContext): Promise<VacationActionCenterData> {
  await assertPermission(access, "leave", "read");
  const isHrActor = isAllVacationVisibility(access);
  const [report, directory] = await Promise.all([
    getVacationReportData(access, { status: "all" }),
    getEmployeeDirectory(),
  ]);

  const actionableStatuses = VACATION_ACTIONABLE_STATUSES;
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
          await withManagerDisplayNames((extraData as VacationRequestDbRow[]).map((row) => mapVacationRow(row))),
        );
        const extraEnriched = await enrichVacationRows(extraMapped);
        for (const row of extraEnriched) {
          candidateRows.push({ ...row, overlapWarnings: [] });
        }
      }
    }
  }

  const stepsByRequest = await fetchVacationApprovalStepsForRequests(candidateRows.map((row) => row.id));
  const rows = buildVacationActionCenterRows({ access, candidateRows, directory, stepsByRequest });

  return { canAssign: isHrActor, generatedAt: new Date().toISOString(), rows };
}

/**
 * The per-row half of the Action Center — which step is the viewer's, what each button may do, the
 * override window — shared by the full Action Center and the sidebar badge so the two can never
 * disagree about what is awaiting someone. `directory` only supplies display names and titles; the
 * badge passes `null` and gets the same rows with those fields empty.
 */
function buildVacationActionCenterRows(input: {
  access: AccessContext;
  candidateRows: VacationRequestRecord[];
  directory: Awaited<ReturnType<typeof getEmployeeDirectory>> | null;
  stepsByRequest: Awaited<ReturnType<typeof fetchVacationApprovalStepsForRequests>>;
}): VacationActionCenterRow[] {
  const { access, candidateRows, directory, stepsByRequest } = input;
  const isHrActor = isAllVacationVisibility(access);
  // One clock for the whole page. Reading new Date() per row would let two rows a millisecond
  // apart disagree about whether the threshold has passed.
  const overrideNow = new Date();
  const viewerHrId = resolveEmployeeIdentityId(access);
  const employeeOf = (hrId: string | null) => (directory ? findEmployeeByHrId(directory, hrId) : null);

  const titleOf = (hrId: string | null) => {
    const employee = employeeOf(hrId);
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

    let actorRawStep = rawSteps.find((step) => step.status === "pending" && approvalStepMatchesAccess(access, step)) ?? null;
    // HR authority (Super Admin / system) is ONE conceptual HR actor — any of them may perform the
    // HR acknowledgement for ANY request once management approvals are complete, even when the HR
    // step row is assigned to a different Super Admin (or the actor has no HR-ID, e.g. the shared
    // admin login). Bind them to the active HR step so the Acknowledge button appears at HR's turn.
    if (!actorRawStep && isHrActor) {
      const active = resolveActiveStep(stepStates);
      if (active?.stepKey === "hr") {
        actorRawStep = rawSteps.find((step) => step.stepKey === "hr" && step.status === "pending") ?? null;
      }
    }
    // Show rows the caller is an assigned pending approver of, or (HR) any actionable row.
    if (!actorRawStep && !isHrActor) continue;

    const titles: Partial<Record<VacationWorkflowStepKey, string | null>> = {};
    for (const step of rawSteps) titles[step.stepKey] = titleOf(step.approverHrId);

    const activeStep = resolveActiveStep(stepStates);
    const activeRawStep = activeStep ? rawSteps.find((step) => step.stepKey === activeStep.stepKey) ?? null : null;

    const overrideEvaluation: AdminOverrideEvaluation = evaluateAdminOverride({
      isAdminActor: isHrActor,
      isOwnRequest: hrIdsMatch(viewerHrId, row.employeeHrId),
      now: overrideNow,
      status: row.status,
      steps: rawSteps.map(toOverrideStep),
    });
    const overrideApproverHrId = overrideEvaluation.step
      ? rawSteps.find(
          (candidate) =>
            candidate.stepOrder === overrideEvaluation.step?.order &&
            candidate.stepKey === overrideEvaluation.step?.stepKey,
        )?.approverHrId ?? null
      : null;
    const adminOverride: VacationAdminOverrideState | null = isHrActor
      ? {
          approverHrId: overrideApproverHrId,
          approverName: overrideApproverHrId
            ? employeeOf(overrideApproverHrId)?.displayName ?? overrideApproverHrId
            : null,
          available: overrideEvaluation.available,
          availableAt: overrideEvaluation.availableAt,
          daysPending: overrideEvaluation.daysPending,
          reason: overrideEvaluation.reason,
        }
      : null;

    const actionAvailability: VacationActionAvailability = resolveActionAvailability({
      status: row.status,
      steps: stepStates,
      actorStep: actorRawStep ? { stepKey: actorRawStep.stepKey, order: actorRawStep.stepOrder } : null,
      isHrActor,
      override: overrideEvaluation,
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
        approverName: employeeOf(step.approverHrId)?.displayName ?? null,
        approverTitle: titleOf(step.approverHrId),
        decidedAt: step.decidedAt,
        decisionComment: step.decisionComment,
        genericStep: genericStepName(step.stepKey),
      })),
      assignedActorName: activeRawStep
        ? employeeOf(activeRawStep.approverHrId)?.displayName ?? activeRawStep.approverHrId
        : null,
      assignedActorTitle: activeRawStep ? titleOf(activeRawStep.approverHrId) : null,
      actionAvailability,
      adminOverride,
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
  return rows;
}

/**
 * What the sidebar's leave badge needs, and nothing it does not: the Action Center rows for this
 * viewer, plus the scoped request rows the legacy sick-leave pass reads.
 *
 * WHY (2026-10-04 performance review, PERF-001): the badge polls every 30 s from every open tab, and
 * it used to build the full Vacation Report TWICE per poll — once inside getVacationActionCenterData
 * and once more for the sick rows — enriching every request ever filed (events, evidence reviews,
 * attachments, holidays, overlap warnings, the entitlement table) to produce a count and an overdue
 * flag. Neither reads any of that. The rows here are the report's own: the same directory scope,
 * the same 60 s-cached request read, the same `mapVacationRow` and `canSeeVacation`, the same
 * actionable statuses and the same extra pending-step rows; `slaAgeDays` is `businessDaysPending`,
 * which `mapVacationRow` computes exactly as the enrichment recomputes it (it reads only the stage
 * start and the clock, never the SLA settings or events).
 */
export async function getVacationAwaitingBadgeSource(
  access: AccessContext,
): Promise<{ centerRows: VacationActionCenterRow[]; scopedRows: VacationRequestRecord[] }> {
  await assertPermission(access, "leave", "read");
  const isHrActor = isAllVacationVisibility(access);
  const activeEmployees = await getEmployeeDirectoryRows();
  const visibleEmployees = await filterVacationEmployeesForAccess(access, activeEmployees);
  const visibleEmployeeHrIds = buildVisibleHrIdSet(visibleEmployees);
  const data = await fetchVacationReportRowsFromDatabase({
    access,
    filters: cleanFilters({ status: "all" }),
    visibleEmployeeHrIds,
  });
  const scopedRows = (data ?? [])
    .map((row) => mapVacationRow(row as VacationRequestDbRow))
    .filter((row) => canSeeVacation(access, row, visibleEmployeeHrIds));

  const candidateRows = scopedRows.filter((row) => VACATION_ACTIONABLE_STATUSES.has(row.status));
  // The same out-of-scope pending approver rows getVacationActionCenterData adds, unenriched.
  if (!isHrActor) {
    const actorPendingIds = await fetchActorPendingApprovalStepRequestIds(access);
    const existingIds = new Set(candidateRows.map((row) => row.id));
    const extraIds = actorPendingIds.filter((id) => !existingIds.has(id));
    if (extraIds.length > 0) {
      const { data: extraData } = await getSupabaseAdmin()
        .from(vacationRequestsTable)
        .select("*")
        .in("id", extraIds)
        .in("status", Array.from(VACATION_ACTIONABLE_STATUSES));
      for (const row of (extraData ?? []) as VacationRequestDbRow[]) candidateRows.push(mapVacationRow(row));
    }
  }

  const stepsByRequest = await fetchVacationApprovalStepsForRequests(candidateRows.map((row) => row.id));
  return {
    centerRows: buildVacationActionCenterRows({ access, candidateRows, directory: null, stepsByRequest }),
    scopedRows,
  };
}

/**
 * Whose turn it is on each open sick leave, for this viewer: "management" (the direct manager or
 * the manager's manager), "hr", or absent (not this viewer's to decide).
 *
 * WHY (2026-10-28): sick leave is the one type on the legacy PARALLEL flow — the managers and HR
 * decide side by side and the status stays `pending_manager` until the last of them does. The
 * approvals hub used to read HR's turn as `pending_hr`, a status a sick leave never reaches, so a
 * sick leave filed on 27 Oct was invisible in HR's list and badge, and one from 3 Oct sat 25 days
 * the same way. The turn is read here from the pending approval steps, by the same rule
 * `getPendingVacationApprovalStepForActor` applies when the decision is posted
 * (`sickLeaveTurnForViewer`).
 */
export async function getSickLeaveTurnsForViewer(
  access: AccessContext,
  requests: VacationRequestRecord[],
): Promise<Map<string, "management" | "hr">> {
  const turns = new Map<string, "management" | "hr">();
  // applyVacationDecisionLegacy refuses anything not `pending_manager`, so nothing else is a turn.
  const open = requests.filter((request) => request.vacationType === "sick" && request.status === "pending_manager");
  if (open.length === 0) return turns;
  const isHrActor = isAllVacationVisibility(access);
  const stepsByRequest = await fetchVacationApprovalStepsForRequests(open.map((request) => request.id));
  for (const request of open) {
    const turn = sickLeaveTurnForViewer({
      isHrActor,
      pendingSteps: (stepsByRequest.get(request.id) ?? [])
        .filter((step) => step.status === "pending")
        .map((step) => ({ matchesViewer: approvalStepMatchesAccess(access, step), stepKey: step.stepKey })),
    });
    if (turn) turns.set(request.id, turn);
  }
  return turns;
}

/** Whether HR has accepted the evidence a sick or compensatory leave needs before HR approves it. */
export function hasAcceptedRequiredVacationEvidence(request: VacationRequestRecord) {
  return hasAcceptedRequiredEvidence(request);
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

  // Owner rule: human-readable names, never raw codes/IDs, in the UI. The picker value stays the
  // HR id (that is what the filter matches on), but the visible label is the name — disambiguated by
  // department/line for namesakes, not by a raw HR id. The free-text search box still matches HR id
  // server-side, and the CSV/XLSX exports still carry it.
  const employeeLabel = (name: string | null | undefined, department?: string | null, line?: string | null) => {
    const context = [department, line].map((value) => text(value)).filter(Boolean).join(" / ");
    const displayName = text(name) || "Unnamed employee";
    return context ? `${displayName} — ${context}` : displayName;
  };

  const employeeOptions = employees
    ? employees
        .filter((employee) => employee.hrId)
        .map((employee) => ({ label: employeeLabel(employee.displayName, employee.departmentName, employee.lineName), value: employee.hrId }))
        .sort((left, right) => left.label.localeCompare(right.label))
    : Array.from(
        new Map(rows.map((row) => [row.employeeHrId, { label: employeeLabel(row.employeeName, row.departmentName, row.lineName), value: row.employeeHrId }])).values(),
      ).sort((left, right) => left.label.localeCompare(right.label));

  const managerSource = employees
    ? employees
        .filter((employee) => employee.managerHrId)
        .map((employee) => ({
          label: text(employee.managerName) || (employee.managerHrId ?? ""),
          value: employee.managerHrId ?? "",
        }))
    : rows
        .filter((row) => row.managerHrId)
        .map((row) => ({
          label: text(row.managerName) || (row.managerHrId ?? ""),
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

// ---------------------------------------------------------------------------------------------
// Vacation report base rows: ONE cached, unscoped, unfiltered read shared by every surface.
//
// phx_vacation_report_rows was the single heaviest query in production by share of DB time
// (~779 calls/hour, ~15% of all query time) — NOT because it is slow (v2_vacation_requests is
// ~300 rows, fully cached, ~7ms per call) but because ~8 dashboard/approval surfaces each re-fetch
// it on every page load. The table is tiny and changes only on a vacation write, so the raw row set
// is cached cross-request and every caller applies its own scope + filters in memory. The cached
// value carries NO access context, so sharing it across users is safe — scoping stays per-request
// in fetchVacationReportRowsFromDatabase below (identical to the RPC's own
// `employee_hr_id = any(p_visible_employee_hr_ids)`), and canSeeVacation still re-checks downstream.
//
// Freshness: every vacation write already calls invalidateExecutiveDashboardCache(reason, ['leave']),
// which revalidateTag()s VACATION_REPORT_ROWS_CACHE_TAG, so a decision is visible on the very next
// read. The short TTL is only a backstop that self-heals within a minute if a write path is ever
// missed — the tag is the real mechanism, not the clock.
// ---------------------------------------------------------------------------------------------

/** Backstop only — tag invalidation on every leave write is the real freshness mechanism. */
const VACATION_REPORT_ROWS_REVALIDATE_SECONDS = 60;

async function loadAllVacationRequestRowsRaw(): Promise<VacationRequestDbRow[]> {
  const pageSize = 1000;
  const rows: VacationRequestDbRow[] = [];
  try {
    for (let from = 0; ; from += pageSize) {
      const to = from + pageSize - 1;
      const { data, error } = await getSupabaseAdmin()
        .from(vacationRequestsTable)
        .select("*")
        .order("created_at", { ascending: false })
        .range(from, to);
      if (error) throwVacationDatabaseError(error);
      const page = (data ?? []) as VacationRequestDbRow[];
      rows.push(...page);
      if (page.length < pageSize) break;
    }
  } catch (error) {
    if (!isVacationSchemaMissingError(error)) throw error;
    return [];
  }
  return rows;
}

// PACKED (PERF-018): the raw rows were 1.58MB of JSON on production and growing ~275KB a month
// toward Next's 2MB data-cache limit, past which the write is silently skipped and the cache stops
// existing. Gzipped + base64 they are a small fraction of that — see ./report-rows-pack. A NEW key,
// so no entry written in the old shape is ever read back as a packed string.
const loadAllVacationRequestRowsPacked = unstable_cache(
  async () => packVacationReportRows(await loadAllVacationRequestRowsRaw()),
  ["vacation-report-all-rows-packed"],
  { revalidate: VACATION_REPORT_ROWS_REVALIDATE_SECONDS, tags: [VACATION_REPORT_ROWS_CACHE_TAG] },
);

/**
 * Every vacation request row, from the cross-request cache. A null pack means even compressed the
 * rows would not fit, so they are read live rather than handing the cache an entry it would refuse;
 * that null is itself cached for the TTL, so the next caller skips straight to the live read.
 */
async function loadAllVacationRequestRowsCached(): Promise<VacationRequestDbRow[]> {
  const packed = await loadAllVacationRequestRowsPacked();
  if (packed === null) return loadAllVacationRequestRowsRaw();
  return unpackVacationReportRows<VacationRequestDbRow>(packed);
}

// The scope + WHERE-clause mirror of phx_vacation_report_rows lives in the pure, dependency-free
// ./report-filter module (filterVacationRowsInMemory) so it can be unit-tested without loading this
// file's heavy graph — see tests/vacation-report-filter-equivalence.test.ts.

async function fetchVacationReportRowsFromDatabase(input: {
  access: AccessContext;
  filters: VacationReportFilters;
  visibleEmployeeHrIds: Set<string>;
}): Promise<VacationRequestDbRow[]> {
  const allRows = await loadAllVacationRequestRowsCached();
  const shouldScopeEmployees = !isAllVacationVisibility(input.access);
  // Mirror the RPC's `employee_hr_id = any(p_visible_employee_hr_ids)` scope — exact match against
  // the very same set — before the WHERE filters. An unscoped (HR / all-visibility) caller sees
  // every row, exactly as passing p_visible_employee_hr_ids = null did.
  const scopedRows = shouldScopeEmployees
    ? allRows.filter((row) => row.employee_hr_id != null && input.visibleEmployeeHrIds.has(row.employee_hr_id))
    : allRows;
  return filterVacationRowsInMemory(scopedRows, input.filters);
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
  const [reviewsByRequest, eventsByRequest, settings, attachmentsByRequest] = await Promise.all([
    fetchEvidenceReviewsForRequests(requestIds),
    fetchVacationEventsForRequests(requestIds),
    fetchVacationSlaSettings(),
    fetchVacationAttachmentsForRequests(requestIds),
  ]);
  const now = new Date();
  return rows.map((row) => {
    const events = eventsByRequest.get(row.id) ?? [];
    const reviews = reviewsByRequest.get(row.id) ?? [];
    return {
      ...row,
      attachments: attachmentsByRequest.get(row.id) ?? [],
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
  const periods = holidayMonthKeysForDates(dates);
  if (periods.length === 0) return [];
  // MONTHS TOGETHER, NOT IN A LINE (2026-10-01, "slow to transfer between page and page"): no
  // month's holidays depend on another's. The first month is still read on its own, because it
  // fills the two caches every month reads — the Google calendar feed and the confirmed-override
  // table — so the rest, read together after it, find them warm instead of each fetching them
  // again. Each month still fails on its own into "no holidays for that month", and the months are
  // appended in the order they were asked for, exactly as the one-at-a-time loop appended them.
  const [firstPeriod, ...laterPeriods] = periods;
  const firstMonth = await getConfirmedNationalHolidays(firstPeriod).catch(() => null);
  const laterMonths = await Promise.all(
    laterPeriods.map((period) => getConfirmedNationalHolidays(period).catch(() => null)),
  );
  const holidays: EgyptianNationalHoliday[] = [];
  for (const result of [firstMonth, ...laterMonths]) {
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

const isPendingVacationStatus = (status: VacationRequestStatus) => status === "pending_manager" || status === "pending_hr";

/**
 * The two approval counts — waiting per stage, and overdue against the SLA — in ONE place, read by
 * both the full report's dashboard and `getVacationPendingApprovalCounts`, so the executive
 * landing tiles and the leave report can never disagree. `slaStatus` must come from
 * `enrichVacationRows` (the real settings and the request's events), never `mapVacationRow`'s
 * defaults, or the overdue count drifts.
 */
function countVacationPendingApprovals(rows: VacationRequestRecord[]): Pick<VacationDashboardData, "overdueBySla" | "pendingByStage"> {
  const pendingManager = rows.filter((row) => row.status === "pending_manager");
  const pendingHr = rows.filter((row) => row.status === "pending_hr");
  const overdueManager = pendingManager.filter((row) => row.slaStatus.isOverdue).length;
  const overdueHr = pendingHr.filter((row) => row.slaStatus.isOverdue).length;
  return {
    overdueBySla: { hr: overdueHr, manager: overdueManager, total: overdueHr + overdueManager },
    pendingByStage: { hr: pendingHr.length, manager: pendingManager.length, total: pendingHr.length + pendingManager.length },
  };
}

function buildVacationDashboardData(input: {
  latestSlaRun: VacationSlaRunDbRow | null;
  rows: VacationRequestRecord[];
}): VacationDashboardData {
  const rows = input.rows;
  const pendingManager = rows.filter((row) => row.status === "pending_manager");
  const pendingHr = rows.filter((row) => row.status === "pending_hr");
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
    ...countVacationPendingApprovals(rows),
  };
}

export async function createVacationAttachmentReviewUrl(access: AccessContext, input: {
  attachmentKind: "compensatory" | "sick";
  requestId: string;
}) {
  await assertPermission(access, "leave", "read");

  const request = await fetchVacationRequestById(input.requestId);
  if (!request) throw new Error("Vacation request was not found.");

  // HR/Super Admin can always review evidence; otherwise the caller must be the CURRENTLY
  // pending, assigned approver for THIS specific request (their turn to decide) — widened from
  // HR-only so a manager can actually see the sick note/evidence before approving it.
  if (!isAllVacationVisibility(access)) {
    const { step } = await getPendingVacationApprovalStepForActor({ access, request });
    if (!step) {
      throw new Error("Forbidden: only the assigned approver or HR/Super Admin can review vacation evidence attachments.");
    }
  }

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

/**
 * A short-lived signed URL for ONE file of a request's attachment history, named by its row id.
 *
 * The `/attachments/<kind>` route signs the FIRST file only — it reads the legacy columns — so a
 * request carrying several documents needs this one to open the second and the third.
 *
 * Who may open it: HR/Super Admin, the currently assigned approver (the same gate as
 * createVacationAttachmentReviewUrl), and the EMPLOYEE WHOSE REQUEST IT IS. The employee is here
 * because he has to see which documents the company already holds before deciding what else to
 * send; it is his own medical document and no one else's.
 */
export async function createVacationAttachmentFileReviewUrl(access: AccessContext, input: {
  attachmentId: string;
  requestId: string;
}) {
  await assertPermission(access, "leave", "read");

  const request = await fetchVacationRequestById(input.requestId);
  if (!request) throw new Error("Vacation request was not found.");

  const isOwnRequest = hrIdsMatch(request.employeeHrId, access.hrId);
  if (!isOwnRequest && !isAllVacationVisibility(access)) {
    const { step } = await getPendingVacationApprovalStepForActor({ access, request });
    if (!step) {
      throw new Error("Forbidden: only the assigned approver, HR/Super Admin, or the employee who filed the request can open its evidence files.");
    }
  }

  const attachment = request.attachments.find((row) => row.id === input.attachmentId);
  if (!attachment) throw new Error("Vacation evidence attachment was not found for this request.");

  const { data, error } = await getSupabaseAdmin().storage
    .from(attachment.bucket || vacationAttachmentBucket)
    .createSignedUrl(attachment.objectPath, 5 * 60);

  if (error || !data?.signedUrl) {
    throw new Error(`Unable to open vacation evidence attachment: ${error?.message ?? "signed URL was not created"}`);
  }

  return {
    contentType: attachment.contentType,
    fileName: attachment.originalName,
    signedUrl: data.signedUrl,
  };
}

/**
 * Add one or more evidence files to a request that is ALREADY SUBMITTED.
 *
 * Owner, 2026-10-03: *"after he upload and submit to re-upload, but that does not replace the one he
 * uploaded before — no, it is an add-on on them"*. So this only ever INSERTS: it never touches the
 * legacy `sick_attachment_*` columns (which keep naming the first file), never deletes a stored
 * object, and never alters an earlier row's `uploaded_at`. The admin therefore reads the request as
 * a dated history rather than as one slot that the last upload won.
 *
 * Allowed for the employee who filed the request and for HR/Super Admin, at any status — a rejected
 * sick request is exactly when a stamped document is asked for a second time. The decision itself is
 * untouched: adding a file approves nothing and re-opens nothing.
 */
export async function addVacationRequestAttachments(access: AccessContext, input: {
  attachments: VacationAttachmentUpload[];
  requestId: string;
}) {
  await assertPermission(access, "leave", "create");

  const files = (input.attachments ?? []).filter(Boolean);
  if (files.length === 0) throw new Error("Choose at least one file to upload.");

  const request = await fetchVacationRequestById(input.requestId);
  if (!request) throw new Error("Vacation request was not found.");

  const isOwnRequest = hrIdsMatch(request.employeeHrId, access.hrId);
  if (!isOwnRequest && !isAllVacationVisibility(access)) {
    throw new Error("Forbidden: only the employee who filed this request, or HR/Super Admin, can add documents to it.");
  }

  const kind: VacationEvidenceType = request.vacationType === "compensatory" ? "compensatory" : "sick";

  const stored: StoredVacationEvidenceFile[] = [];
  try {
    for (const attachment of files) {
      stored.push(
        await uploadAdditionalVacationEvidenceFile({
          attachment,
          employeeHrId: request.employeeHrId,
          kind,
          requestId: request.id,
        }),
      );
    }
  } catch (error) {
    // A partial upload leaves orphan objects with no row pointing at them, so clear the ones that
    // did land before reporting the file that failed.
    for (const file of stored) {
      await deleteSickAttachment(file.objectPath).catch(() => undefined);
    }
    throw error;
  }

  // `resolveEmployeeIdentityId` alone, exactly as every other actor write in this file does.
  // `access.hrId` is the LOWERCASE comparison key: correct for matching (hrIdsMatch above) and wrong
  // for persisting — writing it is what left ~37,000 lowercase actor ids across 52 columns, and a
  // naive `.eq` on one then returns nothing at all rather than something visibly wrong.
  // Pinned by `tests/hr-id-storage-casing.test.ts`.
  const actorHrId = resolveEmployeeIdentityId(access);
  const inserted = await insertVacationAttachmentRows({
    actorHrId,
    actorLoginId: access.loginId,
    files: stored.map((file) => ({ file, kind })),
    requestId: request.id,
  });

  await insertVacationEvent({
    actorHrId,
    actorLoginId: access.loginId,
    eventType: "evidence_uploaded",
    message: inserted.length === 1
      ? `Additional document uploaded: ${inserted[0]?.originalName ?? "document"}.`
      : `${inserted.length} additional documents uploaded.`,
    metadata: {
      addedAfterSubmit: true,
      fileNames: inserted.map((row) => row.originalName).filter(Boolean),
      kind,
      totalAttachments: request.attachments.length + inserted.length,
    },
    requestId: request.id,
  });

  return {
    attachments: [...request.attachments, ...inserted],
    added: inserted,
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
  const visibleEmployees = await filterVacationEmployeesForAccess(access, activeEmployees);
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
    displayId: row.requestCode,
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

/**
 * How many purged requests we keep full detail for. Beyond this the manifest keeps every id — an
 * id is what makes a row findable again — and flags the shortfall explicitly. It never silently
 * drops rows: `detailTruncated` and `detailOmitted` say exactly how much is missing.
 */
const VACATION_PURGE_MANIFEST_DETAIL_LIMIT = 2000;

type VacationPurgeManifestRow = {
  created_at: string | null;
  employee_hr_id: string | null;
  employee_name: string | null;
  end_date: string | null;
  id: string;
  start_date: string | null;
  status: string | null;
  vacation_type: string | null;
};

/**
 * The request rows the history purge is about to destroy, read BEFORE the delete runs.
 * Afterwards there is nothing left to describe, and "whose leave history disappeared, and when"
 * is precisely the question a retention purge has to be able to answer years later. Counting the
 * rows — which is all this used to do — cannot answer it.
 */
async function fetchRequestHistoryPurgeManifest(cutoff: string): Promise<VacationPurgeManifestRow[]> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from(vacationRequestsTable)
      .select("id,employee_hr_id,employee_name,vacation_type,start_date,end_date,status,created_at")
      .lt("created_at", cutoff)
      .order("created_at", { ascending: true });
    if (error) throwVacationDatabaseError(error);
    return (data ?? []) as VacationPurgeManifestRow[];
  } catch (error) {
    if (!isVacationSchemaMissingError(error)) throw error;
    return [];
  }
}

/**
 * These are the rows the purge SET OUT to delete, not necessarily the ones that died: the request
 * delete runs last, so a failure earlier in the sequence leaves them standing. `deletedCounts`
 * sits alongside them in the same audit row and says what actually went — on a `failed` status the
 * two legitimately differ, which is why this says "targeted" and never "purged".
 */
function buildPurgeManifestPayload(rows: VacationPurgeManifestRow[]) {
  const detail = rows.slice(0, VACATION_PURGE_MANIFEST_DETAIL_LIMIT);
  return {
    detailOmitted: rows.length - detail.length,
    detailTruncated: rows.length > detail.length,
    targetedRequestIds: rows.map((row) => row.id),
    targetedRequests: detail.map((row) => ({
      createdAt: row.created_at,
      employeeHrId: row.employee_hr_id,
      employeeName: row.employee_name,
      endDate: row.end_date,
      id: row.id,
      startDate: row.start_date,
      status: row.status,
      vacationType: row.vacation_type,
    })),
    totalTargetedRequests: rows.length,
  };
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
    // The run table is absent. This used to return silently, which meant a real purge could
    // destroy request rows and leave no record anywhere at all. The audit row written by the
    // caller is now the independent second record, but a missing run table is still a governance
    // failure and must not pass unnoticed.
    logError("Vacation retention purge run could not be recorded", {
      labels: {
        event: "vacation_retention_purge_run_unrecorded",
        dryRun: String(input.dryRun),
        status: input.status,
      },
      context: { actorLoginId: input.actorLoginId, deletedCounts: input.deletedCounts },
      error,
    });
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

  let purgeManifest: VacationPurgeManifestRow[] = [];

  if (!dryRun) {
    try {
      // Read what is about to be destroyed while it still exists. Placed before every delete so
      // the manifest describes the pre-purge state rather than whatever survived a partial failure.
      purgeManifest = await fetchRequestHistoryPurgeManifest(cutoffs.request_history);

      // A sick request may carry several documents, and only the FIRST is in the legacy columns, so
      // the attachment history has to be purged with them. Missing it left every later file in the
      // bucket for ever, past the retention date the purge exists to enforce.
      const evidenceCandidateIds = evidenceCandidates.map((row) => row.id);
      const evidenceAttachmentRows = await fetchVacationAttachmentsForRequests(evidenceCandidateIds);
      const evidenceObjectPaths = Array.from(
        new Set(
          [
            ...evidenceCandidates.flatMap((row) => [
              row.sick_attachment_object_path,
              row.compensatory_attachment_object_path,
            ]),
            ...Array.from(evidenceAttachmentRows.values()).flat().map((attachment) => attachment.objectPath),
          ].filter((value): value is string => Boolean(value)),
        ),
      );
      if (evidenceObjectPaths.length > 0) {
        const { error } = await getSupabaseAdmin().storage.from(vacationAttachmentBucket).remove(evidenceObjectPaths);
        if (error) throw error;
        deletedCounts.evidenceAttachments = evidenceObjectPaths.length;
      }
      if (evidenceCandidateIds.length > 0) {
        try {
          for (const batch of chunk(evidenceCandidateIds)) {
            const { error } = await getSupabaseAdmin()
              .from(vacationAttachmentsTable)
              .delete()
              .in("request_id", batch);
            if (error) throwVacationDatabaseError(error);
          }
        } catch (error) {
          if (!isVacationSchemaMissingError(error)) throw error;
        }
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
  const actorLoginId = access.loginId ?? resolveEmployeeIdentityId(access);
  await recordRetentionPurgeRun({
    actorLoginId,
    candidates,
    deletedCounts,
    dryRun,
    errors,
    policySnapshot,
    status,
  });

  // A dry run destroys nothing, so it stays out of audit_logs and is recorded only as a purge run.
  // A real purge is the one irreversible thing this module does, so it gets a required audit row —
  // written independently of the run table above, so a missing run table can no longer erase the
  // only record — and it carries the manifest, so "whose leave history went" stays answerable.
  if (!dryRun) {
    await writeRequiredAuditLog({
      actorLoginId,
      entityId: null,
      entityType: "vacation_retention_purge",
      newValues: null,
      oldValues: { ...buildPurgeManifestPayload(purgeManifest), cutoffs, deletedCounts, errors, policySnapshot, status },
      summary:
        `Leave retention purge ${status}: ${deletedCounts.requestHistory} request(s), ` +
        `${deletedCounts.requestEvents} event(s), ${deletedCounts.decisionTokens} decision token(s), ` +
        `${deletedCounts.slaRunLogs} SLA run(s) and ${deletedCounts.evidenceAttachments} attachment(s) deleted ` +
        `(request history older than ${cutoffs.request_history}).`,
    });
  }

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
  return currentCairoDateOnlyIso();
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
  const hrEscalationRoles = await resolveNotificationRoleRecipients("vacation_sla_hr_escalation");
  const hrRecipients = await getHrRecipients(directory, hrEscalationRoles);

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
        ? `/admin/approvals/vacation/${encodeURIComponent(row.id)}`
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
        subjectHrId: row.employeeHrId,
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

async function loadVacationReportData(access: AccessContext, clean: VacationReportFilters): Promise<VacationReportData> {
  await assertPermission(access, "leave", "read");
  const canAdminManage = isAllVacationVisibility(access) && await canManageVacationRecords(access);
  const canExport = await canAccess(access, "leave", "export");
  const canReviewAttachments = isAllVacationVisibility(access);
  const activeEmployees = await getEmployeeDirectoryRows();
  const visibleEmployees = await filterVacationEmployeesForAccess(access, activeEmployees);
  const visibleEmployeeHrIds = buildVisibleHrIdSet(visibleEmployees);
  // The viewer's OWN earlier record (continuous-service.ts): the same person's history under the HR
  // id they held before a re-hire. Only their own — nobody else's visibility moves.
  for (const candidate of accessIdentityCandidates(access)) {
    for (const earlierHrId of ownAndEarlierRecordHrIds(candidate).slice(1)) {
      const canonical = canonicalHrId(earlierHrId);
      if (canonical) visibleEmployeeHrIds.add(canonical);
      visibleEmployeeHrIds.add(earlierHrId.trim().toUpperCase());
    }
  }
  // 🔴 A SECOND, WIDER READ — used ONLY to find the leavers a charge has been taken from (owner,
  // 2026-10-09). `visibleEmployeeHrIds` is deliberately NOT widened with it: that set decides which
  // REQUESTS the viewer may see, and widening it would change request visibility, which nobody asked
  // for. The access filter is re-applied here so a manager can only ever see their own leavers, and
  // both directory reads are TTL-cached and request-deduped, so this adds no round trip in practice.
  const visibleIncludingDeparted = await filterVacationEmployeesForAccess(
    access,
    await getEmployeeDirectoryRows({ includeInactive: true }),
  );
  const data = await fetchVacationReportRowsFromDatabase({ access, filters: clean, visibleEmployeeHrIds });

  const scopedRows = await withManagerDisplayNames(
    (data ?? [])
      .map((row) => mapVacationRow(row as VacationRequestDbRow))
      .filter((row) => canSeeVacation(access, row, visibleEmployeeHrIds)),
  );
  // STARTED TOGETHER (2026-10-01, "slow to transfer between page and page"): the approval-step read,
  // the evidence/event enrichment, the holiday months, the unfiltered re-read and the last SLA run
  // used to wait on each other in a line, and none reads another's answer. markVacationDecisionAccess
  // sets `canDecide` and nothing else; enrichVacationRows keeps every field it is handed and adds its
  // own three, reading only id, status, createdAt and managerDecisionAt; fetchHolidaysForRows reads
  // only each row's dates. So the rows below are field for field the ones the chained calls built.
  // The results are unwrapped in the order the calls used to run, so a failure throws the same error
  // the one-at-a-time version would have met first.
  const [decisionAccessRead, enrichedRead, holidaysRead, allScopedRead, latestSlaRunRead] = await Promise.allSettled([
    markVacationDecisionAccess(access, scopedRows),
    enrichVacationRows(scopedRows),
    fetchHolidaysForRows(scopedRows),
    fetchVacationReportRowsFromDatabase({ access, filters: {}, visibleEmployeeHrIds }),
    fetchLatestVacationSlaRun(),
  ]);
  const rowsWithDecisionAccess = settledValueOrThrow(decisionAccessRead);
  const visibleRows = settledValueOrThrow(enrichedRead).map((row, index) => ({
    ...row,
    canDecide: rowsWithDecisionAccess[index].canDecide,
  }));
  const holidays = settledValueOrThrow(holidaysRead);
  const warningsByRequest = buildVacationOverlapWarnings({ holidays, rows: visibleRows });
  const visibleRowsWithWarnings = visibleRows.map((row) => ({
    ...row,
    overlapWarnings: warningsByRequest.get(row.id) ?? [],
  }));
  const filteredRows = visibleRowsWithWarnings;
  // Entitlements tab: the Used/Balance arithmetic reads EVERY approved day, not just the rows the
  // current filters happen to be showing (see buildEmployeeEligibilityRows). Re-reading with no
  // filters is cheap — fetchVacationReportRowsFromDatabase serves the cross-request-cached row set
  // (loadAllVacationRequestRowsCached) and re-applies only the access scope in memory, so this adds
  // no database round-trip. enrichVacationRows is deliberately NOT applied: it fetches events and
  // evidence reviews per request id for the timeline UI, and the balance sum reads none of that.
  // (The re-read itself was started with the others above.)
  const allScopedRows = settledValueOrThrow(allScopedRead)
    .map((row) => mapVacationRow(row))
    .filter((row) => canSeeVacation(access, row, visibleEmployeeHrIds));
  // Deductions taken from annual leave (owner, 2026-10-09). A failed read must not take the whole
  // report down, but it must not read as "none" either — it is logged and the section says so.
  // TWO READS, STARTED TOGETHER. The charges section shows the deductions fold — one row per
  // deduction, with the Super Admin's comment; the Used and Balance columns need EVERY annual-balance
  // day, including the weekly attendance review's and payroll's, or they read higher than the balance
  // a request is priced against (annualBalanceLedgerDays). A failed read of either must not take the
  // whole report down, and must not read as "none" either: each is logged and said on screen.
  const [leaveBalanceRead, annualLedgerRead] = await Promise.all([
    // The WIDER list: a charge taken from a leaver's balance belongs in this section as much as on
    // the Entitlements tab, and it was being dropped here because the id list stopped at the active
    // employees. listLeaveBalanceChargesForEmployees reads every deduction row and filters in
    // memory, so a longer list of ids costs nothing.
    listLeaveBalanceChargesForEmployees(visibleIncludingDeparted.map((employee) => employee.hrId)).then(
      (charges) => ({ charges, failed: false }),
      (error: unknown) => {
        console.error("Vacation report: could not read the deductions taken from annual leave", error);
        return { charges: [] as Awaited<ReturnType<typeof listLeaveBalanceChargesForEmployees>>, failed: true };
      },
    ),
    annualBalanceLedgerDays().then(
      (rows) => ({ rows, failed: false }),
      (error: unknown) => {
        console.error("Vacation report: could not read the annual balance ledger", error);
        return { rows: [] as Awaited<ReturnType<typeof annualBalanceLedgerDays>>, failed: true };
      },
    ),
  ]);
  // 🔴 WHO GETS A ROW: every active employee, plus the LEAVERS whose balance has actually been
  // spent. Measured on production 2026-10-09: three of the sixteen September Unpaid Vacation rows
  // belong to people who had left, so a day charged against them landed on a balance that appeared
  // on no screen at all — the gap the charge dialog could only describe.
  //
  // 🔴 NET days, not any ledger row: a charge returned to salary leaves a NEGATIVE row that nets it
  // out, and a leaver whose charge was given back is not a charged leaver. The ledger covers every
  // annual-balance pool; when that read failed, the deductions fold is the fallback so a leaver does
  // not silently vanish on the one day the wider read is broken.
  //
  // 🔴 AND INSIDE THAT PERSON'S OWN CURRENT BALANCE PERIOD — the same window the Used and Balance
  // columns count. Without it the row never drops off: the period moves with today, so a leaver
  // whose charge fell out of it would keep a row showing Used 0 and a FULL untouched entitlement for
  // someone who no longer works here, which is worse than not showing them at all.
  const balanceLedgerRows: ReadonlyArray<{ employeeHrId: string; workDate: string; days: number }> =
    annualLedgerRead.failed ? leaveBalanceRead.charges : annualLedgerRead.rows;
  const activeHrIdKeys = new Set(
    visibleEmployees.map((employee) => employee.hrId.trim().toLowerCase()).filter(Boolean),
  );
  const chargedLeavers = visibleIncludingDeparted.filter((employee) => {
    const key = employee.hrId.trim().toLowerCase();
    if (!key || activeHrIdKeys.has(key)) return false;
    if (!hasDepartedEmployment(employee.employmentStatus)) return false;
    // currentCairoDateOnlyIso() again rather than a hoisted constant: the builder's own call below
    // is matched verbatim by tests/cairo-leave-today.test.ts, which is what keeps this table on the
    // Cairo calendar day, and two reads of the same day are cheaper than loosening that pin.
    const period = getVacationBalancePeriod({
      employeeHrId: employee.hrId,
      hireDate: employee.hireDate,
      referenceDate: currentCairoDateOnlyIso(),
    });
    if (!period) return false;
    const netDays = balanceLedgerRows.reduce(
      (sum, row) =>
        hrIdsMatch(row.employeeHrId, employee.hrId) &&
        row.workDate >= period.periodStart &&
        row.workDate < period.periodEnd
          ? sum + row.days
          : sum,
      0,
    );
    return netDays > 0;
  });
  const employeeEligibility = buildEmployeeEligibilityRows({
    allScopedRows,
    employees: [...visibleEmployees, ...chargedLeavers],
    filters: clean,
    balanceCharges: annualLedgerRead.rows,
    balanceChargesUnavailable: annualLedgerRead.failed,
    // Africa/Cairo calendar day, matching getVacationRequestPageData's employee-facing twin.
    // This is the reference date for the whole Entitlements table — balance period, payment
    // calculation and days-until-eligibility all hang off it. On an employee's hire anniversary
    // the server's own clock still reads the previous day for the first 2-3 Cairo hours, which
    // leaves the balance period on the PREVIOUS entitlement year (old accrual, prior-year used
    // days) and can make HR reject a request that is actually funded.
    today: currentCairoDateOnlyIso(),
  });
  const latestSlaRun = settledValueOrThrow(latestSlaRunRead);

  return {
    canAdminManage,
    canExport,
    canReviewAttachments,
    viewerHrId: access.hrId ?? null,
    dashboard: buildVacationDashboardData({ latestSlaRun, rows: filteredRows }),
    employeeEligibility,
    // 🔴 THE SUMMARY STAYS ABOUT THE ACTIVE WORKFORCE — HIS OWN DECISION, confirmed 2026-10-09:
    // "keep the entitlements summary counting active employees only". Its first figure is literally
    // `activeEmployees`, and counting the charged leavers in it would move a headcount he reads
    // every month to make a few leaver rows visible. The rows are on the tab; the totals are not
    // restated. Do not widen this filter to "include leavers for completeness" — that is the change
    // he was asked about and declined.
    employeeEligibilitySummary: buildEmployeeEligibilitySummary(
      employeeEligibility.filter((row) => !hasDepartedEmployment(row.employmentStatus)),
    ),
    filters: clean,
    leaveBalanceDeductions: {
      failed: leaveBalanceRead.failed,
      rows: leaveBalanceRead.charges.map((charge) => {
        // The wider list, or a leaver's own charge reads "Name unavailable" — his rule is names,
        // never ids, and this section is where the comment the employee reads is shown.
        const person = visibleIncludingDeparted.find((employee) => hrIdsMatch(employee.hrId, charge.employeeHrId));
        return {
          chargedAt: charge.chargedAt,
          comment: charge.comment,
          days: charge.days,
          employeeHrId: charge.employeeHrId,
          employeeName: person?.displayName ?? person?.fullName ?? "Name unavailable",
          // From the SAME row the name comes from, through the one shared vocabulary for "has left"
          // — never the complement of active, which would mark the historical payroll records too.
          employeeHasLeft: hasDepartedEmployment(person?.employmentStatus),
          lastWorkingDate: person?.lastWorkingDate ?? null,
          workDate: charge.workDate,
        };
      }),
    },
    options: buildReportOptions(visibleRowsWithWarnings, visibleEmployees),
    rows: filteredRows,
    summary: buildReportSummary(filteredRows),
  };
}

// Request-scoped dedup only: 8 surfaces (portal, action center, approvals hub x3, CEO/admin
// command centers) can each call getVacationReportData with the SAME (access, filters) within one
// render, and approvals-hub loads it twice outright (once directly, once inside
// getVacationActionCenterData). React's cache() collapses those into a single DB round trip.
// Keyed on a canonical JSON string of cleanFilters(), not the raw filters object, because two
// call sites that both mean "status: all" write two different `{ status: "all" }` object
// literals — cache() compares object arguments by REFERENCE, so without this every call would
// still miss. `access` itself is passed through by reference (never cloned) by every caller, so
// it stays a valid, stable cache key across a request without any extra work.
// SAFE across writes: every vacation write (decideVacationRequest, resubmitVacationRequest, ...)
// lives in its own dedicated API route or a Server Action that redirect()s afterward — never in
// the same function as a getVacationReportData read — and React's cache() scope never spans two
// requests, so a decision made just now is never served stale by a cache hit here.
const loadVacationReportDataCached = cache(async (access: AccessContext, filtersKey: string): Promise<VacationReportData> =>
  loadVacationReportData(access, JSON.parse(filtersKey) as VacationReportFilters));

export async function getVacationReportData(access: AccessContext, filters: VacationReportFilters = {}): Promise<VacationReportData> {
  return loadVacationReportDataCached(access, JSON.stringify(cleanFilters(filters)));
}

/**
 * One employee's remaining annual leave — entitlement minus every approved paid day already taken
 * in their current balance period — computed through buildEmployeeEligibilityRows, the SAME
 * entitlement-row math the Vacation Report's Entitlements tab reduces to for that employee. Never
 * duplicate this subtraction elsewhere (e.g. a portal home tile): call this instead, so the two
 * screens can never disagree.
 *
 * It answers what the employee may actually TAKE (requestableAnnualLeaveDays), which inside the
 * first six months is 0 even though the report's Balance column carries the accrued figure — the
 * rule still refuses the request, and the tile links straight to the screen that would refuse it.
 *
 * Reads systemAccessContext's own all-visibility row set rather than the caller's AccessContext —
 * this is "what does employeeHrId have left", not "what can the viewer see" — then narrows to that
 * one employee in memory. loadAllVacationRequestRowsCached and getEmployeeDirectory are both
 * request-deduped/TTL-cached, so calling this from a landing page adds no new round trip beyond
 * what the report page already pays.
 */
export async function getEmployeeAnnualLeaveBalanceDays(employeeHrId: string | null | undefined): Promise<number | null> {
  const directory = await getEmployeeDirectory();
  const employee = findEmployeeByHrId(directory, employeeHrId);
  if (!employee) return null;

  // A re-hired person's leave under an earlier record is spent from the same balance
  // (continuous-service.ts), so it is read too and counted as theirs.
  const ownAndEarlier = ownAndEarlierRecordHrIds(employee.hrId);
  const visibleHrIds = buildVisibleHrIdSet([employee]);
  for (const earlier of ownAndEarlier.slice(1)) {
    const canonical = canonicalHrId(earlier);
    if (canonical) visibleHrIds.add(canonical);
    visibleHrIds.add(earlier.toUpperCase());
  }
  const scopedRows = (await fetchVacationReportRowsFromDatabase({
    access: systemAccessContext,
    filters: {},
    visibleEmployeeHrIds: visibleHrIds,
  }))
    .map((row) => mapVacationRow(row))
    .filter((row) => ownAndEarlier.some((hrId) => hrIdsMatch(row.employeeHrId, hrId)))
    .map((row) => (hrIdsMatch(row.employeeHrId, employee.hrId) ? row : { ...row, employeeHrId: employee.hrId }));

  // Unknown beats overstated: a balance that forgot days already spent would say more is left than
  // there is, so a failed read answers null (the callers already treat that as "not shown"). EVERY
  // pool, not the deductions fold alone — see annualBalanceLedgerDays.
  let balanceCharges: Awaited<ReturnType<typeof annualBalanceLedgerDays>>;
  try {
    balanceCharges = await annualBalanceLedgerDays();
  } catch {
    return null;
  }
  const [eligibilityRow] = buildEmployeeEligibilityRows({
    allScopedRows: scopedRows,
    employees: [employee],
    filters: {},
    today: currentCairoDateOnlyIso(),
    balanceCharges,
  });

  // NOT the row's Balance column: inside the first six months that is the accrued figure the report
  // shows, which this employee cannot request. See requestableAnnualLeaveDays.
  return eligibilityRow ? requestableAnnualLeaveDays(eligibilityRow) : null;
}

/** One line of a person's leave history, as Employee 360's personnel chapter shows it. */
export type EmployeeLeaveRecordLine = {
  id: string;
  typeLabel: string;
  startDate: string;
  endDate: string;
  durationDays: number;
  statusLabel: string;
};

/**
 * Whether the leave screen would list this person for this viewer: its own filter, never a copy.
 * leave:read alone is not the answer, because every seat holds it for its OWN leave.
 */
export async function canViewEmployeeLeaveRecord(access: AccessContext, employeeHrId: string): Promise<boolean> {
  try {
    // Departed people too: a report can be opened on someone who has left, under the same rule.
    const visible = await filterVacationEmployeesForAccess(access, await getEmployeeDirectoryRows({ includeInactive: true }));
    return visible.some((employee) => hrIdsMatch(employee.hrId, employeeHrId));
  } catch (error) {
    if (error instanceof VacationViewerHasNoEmployeeProfileError) return false;
    throw error;
  }
}

/**
 * One person's leave requests, newest first, keyed on the PERSON rather than the viewer. The report
 * screen's own read is scoped to whoever is looking, so a viewer outside that scope would see this
 * person as having no leave at all. The caller has already decided this viewer may see them.
 * Throws on a failed read; an empty list means nothing was filed.
 */
export async function getEmployeeLeaveRequestsForRecord(employeeHrId: string, limit: number): Promise<EmployeeLeaveRecordLine[]> {
  const directory = await getEmployeeDirectory();
  const employee = findEmployeeByHrId(directory, employeeHrId);
  if (!employee) return [];

  const rows = (await fetchVacationReportRowsFromDatabase({
    access: systemAccessContext,
    filters: {},
    visibleEmployeeHrIds: buildVisibleHrIdSet([employee]),
  }))
    .map((row) => mapVacationRow(row))
    .filter((row) => hrIdsMatch(row.employeeHrId, employee.hrId));

  return rows
    .sort((left, right) => right.startDate.localeCompare(left.startDate))
    .slice(0, limit)
    .map((row) => ({
      id: row.id,
      typeLabel: vacationTypeLabel(row.vacationType),
      startDate: row.startDate,
      endDate: row.endDate,
      durationDays: row.durationDays,
      statusLabel: VACATION_STATUSES.find((status) => status.value === row.status)?.label ?? row.status,
    }));
}

/**
 * The Leave approval counts the executive landing pages show — identical to
 * `getVacationReportData(access, { status: "all" }).dashboard.{pendingByStage,overdueBySla}`.
 *
 * The full report enriches EVERY request ever filed (events, evidence reviews, holidays, overlap
 * warnings) and builds every employee's entitlement balance; measured against production from a
 * local run on 2026-09-21 it took 11.7 s and was the slowest read behind /admin, all to yield two
 * counts. Only a PENDING request can be waiting or overdue, so only those rows are enriched here —
 * with the same `enrichVacationRows`, so the SLA verdict is the report's own.
 */
export async function getVacationPendingApprovalCounts(
  access: AccessContext,
): Promise<Pick<VacationDashboardData, "overdueBySla" | "pendingByStage">> {
  await assertPermission(access, "leave", "read");
  const activeEmployees = await getEmployeeDirectoryRows();
  const visibleEmployees = await filterVacationEmployeesForAccess(access, activeEmployees);
  const visibleEmployeeHrIds = buildVisibleHrIdSet(visibleEmployees);
  const data = await fetchVacationReportRowsFromDatabase({
    access,
    filters: cleanFilters({ status: "all" }),
    visibleEmployeeHrIds,
  });
  const pendingRows = (data ?? [])
    .map((row) => mapVacationRow(row as VacationRequestDbRow))
    .filter((row) => isPendingVacationStatus(row.status) && canSeeVacation(access, row, visibleEmployeeHrIds));
  return countVacationPendingApprovals(await enrichVacationRows(pendingRows));
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
  const visibleEmployees = await filterVacationEmployeesForAccess(access, activeEmployees);
  const visibleEmployeeHrIds = buildVisibleHrIdSet(visibleEmployees);
  const data = await fetchVacationReportRowsFromDatabase({ access, filters: {}, visibleEmployeeHrIds });

  return markVacationDecisionAccess(access, (data ?? [])
    .map((row) => mapVacationRow(row as VacationRequestDbRow))
    .filter((row) => canSeeVacation(access, row, visibleEmployeeHrIds)));
}
