// Probation Case backfill (Phase 2).
//
// One-time-safe, rerunnable, idempotent provisioning of Probation Cases for employees already
// within their 90-day window when the new system goes live. ALWAYS supports a dry-run that
// writes nothing and returns a full validation report; the write path funnels through the same
// idempotent ensureProbationCase so re-running never duplicates. Existing probation_evaluations
// are linked (via legacy_probation_id / employee match) where resolvable; anything unresolved is
// surfaced with a reason, never silently dropped.

import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { normalizeHrId } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isWithinProbationWindow, probationDaysRemaining, probationEndDate } from "@/lib/probation/date";

import { ensureProbationCase, getProbationCaseByEmployee, isProbationFieldRoleTitle } from "./cases";

export type BackfillEligibleRow = {
  employeeHrId: string;
  employeeName: string | null;
  hireDate: string;
  probationEndDate: string | null;
  daysRemaining: number | null;
  hasCase: boolean;
  legacyProbationId: number | null;
  legacyEvaluationIds: string[];
};

export type BackfillUnresolvedRow = {
  employeeHrId: string;
  employeeName: string | null;
  reason: string;
};

export type BackfillReport = {
  dryRun: boolean;
  scannedEmployees: number;
  withinWindow: number;
  eligibleToCreate: BackfillEligibleRow[];
  alreadyHasCase: BackfillEligibleRow[];
  unresolved: BackfillUnresolvedRow[];
  created: number;
  linkedEvaluations: number;
  // Execution log entries, one per acted-on employee (write mode only).
  log: string[];
};

type EmploymentRow = { employmentStatus?: string | null };

// Employees who should NOT get a probation case (already exited).
const INACTIVE_STATUSES = new Set(["terminated", "resigned", "inactive"]);

function isEligibleStatus(employee: EmploymentRow): boolean {
  const status = String(employee.employmentStatus ?? "active").trim().toLowerCase();
  return !INACTIVE_STATUSES.has(status);
}

async function loadLegacyProbationByHrId(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const { data, error } = await getSupabaseAdmin()
    .from("employee_probation")
    .select("id,employee_hr_id,hr_id");
  if (error) return map; // legacy table optional
  for (const row of (data ?? []) as Array<{ id: number; employee_hr_id: string | null; hr_id: string | null }>) {
    const hrId = normalizeHrId(row.employee_hr_id) ?? normalizeHrId(row.hr_id);
    if (hrId && !map.has(hrId)) map.set(hrId, row.id);
  }
  return map;
}

async function loadEvaluationIdsByHrId(): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  const { data, error } = await getSupabaseAdmin()
    .from("probation_evaluations")
    .select("id,employee_hr_id");
  if (error) return map; // optional
  for (const row of (data ?? []) as Array<{ id: string; employee_hr_id: string | null }>) {
    const hrId = normalizeHrId(row.employee_hr_id);
    if (!hrId) continue;
    const arr = map.get(hrId) ?? [];
    arr.push(row.id);
    map.set(hrId, arr);
  }
  return map;
}

/**
 * Compute the backfill plan (no writes). This is the report shown for approval before any write.
 */
export async function planProbationCaseBackfill(): Promise<BackfillReport> {
  const [employees, legacyByHrId, evalsByHrId] = await Promise.all([
    getEmployeeDirectoryRows(),
    loadLegacyProbationByHrId(),
    loadEvaluationIdsByHrId(),
  ]);

  const eligibleToCreate: BackfillEligibleRow[] = [];
  const alreadyHasCase: BackfillEligibleRow[] = [];
  const unresolved: BackfillUnresolvedRow[] = [];
  let withinWindow = 0;

  for (const employee of employees) {
    const hrId = normalizeHrId(employee.hrId);
    if (!hrId) continue;
    if (!isEligibleStatus(employee)) continue;
    // Automatic probation covers the field roles only (owner, 13-14 Nov 2026) — never plan a case for
    // an office or head-office role. Defense-in-depth with the ensureProbationCase guard.
    if (!isProbationFieldRoleTitle(employee.positionTitle ?? employee.jobTitle)) continue;

    if (!employee.hireDate) {
      // Only flag as unresolved if they'd otherwise plausibly be in probation (no hire date at all).
      unresolved.push({
        employeeHrId: hrId,
        employeeName: employee.displayName,
        reason: "missing_hire_date",
      });
      continue;
    }

    if (!isWithinProbationWindow(employee.hireDate)) continue;
    withinWindow += 1;

    const existing = await getProbationCaseByEmployee(hrId);
    const row: BackfillEligibleRow = {
      employeeHrId: hrId,
      employeeName: employee.displayName,
      hireDate: employee.hireDate,
      probationEndDate: probationEndDate(employee.hireDate),
      daysRemaining: probationDaysRemaining(employee.hireDate),
      hasCase: Boolean(existing),
      legacyProbationId: legacyByHrId.get(hrId) ?? null,
      legacyEvaluationIds: evalsByHrId.get(hrId) ?? [],
    };
    if (existing) alreadyHasCase.push(row);
    else eligibleToCreate.push(row);
  }

  return {
    dryRun: true,
    scannedEmployees: employees.length,
    withinWindow,
    eligibleToCreate,
    alreadyHasCase,
    unresolved,
    created: 0,
    linkedEvaluations: 0,
    log: [],
  };
}

/**
 * Execute the backfill. `dryRun` (default true) returns the plan without writing. With
 * `dryRun: false`, creates a case per eligible employee via the idempotent ensureProbationCase
 * (rerunnable — an already-created case is skipped, not duplicated) and links the legacy
 * probation id. Produces a per-employee execution log.
 */
export async function runProbationCaseBackfill(options: {
  dryRun?: boolean;
  actor?: string;
} = {}): Promise<BackfillReport> {
  const dryRun = options.dryRun ?? true;
  const plan = await planProbationCaseBackfill();
  if (dryRun) return plan;

  const log: string[] = [];
  let created = 0;
  let linkedEvaluations = 0;

  for (const target of plan.eligibleToCreate) {
    const result = await ensureProbationCase({
      employeeHrId: target.employeeHrId,
      hireDate: target.hireDate,
      employeeName: target.employeeName,
      legacyProbationId: target.legacyProbationId,
      source: "backfill",
      createdBy: options.actor ?? "backfill",
    });
    if (result.created) {
      created += 1;
      if (target.legacyEvaluationIds.length > 0) linkedEvaluations += target.legacyEvaluationIds.length;
      log.push(`created case for ${target.employeeHrId} (end ${target.probationEndDate}, ${target.legacyEvaluationIds.length} legacy evals)`);
    } else if (result.skippedReason) {
      log.push(`skipped ${target.employeeHrId}: ${result.skippedReason}`);
    } else {
      log.push(`already existed for ${target.employeeHrId} (idempotent no-op)`);
    }
  }

  return { ...plan, dryRun: false, created, linkedEvaluations, log };
}
