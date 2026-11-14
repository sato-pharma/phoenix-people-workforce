
import { approvalIdentity, raiseApproval } from "@/lib/approvals/raise-approval";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { isSalaryBlindRole } from "@/lib/auth/hr-functions";
import {
  canAccess,
  canSeeEmployee,
  hrIdsMatch,
  normalizeHrId,
  systemAccessContext,
  type AccessContext,
} from "@/lib/auth/permissions";
import { resolveCanonicalActorHrId } from "@/lib/auth/canonical-actor";
import { invalidateExecutiveDashboardCache } from "@/lib/dashboard/invalidation";
import { getEmployeeDirectory, getEmployeeDirectoryRows, invalidateEmployeeDirectoryCache } from "@/lib/employees/employee-directory";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { assertResignationWorkflowTransition } from "@/lib/employee-lifecycle/workflow";
import { DECLINE_OFFER_WINDOW_DAYS, isDeclineOfferEligible } from "@/lib/resignations/decline-offer-eligibility";
import { afterResponse } from "@/lib/http/after-response";
import { ApiError } from "@/lib/http/api-errors";
import { resolveNotificationPersonRecipients, resolveRoleRecipientHrIds } from "@/lib/notifications/role-recipients";
import { disableTelegramForIdentity } from "@/lib/notifications/settings";
import { isEmploymentAccessRevoked } from "@/lib/auth/session-lifecycle";
import { getOutstandingDevicesByEmployee } from "@/lib/devices/service";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { openMailboxOffboardingTask } from "@/lib/mailbox-offboarding/service";
import { logError } from "@/lib/observability/log";
import { isResignationEmploymentStatus } from "@/lib/payroll/leaver-kind";
import { computeResignationSettlement } from "@/lib/payroll/copilot/proration";
// Read-only use of the owner-locked payroll policy: the Part-1 anchor and payment-mode
// normalisation. This module never modifies policy.ts.
import { calculateBasicSalary, normalizePayrollPaymentMode } from "@/lib/payroll/policy";
import type { PayrollResignationCandidate } from "@/lib/payroll/salary-import";
import { recordOfferDeclinedAfterHire } from "@/lib/recruitment/offer-outcome-sync";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { generateShortVacancyCode } from "@/lib/workforce/vacancy-code";

import type {
  CreateResignationInput,
  DeclineOfferInput,
  ResignationDashboardData,
  EmployeeResignationInput,
  PayrollResignationCandidateRecord,
  ResignationRecord,
  ResignationSettlementPreview,
  ResignationStatus,
  ResignationWorkflowAction,
  UpdateResignationDatesInput,
} from "./types";

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;
type DirectoryEmployee = Awaited<ReturnType<typeof getEmployeeDirectory>>["employees"][number];
const terminalEmployeeStatuses = [
  "inactive",
  "Inactive",
  "INACTIVE",
  "resigned",
  "Resigned",
  "RESIGNED",
  "terminated",
  "Terminated",
  "TERMINATED",
  // "declined offer / did not join" (declineOfferAndOpenVacancy) — the pay branch reuses
  // "terminated" above and is already covered; this covers the no-pay branch, which is
  // the only employment_status value unique to that workflow.
  "declined_offer",
];

type ResignationRow = {
  cancelled_at?: string | null;
  cancelled_by?: string | null;
  completed_at?: string | null;
  completed_by?: string | null;
  created_at: string;
  created_by: string | null;
  effective_date?: string | null;
  id: string;
  employee_hr_id: string;
  employee_name: string;
  exit_status?: string | null;
  job_title: string | null;
  last_working_date?: string | null;
  line_name: string | null;
  notes?: string | null;
  reason: string | null;
  resignation_date?: string | null;
  reviewed_at?: string | null;
  reviewed_by?: string | null;
  approved_at?: string | null;
  approved_by?: string | null;
  rejected_at?: string | null;
  rejected_by?: string | null;
  rejected_reason?: string | null;
  status?: ResignationStatus | null;
  submitted_date?: string | null;
  updated_at: string;
  workflow_notes?: string | null;
};

type PayrollResignationCandidateRow = {
  id: string;
  area_name: string | null;
  created_by: string | null;
  employee_name: string;
  first_seen_at: string;
  hire_date: string | null;
  hr_id: string;
  job_title: string | null;
  last_payout_month: number;
  last_payout_year: number;
  last_seen_at: string;
  line_name: string | null;
  name_ar: string | null;
  source_file_name: string | null;
  source_row: number | null;
  updated_at: string;
};

type HistoricalResignedEmployeeRow = {
  created_at: string | null;
  employment_status: string | null;
  exit_category?: string | null;
  exit_reason?: string | null;
  exit_status?: string | null;
  full_name: string;
  nickname?: string | null;
  hr_id: string;
  job_title: string | null;
  last_working_date?: string | null;
  lines?: { name: string | null } | Array<{ name: string | null }> | null;
  positions?: { title: string | null } | Array<{ title: string | null }> | null;
  resignation_date?: string | null;
  updated_at: string | null;
};

function asIso(value: string | null | undefined) {
  return value ? new Date(value).toISOString() : null;
}

function todayDate() {
  return currentCairoDateOnlyIso();
}

function normalizeDate(value: string | null | undefined) {
  if (value === null || value === undefined) return "";
  const raw = String(value).trim();
  if (!raw || raw.toLowerCase() === "null" || raw.toLowerCase() === "undefined") return "";
  return raw.slice(0, 10);
}

function cleanText(value: string | null | undefined) {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function lowerErrorMessage(error: unknown) {
  return resignationErrorMessage(error).toLowerCase();
}

function isMissingSchemaMessage(error: unknown) {
  const message = lowerErrorMessage(error);
  return (
    message.includes("could not find the table") ||
    message.includes("could not find the") ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist")) ||
    (message.includes("column") && message.includes("does not exist"))
  );
}

function isMissingResignationRpc(error: unknown) {
  const message = lowerErrorMessage(error);
  return (
    message.includes("phx_resign_employee_and_open_vacancy") ||
    message.includes("could not find the function") ||
    (message.includes("function") && message.includes("does not exist")) ||
    message.includes("pgrst202")
  );
}

function isLastWorkingDateConstraintError(error: unknown) {
  const message = lowerErrorMessage(error);
  return (
    message.includes("last_working_date") &&
    message.includes("null value") &&
    message.includes("employee_resignations")
  );
}

function isMissingColumn(error: unknown, column: string) {
  return lowerErrorMessage(error).includes(column.toLowerCase());
}

function missingColumnFromError(error: unknown, columns: string[]) {
  return columns.find((column) => isMissingColumn(error, column)) ?? null;
}

// ── STRICT schema tolerance, for completing a resignation ──────────────────────────────────────
// The tolerant checks above match any message that merely MENTIONS a column or says "does not
// exist" — so a constraint, a trigger fault or a function failing inside (`column "x" does not
// exist` raised from PL/pgSQL, 42703) was skipped as if the schema object were absent, and the
// resignation went on to read "completed" over a person still on payroll or still in the seat.
// These three answer true only for the exact object being absent, in the exact words PostgREST
// (PGRST202/204/205) and Postgres (42883/42703/42P01) use for it. Anything else is a real failure.

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "";
}

/** True only when the named table itself is absent. */
export function isMissingTableError(error: unknown, table: string) {
  const message = lowerErrorMessage(error);
  const name = table.toLowerCase();
  const namesTable =
    message.includes(`'public.${name}'`) ||
    message.includes(`"public.${name}"`) ||
    message.includes(`'${name}'`) ||
    message.includes(`"${name}"`);
  const saysAbsent =
    ["PGRST205", "42P01"].includes(errorCodeOf(error)) ||
    message.includes("could not find the table") ||
    (message.includes("relation") && message.includes("does not exist"));
  return namesTable && saysAbsent;
}

/** True only when `table` has no column called `column` — never a column missing somewhere else. */
export function isMissingColumnOfTable(error: unknown, table: string, column: string) {
  const message = lowerErrorMessage(error);
  const t = table.toLowerCase();
  const c = column.toLowerCase();
  return (
    // PostgREST: Could not find the 'crm_id' column of 'employees' in the schema cache (PGRST204)
    message.includes(`'${c}' column of '${t}'`) ||
    // Postgres: column "crm_id" of relation "employees" does not exist (42703)
    message.includes(`column "${c}" of relation "${t}" does not exist`)
  );
}

/** True only when the named database function itself is absent (not a failure inside it). */
export function isMissingFunctionError(error: unknown, fn: string) {
  const message = lowerErrorMessage(error);
  const saysAbsent =
    ["PGRST202", "42883"].includes(errorCodeOf(error)) ||
    message.includes("could not find the function") ||
    (message.includes("function") && message.includes("does not exist"));
  // The name must be the function being CALLED: "could not find the function public.<fn>(" or
  // "function public.<fn>(...) does not exist". A raise inside it ("<fn>: hr_id is required")
  // never says absent; a missing function it calls names that other function.
  return saysAbsent && (message.includes(`function public.${fn.toLowerCase()}(`) || message.includes(`function ${fn.toLowerCase()}(`));
}

function schemaReadinessError(scope: string, error: unknown) {
  const message = resignationErrorMessage(error);
  return new Error(`Missing or outdated resignation schema item while ${scope}: ${message}`);
}

function dateOnly(value: string | null | undefined) {
  const text = cleanText(value);
  return text ? text.slice(0, 10) : null;
}

function firstRelationName(
  relation: { name?: string | null; title?: string | null } | Array<{ name?: string | null; title?: string | null }> | null | undefined,
  key: "name" | "title",
) {
  const row = Array.isArray(relation) ? relation[0] : relation;
  return row?.[key] ?? null;
}

function normalizeEmployeeExitStatus(value: string | null | undefined) {
  const status = cleanText(value)?.toLowerCase() ?? "resigned";
  if (!["resigned", "terminated", "inactive"].includes(status)) {
    throw new Error("Resignation employee status must be resigned, terminated, or inactive.");
  }
  return status;
}

function normalizeSubmittedDate(input: CreateResignationInput) {
  return normalizeDate(input.submittedDate || input.submitted_date) || todayDate();
}

function normalizeLastWorkingDate(input: CreateResignationInput) {
  return (
    normalizeDate(input.lastWorkingDate || input.last_working_date || input.effectiveDate || input.effective_date) ||
    todayDate()
  );
}

// Returns the matched employee's STORED hr_id, never the raw actor string.
// submitted_by_hr_id is a foreign key to employees.hr_id, which is exact/case-sensitive,
// but `actor` arrives lowercased (resolveEmployeeIdentityId -> canonicalHrIdKey) and
// hrIdsMatch is deliberately fuzzy (case, punctuation, aliases). Returning the actor
// therefore wrote "a-16" against a stored "A-16" and every resignation failed the FK.
function resolveSubmittedByHrId(
  actor: string,
  directory: Awaited<ReturnType<typeof getEmployeeDirectory>>,
) {
  return directory.employees.find((employee) => hrIdsMatch(employee.hrId, actor))?.hrId ?? null;
}

function appendWorkflowNote(
  existing: string | null | undefined,
  actor: string,
  action: string,
  note?: string | null,
) {
  const entry = `[${new Date().toISOString()}] ${actor}: ${action}${note ? ` - ${note}` : ""}`;
  return existing ? `${existing}\n${entry}` : entry;
}

/** A workflow record's status: its own, else the lifecycle copy, else submitted. One rule for every read. */
export function resignationRowStatus(row: Pick<ResignationRow, "status" | "exit_status">): ResignationStatus {
  return (cleanText(row.status) ?? cleanText(row.exit_status) ?? "submitted") as ResignationStatus;
}

function mapResignation(row: ResignationRow): ResignationRecord {
  const submittedDate =
    dateOnly(row.submitted_date) ??
    dateOnly(row.resignation_date) ??
    dateOnly(row.created_at) ??
    todayDate();
  const effectiveDate =
    dateOnly(row.effective_date) ??
    dateOnly(row.last_working_date) ??
    submittedDate;
  const status = resignationRowStatus(row);

  return {
    id: row.id,
    employeeHrId: row.employee_hr_id,
    employeeName: row.employee_name,
    employeeStatus: null,
    jobTitle: row.job_title,
    lineName: row.line_name,
    submittedDate,
    effectiveDate,
    reason: row.reason,
    workflowNotes: row.workflow_notes ?? row.notes ?? null,
    status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    createdBy: row.created_by ?? null,
    // Both filled by getResignationsDashboardData, the only read path that resolves them.
    createdByName: null,
    exitCategory: null,
    hireDate: null,
    settlement: null,
    outstandingDevices: [],
    reviewedAt: asIso(row.reviewed_at),
    reviewedBy: row.reviewed_by ?? null,
    approvedAt: asIso(row.approved_at),
    approvedBy: row.approved_by ?? null,
    rejectedAt: asIso(row.rejected_at),
    rejectedBy: row.rejected_by ?? null,
    rejectedReason: row.rejected_reason ?? null,
    completedAt: asIso(row.completed_at),
    completedBy: row.completed_by ?? null,
    cancelledAt: asIso(row.cancelled_at),
    cancelledBy: row.cancelled_by ?? null,
  };
}

function mapPayrollResignationCandidate(row: PayrollResignationCandidateRow): PayrollResignationCandidateRecord {
  return {
    id: row.id,
    areaName: row.area_name,
    createdBy: row.created_by,
    employeeName: row.employee_name,
    firstSeenAt: new Date(row.first_seen_at).toISOString(),
    hireDate: row.hire_date,
    hrId: row.hr_id,
    jobTitle: row.job_title,
    lastPayoutMonth: Number(row.last_payout_month),
    lastPayoutYear: Number(row.last_payout_year),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    lineName: row.line_name,
    nameAr: row.name_ar,
    sourceFileName: row.source_file_name,
    sourceRow: row.source_row === null || row.source_row === undefined ? null : Number(row.source_row),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function mapLegacyResignationEmployee(row: HistoricalResignedEmployeeRow): ResignationRecord {
  const submittedDate =
    dateOnly(row.resignation_date) ??
    dateOnly(row.last_working_date) ??
    dateOnly(row.updated_at) ??
    todayDate();
  const effectiveDate =
    dateOnly(row.last_working_date) ??
    dateOnly(row.resignation_date) ??
    submittedDate;
  const status = cleanText(row.exit_status) === "cancelled" ? "cancelled" : "completed";
  const updatedAt = row.updated_at ? new Date(row.updated_at).toISOString() : new Date(0).toISOString();
  const createdAt = row.created_at ? new Date(row.created_at).toISOString() : updatedAt;

  return {
    approvedAt: null,
    approvedBy: null,
    cancelledAt: status === "cancelled" ? updatedAt : null,
    cancelledBy: null,
    completedAt: status === "completed" ? updatedAt : null,
    completedBy: null,
    createdAt,
    createdBy: null,
    createdByName: null,
    exitCategory: row.exit_category ?? null,
    hireDate: null,
    settlement: null,
    outstandingDevices: [],
    effectiveDate,
    employeeHrId: row.hr_id,
    employeeName: resolveEmployeeDisplayName(row.full_name, row.nickname),
    employeeStatus: row.employment_status ?? null,
    id: `legacy:${row.hr_id}`,
    jobTitle: row.job_title ?? firstRelationName(row.positions, "title"),
    lineName: firstRelationName(row.lines, "name"),
    reason:
      row.exit_reason ??
      `Historical lifecycle status: ${row.employment_status ?? "resigned"}.`,
    rejectedAt: null,
    rejectedBy: null,
    rejectedReason: null,
    reviewedAt: null,
    reviewedBy: null,
    status,
    submittedDate,
    updatedAt,
    workflowNotes: "Compatibility record generated from employee lifecycle data because no resignation workflow record exists.",
  };
}

async function loadHistoricalResignedEmployees(supabase: SupabaseClient) {
  // Compatibility path for databases where the backfill migration has not run yet.
  // It intentionally reads terminal employees directly without changing the active Employees directory.
  const joinedResult = await supabase
    .from("employees")
    .select(
      "hr_id,full_name,nickname,job_title,employment_status,resignation_date,last_working_date,exit_category,exit_reason,exit_status,created_at,updated_at,lines(name),positions(title)",
    )
    .in("employment_status", terminalEmployeeStatuses)
    .order("updated_at", { ascending: false });

  let data: unknown[] | null = joinedResult.data;
  let error = joinedResult.error;

  if (error && (error.message.toLowerCase().includes("relationship") || isMissingSchemaMessage(error))) {
    const fallbackResult = await supabase
      .from("employees")
      .select(
        "hr_id,full_name,nickname,job_title,employment_status,created_at,updated_at",
      )
      .in("employment_status", terminalEmployeeStatuses)
      .order("updated_at", { ascending: false });

    data = fallbackResult.data;
    error = fallbackResult.error;
  }

  if (error) {
    throw schemaReadinessError("loading historical resigned employees from employees", error);
  }

  return (data ?? []) as HistoricalResignedEmployeeRow[];
}

async function notifyResignationWorkflow(
  record: {
    effectiveDate: string;
    employeeHrId: string;
    employeeName: string;
    id?: string;
    status: string;
  },
  title: string,
  tone: "success" | "warning" | "danger" | "neutral" = "warning",
) {
  const actionUrl = record.id
    ? `/admin/approvals-hub?module=resignation&id=${encodeURIComponent(record.id)}`
    : "/admin/approvals-hub?module=resignation";
  // The admin-editable resignation_workflow template renders an employee detail table
  // (Department/Position/Last Working Day) and a "Dear {{managerName}}" greeting. The
  // minimal record passed here lacks those fields, so load the directory row defensively
  // to populate them — a directory failure must never block the resignation notification.
  let resignationDetail: Awaited<ReturnType<typeof getEmployeeDirectoryRows>>[number] | null = null;
  try {
    // includeInactive: by the time this fires the employee is already 'resigned', so the
    // default active-only directory omits them and every template token above degrades to
    // "—"/"Team" — an email about a named person that cannot name their job or manager.
    const directory = await getEmployeeDirectoryRows({ includeInactive: true });
    resignationDetail =
      directory.find((row) => normalizeHrId(row.hrId) === normalizeHrId(record.employeeHrId)) ?? null;
  } catch {
    resignationDetail = null;
  }

  // Who hears about a resignation is an owner decision, not an org-chart inference:
  // Super Admin + Talent Acquisition only (2026-08-09). Resolved from the admin-editable
  // `resignation_workflow_alert` role policy and passed explicitly, so permission_based
  // targets exactly these people instead of inferring an audience from the subject's scope.
  const { recipients: alertRecipients, warnings: alertWarnings } =
    await resolveNotificationPersonRecipients("resignation_workflow_alert", "Resignation workflow recipients");
  if (alertWarnings.length > 0) {
    logError("Resignation workflow recipient resolution warned", {
      labels: { event: "resignation_workflow_recipients_warning", hr_id: record.employeeHrId },
      error: new Error(alertWarnings.join("; ")),
    });
  }
  const moduleOwnerHrIds = alertRecipients.map((recipient) => recipient.hrId).filter(Boolean);
  await raiseApproval(approvalIdentity("resignation", record.status), { via: "notice", notice: {
    actionUrl,
    actorId: "system",
    email: {
      ctaHref: actionUrl,
      ctaLabel: "Review in Action Center",
      employeeHrId: record.employeeHrId,
      metrics: [
        { label: "Employee", value: `${record.employeeName} (${record.employeeHrId})` },
        { label: "Status", value: record.status },
        { label: "Effective date", value: record.effectiveDate },
      ],
      notificationType: "resignation",
      subject: `Phoenix ${title} - ${record.employeeName}`,
      summary: `Resignation workflow for ${record.employeeName} is now ${record.status.replace(/_/g, " ")}.`,
      // Tokens the resignation_workflow template uses but the metric mapping never fills.
      templateContext: {
        date: record.effectiveDate,
        endDate: record.effectiveDate,
        jobTitle: resignationDetail?.jobTitle ?? "—",
        line: resignationDetail?.lineName ?? "—",
        managerName: resignationDetail?.managerName ?? "Team",
      },
      title,
      tone,
    },
    eventType: "workflow_updated",
    message: `Resignation workflow for ${record.employeeName} is now ${record.status.replace(/_/g, " ")}.`,
    metadata: {
      effectiveDate: record.effectiveDate,
      employeeHrId: record.employeeHrId,
      idempotencyKey: `resignation:${record.employeeHrId}:${record.status}:${record.effectiveDate}`,
      moduleOwnerHrIds,
      status: record.status,
    },
    module: "resignations",
    priority: tone === "danger" ? "critical" : "high",
    subjectHrId: record.employeeHrId,
    title,
  } });
}

export function resignationErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return String(error);
}

// Only a genuinely absent table/column/function counts as "schema missing". This used to
// also return true for ANY message merely MENTIONING employee_resignations /
// payroll_resignation_candidates / position_vacancies / the RPC — so a constraint or FK
// violation on those tables was reported to the user as "Resignations schema is not ready",
// pointing at a missing migration that was never missing. A real absent object still matches
// isMissingSchemaMessage ("could not find the table", "relation ... does not exist").
export function isResignationsSchemaMissing(error: unknown) {
  return isMissingSchemaMessage(error);
}

function periodSortValue(month: number, year: number) {
  return year * 100 + month;
}

export async function upsertPayrollResignationCandidates(input: {
  actor: string | null;
  candidates: PayrollResignationCandidate[];
  month: number;
  sourceFileName: string;
  year: number;
}) {
  const candidatesByHrId = new Map<string, PayrollResignationCandidate>();
  input.candidates.forEach((candidate) => {
    const hrId = candidate.hrId.trim();
    if (!hrId) return;
    candidatesByHrId.set(hrId, { ...candidate, hrId });
  });

  const candidates = Array.from(candidatesByHrId.values());
  if (candidates.length === 0) return 0;

  const supabase = getSupabaseAdmin();
  const hrIds = candidates.map((candidate) => candidate.hrId);
  const { data: existingRows, error: existingError } = await supabase
    .from("payroll_resignation_candidates")
    .select("hr_id,last_payout_month,last_payout_year")
    .in("hr_id", hrIds);

  if (existingError) throw existingError;

  const existingByHrId = new Map(
    ((existingRows ?? []) as Array<Record<string, unknown>>).map((row) => [
      String(row.hr_id ?? ""),
      {
        month: Number(row.last_payout_month ?? 0),
        year: Number(row.last_payout_year ?? 0),
      },
    ]),
  );
  const currentPeriod = periodSortValue(input.month, input.year);
  const now = new Date().toISOString();
  const payload = candidates
    .filter((candidate) => {
      const existing = existingByHrId.get(candidate.hrId);
      if (!existing) return true;
      return currentPeriod >= periodSortValue(existing.month, existing.year);
    })
    .map((candidate) => ({
      area_name: candidate.area,
      created_by: input.actor,
      employee_name: candidate.fullName || candidate.hrId,
      hire_date: candidate.hireDate,
      hr_id: candidate.hrId,
      job_title: candidate.jobTitle,
      last_payout_month: input.month,
      last_payout_year: input.year,
      last_seen_at: now,
      line_name: candidate.line,
      name_ar: candidate.nameAr,
      source_file_name: input.sourceFileName,
      source_row: candidate.row,
      updated_at: now,
    }));

  if (payload.length === 0) return 0;

  const { error } = await supabase
    .from("payroll_resignation_candidates")
    .upsert(payload, {
      onConflict: "hr_id",
    });

  if (error) throw error;
  return payload.length;
}

type EmployeeSalaryRow = {
  base_salary: number | null;
  extra_cost_of_living: number | null;
  fuel_allowance: number | null;
  hr_id: string;
  payment_mode: string | null;
};

/**
 * Settlement preview for the resignation month, BEFORE fingerprint, medical insurance and every
 * other deduction (that is what the Resignations page asks for — a clean "what is owed" figure,
 * not the final payslip).
 *
 * Every number comes from the owner-locked engines, none of it is re-derived here:
 *  - computeResignationSettlement is Rule 1 — last working day ≤ 25th pays a Base-only day rate
 *    for the days worked (no ECoL, no Fuel); after the 25th pays Base + ECoL + Fuel in full.
 *  - calculateBasicSalary is the Part-1 anchor (Base × BASIC_SALARY_RATE), taken from the FULL
 *    monthly base, never the prorated one — anchoring on the prorated base applies the 70% twice
 *    and shrinks the split (the bug fixed for PD-0006 on 2026-07-26, documented in
 *    automated-payroll/split.ts freezeFirstPart).
 *
 * The final assignment mirrors split.ts: a one-part employee takes the whole settlement in Part 1;
 * a two-part employee takes min(Basic, total) in Part 1 and the remainder in Part 2.
 */
function buildResignationSettlementPreview(
  salary: EmployeeSalaryRow | null,
  effectiveDate: string,
  /**
   * The employee's own employment status. The exit workflow this preview sits on records dismissals
   * as well as resignations, so the record itself cannot say which kind of departure it is — and a
   * dismissal keeps neither allowance and gets no >25th waiver.
   */
  employmentStatus: string | null,
  /**
   * The employee's hire date. Somebody who joined AND left in the same month is a leaver on every
   * surface, so without this the preview counts from the 1st and shows dues for days before they
   * started. Null for every leaver hired in an earlier month, where the span starts on the 1st.
   */
  hireDate: string | null,
): ResignationSettlementPreview | null {
  if (!salary) return null;

  const baseSalary = Number(salary.base_salary ?? 0);
  if (!Number.isFinite(baseSalary) || baseSalary <= 0) return null;

  const lastWorkingDate = dateOnly(effectiveDate);
  if (!lastWorkingDate) return null;

  const [year, month] = lastWorkingDate.split("-").map(Number);
  if (!year || !month) return null;

  const settlement = computeResignationSettlement({
    baseSalary,
    extraCostOfLiving: Number(salary.extra_cost_of_living ?? 0),
    fuelAllowance: Number(salary.fuel_allowance ?? 0),
    lastWorkingDate,
    isResignation: isResignationEmploymentStatus(employmentStatus),
    hireDate,
    otherAdditions: 0,
    otherDeductions: 0,
    period: { month, year },
  });
  if (!settlement) return null;

  const paymentMode = normalizePayrollPaymentMode(salary.payment_mode);
  const basicSalary = calculateBasicSalary({ baseSalary });
  const total = settlement.netForMonth;
  const firstPart =
    paymentMode === "two_parts" ? Math.min(basicSalary, total) : total;
  const secondPart = Math.round((total - firstPart + Number.EPSILON) * 100) / 100;

  return {
    baseSalary,
    branch: settlement.branch,
    coveredByFirstPart: secondPart <= 0,
    daysWorked: settlement.daysWorked,
    firstPart: Math.round((firstPart + Number.EPSILON) * 100) / 100,
    paymentMode,
    secondPart: Math.max(0, secondPart),
    total,
  };
}

function isCompanyResignationReader(access: AccessContext) {
  return (
    access.scope === "system" ||
    access.scope === "company" ||
    access.role === "Super Admin" ||
    access.role === "CEO" ||
    access.role === "HR Operations" ||
    // The HR Operations Specialist follows every resignation he submits through to the completed
    // cycle (owner, 2026-10-20). Settlement amounts are withheld from her — isSalaryBlindRole.
    access.role === "HR Administration"
  );
}

export async function getResignationsDashboardData(access?: AccessContext): Promise<ResignationDashboardData> {
  const supabase = getSupabaseAdmin();
  // The directory joins the reads below rather than going first: none of them needs it, and on a
  // cold directory cache awaiting it alone was a whole extra wait. A failure still throws.
  const [directory, resignationsResult, candidatesResult, historicalEmployees] = await Promise.all([
    getEmployeeDirectory(),
    supabase
      .from("employee_resignations")
      .select("*")
      .order("effective_date", { ascending: true })
      .order("created_at", { ascending: false }),
    supabase
      .from("payroll_resignation_candidates")
      .select("*")
      .order("last_payout_year", { ascending: false })
      .order("last_payout_month", { ascending: false })
      .order("updated_at", { ascending: false }),
    loadHistoricalResignedEmployees(supabase),
  ]);

  if (resignationsResult.error) throw resignationsResult.error;
  if (candidatesResult.error) throw candidatesResult.error;

  const employeesByHrId = new Map(directory.employees.map((employee) => [normalizeHrId(employee.hrId), employee]));

  // Actor names come straight from `employees`, not from the directory: getEmployeeDirectory()
  // returns 112 rows and excludes PHX-1 and ADMIN-HR (both employment_status='active', so it is
  // NOT an active/inactive filter). Those two authored 32 of the 38 production records, so
  // resolving through the directory left the audit column printing "phx-1" — the raw-code display
  // the owner's rule forbids. One extra round trip, scoped to the ids actually referenced.
  // One lookup covering BOTH the actors (created_by) and the subjects (employee_hr_id): the
  // subjects are resigned by definition, so the active directory omits them too and their hire
  // date would come back null for nearly every row.
  const referencedHrIds = Array.from(
    new Set(
      (resignationsResult.data ?? [])
        .flatMap((row) => [(row as ResignationRow).created_by, (row as ResignationRow).employee_hr_id])
        .filter((value): value is string => Boolean(value && value.trim()))
        .flatMap((value) => [value, value.toUpperCase()]),
    ),
  );
  const actorNameByHrId = new Map<string, string>();
  const hireDateByHrId = new Map<string, string | null>();
  const salaryByHrId = new Map<string, EmployeeSalaryRow>();

  const mappedResignations = (resignationsResult.data ?? []).map((row) =>
    mapResignation(row as ResignationRow),
  );

  // The people lookup and the device register below are independent reads, so they run side by
  // side rather than one after the other. Neither throws: a failed people read leaves the names,
  // hire dates and salaries blank exactly as before, and the device read never throws (see below).
  const [employeeLookup, outstandingDevicesByHrId] = await Promise.all([
    referencedHrIds.length > 0
      ? supabase
          .from("employees")
          .select(
            "hr_id, full_name, nickname, hire_date, base_salary, extra_cost_of_living, fuel_allowance, payment_mode",
          )
          .in("hr_id", referencedHrIds)
      : null,
    /**
     * What each leaver still holds, in ONE query for the whole page.
     *
     * Read here rather than inside the map because the map is synchronous and because a per-row
     * lookup would be one round trip per resignation. It never throws — see
     * `getOutstandingDevicesByEmployee`: this page is how somebody finds out a person left at all,
     * and it must render whether or not the device register answers.
     */
    getOutstandingDevicesByEmployee(mappedResignations.map((record) => record.employeeHrId)),
  ]);

  if (employeeLookup) {
    const { data: employeeRows } = employeeLookup;
    for (const entry of employeeRows ?? []) {
      const row = entry as EmployeeSalaryRow & {
        full_name: string | null;
        hire_date: string | null;
        nickname: string | null;
      };
      const key = normalizeHrId(row.hr_id);
      if (!key) continue;
      actorNameByHrId.set(key, resolveEmployeeDisplayName(row.full_name ?? row.hr_id, row.nickname));
      hireDateByHrId.set(key, dateOnly(row.hire_date));
      salaryByHrId.set(key, row);
    }
  }

  const scopedAccess = access ?? systemAccessContext;
  // THE SEAT THAT NEVER SEES A SALARY follows every resignation to the completed cycle and is shown
  // no money on the way (owner, 2026-10-20). Withheld HERE, where the data leaves the server, so
  // every caller of this read — the page, the API, the command centres, the approvals hub — carries
  // the same nulls: no settlement preview (it is built from the base salary and allowances) and no
  // signed value on a device still held. `settlementWithheld` tells the screen to say so in words,
  // never to print a zero or a dash that reads like "nothing is owed".
  const settlementWithheld = isSalaryBlindRole(scopedAccess.role);

  const allWorkflowRecords = mappedResignations.map((record) => {
    const outstandingDevices =
      outstandingDevicesByHrId.get(String(record.employeeHrId ?? "").trim().toLowerCase()) ?? [];
    return {
      ...record,
      createdByName: record.createdBy
        ? actorNameByHrId.get(normalizeHrId(record.createdBy) ?? "") ?? null
        : null,
      hireDate: hireDateByHrId.get(normalizeHrId(record.employeeHrId) ?? "") ?? null,
      settlement: settlementWithheld
        ? null
        : buildResignationSettlementPreview(
            salaryByHrId.get(normalizeHrId(record.employeeHrId) ?? "") ?? null,
            record.effectiveDate,
            employeesByHrId.get(normalizeHrId(record.employeeHrId))?.employmentStatus ?? record.employeeStatus ?? null,
            hireDateByHrId.get(normalizeHrId(record.employeeHrId) ?? "") ?? null,
          ),
      // Beside the settlement, because the custody receipt says final dues follow the return.
      outstandingDevices: settlementWithheld
        ? outstandingDevices.map((device) => ({ ...device, agreedValueEgp: null }))
        : outstandingDevices,
      employeeStatus: employeesByHrId.get(normalizeHrId(record.employeeHrId))?.employmentStatus ?? record.employeeStatus ?? null,
    };
  });
  const workflowRecords = isCompanyResignationReader(scopedAccess)
    ? allWorkflowRecords
    : allWorkflowRecords.filter((record) => {
        const employee = employeesByHrId.get(normalizeHrId(record.employeeHrId));
        return employee ? canSeeEmployee(scopedAccess, employee) : false;
      });
  const workflowHrIds = new Set(workflowRecords.map((record) => normalizeHrId(record.employeeHrId)));

  // Legacy/compatibility records must obey the SAME scope rule as the workflow records above.
  // They previously did not, which leaked in two ways for any non-company reader: every past
  // leaver's name appeared regardless of scope, and — worse — an employee whose workflow record
  // had just been filtered out was absent from workflowHrIds, so their exit resurfaced here as a
  // legacy row. That made the filter above bypassable rather than merely incomplete. It was
  // unreachable in practice only because resignations:read is held solely by Super Admin, CEO and
  // Talent Acquisition, all of whom isCompanyResignationReader short-circuits — masked by the
  // narrow grant, not by any scoping. Keep this before widening resignations:read.
  //
  // Checked against that warning on 2026-08-10, when the owner granted resignations:["read"] to the
  // Finance Manager: the widening is safe for exactly the stated reason. scopeForRole returns
  // "company" for that role, so isCompanyResignationReader short-circuits on him too and he never
  // reaches the fallback below. The unsafe widening remains a grant to a role whose scope is NOT
  // company — that role would land in canSeeEmployee here, which is the path this guard protects.
  const canSeeLegacyResignation = (hrId: string) => {
    if (isCompanyResignationReader(scopedAccess)) return true;
    // loadHistoricalResignedEmployees selects no manager_hr_id, so prefer the directory row that
    // carries the real manager chain. The manager-less stand-in still lets canSeeEmployee match
    // the viewer's own hrId (an employee keeps seeing their own exit record), while a
    // manager-of-report relationship we cannot prove fails closed.
    const directoryRow = employeesByHrId.get(normalizeHrId(hrId));
    return canSeeEmployee(scopedAccess, directoryRow ?? { hrId, managerHrId: null });
  };

  const legacyRecords = historicalEmployees
    .filter((employee) => !workflowHrIds.has(normalizeHrId(employee.hr_id)))
    .filter((employee) => canSeeLegacyResignation(employee.hr_id))
    .map(mapLegacyResignationEmployee);
  const records = [...workflowRecords, ...legacyRecords].sort((left, right) => {
    const dateCompare = right.submittedDate.localeCompare(left.submittedDate);
    return dateCompare || left.employeeName.localeCompare(right.employeeName);
  });
  const payrollCandidates = (candidatesResult.data ?? []).map((row) => {
    const candidate = mapPayrollResignationCandidate(row as PayrollResignationCandidateRow);
    return {
      ...candidate,
      employeeName: employeesByHrId.get(normalizeHrId(candidate.hrId))?.displayName ?? candidate.employeeName,
    };
  });
  const employees = directory.employees
    .map((employee) => ({
      jobTitle: employee.positionTitle ?? employee.jobTitle ?? null,
      label: `${employee.displayName} (${employee.hrId})`,
      lineName: employee.lineName ?? null,
      value: employee.hrId,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));

  const summary = {
    active: records.filter((record) => ["submitted", "under_review", "approved"].includes(record.status)).length,
    approved: records.filter((record) => record.status === "approved").length,
    completed: records.filter((record) => record.status === "completed").length,
    payrollCandidates: payrollCandidates.length,
    pending: records.filter((record) => ["submitted", "under_review"].includes(record.status)).length,
    total: records.length,
  };

  return { employees, payrollCandidates, records, settlementWithheld, summary };
}

/**
 * Whose workflow resignations this viewer may see, and the status of each — the sidebar badge's
 * read (countAwaitingMyActionItems), and nothing more.
 *
 * WHY (31 Oct 2026, the owner's "lighter inbox count"). The badge used to read the whole dashboard
 * above for a number: every column of every resignation, every payroll leaver candidate, every
 * historical leaver, a people lookup and the device register — about ten Supabase requests on every
 * badge refresh of every HR, finance and management seat, to count the one or two requests still
 * waiting. This reads the directory (served from its process-wide cache) and three columns of one
 * table.
 *
 * 🔴 THE SAME SCOPE AS THE DASHBOARD, LINE FOR LINE: a company reader sees every record; anyone
 * else sees a record only when its employee is in the directory and canSeeEmployee admits them.
 * tests/badge-counts-viewer-cache.test.ts holds the two bodies to the same lines. The historical
 * leavers the dashboard adds are completed or cancelled by construction, so no count could ever
 * include one, and they are not read.
 */
export async function listVisibleResignationStatuses(
  access?: AccessContext,
): Promise<Array<{ employeeHrId: string; status: ResignationStatus }>> {
  const supabase = getSupabaseAdmin();
  const [directory, resignationsResult] = await Promise.all([
    getEmployeeDirectory(),
    supabase.from("employee_resignations").select("employee_hr_id, status, exit_status"),
  ]);
  if (resignationsResult.error) throw resignationsResult.error;

  const employeesByHrId = new Map(directory.employees.map((employee) => [normalizeHrId(employee.hrId), employee]));
  const scopedAccess = access ?? systemAccessContext;
  const rows = (resignationsResult.data ?? []) as Array<Pick<ResignationRow, "employee_hr_id" | "status" | "exit_status">>;
  const visibleRows = isCompanyResignationReader(scopedAccess)
    ? rows
    : rows.filter((row) => {
        const employee = employeesByHrId.get(normalizeHrId(row.employee_hr_id));
        return employee ? canSeeEmployee(scopedAccess, employee) : false;
      });
  return visibleRows.map((row) => ({ employeeHrId: row.employee_hr_id, status: resignationRowStatus(row) }));
}

/**
 * Submitter-side view: the resignation request(s) the caller filed themselves.
 * Used by the consolidated Actions "My requests" tab. Scoped strictly to the
 * caller's own HR_ID — never surfaces another employee's resignation.
 */
export async function getMyResignations(access: AccessContext): Promise<ResignationRecord[]> {
  const hrId = access.hrId?.trim();
  if (!hrId) return [];
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("employee_resignations")
    .select("*")
    .eq("employee_hr_id", hrId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row) => mapResignation(row as ResignationRow));
}

async function assertResignationRuntimeSchema(
  supabase: SupabaseClient,
  options: { requireVacancies?: boolean } = {},
) {
  const checks = [
    {
      label: "employees.hr_id/full_name/employment_status",
      query: supabase
        .from("employees")
        .select("hr_id,full_name,nickname,employment_status")
        .limit(1),
    },
    ...(options.requireVacancies
      ? [
          {
            label: "position_vacancies core columns",
            query: supabase
              .from("position_vacancies")
              .select("id,vacancy_code,status")
              .limit(1),
          },
        ]
      : []),
  ];

  for (const check of checks) {
    const { error } = await check.query;
    if (error) {
      throw schemaReadinessError(`checking ${check.label}`, error);
    }
  }

  const modernResignationSchema = await supabase
    .from("employee_resignations")
    .select("id,employee_hr_id,employee_name,submitted_date,effective_date,status")
    .limit(1);
  if (!modernResignationSchema.error) {
    return;
  }

  const legacyResignationSchema = await supabase
    .from("employee_resignations")
    .select("id,employee_hr_id,resignation_date,last_working_date,exit_status")
    .limit(1);
  if (!legacyResignationSchema.error) {
    return;
  }

  throw schemaReadinessError("checking employee_resignations modern/legacy columns", modernResignationSchema.error);
}

async function insertResignationRecord(
  supabase: SupabaseClient,
  input: {
    actor: string;
    effectiveDate: string;
    employee: DirectoryEmployee;
    reason: string | null;
    submittedByHrId: string | null;
    submittedDate: string;
    workflowNotes: string | null;
    vacancyId?: number | null;
  },
) {
  const now = new Date().toISOString();
  const workflowNotes = appendWorkflowNote(
    null,
    input.actor,
    "submitted resignation",
    input.workflowNotes,
  );
  const basePayload = {
    created_at: now,
    created_by: input.actor,
    effective_date: input.effectiveDate,
    employee_hr_id: input.employee.hrId,
    employee_name: input.employee.fullName,
    job_title: input.employee.positionTitle ?? input.employee.jobTitle ?? null,
    line_name: input.employee.lineName ?? null,
    reason: input.reason,
    status: "submitted" as const,
    submitted_date: input.submittedDate,
    updated_at: now,
    workflow_notes: workflowNotes,
  };
  const payload: Record<string, unknown> = {
    ...basePayload,
    create_vacancy: Boolean(input.vacancyId),
    exit_status: "submitted" as const,
    last_working_date: input.effectiveDate,
    notes: input.workflowNotes ?? input.reason,
    resignation_date: input.submittedDate,
    submitted_by_hr_id: input.submittedByHrId,
    vacancy_id: input.vacancyId ?? null,
  };
  const optionalColumns = [
    "create_vacancy",
    "effective_date",
    "exit_status",
    "notes",
    "resignation_date",
    "submitted_by_hr_id",
    "submitted_date",
    "vacancy_id",
    "workflow_notes",
  ];

  for (let attempt = 0; attempt <= optionalColumns.length; attempt++) {
    const { data, error } = await supabase
      .from("employee_resignations")
      .insert(payload)
      .select("id")
      .single();

    if (!error) {
      return String((data as { id: string }).id);
    }

    const missingColumn = missingColumnFromError(error, optionalColumns);
    if (missingColumn) {
      delete payload[missingColumn];
      continue;
    }

    throw schemaReadinessError("writing employee_resignations", error);
  }

  throw new Error("Unable to insert resignation after removing unsupported optional columns.");
}

async function insertFallbackVacancy(
  supabase: SupabaseClient,
  employee: DirectoryEmployee,
  effectiveDate: string,
  vacancyCode: string,
) {
  const now = new Date().toISOString();
  const payload = {
    area_id: employee.areaId,
    created_at: now,
    department_id: employee.departmentId,
    job_title: employee.jobTitle ?? employee.positionTitle ?? null,
    line_id: employee.lineId,
    manager_hr_id: employee.managerHrId,
    manager_name: employee.managerName ?? null,
    note: `Auto-opened from resignation of ${employee.fullName} (${employee.hrId}). Effective ${effectiveDate}.`,
    position_id: employee.positionId,
    region_name: employee.regionName ?? null,
    replacement_for_hr_id: employee.hrId,
    status: "open",
    updated_at: now,
    vacancy_code: vacancyCode,
  };

  const fullResult = await supabase
    .from("position_vacancies")
    .insert(payload)
    .select("id")
    .single();

  if (!fullResult.error) {
    return Number((fullResult.data as { id: number }).id);
  }

  if (!isMissingSchemaMessage(fullResult.error)) {
    throw fullResult.error;
  }

  const minimalResult = await supabase
    .from("position_vacancies")
    .insert({
      job_title: payload.job_title,
      status: "open",
      updated_at: now,
      vacancy_code: vacancyCode,
    })
    .select("id")
    .single();

  if (minimalResult.error) {
    throw schemaReadinessError("writing position_vacancies", minimalResult.error);
  }

  return Number((minimalResult.data as { id: number }).id);
}

async function ensureResignationVacancyOwnership(
  supabase: SupabaseClient,
  employee: DirectoryEmployee,
  vacancyCode: string,
) {
  const cleanVacancyCode = String(vacancyCode ?? "").trim();
  if (!cleanVacancyCode) {
    return;
  }

  const now = new Date().toISOString();
  const fullPayload = {
    manager_hr_id: employee.managerHrId,
    manager_name: employee.managerName ?? null,
    replacement_for_hr_id: employee.hrId,
    updated_at: now,
  };

  const fullResult = await supabase
    .from("position_vacancies")
    .update(fullPayload)
    .eq("vacancy_code", cleanVacancyCode);

  if (!fullResult.error) {
    return;
  }

  if (!isMissingSchemaMessage(fullResult.error)) {
    throw fullResult.error;
  }

  const fallbackResult = await supabase
    .from("position_vacancies")
    .update({
      manager_hr_id: employee.managerHrId,
      manager_name: employee.managerName ?? null,
      updated_at: now,
    })
    .eq("vacancy_code", cleanVacancyCode);

  if (fallbackResult.error && !isMissingSchemaMessage(fallbackResult.error)) {
    throw fallbackResult.error;
  }
}

async function updateEmployeeLifecycleFallback(
  supabase: SupabaseClient,
  employeeHrId: string,
  input: {
    effectiveDate: string;
    employeeStatus: string;
    reason: string | null;
    submittedDate: string;
  },
  // strict (the Complete action only): drop an optional column ONLY when `employees` genuinely
  // lacks it, and fail when no employee row was written. The other callers keep the old tolerance.
  options?: { strict?: boolean },
) {
  const strict = options?.strict === true;
  const optionalColumns = [
    "exit_reason",
    "exit_status",
    "last_working_date",
    "organogram_visible",
    "payroll_eligible",
    "resignation_date",
    "crm_id",
  ];
  const payload: Record<string, unknown> = {
    employment_status: input.employeeStatus,
    exit_reason: input.reason,
    exit_status: "submitted",
    last_working_date: input.effectiveDate,
    organogram_visible: false,
    payroll_eligible: false,
    resignation_date: input.submittedDate,
    // A leaver releases their CRM SLOT so the replacement hire can inherit it (owner rule,
    // 2026-08-05). employees_crm_id_unique_idx is unique across ALL employees regardless of
    // employment_status, and the employee-import validator maps crm_id -> hr_id with no
    // active-only filter (unlike the org-seat map beside it), so a leaver who kept it blocked
    // their own successor's master import with "CRM ID 1399 is already assigned to HR_ID B-97".
    // 30 leavers were holding one.
    crm_id: null,
    // crm_username is deliberately NOT cleared. It used to be, and that silently destroyed visit
    // attribution: the CRM sync stamps agent_hr_id ONCE at sync time via override -> crm_id ->
    // crm_username, and the mirror runs a day or more behind the visit date, so clearing both
    // automatic tiers on resignation day turned every not-yet-synced visit — including ones the
    // person genuinely performed while still employed — into a permanent NULL. Measured on
    // production 2026-08-09: all 56 departed employees had crm_username NULL, stranding 587
    // visits dated on or before their own last working day. It also made isAttributableOn()'s
    // escape hatch unreachable — that guard allows a post-exit row only when the record carries
    // the employee's own CRM label, and the label it compares against IS crm_username.
    // Keeping it does not reintroduce the import conflict above: a replacement inherits the
    // numeric slot under their OWN display name (see slots 1102/1395/1399, each carrying two
    // people's names in their history), so employees_crm_username_unique_idx only fires if one
    // person's exact CRM name is handed to somebody else — which should be refused anyway.
    updated_at: new Date().toISOString(),
  };

  for (let attempt = 0; attempt <= optionalColumns.length; attempt++) {
    const query = supabase
      .from("employees")
      .update(payload)
      .eq("hr_id", employeeHrId);
    const { data, error }: { data: unknown; error: unknown } = strict ? await query.select("hr_id") : await query;

    if (!error) {
      // An UPDATE that matched nobody is not an error to PostgREST, and the employee would stay
      // active and on payroll while the resignation went on to read "completed".
      if (strict && (!Array.isArray(data) || data.length === 0)) {
        throw new Error(`No employee record matched ${employeeHrId}, so nobody was taken off payroll.`);
      }
      return;
    }

    const missingColumn = optionalColumns.find((column) =>
      strict ? isMissingColumnOfTable(error, "employees", column) : isMissingColumn(error, column),
    );
    if (missingColumn) {
      delete payload[missingColumn];
      continue;
    }

    throw schemaReadinessError("updating employees lifecycle columns", error);
  }

  throw new Error("Unable to update employee lifecycle after removing unsupported optional columns.");
}

async function normalizeTerminalEmployeeLifecycleFlags(
  supabase: SupabaseClient,
  employeeHrId: string,
) {
  const { error: rpcError } = await supabase.rpc(
    "phx_normalize_terminal_employee_lifecycle_flags",
    { p_employee_hr_id: employeeHrId },
  );

  if (rpcError && !isMissingSchemaMessage(rpcError)) {
    throw schemaReadinessError("normalizing terminal employee lifecycle flags", rpcError);
  }

  if (rpcError) {
    const { error } = await supabase
      .from("employees")
      .update({
        organogram_visible: false,
        payroll_eligible: false,
        updated_at: new Date().toISOString(),
      })
      .eq("hr_id", employeeHrId)
      .in("employment_status", ["resigned", "terminated", "inactive"]);

    if (error && !isMissingSchemaMessage(error)) {
      throw schemaReadinessError("normalizing terminal employee lifecycle flags", error);
    }
  }
}

// Closes the departing employee's au occupancy span(s), which is what makes the organogram
// stop showing them on their seat and lets the area fall back to 'vacant_will_hire'.
//
// The Employees-page path gets this for free — it is step 5 of
// phx_resign_employee_and_open_vacancy, inside that RPC's transaction. The Approvals Hub
// path cannot reuse that RPC (it would insert a SECOND employee_resignations row and a
// second vacancy for a resignation that already has both), so it calls the extracted
// step-5-only wrapper instead. The au schema is not exposed on PostgREST and no TypeScript
// in src/ touches it directly, so the wrapper is the only route in.
//
// The wrapper is a no-op returning vacated_count: 0 when the employee holds no open seat,
// so re-completing an already-terminated employee is harmless. A genuinely failing call
// throws, exactly like the two lifecycle helpers it runs beside — leaving a departed person
// visibly occupying a seat is not something to swallow silently.
async function vacateAuSeatsIfSupported(
  supabase: SupabaseClient,
  employeeHrId: string,
  input: { actor: string; effectiveDate: string | null; reason: string | null },
) {
  const { error } = await supabase.rpc("phx_vacate_au_seats_for_employee", {
    p_actor: input.actor,
    p_effective_date: input.effectiveDate,
    p_employee_hr_id: employeeHrId,
    p_reason: input.reason,
  });

  // Tolerated ONLY when the wrapper itself is absent (PGRST202 / 42883 naming it), so an
  // environment without the migration degrades instead of failing the whole workflow. It used to
  // tolerate anything isMissingSchemaMessage matched, which includes a 42703 raised INSIDE the
  // function (the failure that broke every move onto an area seat on 2026-11-04) — a person left
  // sitting in their seat while the resignation read "completed". This helper's only caller is
  // the Complete action.
  if (error && !isMissingFunctionError(error, "phx_vacate_au_seats_for_employee")) {
    throw schemaReadinessError("vacating au seats for the departing employee", error);
  }
}

/**
 * Switches off the leaver's access — but only once their departure has actually TAKEN EFFECT.
 *
 * WHY THE DATE. This used to run unconditionally at the moment the exit was FILED, and HR files
 * exits in advance, so it locked people out while they were still working. On 2026-08-30 A-16
 * could not sign in with a 2026-08-31 last working day: nine failed logins, HR re-activating her
 * account by hand at 09:55:18 Cairo, two password resets and a password setup inside four minutes,
 * none of which could work. Dating this is what stops HR ever having to do that again.
 *
 * DEFERRING IS SAFE, and specifically it does not open a window. From the last working day onward
 * the auth gate refuses both login and session on employment_status regardless of `is_active`
 * (src/lib/auth/session-lifecycle.ts — the SAME rule this calls, so the two cannot drift), and the
 * daily leaver sweep flips the flag once the day arrives. The flag can only ever lag the block.
 *
 * THE MAILBOX TASK IS NOT DATED and is opened either way: it is a work item for the offboarding
 * desk, not an access revocation, and opening it the moment the exit is known is what lets the desk
 * prepare. The daily sweep is what judges it overdue, and it already keys that on the last working
 * day.
 *
 * Returns whether the access flips actually ran, so a caller can say which of the two happened.
 */
async function deactivateEmployeeAccessIfSupported(
  supabase: SupabaseClient,
  employeeHrId: string,
  departure: { effectiveDate: string | null; employeeStatus: string | null },
  // strict (the Complete action only): skip a table ONLY when it genuinely does not exist. The
  // old tolerance (any message isMissingSchemaMessage matches) stays for the other callers.
  options?: { strict?: boolean },
): Promise<{ revoked: boolean }> {
  const tolerated = (error: unknown, table: string) =>
    options?.strict === true ? isMissingTableError(error, table) : isMissingSchemaMessage(error);
  const revoked = isEmploymentAccessRevoked({
    employmentStatus: departure.employeeStatus,
    lastWorkingDate: departure.effectiveDate,
    todayCairo: currentCairoDateOnlyIso(),
  });

  if (revoked) {
    const appAuthResult = await supabase
      .from("app_auth_users")
      .update({
        is_active: false,
        updated_at: new Date().toISOString(),
      })
      .eq("hr_id", employeeHrId);

    if (appAuthResult.error && !tolerated(appAuthResult.error, "app_auth_users")) {
      throw appAuthResult.error;
    }

    const accessProfileResult = await supabase
      .from("user_access_profiles")
      .update({
        is_active: false,
        updated_at: new Date().toISOString(),
      })
      .eq("hr_id", employeeHrId);

    if (accessProfileResult.error && !tolerated(accessProfileResult.error, "user_access_profiles")) {
      throw accessProfileResult.error;
    }

    await disableTelegramForIdentity({
      actorLoginId: "system",
      hrId: employeeHrId,
      reason: "Employee resigned, terminated, or deactivated.",
    });
  }

  await openMailboxRevocationTaskBestEffort(employeeHrId);
  return { revoked };
}

/**
 * Opens the leaver's Turbify mailbox revocation task.
 *
 * BEST-EFFORT ON PURPOSE, and swallowed: a mailbox task must never be the reason a resignation
 * fails to record. A resignation that does not save is a payroll
 * and headcount problem within the hour; a mailbox task that does not open is caught by the daily
 * sweep, which exists precisely because this call is allowed to fail quietly.
 *
 * That is also why the failure is LOGGED rather than merely ignored — a swallowed exception with
 * no log is indistinguishable from "this employee had no mailbox", which is a normal outcome here.
 */
async function openMailboxRevocationTaskBestEffort(employeeHrId: string) {
  try {
    await openMailboxOffboardingTask(employeeHrId, "system:resignation", "resignation");
  } catch (error) {
    logError("Mailbox revocation task could not be opened for a leaver", {
      labels: { event: "mailbox_offboarding_open_failed", employeeHrId },
      error,
    });
  }
}

/**
 * Reads back the open vacancy the vacated seat already has, if any.
 *
 * Status is normalized exactly the way the SQL guard normalizes it —
 * `lower(coalesce(status, 'open')) = 'open'` — so a row with a NULL or differently-cased status
 * is still recognized as open. Getting that wrong reads as "this seat has no vacancy" and makes
 * the caller open a second one.
 */
async function findOpenVacancyForSeat(
  supabase: SupabaseClient,
  employeeHrId: string,
): Promise<{ resolved: boolean; vacancyId: number | null }> {
  const { data, error } = await supabase
    .from("position_vacancies")
    .select("id, status")
    .eq("replacement_for_hr_id", employeeHrId)
    .order("created_at", { ascending: true })
    .limit(50);

  if (error) {
    // Fail CLOSED. The caller's only response to "no vacancy exists" is to open one, so a read
    // that did not actually complete must never be reported as an empty result. Unresolved is
    // reserved for the vacancy table (or its seat column) genuinely not existing; any other
    // failure throws, so completing a resignation stops instead of skipping the link silently.
    if (
      isMissingTableError(error, "position_vacancies") ||
      isMissingColumnOfTable(error, "position_vacancies", "replacement_for_hr_id")
    ) {
      return { resolved: false, vacancyId: null };
    }
    throw error;
  }

  const rows = (data ?? []) as Array<{ id: number; status?: string | null }>;
  const open = rows.find((candidate) => (cleanText(candidate.status) ?? "open").toLowerCase() === "open");
  return { resolved: true, vacancyId: open ? Number(open.id) : null };
}

/**
 * Points a just-completed resignation at the open vacancy for the seat it vacated.
 *
 * It deliberately does NOT open a vacancy in the normal case. Completing a resignation writes the
 * employee's terminal lifecycle row, and that UPDATE fires the `phx_employee_terminal_vacancy_guard`
 * trigger (AFTER UPDATE OF employment_status, ... ON public.employees), which runs
 * `phx_ensure_terminal_employee_vacancy`: it adopts the seat's existing open vacancy if there is
 * one and otherwise opens exactly one `VAC-TERM-…` row. By the time control returns here the
 * vacancy already exists, so an unconditional insert would leave the seat with TWO open vacancies —
 * and because the two paths mint different codes (`vacancyCodeFromEmployee` vs `VAC-TERM-…`), the
 * unique index on `vacancy_code` would not catch the duplicate either.
 *
 * What the guard cannot do is link the record: it only touches `position_vacancies`. A resignation
 * raised through createResignation carries `vacancy_id = null` / `create_vacancy = false` (only
 * resignEmployeeAndOpenVacancy ever set them), and employee-directory's `replacementForVacancy`
 * resolves "who does this vacancy replace" through exactly that column. So read the vacancy back
 * and stamp it.
 *
 * The insert below is the last resort for an environment where the guard trigger is not installed,
 * and it only runs once a completed read has PROVEN the seat has no open vacancy.
 */
async function linkCompletedResignationVacancy(
  supabase: SupabaseClient,
  input: {
    effectiveDate: string;
    employee: DirectoryEmployee | null;
    employeeHrId: string;
    resignationId: string;
    resignationVacancyId: number | null;
  },
) {
  // Already linked — the Employees-page path opened and recorded this vacancy at submit time.
  if (input.resignationVacancyId) return;

  const lookup = await findOpenVacancyForSeat(supabase, input.employeeHrId);
  if (!lookup.resolved) return;

  let vacancyId = lookup.vacancyId;
  if (!vacancyId) {
    // No open vacancy and the read proved it: the guard trigger is absent here. Open one using the
    // same code convention and insert path the Employees-page fallback uses.
    if (!input.employee) return;
    vacancyId = await insertFallbackVacancy(
      supabase,
      input.employee,
      input.effectiveDate,
      vacancyCodeFromEmployee(input.employeeHrId, input.effectiveDate),
    );
  }

  // No `updated_at` here, on purpose: this runs BEFORE the row is stamped completed, and that
  // final stamp is optimistic-locked on the updated_at read at the start. Bumping it here would
  // make every Complete fail its own lock. The stamp sets updated_at a moment later.
  const { error } = await supabase
    .from("employee_resignations")
    .update({
      create_vacancy: true,
      vacancy_id: vacancyId,
    })
    .eq("id", input.resignationId);

  // Tolerated only when one of the two link columns genuinely does not exist. It used to swallow
  // any error MENTIONING them — a foreign-key violation on vacancy_id included.
  if (
    error &&
    !isMissingColumnOfTable(error, "employee_resignations", "create_vacancy") &&
    !isMissingColumnOfTable(error, "employee_resignations", "vacancy_id")
  ) {
    throw error;
  }
}

async function resignEmployeeWithFallback(
  supabase: SupabaseClient,
  input: {
    actor: string;
    effectiveDate: string;
    employee: DirectoryEmployee;
    employeeStatus: string;
    reason: string | null;
    submittedByHrId: string | null;
    submittedDate: string;
    vacancyCode: string;
    workflowNotes: string | null;
  },
) {
  // Fallback is intentionally non-RPC for environments where the migration has not been applied.
  // Keep it conservative and schema-tolerant, then rely on the migration/RPC for transactionality.
  await assertResignationRuntimeSchema(supabase, { requireVacancies: true });
  const vacancyId = await insertFallbackVacancy(
    supabase,
    input.employee,
    input.effectiveDate,
    input.vacancyCode,
  );
  const resignationId = await insertResignationRecord(supabase, {
    actor: input.actor,
    effectiveDate: input.effectiveDate,
    employee: input.employee,
    reason: input.reason,
    submittedByHrId: input.submittedByHrId,
    submittedDate: input.submittedDate,
    vacancyId,
    workflowNotes: input.workflowNotes,
  });

  await updateEmployeeLifecycleFallback(supabase, input.employee.hrId, {
    effectiveDate: input.effectiveDate,
    employeeStatus: input.employeeStatus,
    reason: input.reason,
    submittedDate: input.submittedDate,
  });
  await deactivateEmployeeAccessIfSupported(supabase, input.employee.hrId, {
    effectiveDate: input.effectiveDate,
    employeeStatus: input.employeeStatus,
  });

  return {
    employeeHrId: input.employee.hrId,
    employeeStatus: input.employeeStatus,
    resignationId,
    usedFallback: true,
    vacancyCode: input.vacancyCode,
  };
}

export async function createResignation(
  input: CreateResignationInput,
  actor: string,
  access?: AccessContext,
) {
  const employeeHrId = String(input.employeeHrId ?? "").trim();
  const submittedDate = normalizeSubmittedDate(input);
  const effectiveDate = normalizeLastWorkingDate(input);

  if (!employeeHrId) throw new Error("Employee HR ID is required.");

  if (effectiveDate < submittedDate) {
    throw new Error("Effective resignation date cannot be before the submitted date.");
  }

  const directory = await getEmployeeDirectory();
  const employee = directory.employees.find((item) => hrIdsMatch(item.hrId, employeeHrId));
  if (!employee) throw new Error("Employee was not found in the directory.");

  return createResignationForEmployee({
    ...input,
    submittedDate,
    effectiveDate,
  }, actor, employee, access);
}

async function createResignationForEmployee(
  input: CreateResignationInput,
  actor: string,
  employee: DirectoryEmployee,
  access?: AccessContext,
) {
  const submittedDate = normalizeSubmittedDate(input);
  const effectiveDate = normalizeLastWorkingDate(input);
  const directory = await getEmployeeDirectory();
  const submittedByHrId = resolveSubmittedByHrId(actor, directory);
  const supabase = getSupabaseAdmin();
  await assertResignationWorkflowTransition({
    access,
    action: "submit",
    expectedNextStatus: "resignation_submitted",
    status: "new",
  });

  // Scope guard — deliberately mirrors resignEmployeeAndOpenVacancy below. This path takes
  // the target employee from the caller-supplied payload rather than the URL, so without
  // this a role holding resignations:create could submit a resignation for ANY employee,
  // including one far outside their own chain. It was survivable only because that grant
  // has been limited to Super Admin / Talent Acquisition, both of whom canSeeEmployee
  // already passes company-wide — the missing check was masked by the narrow grant, not
  // by any actual scoping. Keep this in place before widening resignations:create.
  const scopedAccess = access ?? systemAccessContext;
  if (!canSeeEmployee(scopedAccess, employee)) {
    throw new Error(`Forbidden: ${scopedAccess.role} cannot access employee ${employee.hrId}.`);
  }

  const resignationId = await insertResignationRecord(supabase, {
    actor,
    effectiveDate,
    employee,
    reason: cleanText(input.reason),
    submittedByHrId,
    submittedDate,
    workflowNotes: cleanText(input.workflowNotes),
  });

  // After the reply (afterResponse): the resignation is saved, and the notice used to be awaited before
  // the answer left — a directory read, the recipient lookup and the fan-out. A failed notice is logged,
  // never thrown (it used to turn a saved resignation into a false 500).
  await afterResponse("resignation_notice:submitted", async () => {
    await notifyResignationWorkflow(
      {
        effectiveDate,
        employeeHrId: employee.hrId,
        employeeName: employee.displayName,
        id: resignationId,
        status: "submitted",
      },
      "Resignation Submitted",
      "warning",
    );
  });
  invalidateExecutiveDashboardCache("resignation workflow created", ["resignations"]);
  return resignationId;
}

function vacancyCodeFromEmployee(hrId: string, effectiveDate: string) {
  return generateShortVacancyCode({
    parts: [effectiveDate],
    primary: hrId,
  });
}

export async function resignEmployeeAndOpenVacancy(
  hrId: string,
  input: EmployeeResignationInput,
  actor: string,
  access?: AccessContext,
  options?: { suppressWorkflowNotification?: boolean },
) {
  const employeeHrId = String(hrId || input.employeeHrId || "").trim();
  if (!employeeHrId) {
    throw new Error("Employee HR ID is required.");
  }

  const directory = await getEmployeeDirectory();
  const employee = directory.employees.find((item) => hrIdsMatch(item.hrId, employeeHrId));
  if (!employee) {
    throw new Error("Employee was not found in the directory.");
  }

  const supabase = getSupabaseAdmin();
  const submittedDate = normalizeSubmittedDate(input);
  const effectiveDate = normalizeLastWorkingDate(input);
  const employeeStatus = normalizeEmployeeExitStatus(input.employeeStatus);
  const directoryForActor = await getEmployeeDirectory();
  const submittedByHrId = resolveSubmittedByHrId(actor, directoryForActor);
  const vacancyCode = vacancyCodeFromEmployee(employeeHrId, effectiveDate);
  const workflowNotesWithReference = [
    cleanText(input.workflowNotes),
    `Termination/vacancy reference: ${vacancyCode}`,
  ].filter(Boolean).join("\n");

  if (effectiveDate < submittedDate) {
    throw new Error("Effective resignation date cannot be before the submitted date.");
  }

  await assertResignationWorkflowTransition({
    access,
    action: "submit",
    expectedNextStatus: "resignation_submitted",
    status: "new",
  });

  const scopedAccess = access ?? systemAccessContext;
  if (!canSeeEmployee(scopedAccess, employee)) {
    throw new Error(`Forbidden: ${scopedAccess.role} cannot access employee ${employee.hrId}.`);
  }

  const rpcResult = await supabase.rpc("phx_resign_employee_and_open_vacancy", {
    p_actor: actor,
    p_effective_date: effectiveDate,
    p_employee_hr_id: employeeHrId,
    p_employee_status: employeeStatus,
    p_reason: cleanText(input.reason),
    p_submitted_by_hr_id: submittedByHrId,
    p_submitted_date: submittedDate,
    p_vacancy_code: vacancyCode,
    p_workflow_notes: workflowNotesWithReference,
  });

  let result: {
    employee_hr_id?: string;
    employee_status?: string;
    resignation_id?: string;
    used_fallback?: boolean;
    vacancy_code?: string;
  };

  if (rpcResult.error) {
    if (!isMissingResignationRpc(rpcResult.error) && !isLastWorkingDateConstraintError(rpcResult.error)) {
      if (isMissingSchemaMessage(rpcResult.error)) {
        throw schemaReadinessError("calling phx_resign_employee_and_open_vacancy", rpcResult.error);
      }
      throw new Error(rpcResult.error.message);
    }

    const fallbackResult = await resignEmployeeWithFallback(supabase, {
      actor,
      effectiveDate,
      employee,
      employeeStatus,
      reason: cleanText(input.reason),
      submittedByHrId,
      submittedDate,
      vacancyCode,
      workflowNotes: workflowNotesWithReference,
    });

    result = {
      employee_hr_id: fallbackResult.employeeHrId,
      employee_status: fallbackResult.employeeStatus,
      resignation_id: fallbackResult.resignationId,
      used_fallback: true,
      vacancy_code: fallbackResult.vacancyCode,
    };
  } else {
    result = (rpcResult.data ?? {}) as {
      employee_hr_id?: string;
      employee_status?: string;
      resignation_id?: string;
      vacancy_code?: string;
    };
  }

  await updateEmployeeLifecycleFallback(supabase, employeeHrId, {
    effectiveDate,
    employeeStatus: result.employee_status ?? employeeStatus,
    reason: cleanText(input.reason),
    submittedDate,
  });
  await ensureResignationVacancyOwnership(supabase, employee, result.vacancy_code ?? vacancyCode);
  await normalizeTerminalEmployeeLifecycleFlags(supabase, employeeHrId);
  // Telegram deactivation is an external API call and cannot run inside the RPC's SQL
  // transaction, so it must happen here — not only on the JS fallback path
  // (resignEmployeeWithFallback -> deactivateEmployeeAccessIfSupported), or every RPC-path
  // resignation would silently stop disabling the employee's Telegram access.
  //
  // Dated for the same reason the RPC's own is_active flips are (see the migration
  // 20260903181500): someone serving out their notice is still working, and cutting their
  // notifications days early is the same early-revocation bug in a different channel. The daily
  // leaver sweep disables it when the day arrives.
  if (
    isEmploymentAccessRevoked({
      employmentStatus: result.employee_status ?? employeeStatus,
      lastWorkingDate: effectiveDate,
      todayCairo: currentCairoDateOnlyIso(),
    })
  ) {
    await disableTelegramForIdentity({
      actorLoginId: "system",
      hrId: employeeHrId,
      reason: "Employee resigned, terminated, or deactivated.",
    });
  }
  // Same reasoning as the Telegram call directly above: this path runs the RPC and never reaches
  // deactivateEmployeeAccessIfSupported, so without this line every RPC-path resignation would
  // silently skip opening the mailbox revocation task.
  await openMailboxRevocationTaskBestEffort(employeeHrId);

  const { data: existingAuditRows, error: auditLookupError } = await supabase
    .from("audit_logs")
    .select("id")
    .eq("entity_type", "employee_resignation")
    .eq("entity_id", employeeHrId)
    .limit(1);
  if (auditLookupError) throw auditLookupError;

  if ((existingAuditRows ?? []).length === 0) {
    await writeRequiredAuditLog({
      actorLoginId: actor,
      entityId: employeeHrId,
      entityType: "employee_resignation",
      newValues: {
        employeeStatus: result.employee_status ?? employeeStatus,
        organogramVisible: false,
        payrollEligible: false,
        resignationId: result.resignation_id ?? null,
        vacancyCode: result.vacancy_code ?? vacancyCode,
      },
      oldValues: {
        employeeStatus: employee.employmentStatus,
        organogramVisible: employee.organogramVisible,
        payrollEligible: employee.payrollEligible,
      },
      summary: "Employee resigned or terminated and vacancy was opened.",
    });
  }

  // A probation-sourced termination must NOT be announced as a voluntary "Resignation Submitted"
  // (wrong framing, wrong recipient list, never reviewed for probation). The caller suppresses this;
  // the dedicated probation-termination notification (owner-confirmed recipients) is handled separately.
  if (!options?.suppressWorkflowNotification) {
    await notifyResignationWorkflow(
      {
        effectiveDate,
        employeeHrId: employee.hrId,
        employeeName: employee.displayName,
        id: result.resignation_id,
        status: "submitted",
      },
      "Resignation Submitted",
      "warning",
    );
  }

  invalidateEmployeeDirectoryCache();
  invalidateExecutiveDashboardCache("employee resigned and vacancy opened", ["resignations", "employees", "vacancies", "payroll"]);

  return {
    employeeHrId: result.employee_hr_id ?? employeeHrId,
    employeeStatus: result.employee_status ?? employeeStatus,
    resignationId: result.resignation_id ?? "",
    usedFallback: result.used_fallback ?? false,
    vacancyCode: result.vacancy_code ?? vacancyCode,
  };
}

function isMissingDeclineOfferRpc(error: unknown) {
  const message = lowerErrorMessage(error);
  return (
    message.includes("phx_decline_offer_and_open_vacancy") ||
    message.includes("could not find the function") ||
    (message.includes("function") && message.includes("does not exist")) ||
    message.includes("pgrst202")
  );
}

/**
 * The "declined offer / did not join" shortcut (owner rule, 2026-09-11): an employee
 * who backed out within DECLINE_OFFER_WINDOW_DAYS of hiring — got a better offer, never
 * really started, or worked only a few days. Distinct from resignEmployeeAndOpenVacancy
 * above: no resignation framing, and HR chooses per case whether the person is entered
 * into that month's payroll for the days they did work.
 *
 * `input.includeInPayroll` resolves to the employment_status the RPC receives:
 *   - true  -> "terminated". Already inside Ready Payroll's terminalPayrollStatuses
 *     (app/api/payroll/template/route.ts), so it is picked up automatically for that
 *     month at base-only pay (no allowances, no >25th waiver — the same leaver_non_resignation
 *     rule any non-resignation departure gets, per the owner's 2026-08-14 ruling).
 *   - false -> "declined_offer" (new value, not in that Set), so Ready Payroll never
 *     includes the row at all. Zero payroll footprint.
 * Neither branch writes an employee_resignations row (see the migration's header for
 * why), so the automated payroll engine — which keys leavers off that table alone —
 * never sees either case, and the two payroll engines can never disagree about this
 * employee's pay.
 */
export async function declineOfferAndOpenVacancy(
  hrId: string,
  input: DeclineOfferInput,
  actor: string,
  access?: AccessContext,
) {
  const employeeHrId = String(hrId || input.employeeHrId || "").trim();
  if (!employeeHrId) {
    throw new Error("Employee HR ID is required.");
  }

  const directory = await getEmployeeDirectory();
  const employee = directory.employees.find((item) => hrIdsMatch(item.hrId, employeeHrId));
  if (!employee) {
    throw new Error("Employee was not found in the directory.");
  }

  const today = todayDate();
  if (!isDeclineOfferEligible({ employmentStatus: employee.employmentStatus, hireDate: employee.hireDate }, today)) {
    throw new Error(
      `This employee is not eligible for the declined-offer shortcut (hired more than ${DECLINE_OFFER_WINDOW_DAYS} days ago, or already exited). Use the standard resignation workflow instead.`,
    );
  }

  const supabase = getSupabaseAdmin();
  const submittedDate = normalizeDate(input.submittedDate) || today;
  const lastWorkingDate = normalizeDate(input.lastWorkingDate) || today;
  if (lastWorkingDate < (dateOnly(employee.hireDate) ?? lastWorkingDate)) {
    throw new Error("Last working date cannot be before the hire date.");
  }
  if (lastWorkingDate > today) {
    throw new Error("Last working date cannot be in the future.");
  }

  const employeeStatus = input.includeInPayroll ? "terminated" : "declined_offer";
  const directoryForActor = await getEmployeeDirectory();
  const submittedByHrId = resolveSubmittedByHrId(actor, directoryForActor);
  const vacancyCode = vacancyCodeFromEmployee(employeeHrId, lastWorkingDate);
  const note = cleanText(input.note) ?? "Declined offer after hire";

  await assertResignationWorkflowTransition({
    access,
    action: "submit",
    expectedNextStatus: "resignation_submitted",
    status: "new",
  });

  const scopedAccess = access ?? systemAccessContext;
  if (!canSeeEmployee(scopedAccess, employee)) {
    throw new Error(`Forbidden: ${scopedAccess.role} cannot access employee ${employee.hrId}.`);
  }

  const rpcResult = await supabase.rpc("phx_decline_offer_and_open_vacancy", {
    p_actor: actor,
    p_employee_hr_id: employeeHrId,
    p_employee_status: employeeStatus,
    p_last_working_date: lastWorkingDate,
    p_note: note,
    p_submitted_by_hr_id: submittedByHrId,
    p_submitted_date: submittedDate,
    p_vacancy_code: vacancyCode,
  });

  if (rpcResult.error) {
    if (isMissingSchemaMessage(rpcResult.error)) {
      throw schemaReadinessError("calling phx_decline_offer_and_open_vacancy", rpcResult.error);
    }
    if (isMissingDeclineOfferRpc(rpcResult.error)) {
      throw schemaReadinessError(
        "calling phx_decline_offer_and_open_vacancy — the migration adding this function has not run yet",
        rpcResult.error,
      );
    }
    throw new Error(rpcResult.error.message);
  }

  const result = (rpcResult.data ?? {}) as {
    employee_hr_id?: string;
    employee_status?: string;
    vacancy_code?: string;
  };

  // Telegram deactivation is an external API call and cannot run inside the RPC's SQL
  // transaction — same reasoning as resignEmployeeAndOpenVacancy above. The "declined_offer"
  // status has no notice-period grace (it is not in DEPARTED_EMPLOYMENT_STATUSES), so
  // isEmploymentAccessRevoked returns true unconditionally for it; "terminated" goes
  // through the same last-working-date grace check a real termination gets.
  if (
    isEmploymentAccessRevoked({
      employmentStatus: result.employee_status ?? employeeStatus,
      lastWorkingDate,
      todayCairo: today,
    })
  ) {
    await disableTelegramForIdentity({
      actorLoginId: "system",
      hrId: employeeHrId,
      reason: "Employee declined the offer / did not join after hire.",
    });
  }
  await openMailboxRevocationTaskBestEffort(employeeHrId);

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: employeeHrId,
    entityType: "employee_decline_offer",
    newValues: {
      employeeStatus: result.employee_status ?? employeeStatus,
      exitCategory: "declined_offer",
      includeInPayroll: input.includeInPayroll,
      organogramVisible: false,
      payrollEligible: false,
      vacancyCode: result.vacancy_code ?? vacancyCode,
    },
    oldValues: {
      employeeStatus: employee.employmentStatus,
      organogramVisible: employee.organogramVisible,
      payrollEligible: employee.payrollEligible,
    },
    summary: "Employee declined the offer / did not join shortly after hiring; vacancy was opened.",
  });

  // The letter this person accepted stops saying accepted, and the candidate behind it moves with it.
  // Before this, the Employee Master said "declined offer" while the Offers screen and the candidate
  // pool still counted a hire — four people on production on 2026-10-14. Keyed on the employee the
  // letter points at, best effort, and after the audit row so a failure here cannot hide the decline.
  await recordOfferDeclinedAfterHire({
    actorHrId: access?.hrId ?? null,
    employeeHrId: employee.hrId,
  });

  await notifyResignationWorkflow(
    {
      effectiveDate: lastWorkingDate,
      employeeHrId: employee.hrId,
      employeeName: employee.displayName,
      status: "declined_offer",
    },
    "Declined Offer Recorded",
    "warning",
  );

  invalidateEmployeeDirectoryCache();
  invalidateExecutiveDashboardCache("employee declined offer and vacancy opened", [
    "resignations",
    "employees",
    "vacancies",
    "payroll",
  ]);

  return {
    employeeHrId: result.employee_hr_id ?? employeeHrId,
    employeeStatus: result.employee_status ?? employeeStatus,
    includeInPayroll: input.includeInPayroll,
    vacancyCode: result.vacancy_code ?? vacancyCode,
  };
}

function normalizeResignationDateUpdate(
  input: UpdateResignationDatesInput,
  current: Pick<ResignationRecord, "effectiveDate" | "submittedDate">,
) {
  const submittedDate =
    normalizeDate(input.submittedDate || input.submitted_date || input.resignationDate || current.submittedDate);
  const effectiveDate =
    normalizeDate(
      input.effectiveDate ||
        input.effective_date ||
        input.lastWorkingDate ||
        input.last_working_date ||
        current.effectiveDate,
    ) || submittedDate;

  if (!submittedDate) throw new Error("Resignation date is required.");
  if (!effectiveDate) throw new Error("Effective resignation date is required.");
  if (effectiveDate < submittedDate) {
    throw new Error("Effective resignation date cannot be before the submitted date.");
  }

  return { effectiveDate, submittedDate };
}

async function updateEmployeeResignationDatesFallback(
  supabase: SupabaseClient,
  employeeHrId: string,
  dates: { effectiveDate: string; submittedDate: string },
) {
  const optionalColumns = ["last_working_date", "resignation_date"];
  const payload: Record<string, unknown> = {
    last_working_date: dates.effectiveDate,
    resignation_date: dates.submittedDate,
    updated_at: new Date().toISOString(),
  };

  for (let attempt = 0; attempt <= optionalColumns.length; attempt++) {
    const { error } = await supabase
      .from("employees")
      .update(payload)
      .eq("hr_id", employeeHrId);

    if (!error) return;

    const missingColumn = optionalColumns.find((column) => isMissingColumn(error, column));
    if (missingColumn) {
      delete payload[missingColumn];
      continue;
    }

    throw schemaReadinessError("updating employee resignation date columns", error);
  }

  throw new Error("Unable to update employee resignation date columns after removing unsupported optional columns.");
}

async function loadHistoricalResignedEmployeeByHrId(supabase: SupabaseClient, hrId: string) {
  const dbHrId = normalizeHrId(hrId)?.toUpperCase() ?? hrId.trim().toUpperCase();
  const joinedResult = await supabase
    .from("employees")
    .select(
      "hr_id,full_name,nickname,job_title,employment_status,resignation_date,last_working_date,exit_reason,exit_status,created_at,updated_at,lines(name),positions(title)",
    )
    .eq("hr_id", dbHrId)
    .maybeSingle();

  let data: unknown | null = joinedResult.data;
  let error = joinedResult.error;

  if (error && (error.message.toLowerCase().includes("relationship") || isMissingSchemaMessage(error))) {
    const fallbackResult = await supabase
      .from("employees")
      .select("hr_id,full_name,nickname,job_title,employment_status,created_at,updated_at,resignation_date,last_working_date")
      .eq("hr_id", dbHrId)
      .maybeSingle();

    data = fallbackResult.data;
    error = fallbackResult.error;
  }

  if (error) {
    throw schemaReadinessError("loading legacy resignation employee by HR ID", error);
  }

  return data as HistoricalResignedEmployeeRow | null;
}

async function updateModernResignationDates(
  supabase: SupabaseClient,
  row: ResignationRow,
  dates: { effectiveDate: string; submittedDate: string },
  actor: string,
) {
  const current = mapResignation(row);
  const note = `Submitted ${current.submittedDate} -> ${dates.submittedDate}; effective ${current.effectiveDate} -> ${dates.effectiveDate}`;
  const optionalColumns = [
    "effective_date",
    "last_working_date",
    "resignation_date",
    "submitted_date",
    "workflow_notes",
  ];
  const payload: Record<string, unknown> = {
    effective_date: dates.effectiveDate,
    last_working_date: dates.effectiveDate,
    resignation_date: dates.submittedDate,
    submitted_date: dates.submittedDate,
    updated_at: new Date().toISOString(),
    workflow_notes: appendWorkflowNote(row.workflow_notes, actor, "updated resignation dates", note),
  };

  for (let attempt = 0; attempt <= optionalColumns.length; attempt++) {
    const { data, error } = await supabase
      .from("employee_resignations")
      .update(payload)
      .eq("id", row.id)
      .select("*")
      .single();

    if (!error) {
      return data as ResignationRow;
    }

    const missingColumn = missingColumnFromError(error, optionalColumns);
    if (missingColumn) {
      delete payload[missingColumn];
      continue;
    }

    throw schemaReadinessError("updating employee_resignations date columns", error);
  }

  throw new Error("Unable to update resignation dates after removing unsupported optional columns.");
}

async function auditResignationDateUpdate(
  actor: string,
  record: Pick<ResignationRecord, "effectiveDate" | "employeeHrId" | "id" | "submittedDate">,
  dates: { effectiveDate: string; submittedDate: string },
) {
  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: record.employeeHrId,
    entityType: "employee_resignation",
    newValues: {
      effectiveDate: dates.effectiveDate,
      resignationId: record.id,
      submittedDate: dates.submittedDate,
    },
    oldValues: {
      effectiveDate: record.effectiveDate,
      resignationId: record.id,
      submittedDate: record.submittedDate,
    },
    summary: "Resignation dates updated.",
  });
}

/**
 * RE-DATING A RESIGNATION MOVES MONEY. `updateResignationDates` writes `employees.last_working_date`,
 * which the leaver's payroll basis reads (a last day past the 25th pays the month in full), so the
 * salary-blind seat — the HR Operations Specialist, who never sees or decides a figure — may not
 * change it, though she holds resignations:update to follow a resignation through. The PATCH route
 * refuses her with this sentence; both resignation pages hide the Dates control on the same answer.
 */
export const RESIGNATION_DATES_KEPT_FROM_SEAT_MESSAGE =
  "Changing resignation dates changes the leaver's pay, so it stays with the HR Manager.";

/** True when the viewer is refused re-dating whatever her grants say — the salary-blind seat. */
export function isResignationDatesKeptFromViewer(access: Pick<AccessContext, "role">): boolean {
  return isSalaryBlindRole(access.role);
}

/** Whether the Dates control is offered: resignations:update, and not the salary-blind seat. */
export async function canChangeResignationDates(access: AccessContext): Promise<boolean> {
  if (isResignationDatesKeptFromViewer(access)) return false;
  return canAccess(access, "resignations", "update");
}

export async function updateResignationDates(
  id: string,
  input: UpdateResignationDatesInput,
  actor: string,
) {
  const resignationId = String(id ?? "").trim();
  if (!resignationId) throw new Error("Resignation record ID is required.");

  const supabase = getSupabaseAdmin();
  if (resignationId.startsWith("legacy:")) {
    const employeeHrId = resignationId.slice("legacy:".length).trim();
    if (!employeeHrId) throw new Error("Legacy resignation HR ID is required.");

    const employee = await loadHistoricalResignedEmployeeByHrId(supabase, employeeHrId);
    if (!employee) return null;

    const current = mapLegacyResignationEmployee(employee);
    const dates = normalizeResignationDateUpdate(input, current);
    await updateEmployeeResignationDatesFallback(supabase, employee.hr_id, dates);
    await auditResignationDateUpdate(actor, current, dates);
    invalidateEmployeeDirectoryCache();
    invalidateExecutiveDashboardCache("resignation dates updated", ["resignations", "employees", "vacancies"]);

    const updatedEmployee = await loadHistoricalResignedEmployeeByHrId(supabase, employeeHrId);
    return updatedEmployee ? mapLegacyResignationEmployee(updatedEmployee) : current;
  }

  const { data, error } = await supabase
    .from("employee_resignations")
    .select("*")
    .eq("id", resignationId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const row = data as ResignationRow;
  const current = mapResignation(row);
  const dates = normalizeResignationDateUpdate(input, current);
  const updatedRow = await updateModernResignationDates(supabase, row, dates, actor);
  const updatedRecord = mapResignation(updatedRow);

  await updateEmployeeResignationDatesFallback(supabase, updatedRecord.employeeHrId, dates);
  await auditResignationDateUpdate(actor, current, dates);
  invalidateEmployeeDirectoryCache();
  invalidateExecutiveDashboardCache("resignation dates updated", ["resignations", "employees", "vacancies"]);

  return updatedRecord;
}

export async function runResignationWorkflow(
  id: string,
  action: ResignationWorkflowAction,
  actor: string,
  note?: string | null,
  rejectedReason?: string | null,
  access?: AccessContext,
) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("employee_resignations")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const row = data as ResignationRow;
  const currentStatus = (cleanText(row.status) ?? cleanText(row.exit_status) ?? "submitted") as ResignationStatus;
  const expectedNextStatusByAction: Record<ResignationWorkflowAction, string> = {
    approve: "resignation_approved",
    cancel: "resignation_cancelled",
    complete: "resignation_completed",
    mark_review: "resignation_under_review",
    reject: "resignation_rejected",
    reopen: "resignation_under_review",
  };
  await assertResignationWorkflowTransition({
    access,
    action,
    expectedNextStatus: expectedNextStatusByAction[action],
    status: currentStatus,
  });

  // getEmployeeDirectory() excludes inactive/terminated employees with no way to opt back in,
  // but resignation actions (approve/complete/etc) routinely target an employee whose status has
  // already flipped -- use the inactive-inclusive lookup so the scope check itself doesn't throw
  // a false Forbidden for every caller (including Super Admin) once that happens.
  const directory = await getEmployeeDirectoryRows({ includeInactive: true });
  const directoryEmployee = directory.find((item) => hrIdsMatch(item.hrId, row.employee_hr_id)) ?? null;
  const employee = directoryEmployee ?? { hrId: row.employee_hr_id, managerHrId: null };
  const scopedAccess = access ?? systemAccessContext;
  if (!canSeeEmployee(scopedAccess, employee)) {
    throw new Error(`Forbidden: ${scopedAccess.role} cannot access employee ${row.employee_hr_id}.`);
  }

  const now = new Date().toISOString();
  // Persist the canonical HR_ID (never a login token) so the Approvals Hub history matches.
  const actorHrId = await resolveCanonicalActorHrId(actor);
  const updates: Record<string, unknown> = {
    exit_status: currentStatus,
    notes: note ? appendWorkflowNote(row.reason, actorHrId, action, note) : row.reason,
    updated_at: now,
    workflow_notes: appendWorkflowNote(row.workflow_notes, actorHrId, action, note),
  };

  switch (action) {
    case "mark_review":
      if (currentStatus === "completed") throw new Error("Completed resignations cannot be reviewed again.");
      updates.status = "under_review";
      updates.exit_status = "submitted";
      updates.reviewed_at = now;
      updates.reviewed_by = actorHrId;
      updates.rejected_reason = null;
      break;
    case "approve":
      if (!["submitted", "under_review"].includes(currentStatus)) {
        throw new Error("Only submitted or under-review resignations can be approved.");
      }
      updates.status = "approved";
      updates.exit_status = "approved";
      updates.approved_at = now;
      updates.approved_by = actorHrId;
      updates.rejected_reason = null;
      break;
    case "reject":
      if (currentStatus === "completed") throw new Error("Completed resignations cannot be rejected.");
      updates.status = "rejected";
      updates.exit_status = "cancelled";
      updates.rejected_at = now;
      updates.rejected_by = actorHrId;
      updates.rejected_reason = cleanText(rejectedReason) ?? "No reason provided.";
      break;
    case "complete":
      if (currentStatus !== "approved") {
        throw new Error("Only approved resignations can be completed.");
      }
      updates.status = "completed";
      updates.exit_status = "completed";
      updates.completed_at = now;
      updates.completed_by = actorHrId;
      break;
    case "cancel":
      if (currentStatus === "completed") throw new Error("Completed resignations cannot be cancelled.");
      updates.status = "cancelled";
      updates.exit_status = "cancelled";
      updates.cancelled_at = now;
      updates.cancelled_by = actorHrId;
      break;
    case "reopen":
      if (!["rejected", "cancelled", "approved"].includes(currentStatus)) {
        throw new Error("Only rejected, cancelled, or approved resignations can be reopened.");
      }
      updates.status = "under_review";
      updates.exit_status = "submitted";
      updates.reviewed_at = now;
      updates.reviewed_by = actorHrId;
      updates.rejected_reason = null;
      break;
    default:
      throw new Error("Unsupported resignation workflow action.");
  }

  // Cancel and reject used to stamp only this row, so a resignation filed from the Employees page
  // (which ends the person on the spot) stayed in force after it was called off: the person was
  // still resigned, off payroll, out of their seat, with the replacement vacancy open and the login
  // off. The restore puts all of that back in one transaction, before the row says "cancelled", so
  // a refusal (seat or vacancy already given to someone else) leaves the resignation as it was.
  // A resignation that never ended anyone answers restored:false and changes nothing.
  let restoredEmployee = false;
  if (action === "cancel" || action === "reject") {
    restoredEmployee = await restoreEmployeeAfterCancelledResignation(supabase, row.id, actorHrId);
  }

  // "Completed" has to mean the person actually left, and the row may only SAY so once they have.
  // Complete runs the four employee-side steps FIRST (resignationCompletionSteps, in this order:
  // lifecycle, access, vacancy link, seat) and stamps the row completed LAST, through the same
  // optimistic-locked update every other action uses. A failed step leaves the resignation
  // Approved and tells HR which step stopped; pressing Complete again is safe, because every step
  // is a re-assertion. Until 2026-11-13 the row was stamped first, so one failed step left a
  // "completed" resignation over a person still active, on payroll, logged in or seated (REC-028).
  let updated: ResignationRow;
  if (action === "complete") {
    updated = await completeResignationInOrder(
      row.id,
      resignationCompletionSteps(supabase, { actorHrId, directoryEmployee, row }),
      () => stampResignationWorkflowRow(supabase, id, row.updated_at, updates),
    );
  } else {
    updated = await stampResignationWorkflowRow(supabase, id, row.updated_at, updates);
  }
  const record = mapResignation(updated);

  // After the reply (afterResponse): the decision is saved, and the notice used to be awaited before the
  // answer left — a whole-directory read, the recipient lookup and the fan-out. A failed notice is logged,
  // never thrown (it used to turn a saved decision into a false 500).
  await afterResponse("resignation_notice:workflow", async () => {
    await notifyResignationWorkflow(
      record,
      action === "approve"
        ? "Resignation Approved"
        : action === "reject"
          ? "Resignation Rejected"
          : action === "complete"
            ? "Resignation Completed"
            : "Resignation Workflow Updated",
      action === "reject" || action === "cancel" ? "danger" : action === "approve" || action === "complete" ? "success" : "warning",
    );
  });
  if (restoredEmployee) {
    invalidateEmployeeDirectoryCache();
    invalidateExecutiveDashboardCache("resignation cancelled and employee restored", [
      "resignations",
      "employees",
      "vacancies",
      "payroll",
    ]);
  }
  invalidateExecutiveDashboardCache("resignation workflow updated", ["resignations", "employees", "vacancies"]);
  return record;
}

/**
 * Writes a workflow decision onto the resignation row — the one write every action ends with.
 * Optimistic-locked on the `updated_at` read at the start of runResignationWorkflow, so a row
 * someone else changed meanwhile is never overwritten.
 */
async function stampResignationWorkflowRow(
  supabase: SupabaseClient,
  id: string,
  expectedUpdatedAt: string,
  updates: Record<string, unknown>,
): Promise<ResignationRow> {
  const { data: updated, error: updateError } = await supabase
    .from("employee_resignations")
    .update(updates)
    .eq("id", id)
    .eq("updated_at", expectedUpdatedAt)
    .select("*")
    .maybeSingle();

  if (updateError) throw updateError;
  if (!updated) throw new Error("Resignation workflow was updated by another user. Refresh and try again.");
  return updated as ResignationRow;
}

/**
 * The cheap re-read before anyone is ended: the row must still be Approved with the SAME
 * updated_at, so a concurrent edit (cancelled, reopened, completed by someone else) stops Complete
 * before a single employee-side step runs. The final stamp keeps its own lock as well.
 */
async function assertResignationStillApproved(
  supabase: SupabaseClient,
  id: string,
  expectedUpdatedAt: string,
) {
  const { data, error } = await supabase
    .from("employee_resignations")
    .select("status, exit_status, updated_at")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  const current = data as Pick<ResignationRow, "status" | "exit_status" | "updated_at"> | null;
  if (!current || resignationRowStatus(current) !== "approved" || current.updated_at !== expectedUpdatedAt) {
    throw new Error("Resignation workflow was updated by another user. Refresh and try again.");
  }
}

export type ResignationCompletionStepKey = "endEmployment" | "revokeAccess" | "linkVacancy" | "vacateSeat";

/** The employee-side steps of Complete, in the order they run, with the words HR is shown. */
export const RESIGNATION_COMPLETION_STEPS: ReadonlyArray<{ key: ResignationCompletionStepKey; label: string }> = [
  { key: "endEmployment", label: "End the employment record (status, payroll and organogram)" },
  { key: "revokeAccess", label: "Switch off sign-in access" },
  { key: "linkVacancy", label: "Link the replacement vacancy" },
  { key: "vacateSeat", label: "Free the organogram seat" },
];

export type ResignationCompletionSteps = { recheck: () => Promise<void> } & Record<
  ResignationCompletionStepKey,
  () => Promise<void>
>;

/** What HR reads when a step stops Complete. Plain words; never the database's own text. */
export function resignationCompletionFailureMessage(stepKey: ResignationCompletionStepKey) {
  const index = RESIGNATION_COMPLETION_STEPS.findIndex((step) => step.key === stepKey);
  const label = RESIGNATION_COMPLETION_STEPS[index]?.label ?? stepKey;
  return (
    `The resignation was not completed: step ${index + 1} of ${RESIGNATION_COMPLETION_STEPS.length}, ` +
    `"${label}", failed. It is still Approved and nothing was marked completed. ` +
    "Pressing Complete again is safe: the steps that already ran are simply repeated."
  );
}

/**
 * Complete, in the right order: re-check, end the employee, THEN stamp the row completed.
 *
 * Every step is injected so the order and the failure handling are tested without a database
 * (tests/resignation-complete-order.test.ts). A step that throws stops the run before the stamp,
 * is logged as `resignation_complete_step_failed` with the step and the resignation id only (no
 * name, no salary), and reaches HR as a 409 naming the step.
 */
export async function completeResignationInOrder<T>(
  resignationId: string,
  steps: ResignationCompletionSteps,
  stampCompleted: () => Promise<T>,
  log: typeof logError = logError,
): Promise<T> {
  await steps.recheck();

  for (const step of RESIGNATION_COMPLETION_STEPS) {
    try {
      await steps[step.key]();
    } catch (error) {
      log("A resignation was not completed: an employee-side step failed", {
        labels: { event: "resignation_complete_step_failed", resignationId, step: step.key },
        error,
      });
      const failure = new ApiError(409, "resignation_complete_step_failed", resignationCompletionFailureMessage(step.key));
      failure.cause = error;
      throw failure;
    }
  }

  return stampCompleted();
}

/**
 * The four employee-side steps of Complete, bound to this resignation.
 *
 * They are the same steps the Employees-page path performs, deliberately NOT
 * resignEmployeeAndOpenVacancy itself: that inserts a SECOND employee_resignations row via
 * phx_resign_employee_and_open_vacancy, and this record already exists.
 *
 * Every step is a re-assertion, which is what makes "press Complete again" safe after a partial
 * failure (each checked 2026-11-13):
 *   - endEmployment writes absolute values (terminal status, payroll and organogram off, CRM slot
 *     released). Its write fires phx_employee_terminal_vacancy_guard, which ADOPTS the seat's open
 *     vacancy before it would open one, and opens one under a deterministic VAC-TERM code.
 *   - revokeAccess sets is_active false (a no-op the second time), disables Telegram again, and
 *     the mailbox opener returns the employee's existing open task.
 *   - linkVacancy returns at once when the row is already linked, else reads the open vacancy back.
 *   - vacateSeat closes only OPEN person spans; a seat already vacated returns vacated_count 0.
 *
 * Strict where it matters: each step tolerates only its own schema object genuinely not existing;
 * any other error propagates and stops Complete before the row is stamped.
 */
export function resignationCompletionSteps(
  supabase: SupabaseClient,
  input: { actorHrId: string; directoryEmployee: DirectoryEmployee | null; row: ResignationRow },
): ResignationCompletionSteps {
  const record = mapResignation(input.row);
  // mapResignation hardcodes employeeStatus: null, so read the stored column and let
  // normalizeEmployeeExitStatus default it — "resigned" is the right outcome for this workflow
  // (the Employees-page path is what produces "terminated").
  const storedRow = input.row as ResignationRow & { employee_status?: string | null; vacancy_id?: number | null };
  const employeeStatus = normalizeEmployeeExitStatus(cleanText(storedRow.employee_status));
  const reason = cleanText(record.reason);

  return {
    recheck: () => assertResignationStillApproved(supabase, input.row.id, input.row.updated_at),
    endEmployment: () =>
      updateEmployeeLifecycleFallback(
        supabase,
        record.employeeHrId,
        {
          effectiveDate: record.effectiveDate,
          employeeStatus,
          reason,
          submittedDate: record.submittedDate,
        },
        { strict: true },
      ),
    revokeAccess: async () => {
      await deactivateEmployeeAccessIfSupported(
        supabase,
        record.employeeHrId,
        { effectiveDate: record.effectiveDate, employeeStatus },
        { strict: true },
      );
    },
    // The lifecycle write is what opens the vacancy (the guard trigger above). This step only
    // reconciles the record with it — see linkCompletedResignationVacancy for why opening one
    // here unconditionally would double the seat.
    linkVacancy: () =>
      linkCompletedResignationVacancy(supabase, {
        effectiveDate: record.effectiveDate,
        employee: input.directoryEmployee,
        employeeHrId: record.employeeHrId,
        resignationId: record.id,
        resignationVacancyId: storedRow.vacancy_id ?? null,
      }),
    // Nothing above touches the au seat model, so without this the organogram kept showing the
    // departed person on their seat. The vacancy link reads position_vacancies, which vacating
    // never writes (au.resign_occupant touches only au.occupancy_history and au.line_area_map),
    // so the two are independent.
    vacateSeat: () =>
      vacateAuSeatsIfSupported(supabase, record.employeeHrId, {
        actor: input.actorHrId,
        effectiveDate: record.effectiveDate,
        reason,
      }),
  };
}

/**
 * Undo what a resignation did to the employee: status, payroll, seat, replacement vacancy, login
 * and CRM id (phx_restore_employee_after_cancelled_resignation). True when someone was restored.
 */
export async function restoreEmployeeAfterCancelledResignation(
  supabase: SupabaseClient,
  resignationId: string,
  actorHrId: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("phx_restore_employee_after_cancelled_resignation", {
    p_actor: actorHrId,
    p_resignation_id: resignationId,
  });
  if (error) {
    // The SQL guards speak plainly ("restore: the seat AI-0009 left has since been given to …");
    // drop only the prefix so the screen shows the reason itself.
    throw new Error(String(error.message ?? "The resignation could not be cancelled.").replace(/^restore:\s*/i, ""));
  }
  return Boolean((data as { restored?: boolean } | null)?.restored);
}

export async function runResignationSlaDaily(): Promise<{ processed: number; errors: number }> {
  const today = currentCairoDateOnlyIso();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("employee_resignations")
    .select("id, employee_name, employee_hr_id, effective_date, created_at, status")
    .in("status", ["submitted", "under_review"]);
  if (error) return { processed: 0, errors: 1 };

  // Resolved, filtered and deduped by person in one place — see resolveRoleRecipientHrIds. The line
  // this replaces was `.map((a) => String(a.hr_id)).filter(Boolean)`, which turned the admin-HR
  // console's NULL hr_id into the string "NULL" and failed this reminder's notification insert on
  // its foreign key, once per overdue resignation, every day at 06:36 Cairo.
  const hrHrIds = await resolveRoleRecipientHrIds("resignation_sla_reminder");
  if (hrHrIds.length === 0) return { processed: 0, errors: 0 };

  let processed = 0;
  let errors = 0;
  const now = Date.now();
  for (const row of data ?? []) {
    const ageDays = Math.max(0, Math.floor((now - new Date(row.created_at as string).getTime()) / 86400000));
    if (ageDays < 5) continue;
    for (const hrId of hrHrIds) {
      try {
        await raiseApproval({ module: "resignation", step: "reminder" }, { via: "notice", notice: {
          channels: ["email", "push"],
          eventType: "resignation_sla_reminder",
          message: `${String(row.employee_name)}'s resignation (effective: ${String(row.effective_date)}) has been pending ${ageDays} day${ageDays === 1 ? "" : "s"} with no final decision.`,
          metadata: { idempotencyKey: `resignation:${String(row.id)}:sla:${hrId}:${today}` },
          module: "resignation",
          priority: "high",
          recipientHrId: hrId,
          title: "Resignation pending decision",
          actionUrl: `/admin/approvals-hub?module=resignation&id=${String(row.id)}`,
          email: {
            ctaHref: `/admin/approvals-hub?module=resignation&id=${String(row.id)}`,
            ctaLabel: "Review resignation",
            tone: "danger" as const,
          },
        } });
        processed++;
      } catch (error) {
        logError("Resignation SLA reminder failed for recipient", { labels: { event: "resignation_sla_reminder_failed", cron: "resignation-sla-reminder", recipientHrId: hrId }, error });
        errors++;
      }
    }
  }
  return { processed, errors };
}
