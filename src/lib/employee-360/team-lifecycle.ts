// Employee 360 — manager "Team Lifecycle" analytics.
//
// The non-development side of a field manager's team health: are their reps
// planning (weekly plans), showing up in the field (no-activity deduction flags),
// and who is still in probation. All three are BULK single queries scoped to the
// manager's reps, best-effort so the 360 page never breaks.
//
// Attendance note: field Medical Reps do NOT punch fingerprint devices (only ~17
// office staff do), so a device-attendance panel would be a misleading zero for
// every field team. The field-force equivalent of "absent" is a confirmed
// no-activity day — surfaced through the field-workforce deduction pipeline
// (`deduction_candidates`, source_module = FIELD_WORKFORCE). That is the populated,
// meaningful signal, so that is what this reports. Probation is computed purely
// from hire_date + 90 (the canonical rule) — no extra query.

import { compactDeductionHrId } from "@/lib/deductions-governance/service";
import { resolveEmployee360RoleCategory } from "@/lib/employee-360/roles";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type TeamProbationRep = { hrId: string; name: string; daysRemaining: number };

export type TeamLifecycleSummary = {
  hasData: boolean;
  repCount: number;
  // Weekly-plan compliance (all-time; a rep who has ever planned)
  planSubmittedCount: number; // reps with >=1 non-draft weekly plan
  planApprovedCount: number; // reps with >=1 fully-approved weekly plan
  planCoverageRate: number; // planSubmittedCount / repCount
  // Field discipline — confirmed no-activity deduction flags in the window's months.
  disciplineHasData: boolean;
  disciplineFlaggedReps: number; // distinct reps with any live field-workforce flag
  disciplineNoActivityDays: number; // total confirmed no-activity days across the team
  // Probation (hire_date + 90 > today)
  probationCount: number;
  probationReps: TeamProbationRep[];
};

const EMPTY: TeamLifecycleSummary = {
  hasData: false,
  repCount: 0,
  planSubmittedCount: 0,
  planApprovedCount: 0,
  planCoverageRate: 0,
  disciplineHasData: false,
  disciplineFlaggedReps: 0,
  disciplineNoActivityDays: 0,
  probationCount: 0,
  probationReps: [],
};

const PROBATION_DAYS = 90;
const APPROVED_PLAN_STATUSES = new Set(["ceo_approved", "final_approved", "hr_acknowledged"]);

/** The "YYYY-MM" month keys spanned by the window (capped at 24). */
function monthKeysIn(from: string, to: string): string[] {
  const start = `${from.slice(0, 7)}-01T00:00:00Z`;
  const endKey = to.slice(0, 7);
  const cursor = new Date(start);
  if (Number.isNaN(cursor.getTime())) return [];
  const keys: string[] = [];
  for (let i = 0; i < 24; i += 1) {
    const key = cursor.toISOString().slice(0, 7);
    keys.push(key);
    if (key >= endKey) break;
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return keys;
}

export async function getEmployee360TeamLifecycle(input: {
  teamHrIds: string[];
  employees: EmployeeDirectoryRow[];
  window: { from: string; to: string };
  now?: string;
}): Promise<TeamLifecycleSummary> {
  const teamKeys = new Set(
    input.teamHrIds.map((h) => canonicalHrIdKey(h)).filter((k): k is string => Boolean(k)),
  );
  const teamReps = input.employees.filter((e) => {
    const key = canonicalHrIdKey(e.hrId);
    return (
      key != null &&
      teamKeys.has(key) &&
      resolveEmployee360RoleCategory(e.jobTitle ?? e.positionTitle) === "medical-rep"
    );
  });
  if (teamReps.length === 0) return EMPTY;

  const repHrIdsUpper = teamReps.map((e) => e.hrId.toUpperCase());
  // Map the deduction-pipeline compact key back to a canonical HR_ID key.
  const compactToKey = new Map<string, string>();
  for (const e of teamReps) {
    const key = canonicalHrIdKey(e.hrId);
    const compact = compactDeductionHrId(e.hrId);
    if (key && compact) compactToKey.set(compact, key);
  }
  const months = monthKeysIn(input.window.from, input.window.to);

  const [plans, discipline] = await Promise.all([
    fetchPlanCompliance(repHrIdsUpper, input.window),
    fetchFieldDiscipline([...compactToKey.keys()], months, compactToKey),
  ]);

  // Probation — canonical rule: hire_date + 90 days > today.
  const today = input.now ? new Date(input.now) : new Date();
  const probationReps: TeamProbationRep[] = [];
  for (const e of teamReps) {
    if (!e.hireDate) continue;
    const end = new Date(`${String(e.hireDate).slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(end.getTime())) continue;
    end.setUTCDate(end.getUTCDate() + PROBATION_DAYS);
    const daysRemaining = Math.ceil((end.getTime() - today.getTime()) / 86_400_000);
    if (daysRemaining > 0) {
      probationReps.push({ hrId: e.hrId, name: e.displayName || e.fullName || e.hrId, daysRemaining });
    }
  }
  probationReps.sort((a, b) => a.daysRemaining - b.daysRemaining);

  const total = teamReps.length;
  return {
    hasData: true,
    repCount: total,
    planSubmittedCount: plans.submitted,
    planApprovedCount: plans.approved,
    planCoverageRate: total > 0 ? plans.submitted / total : 0,
    disciplineHasData: discipline.hasData,
    disciplineFlaggedReps: discipline.flaggedReps,
    disciplineNoActivityDays: discipline.noActivityDays,
    probationCount: probationReps.length,
    probationReps,
  };
}

async function fetchPlanCompliance(
  repHrIdsUpper: string[],
  window: { from: string; to: string },
): Promise<{ submitted: number; approved: number }> {
  const submitted = new Set<string>();
  const approved = new Set<string>();
  try {
    // PostgREST folds every .in() value into the request URL; an unbatched array of a few
    // hundred ids can push the URL past undici's ~16KB header limit and throw
    // "TypeError: fetch failed" / HeadersOverflowError — teamHrIds can be a manager's whole
    // org subtree (e.g. an NSM's line), so batch it.
    for (let i = 0; i < repHrIdsUpper.length; i += 100) {
      const batch = repHrIdsUpper.slice(i, i + 100);
      const { data } = await getSupabaseAdmin()
        .from("employee_plan_headers")
        .select("employee_hr_id, status")
        .eq("plan_kind", "weekly")
        .in("employee_hr_id", batch)
        .gte("period_start_date", window.from.slice(0, 10))
        .lte("period_start_date", window.to.slice(0, 10));
      for (const row of data ?? []) {
        const r = row as Record<string, unknown>;
        const key = canonicalHrIdKey(String(r.employee_hr_id ?? ""));
        const status = String(r.status ?? "");
        if (!key) continue;
        if (status !== "draft" && status !== "cancelled") submitted.add(key);
        if (APPROVED_PLAN_STATUSES.has(status)) approved.add(key);
      }
    }
  } catch {
    // employee_plan_headers unavailable — leave empty.
  }
  return { submitted: submitted.size, approved: approved.size };
}

async function fetchFieldDiscipline(
  compactKeys: string[],
  monthKeys: string[],
  compactToKey: Map<string, string>,
): Promise<{ hasData: boolean; flaggedReps: number; noActivityDays: number }> {
  if (compactKeys.length === 0 || monthKeys.length === 0) {
    return { hasData: false, flaggedReps: 0, noActivityDays: 0 };
  }
  try {
    // PostgREST folds every .in() value into the request URL; batch compactKeys since it can
    // span a manager's whole org subtree (see the header-overflow reasoning above).
    let noActivityDays = 0;
    const flagged = new Set<string>();
    for (let i = 0; i < compactKeys.length; i += 100) {
      const batch = compactKeys.slice(i, i + 100);
      const { data } = await getSupabaseAdmin()
        .from("deduction_candidates")
        .select("employee_hr_id_compact, deduction_type, dates")
        .eq("source_module", "FIELD_WORKFORCE")
        .is("superseded_at", null)
        .in("employee_hr_id_compact", batch)
        .in("month_key", monthKeys);
      for (const row of data ?? []) {
        const r = row as Record<string, unknown>;
        const key = compactToKey.get(String(r.employee_hr_id_compact ?? ""));
        if (!key) continue;
        flagged.add(key);
        if (String(r.deduction_type ?? "") === "no_activity") {
          noActivityDays += Array.isArray(r.dates) ? Math.max(1, r.dates.length) : 1;
        }
      }
    }
    return { hasData: true, flaggedReps: flagged.size, noActivityDays };
  } catch {
    return { hasData: false, flaggedReps: 0, noActivityDays: 0 };
  }
}
