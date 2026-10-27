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
//
// WHO IS ON THE TEAM (owner, 2026-10-20: "every single role that is applicable to appear in a
// module — find it and show it"): the Medical Reps AND the district and regional managers anywhere
// beneath the subject, never the subject himself. Until then only Medical Reps were kept, so a
// Regional or National Sales Manager's page said nothing about the district managers under him —
// their probation, their weekly plans or their no-activity flags. A manager's weekly plan is his
// Phoenix CRM manager week (`phoenix_crm_manager_plans`), counted by the same pure rule as a rep's.
// Team Health (team-health.ts) stays rep-only on purpose: its figures are per-rep field work.

import { compactDeductionsHrId } from "@/lib/deductions/candidate-key";
import { resolveEmployee360RoleCategory, type Employee360RoleCategory } from "@/lib/employee-360/roles";
import { countTeamPlanCompliance, type RepWeekPlanRow } from "@/lib/employee-360/team-plan-compliance";
import { isActiveLifecycleStatus, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { loadManagerPlansInRange } from "@/lib/phoenix-crm/server/manager-plan-readers";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";
import { probationDaysRemaining } from "@/lib/probation/date";
import { isMedicalRepresentativeTitle } from "@/lib/probation/intelligence/cases";
import { ownTerritories, personKey } from "@/lib/phoenix-crm/scope";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type TeamProbationRep = { hrId: string; name: string; daysRemaining: number };

export type TeamLifecycleSummary = {
  hasData: boolean;
  repCount: number; // Medical Reps beneath the subject
  managerCount: number; // district and regional managers beneath the subject (owner, 2026-10-20)
  // Weekly-plan compliance in the window — the reps' Phoenix CRM weeks and the managers' Phoenix
  // CRM manager weeks (team-plan-compliance.ts)
  // Null when a plan read failed: the screen prints "—" and the reason, never a zero nobody measured.
  planSubmittedCount: number | null; // people with >=1 week sent (submitted, approved or returned)
  planApprovedCount: number | null; // people with >=1 approved week
  planCoverageRate: number | null; // planSubmittedCount / (repCount + managerCount)
  /** Why the plan figures are null, in plain words; null when they were read. */
  planUnavailableReason: string | null;
  // Field discipline — confirmed no-activity deduction flags in the window's months.
  disciplineHasData: boolean;
  disciplineFlaggedReps: number; // distinct team members with a live no-activity flag
  disciplineNoActivityDays: number; // total confirmed no-activity days across the team
  // Probation — the tracker's own rule: a Medical Rep still inside hire + 90 days, counted on the Cairo calendar
  probationCount: number;
  probationReps: TeamProbationRep[];
};

/** The managers kept on a manager's team beside his Medical Reps. */
const TEAM_MANAGER_CATEGORIES = new Set<Employee360RoleCategory>(["district-manager", "regional-manager"]);

/**
 * Split the subject's subtree into the Medical Reps and the district/regional managers beneath him.
 * The subject himself is never his own team member, and a person listed twice is counted once.
 * Only the people working today are on the team (2026-10-27): Dina Hamdy's page read "Plans 3 / 10" because six
 * people who had left still named her as their manager; her team is four, so the true figure is 3 / 4.
 * Pure, so the membership rule is pinned without a database.
 */
export function selectTeamLifecycleMembers(input: {
  subjectHrId: string;
  teamHrIds: string[];
  employees: EmployeeDirectoryRow[];
}): { reps: EmployeeDirectoryRow[]; managers: EmployeeDirectoryRow[] } {
  const subjectKey = canonicalHrIdKey(input.subjectHrId);
  const teamKeys = new Set(
    input.teamHrIds.map((h) => canonicalHrIdKey(h)).filter((k): k is string => Boolean(k)),
  );
  const seen = new Set<string>();
  const reps: EmployeeDirectoryRow[] = [];
  const managers: EmployeeDirectoryRow[] = [];
  for (const e of input.employees) {
    const key = canonicalHrIdKey(e.hrId);
    if (key == null || !teamKeys.has(key) || key === subjectKey || seen.has(key)) continue;
    if (!isActiveLifecycleStatus(e.employmentStatus)) continue;
    const category = resolveEmployee360RoleCategory(e.jobTitle ?? e.positionTitle);
    if (category === "medical-rep") reps.push(e);
    else if (category && TEAM_MANAGER_CATEGORIES.has(category)) managers.push(e);
    else continue;
    seen.add(key);
  }
  return { reps, managers };
}

const EMPTY: TeamLifecycleSummary = {
  hasData: false,
  repCount: 0,
  managerCount: 0,
  planSubmittedCount: 0,
  planApprovedCount: 0,
  planCoverageRate: 0,
  planUnavailableReason: null,
  disciplineHasData: false,
  disciplineFlaggedReps: 0,
  disciplineNoActivityDays: 0,
  probationCount: 0,
  probationReps: [],
};

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
  /** The manager whose report this is — never counted on his own team. */
  subjectHrId: string;
  /** The subject's whole subtree (the subject may be in it; he is left out). */
  teamHrIds: string[];
  employees: EmployeeDirectoryRow[];
  window: { from: string; to: string };
  now?: string;
}): Promise<TeamLifecycleSummary> {
  const { reps: teamReps, managers: teamManagers } = selectTeamLifecycleMembers(input);
  const teamPeople = [...teamReps, ...teamManagers];
  if (teamPeople.length === 0) return EMPTY;

  // Map the deduction-pipeline compact key back to a canonical HR_ID key.
  const compactToKey = new Map<string, string>();
  for (const e of teamPeople) {
    const key = canonicalHrIdKey(e.hrId);
    const compact = compactDeductionsHrId(e.hrId);
    if (key && compact) compactToKey.set(compact, key);
  }
  const months = monthKeysIn(input.window.from, input.window.to);

  const [repPlans, managerPlans, discipline] = await Promise.all([
    fetchPlanCompliance(teamReps, input.window),
    fetchManagerPlanCompliance(teamManagers, input.window),
    fetchFieldDiscipline([...compactToKey.keys()], months, compactToKey),
  ]);

  // Probation — the tracker's rule (probation/service.ts): Medical Reps only (owner, 2026-07-17), days left counted
  // on the Cairo calendar by the canonical helper. A hand-rolled UTC count here read 5 for Dina where the tracker reads 2.
  const today = input.now ? new Date(input.now) : new Date();
  const probationReps: TeamProbationRep[] = [];
  for (const e of teamReps) {
    if (!isMedicalRepresentativeTitle(e.positionTitle ?? e.jobTitle)) continue;
    const daysRemaining = probationDaysRemaining(e.hireDate, today);
    if (daysRemaining != null && daysRemaining > 0) {
      probationReps.push({ hrId: e.hrId, name: e.displayName || e.fullName || e.hrId, daysRemaining });
    }
  }
  probationReps.sort((a, b) => a.daysRemaining - b.daysRemaining);

  return {
    hasData: true,
    repCount: teamReps.length,
    managerCount: teamManagers.length,
    ...combinePlanCompliance(repPlans, managerPlans, teamPeople.length),
    disciplineHasData: discipline.hasData,
    disciplineFlaggedReps: discipline.flaggedReps,
    disciplineNoActivityDays: discipline.noActivityDays,
    probationCount: probationReps.length,
    probationReps,
  };
}

type PlanCounts = { submitted: number; approved: number };

/**
 * PURE. The reps' and the managers' plan counts as the panel's plan figures. The two are disjoint sets of people, so
 * the counts add. Either read having failed (null) makes every plan figure null with the reason — a half-read team is
 * not a figure, and a zero would say nobody planned.
 */
export function combinePlanCompliance(
  repPlans: PlanCounts | null,
  managerPlans: PlanCounts | null,
  total: number,
): Pick<TeamLifecycleSummary, "planSubmittedCount" | "planApprovedCount" | "planCoverageRate" | "planUnavailableReason"> {
  if (!repPlans || !managerPlans) {
    return {
      planSubmittedCount: null,
      planApprovedCount: null,
      planCoverageRate: null,
      planUnavailableReason: "The weekly plans could not be read just now.",
    };
  }
  const submitted = repPlans.submitted + managerPlans.submitted;
  return {
    planSubmittedCount: submitted,
    planApprovedCount: repPlans.approved + managerPlans.approved,
    planCoverageRate: total > 0 ? submitted / total : 0,
    planUnavailableReason: null,
  };
}

/**
 * The team reps' Phoenix CRM weeks starting inside the window — a Medical Rep's weekly plan lives
 * there, never in the legacy `employee_plan_headers` (the rules are in team-plan-compliance.ts).
 * A failed read is null, so the tiles say "—" with the reason, never zero.
 */
async function fetchPlanCompliance(
  teamReps: EmployeeDirectoryRow[],
  window: { from: string; to: string },
): Promise<PlanCounts | null> {
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
  } catch (error) {
    // The org tree or phoenix_crm_plans unavailable — unknown, never zero.
    console.error("[employee-360] the team's weekly plans could not be read", error);
    return null;
  }
}

/**
 * The team managers' Phoenix CRM manager weeks starting inside the window, counted by the same rule as
 * a rep's week (owner, 2026-10-20). A manager's week is keyed by HIS HR id, never a seat, so each row
 * is credited to the manager who owns it. A failed read is null, never zero.
 */
async function fetchManagerPlanCompliance(
  teamManagers: EmployeeDirectoryRow[],
  window: { from: string; to: string },
): Promise<PlanCounts | null> {
  if (teamManagers.length === 0) return { submitted: 0, approved: 0 };
  try {
    // The manager-plan readers store and return a personKey; the team is keyed by canonicalHrIdKey.
    const teamKeyByPerson = new Map<string, string>();
    for (const manager of teamManagers) {
      const person = personKey(manager.hrId);
      const key = canonicalHrIdKey(manager.hrId);
      if (person && key) teamKeyByPerson.set(person, key);
    }
    const from = window.from.slice(0, 10);
    const to = window.to.slice(0, 10);
    const plans = await loadManagerPlansInRange({ from, to, managerHrIds: [...teamKeyByPerson.keys()] });
    const rows: RepWeekPlanRow[] = plans
      // The reader returns every week that TOUCHES the window; a rep's tile counts the weeks that
      // START inside it, so the manager's does too.
      .filter((plan) => plan.weekStart >= from && plan.weekStart <= to)
      .map((plan) => ({
        seatId: `manager-week:${plan.managerHrId}`,
        weekStart: plan.weekStart,
        status: plan.status,
        submittedAt: plan.submittedAt,
        submittedByHrId: plan.managerHrId,
      }));
    return countTeamPlanCompliance({
      rows,
      repKeyBySeat: new Map(),
      repKeyOf: (hrId) => teamKeyByPerson.get(personKey(hrId) ?? "") ?? null,
    });
  } catch (error) {
    // phoenix_crm_manager_plans unavailable — unknown, never zero.
    console.error("[employee-360] the team managers' weekly plans could not be read", error);
    return null;
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
      // Unified Deductions module: a confirmed no-activity day is category `no_records_activity` (legacy
      // deduction_type = "no_activity"). The `crm` category is a CRM-data deduction, not an absence — counting it
      // here put three people on Dina's "No-activity flags" tile who had no no-activity day at all (2026-10-27).
      const { data, error } = await getSupabaseAdmin()
        .from("deductions_candidates")
        .select("employee_hr_id_compact, dates")
        .eq("category", "no_records_activity")
        .is("superseded_at", null)
        .in("employee_hr_id_compact", batch)
        .in("month_key", monthKeys);
      // A failed read is "—", never a zero that says nobody was flagged.
      if (error) throw error;
      for (const row of data ?? []) {
        const r = row as Record<string, unknown>;
        const key = compactToKey.get(String(r.employee_hr_id_compact ?? ""));
        if (!key) continue;
        flagged.add(key);
        noActivityDays += Array.isArray(r.dates) ? Math.max(1, r.dates.length) : 1;
      }
    }
    return { hasData: true, flaggedReps: flagged.size, noActivityDays };
  } catch (error) {
    console.error("[employee-360] the team's no-activity flags could not be read", error);
    return { hasData: false, flaggedReps: 0, noActivityDays: 0 };
  }
}
