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

import { compactDeductionsHrId } from "@/lib/deductions/candidate-key";
import { resolveEmployee360RoleCategory } from "@/lib/employee-360/roles";
import { countTeamPlanCompliance, type RepWeekPlanRow } from "@/lib/employee-360/team-plan-compliance";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";
import { ownTerritories } from "@/lib/phoenix-crm/scope";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type TeamProbationRep = { hrId: string; name: string; daysRemaining: number };

export type TeamLifecycleSummary = {
  hasData: boolean;
  repCount: number;
  // Weekly-plan compliance in the window — the reps' Phoenix CRM weeks (team-plan-compliance.ts)
  planSubmittedCount: number; // reps with >=1 week sent (submitted, approved or returned)
  planApprovedCount: number; // reps with >=1 approved week
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

  // Map the deduction-pipeline compact key back to a canonical HR_ID key.
  const compactToKey = new Map<string, string>();
  for (const e of teamReps) {
    const key = canonicalHrIdKey(e.hrId);
    const compact = compactDeductionsHrId(e.hrId);
    if (key && compact) compactToKey.set(compact, key);
  }
  const months = monthKeysIn(input.window.from, input.window.to);

  const [plans, discipline] = await Promise.all([
    fetchPlanCompliance(teamReps, input.window),
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

/**
 * The team reps' Phoenix CRM weeks starting inside the window — a Medical Rep's weekly plan lives
 * there, never in the legacy `employee_plan_headers` (the rules are in team-plan-compliance.ts).
 * Best-effort like the rest of this panel: a failed read leaves the tiles at zero.
 */
async function fetchPlanCompliance(
  teamReps: EmployeeDirectoryRow[],
  window: { from: string; to: string },
): Promise<{ submitted: number; approved: number }> {
  try {
    const org = await loadPhoenixCrmOrg();
    const repKeyBySeat = new Map<string, string>();
    const teamKeys = new Set<string>();
    for (const rep of teamReps) {
      const key = canonicalHrIdKey(rep.hrId);
      if (!key) continue;
      teamKeys.add(key);
      for (const seat of ownTerritories(org, rep.hrId)) repKeyBySeat.set(seat.seatId, key);
    }
    const seatIds = [...repKeyBySeat.keys()];
    const rows: RepWeekPlanRow[] = [];
    // PostgREST folds every .in() value into the request URL; an unbatched array of a few
    // hundred ids can push the URL past undici's ~16KB header limit and throw
    // "TypeError: fetch failed" / HeadersOverflowError — a manager's team can be his whole
    // org subtree (e.g. an NSM's line), so batch it.
    for (let i = 0; i < seatIds.length; i += 100) {
      const batch = seatIds.slice(i, i + 100);
      const { data, error } = await getSupabaseAdmin()
        .from("phoenix_crm_plans")
        .select("seat_id, week_start, status, submitted_at, submitted_by_hr_id")
        .in("seat_id", batch)
        .eq("is_test", false)
        .gte("week_start", window.from.slice(0, 10))
        .lte("week_start", window.to.slice(0, 10));
      if (error) throw error;
      for (const row of (data ?? []) as Array<Record<string, unknown>>) {
        rows.push({
          seatId: String(row.seat_id ?? ""),
          weekStart: String(row.week_start ?? "").slice(0, 10),
          status: String(row.status ?? ""),
          submittedAt: typeof row.submitted_at === "string" ? row.submitted_at : null,
          submittedByHrId: typeof row.submitted_by_hr_id === "string" ? row.submitted_by_hr_id : null,
        });
      }
    }
    return countTeamPlanCompliance({
      rows,
      repKeyBySeat,
      repKeyOf: (hrId) => {
        const key = canonicalHrIdKey(hrId ?? "");
        return key && teamKeys.has(key) ? key : null;
      },
    });
  } catch {
    // The org tree or phoenix_crm_plans unavailable — leave empty.
    return { submitted: 0, approved: 0 };
  }
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
      // Unified Deductions module. Legacy governance filed field-workforce discipline
      // under source_module = "FIELD_WORKFORCE"; here it splits into two categories —
      // `no_records_activity` (the old deduction_type = "no_activity") and `crm`. Both
      // count toward a flagged rep; only `no_records_activity` counts as no-activity days.
      const { data } = await getSupabaseAdmin()
        .from("deductions_candidates")
        .select("employee_hr_id_compact, category, dates")
        .in("category", ["no_records_activity", "crm"])
        .is("superseded_at", null)
        .in("employee_hr_id_compact", batch)
        .in("month_key", monthKeys);
      for (const row of data ?? []) {
        const r = row as Record<string, unknown>;
        const key = compactToKey.get(String(r.employee_hr_id_compact ?? ""));
        if (!key) continue;
        flagged.add(key);
        if (String(r.category ?? "") === "no_records_activity") {
          noActivityDays += Array.isArray(r.dates) ? Math.max(1, r.dates.length) : 1;
        }
      }
    }
    return { hasData: true, flaggedReps: flagged.size, noActivityDays };
  } catch {
    return { hasData: false, flaggedReps: 0, noActivityDays: 0 };
  }
}
