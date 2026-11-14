// Probation Case repository + provisioning (Phase 2).
//
// The Probation Case is the single source of truth per employee. `ensureProbationCase` is the
// ONE idempotent entry point every hire path (and the backfill) funnels through so a case is
// created exactly once — the unique constraint on employee_hr_id is the hard dedup guard, and
// this function is safe under concurrency (it treats a unique-violation as "already exists").

import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { employeeLeftFlag, type EmployeeLeftFlag } from "@/lib/employees/left-flag";
import { normalizeHrId } from "@/lib/auth/permissions";
import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { probationEndDate, probationStartDate } from "@/lib/probation/date";

import type { ProbationCase } from "./types";

type ProbationCaseRow = {
  id: string;
  employee_hr_id: string;
  employee_name: string | null;
  job_title: string | null;
  line_name: string | null;
  area_name: string | null;
  manager_hr_id: string | null;
  hire_date: string | null;
  probation_start_date: string | null;
  probation_end_date: string | null;
  status: string;
  decision: string | null;
  decision_reason: string | null;
  decision_by: string | null;
  decision_at: string | null;
  evidence_acknowledged: boolean;
  side_effects_applied_at: string | null;
  legacy_probation_id: number | null;
  source: string;
  last_crm_sync_at: string | null;
  last_report_update_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export function isProbationCaseSchemaMissing(error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message ?? error ?? "").toLowerCase();
  return (
    message.includes("probation_cases") ||
    message.includes("could not find the table") ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist"))
  );
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  const message = String((error as { message?: unknown })?.message ?? error ?? "").toLowerCase();
  return code === "23505" || message.includes("duplicate key") || message.includes("already exists");
}

export function mapProbationCaseRow(row: ProbationCaseRow): ProbationCase {
  return {
    id: row.id,
    employeeHrId: row.employee_hr_id,
    employeeName: row.employee_name,
    jobTitle: row.job_title,
    lineName: row.line_name,
    areaName: row.area_name,
    managerHrId: row.manager_hr_id,
    hireDate: row.hire_date,
    probationStartDate: row.probation_start_date,
    probationEndDate: row.probation_end_date,
    status: (row.status as ProbationCase["status"]) ?? "active",
    decision: (row.decision as ProbationCase["decision"]) ?? null,
    decisionReason: row.decision_reason,
    decisionBy: row.decision_by,
    decisionAt: row.decision_at,
    evidenceAcknowledged: Boolean(row.evidence_acknowledged),
    sideEffectsAppliedAt: row.side_effects_applied_at,
    legacyProbationId: row.legacy_probation_id,
    source: row.source ?? "system",
    lastCrmSyncAt: row.last_crm_sync_at,
    lastReportUpdateAt: row.last_report_update_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const CASE_COLUMNS =
  "id,employee_hr_id,employee_name,job_title,line_name,area_name,manager_hr_id,hire_date," +
  "probation_start_date,probation_end_date,status,decision,decision_reason,decision_by,decision_at," +
  "evidence_acknowledged,side_effects_applied_at,legacy_probation_id,source,last_crm_sync_at," +
  "last_report_update_at,created_by,created_at,updated_at";

/** Fetch a single case by employee HR_ID (normalized), or null. */
export async function getProbationCaseByEmployee(
  employeeHrId: string,
): Promise<ProbationCase | null> {
  const hrId = normalizeHrId(employeeHrId);
  if (!hrId) return null;
  const { data, error } = await getSupabaseAdmin()
    .from("probation_cases")
    .select(CASE_COLUMNS)
    .ilike("employee_hr_id", hrId)
    .maybeSingle();
  if (error) {
    if (isProbationCaseSchemaMissing(error)) return null;
    throw error;
  }
  return data ? mapProbationCaseRow(data as unknown as ProbationCaseRow) : null;
}

/**
 * Defense-in-depth cross-check for the legacy-decision desync bug.
 *
 * The LEGACY probation workflow (runProbationWorkflow → applyDecisionSideEffects, retired in REC-010 on
 * 14 Nov 2026 — this filter stays for the people it decided before then) resolved an
 * employee by writing `employee_probation.status` and `employees.employment_status`, but historically
 * never mirrored the outcome into `probation_cases`. That leaves a `probation_cases` row stranded at
 * status='active' / decision=null, so the CEO dashboard and the milestone-email sweep (both of which
 * read only `.eq("status","active")`) keep treating a fully-resolved rep as an open case.
 *
 * Given a set of "active" case rows, this drops any whose employee is in fact already resolved:
 *   - `employee_probation.status IN ('passed','terminated')` — this is the ONLY signal that catches a
 *     legacy PASS, which leaves `employment_status = 'active'` and is otherwise indistinguishable
 *     from a genuinely undecided case; and
 *   - `employees.employment_status` terminal (outside the active/on_leave set) — catches a legacy
 *     termination / resignation.
 *
 * FAILS OPEN: any lookup error (or a completely clean cohort) returns the input array unchanged, so a
 * transient monitoring-query failure can never crash the caller or hide a live case. HR_IDs are
 * compared case-insensitively.
 */
export async function filterResolvedProbationCases<T extends { employee_hr_id: string }>(
  rows: T[],
): Promise<T[]> {
  if (rows.length === 0) return rows;
  const hrIds = Array.from(
    new Set(rows.map((r) => r.employee_hr_id).filter((x): x is string => Boolean(x))),
  );
  if (hrIds.length === 0) return rows;

  // The COMPARISONS below lower-case both sides, but `.in()` does not — and HR_IDs are mixed case
  // in this database on both sides of this join. `probation_cases` holds the older cohort as
  // `ai-0004` while `employees` holds `AI-0004`, so the exact-match fetch returned no row for them
  // and this function, which then has nothing to filter ON, quietly passed a TERMINATED employee
  // through as a live case. Measured on production 2026-09-29: 1 of the 10 cases in the 30-90 day
  // band missed its employee row this way, and it was the terminated one.
  //
  // Widening the fetch to the case variants is what makes the documented case-insensitive
  // comparison actually true. The lower-cased sets below still do the matching.
  const hrIdVariants = Array.from(
    new Set(hrIds.flatMap((id) => [id, id.toLowerCase(), id.toUpperCase()])),
  );

  try {
    const supabase = getSupabaseAdmin();
    const [empRes, probRes] = await Promise.all([
      supabase.from("employees").select("hr_id, employment_status").in("hr_id", hrIdVariants),
      supabase.from("employee_probation").select("employee_hr_id, status").in("employee_hr_id", hrIdVariants),
    ]);
    // Fail open: never hide data (or crash) on a monitoring-query error.
    if (empRes.error || probRes.error) return rows;

    const terminalEmp = new Set<string>();
    for (const e of (empRes.data ?? []) as Array<{ hr_id: string; employment_status: string | null }>) {
      if (isTerminalEmploymentStatus(e.employment_status)) terminalEmp.add(e.hr_id.toLowerCase());
    }
    const resolvedProbation = new Set<string>();
    for (const p of (probRes.data ?? []) as Array<{ employee_hr_id: string; status: string | null }>) {
      const status = String(p.status ?? "").trim().toLowerCase();
      if (status === "passed" || status === "terminated") resolvedProbation.add(p.employee_hr_id.toLowerCase());
    }
    if (terminalEmp.size === 0 && resolvedProbation.size === 0) return rows;

    return rows.filter((r) => {
      const key = r.employee_hr_id.toLowerCase();
      return !terminalEmp.has(key) && !resolvedProbation.has(key);
    });
  } catch {
    // Fail open on any unexpected error (schema missing, transient network) — behave as today.
    return rows;
  }
}

/**
 * The word for the case page: this person has left, or declined, and the case is still open. It reports
 * only. A decision stays with whoever holds it, and the decision path never reads this. Fails open, like
 * the filter above: a failed lookup leaves the page as it was rather than taking it down.
 */
export async function readProbationEmployeeLeft(employeeHrId: string): Promise<EmployeeLeftFlag | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("employees")
    .select("employment_status, last_working_date")
    .in("hr_id", [employeeHrId, employeeHrId.toLowerCase(), employeeHrId.toUpperCase()])
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { employment_status: string | null; last_working_date: string | null };
  return employeeLeftFlag({ employmentStatus: row.employment_status, lastWorkingDate: row.last_working_date });
}

/**
 * Post-decision lock (Phase 10): once a case is decided, no further feedback/assessment input is
 * accepted. Throws a "Conflict" so callers map it to 409. No-op when the case is still active.
 */
export async function assertCaseAcceptsSubmissions(caseId: string | null | undefined): Promise<void> {
  if (!caseId) return;
  const { data, error } = await getSupabaseAdmin()
    .from("probation_cases")
    .select("status, decision")
    .eq("id", caseId)
    .maybeSingle();
  if (error) return; // best-effort; don't block on a transient read
  const row = data as { status?: string; decision?: string | null } | null;
  if (row && (row.status === "decided" || row.decision)) {
    throw new Error("Conflict: this probation case has already been decided and is locked to further input.");
  }
}

/**
 * Automatic probation covers the FIELD ROLES (owner, 13-14 Nov 2026, audit item REC-074): a Medical
 * Representative, or a District / Senior District / Regional / National Sales Manager. It replaced the
 * 2026-07-17 Medical-Representatives-only rule ("Field roles only", then "All sales managers").
 * Office and head-office roles (Training, Product, SFE, Marketing, HR, Finance managers, assistants)
 * never get a case automatically. Matched as lower-case substrings, so title variants ("Senior Medical
 * Representative", "Senior District Manager") are covered.
 *
 * 🔴 The database hire trigger (public.probation_provision_case_on_hire, migration
 * 20261114021245_probation_covers_field_sales_managers.sql) holds THE SAME list as a regex;
 * tests/probation-case-provisioning.test.ts fails when the two differ.
 */
export const PROBATION_FIELD_ROLE_TITLES = [
  "medical rep",
  "district manager",
  "district sales manager",
  "regional sales manager",
  "national sales manager",
] as const;

export function isProbationFieldRoleTitle(jobTitle: string | null | undefined): boolean {
  const title = String(jobTitle ?? "").trim().toLowerCase();
  if (!title) return false;
  return PROBATION_FIELD_ROLE_TITLES.some((fragment) => title.includes(fragment));
}

export type EnsureProbationCaseInput = {
  employeeHrId: string;
  /** Optional overrides; when omitted, identity + hire date resolve from the employee directory. */
  hireDate?: string | null;
  employeeName?: string | null;
  jobTitle?: string | null;
  lineName?: string | null;
  areaName?: string | null;
  managerHrId?: string | null;
  legacyProbationId?: number | null;
  source?: string;
  createdBy?: string | null;
};

export type EnsureProbationCaseResult = {
  case: ProbationCase | null;
  created: boolean;
  /** Set when the case could not be created (e.g. unknown employee, missing hire date). */
  skippedReason?: string;
};

/**
 * Idempotently create-or-return the Probation Case for an employee.
 *
 * - Returns the existing case unchanged if one already exists (no overwrite).
 * - Resolves identity + hire date from the employee directory when not supplied.
 * - Derives probation_end_date via the canonical hire+90 helper.
 * - Concurrency-safe: a unique-violation on employee_hr_id is treated as "already exists"
 *   and the existing row is re-read and returned.
 * - Never throws on a missing hire date or unknown employee; returns skippedReason instead so
 *   callers (hire paths) stay non-blocking.
 */
export async function ensureProbationCase(
  input: EnsureProbationCaseInput,
): Promise<EnsureProbationCaseResult> {
  const employeeHrId = normalizeHrId(input.employeeHrId);
  if (!employeeHrId) return { case: null, created: false, skippedReason: "missing_employee_hr_id" };

  const existing = await getProbationCaseByEmployee(employeeHrId);
  if (existing) return { case: existing, created: false };

  // Resolve identity + hire date from the directory when the caller did not supply them.
  let identity = {
    employeeName: input.employeeName ?? null,
    jobTitle: input.jobTitle ?? null,
    lineName: input.lineName ?? null,
    areaName: input.areaName ?? null,
    managerHrId: input.managerHrId ?? null,
    hireDate: input.hireDate ?? null,
  };
  if (
    !identity.hireDate ||
    !identity.employeeName ||
    !identity.jobTitle ||
    identity.managerHrId === null
  ) {
    const rows = await getEmployeeDirectoryRows();
    const employee = rows.find((row) => normalizeHrId(row.hrId) === employeeHrId) ?? null;
    if (employee) {
      identity = {
        employeeName: identity.employeeName ?? employee.fullName ?? null,
        jobTitle: identity.jobTitle ?? employee.positionTitle ?? employee.jobTitle ?? null,
        lineName: identity.lineName ?? employee.lineName ?? null,
        areaName: identity.areaName ?? employee.areaName ?? null,
        managerHrId: identity.managerHrId ?? employee.managerHrId ?? null,
        hireDate: identity.hireDate ?? employee.hireDate ?? null,
      };
    }
  }

  if (!identity.hireDate) {
    // Cannot anchor the 90-day window without a hire date — surface, don't fabricate.
    return { case: null, created: false, skippedReason: "missing_hire_date" };
  }

  // Scope guard (owner, 13-14 Nov 2026): automatic probation covers the field roles only - Medical
  // Representatives and the District, Regional and National Sales Managers. An office or head-office
  // employee never gets a case, even mid hire+90 window. This is the single choke point for BOTH the
  // backfill and the real-time hire hook (provisioning.ts).
  if (!isProbationFieldRoleTitle(identity.jobTitle)) {
    return { case: null, created: false, skippedReason: "not_field_role" };
  }

  const startDate = probationStartDate(identity.hireDate);
  const endDate = probationEndDate(identity.hireDate);

  const { data, error } = await getSupabaseAdmin()
    .from("probation_cases")
    .insert({
      employee_hr_id: employeeHrId,
      employee_name: identity.employeeName,
      job_title: identity.jobTitle,
      line_name: identity.lineName,
      area_name: identity.areaName,
      manager_hr_id: identity.managerHrId,
      hire_date: identity.hireDate,
      probation_start_date: startDate,
      probation_end_date: endDate,
      status: "active",
      legacy_probation_id: input.legacyProbationId ?? null,
      source: input.source ?? "system",
      created_by: input.createdBy ?? "system",
    })
    .select(CASE_COLUMNS)
    .single();

  if (error) {
    // Lost a create race — the row now exists; return it.
    if (isUniqueViolation(error)) {
      const raced = await getProbationCaseByEmployee(employeeHrId);
      if (raced) return { case: raced, created: false };
    }
    throw error;
  }

  return { case: mapProbationCaseRow(data as unknown as ProbationCaseRow), created: true };
}
