// Probation DV-Day sync writer (Phase 3, P3-T09 idempotent integration + P3-T10 sync health).
//
// Composes the pure pipeline (detect → validate → shape) and persists the result idempotently:
//   * probation_dv_days: insert NEW (evaluator,employee,date) days only (ON CONFLICT DO NOTHING),
//     so a re-sync never duplicates and never clobbers a day that already advanced into the
//     feedback lifecycle. Already-persisted keys are marked "duplicate" by validation and skipped.
//   * probation_dv_visits: per-visit detail, ON CONFLICT (crm_visit_id, dv_day_id) DO NOTHING — a CRM
//     activity attaches to one DV-Day per evaluator: a chain visit to each of its two managers' days.
//   * probation_dv_ingest_issues: identity-less rows, ON CONFLICT (crm_visit_id, reason) DO NOTHING.
//   * probation_cases.last_crm_sync_at bumped for touched cases (sync-health, P3-T10).
//
// Called for a date window by the CRM housekeeping timer (crm/housekeeping-scheduler.ts) and by the
// probation backfill route. The iReports360 poller and its sync/reconcile routes, which also called it,
// were retired with the vendor on 6 November 2026.

import { normalizeHrId } from "@/lib/auth/permissions";
import { isProbationSchemaMissing } from "@/lib/probation/service";

import { detectDvDaysForWindow } from "./dv-detection";
import { dvDayKey } from "./dv-source";
import { toDvDayRow, toDvVisitRows } from "./dv-persistence";
import { toIngestIssueRows } from "./dv-review";
import {
  partitionValidatedDvDays,
  validateDvDays,
  type DvValidationContext,
  type ProbationCaseRef,
} from "./dv-validation";

import type { SupabaseClient } from "@supabase/supabase-js";

export type DvSyncSummary = {
  window: { dateFrom: string; dateTo: string };
  detected: number;
  inserted: number;
  needsReview: number;
  duplicates: number;
  ingestIssues: number;
  visitsWritten: number;
  casesTouched: number;
};

function norm(value: string | null | undefined): string {
  return normalizeHrId(value) ?? String(value ?? "").trim().toLowerCase();
}

async function loadCases(supabase: SupabaseClient): Promise<{
  caseByEmployee: Map<string, ProbationCaseRef>;
  caseEmployeeHrIds: string[];
}> {
  const { data: cases, error: caseErr } = await supabase
    .from("probation_cases")
    .select("id, employee_hr_id, probation_start_date, probation_end_date, line_name");
  // Before the domain migrations are applied (e.g. the deploy→migrate window on go-live), the table
  // does not exist yet. Treat that as "no cases" and skip quietly rather than throwing on every cron
  // tick — the sync then does nothing and returns a clean zero result.
  if (caseErr && isProbationSchemaMissing(caseErr)) {
    return { caseByEmployee: new Map(), caseEmployeeHrIds: [] };
  }
  if (caseErr) throw new Error(caseErr.message);

  const caseByEmployee = new Map<string, ProbationCaseRef>();
  const caseEmployeeHrIds: string[] = [];
  for (const c of (cases ?? []) as Array<{
    id: string; employee_hr_id: string; probation_start_date: string | null;
    probation_end_date: string | null; line_name: string | null;
  }>) {
    caseByEmployee.set(norm(c.employee_hr_id), {
      caseId: c.id,
      probationStartDate: c.probation_start_date,
      probationEndDate: c.probation_end_date,
      lineName: c.line_name,
    });
    caseEmployeeHrIds.push(c.employee_hr_id);
  }
  // BLOCKER fix: ireports360_visits.agent_hr_id and employees.hr_id are stored UPPERCASE, but
  // probation case keys are normalized lowercase by ensureProbationCase (backfill). The scope filters
  // that consume this list use a case-SENSITIVE `.in(...)`, so a lowercase key never matches "B-100"
  // and the whole backfilled cohort captured ZERO DV-Days. Pass every casing variant so the `.in`
  // matches regardless of stored casing — downstream case resolution is already case-insensitive (norm()).
  const scopedHrIds = Array.from(new Set(
    caseEmployeeHrIds.flatMap((k) => [k, k.toUpperCase(), k.toLowerCase()]),
  ));
  return { caseByEmployee, caseEmployeeHrIds: scopedHrIds };
}

async function buildContext(
  supabase: SupabaseClient,
  caseByEmployee: Map<string, ProbationCaseRef>,
  caseEmployeeHrIds: string[],
  evaluatorHrIds: string[],
): Promise<DvValidationContext> {
  // Evaluator roles (active users only).
  const evaluatorAppRoleByHrId = new Map<string, string>();
  if (evaluatorHrIds.length > 0) {
    const { data: users, error: userErr } = await supabase
      .from("app_auth_users")
      .select("hr_id, role")
      .in("hr_id", evaluatorHrIds)
      .eq("is_active", true);
    if (userErr) throw new Error(userErr.message);
    for (const u of (users ?? []) as Array<{ hr_id: string; role: string }>) {
      evaluatorAppRoleByHrId.set(norm(u.hr_id), u.role);
    }
  }

  // Manager map for the probation employees (DM = evaluator is the employee's manager).
  const managerHrIdByEmployee = new Map<string, string | null>();
  // PostgREST folds every .in() value into the request URL; an unbatched array of a few hundred
  // ids can push the URL past undici's ~16KB header limit and throw "TypeError: fetch failed" /
  // HeadersOverflowError — caseEmployeeHrIds covers every probation case ever, tripled by casing
  // variants, so batch.
  for (let i = 0; i < caseEmployeeHrIds.length; i += 100) {
    const batch = caseEmployeeHrIds.slice(i, i + 100);
    const { data: emps, error: empErr } = await supabase
      .from("employees")
      .select("hr_id, manager_hr_id")
      .in("hr_id", batch);
    if (empErr) throw new Error(empErr.message);
    for (const e of (emps ?? []) as Array<{ hr_id: string; manager_hr_id: string | null }>) {
      managerHrIdByEmployee.set(norm(e.hr_id), e.manager_hr_id ? norm(e.manager_hr_id) : null);
    }
  }

  // Already-persisted DV-Day keys (idempotency guard).
  const existingDvDayKeys = new Set<string>();
  const { data: existing, error: exErr } = await supabase
    .from("probation_dv_days")
    .select("evaluator_hr_id, employee_hr_id, dv_date");
  if (exErr) throw new Error(exErr.message);
  for (const r of (existing ?? []) as Array<{ evaluator_hr_id: string | null; employee_hr_id: string; dv_date: string }>) {
    existingDvDayKeys.add(dvDayKey(r.evaluator_hr_id, r.employee_hr_id, r.dv_date));
  }

  return { caseByEmployee, evaluatorAppRoleByHrId, managerHrIdByEmployee, existingDvDayKeys };
}

/**
 * Idempotently capture validated DV-Days for a date window. Read + write. Safe to re-run and to
 * call repeatedly from the visit sync/reconcile crons.
 */
export async function syncProbationDvDays(
  supabase: SupabaseClient,
  input: { dateFrom: string; dateTo: string; syncedAt?: string },
): Promise<DvSyncSummary> {
  const syncedAt = input.syncedAt ?? new Date().toISOString();

  // Load the probation cohort FIRST and scope detection to those employees so non-probation
  // double visits never enter the probation tables.
  const { caseByEmployee, caseEmployeeHrIds } = await loadCases(supabase);
  if (caseEmployeeHrIds.length === 0) {
    return {
      window: { dateFrom: input.dateFrom, dateTo: input.dateTo },
      detected: 0, inserted: 0, needsReview: 0, duplicates: 0, ingestIssues: 0,
      visitsWritten: 0, casesTouched: 0,
    };
  }

  const detection = await detectDvDaysForWindow(supabase, input.dateFrom, input.dateTo, caseEmployeeHrIds);

  const evaluatorHrIds = Array.from(
    new Set(detection.dvDays.map((d) => d.evaluatorHrId).filter(Boolean)),
  );
  const ctx = await buildContext(supabase, caseByEmployee, caseEmployeeHrIds, evaluatorHrIds);

  const validated = validateDvDays(detection.dvDays, ctx);
  const partitioned = partitionValidatedDvDays(validated);
  const toPersist = partitioned.validated;
  const duplicates = partitioned.duplicates;
  // Only persist review-status days that resolved to a probation case; a day with no case is not
  // probation-relevant (belongs to a non-probation employee) and is dropped, not queued.
  const needsReview = partitioned.needsReview.filter((d) => d.caseId);

  // Persist parent DV-Days (validated + review-status, all resolved to an employee). NEW keys only
  // survive to here for validated; needsReview may include existing? No — needsReview items were
  // not marked duplicate, so they are new. Insert with ON CONFLICT DO NOTHING for safety.
  const parentRows = [...toPersist, ...needsReview].map((d) => toDvDayRow(d, syncedAt));
  let inserted = 0;
  let visitsWritten = 0;
  const touchedCaseIds = new Set<string>();
  const newValidatedDvDayIds: string[] = [];

  if (parentRows.length > 0) {
    const { data: insertedDays, error: insErr } = await supabase
      .from("probation_dv_days")
      .upsert(parentRows, { onConflict: "evaluator_hr_id,employee_hr_id,dv_date", ignoreDuplicates: true })
      .select("id, evaluator_hr_id, employee_hr_id, dv_date, case_id, dv_status");
    if (insErr) throw new Error(insErr.message);

    const insertedByKey = new Map<string, string>();
    for (const r of (insertedDays ?? []) as Array<{
      id: string; evaluator_hr_id: string | null; employee_hr_id: string; dv_date: string;
      case_id: string | null; dv_status: string;
    }>) {
      insertedByKey.set(dvDayKey(r.evaluator_hr_id, r.employee_hr_id, r.dv_date), r.id);
      if (r.case_id) touchedCaseIds.add(r.case_id);
      // Snapshot email fires for a newly-CAPTURED validated DV-Day (Phase 9).
      if (r.dv_status === "validated") newValidatedDvDayIds.push(r.id);
    }
    inserted = insertedByKey.size;

    // Attach per-visit detail only for the days we just inserted (existing days keep their visits).
    const visitRows: Array<Record<string, unknown>> = [];
    for (const day of [...toPersist, ...needsReview]) {
      const dvDayId = insertedByKey.get(day.key);
      if (!dvDayId) continue; // was an existing (conflicting) day — skip
      for (const vr of toDvVisitRows(day)) visitRows.push({ ...vr, dv_day_id: dvDayId });
    }
    if (visitRows.length > 0) {
      // (crm_visit_id, dv_day_id): a chain visit is in BOTH its managers' DV-Days (20261008141330).
      const upsertVisits = (onConflict: string) =>
        supabase.from("probation_dv_visits").upsert(visitRows, { onConflict, ignoreDuplicates: true }).select("id");
      let { data: insVisits, error: vErr } = await upsertVisits("crm_visit_id,dv_day_id");
      // 🔴 Until 20261008141330 is applied the table holds only UNIQUE (crm_visit_id), and Postgres
      // answers 42P10 (no constraint matches the ON CONFLICT target). The days above are ALREADY written
      // and a later run skips an existing day, so a throw here would leave them with no visits for good.
      // Fall back to the old key instead: the deploy and the migration can then land in either order.
      if (vErr?.code === "42P10") ({ data: insVisits, error: vErr } = await upsertVisits("crm_visit_id"));
      if (vErr) throw new Error(vErr.message);
      visitsWritten = (insVisits ?? []).length;
    }
  }

  // Ingest issues for identity-less rows (surfaced, never dropped).
  const issueRows = toIngestIssueRows(detection.unresolved);
  let ingestIssues = 0;
  if (issueRows.length > 0) {
    const { data: insIssues, error: issErr } = await supabase
      .from("probation_dv_ingest_issues")
      .upsert(issueRows, { onConflict: "crm_visit_id,reason,employee_hr_id,evaluator_hr_id,dv_date", ignoreDuplicates: true })
      .select("id");
    if (issErr) throw new Error(issErr.message);
    ingestIssues = (insIssues ?? []).length;
  }

  // Sync-health (P3-T10): bump last_crm_sync_at on touched cases.
  if (touchedCaseIds.size > 0) {
    const { error: bumpErr } = await supabase
      .from("probation_cases")
      .update({ last_crm_sync_at: syncedAt })
      .in("id", Array.from(touchedCaseIds));
    if (bumpErr) throw new Error(bumpErr.message);
  }

  // NOTE (MOD-1, 2026-07-17): the per-DV-Day snapshot email is intentionally NOT sent here anymore.
  // Firing one email to ~8 stakeholders on every validated Double-Visit day flooded inboxes. It's
  // replaced by a single WEEKLY digest per probationer (processProbationWeeklyDigest) that rolls up
  // the week's DV-Days. newValidatedDvDayIds is still tracked for the sync result/telemetry below.
  void newValidatedDvDayIds;

  return {
    window: { dateFrom: input.dateFrom, dateTo: input.dateTo },
    detected: detection.dvDays.length,
    inserted,
    needsReview: needsReview.length,
    duplicates: duplicates.length,
    ingestIssues,
    visitsWritten,
    casesTouched: touchedCaseIds.size,
  };
}
