// Daily Deductions module: the No-weekly-plan connector (I/O half). The rules live in
// no-weekly-plan-select.ts — read its header first; it carries the owner's wording, the
// head-office allow-list and the four guards.

import { getApprovedLeaveDayMap } from "@/lib/attendance/working-days";
import { compactDeductionsHrId } from "@/lib/deductions/candidate-key.ts";
import { assertBaseSalaryMapLoaded } from "@/lib/deductions/connectors/health.ts";
import type { DeductionsCandidateDraft } from "@/lib/deductions/types.ts";
import { getBaseSalaryMap } from "@/lib/payroll/copilot/feeders.ts";
import { loadManagerPlansInRange } from "@/lib/phoenix-crm/server/manager-plan-readers";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { buildWeekKey, planDeductionGraceDeadlineForMonday } from "@/lib/weekly-planning/week";
import {
  onTimePhoenixCrmPlans,
  owesAWeeklyPlan,
  selectNoWeeklyPlanDrafts,
  type PhoenixCrmWeekSubmission,
  type OnTimeWeeklyPlan,
  type WeeklyPlanRosterEntry,
  type WeeklyPlanWeek,
} from "./no-weekly-plan-select.ts";

function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * Every Monday inside the month, with the week key its plan is filed under.
 *
 * The charge lands on the Monday, so the month that owns a week is the month that owns its
 * Monday — a week straddling month end is charged once, in one month, never split or doubled.
 */
export function mondaysInMonth(input: { month: number; year: number }): WeeklyPlanWeek[] {
  const weeks: WeeklyPlanWeek[] = [];
  const days = lastDayOfMonth(input.year, input.month);
  for (let day = 1; day <= days; day += 1) {
    const date = new Date(Date.UTC(input.year, input.month - 1, day));
    if (date.getUTCDay() !== 1) continue; // 1 = Monday
    const mondayIso = `${input.year}-${String(input.month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    weeks.push({ weekKey: buildWeekKey(mondayIso), mondayIso });
  }
  return weeks;
}

async function loadHeadOfficeRoster(): Promise<WeeklyPlanRosterEntry[]> {
  // EVERY active person, page by page: a person cut off by a response ceiling would never be asked
  // for a plan, and so never charged for a missing one.
  let data: Array<Record<string, unknown>>;
  try {
    data = await fetchAllRows<Record<string, unknown>>(
      () =>
        getSupabaseAdmin()
          .from("employees")
          // `last_working_date`, NOT `end_date` — there is no such column, and PostgREST fails the WHOLE
          // read with 42703 rather than one field, which `loadHeadOfficeRoster`'s fail-closed throw then
          // surfaces as "Failed to load the weekly-plan roster". Caught by a live dry run, 2026-10-12.
          // Only resigned/terminated rows carry it (112 active employees, 0 with a date), so for an
          // active person it is null and the span guard is inert.
          .select("hr_id,full_name,job_title,hire_date,last_working_date")
          .eq("employment_status", "active"),
      "hr_id",
    );
  } catch (error) {
    // Fail closed — an empty roster would silently report "nobody owes a plan".
    throw new Error(`Failed to load the weekly-plan roster: ${(error as { message?: string } | null)?.message ?? String(error)}`);
  }
  return data
    .map((row) => ({
      hrId: String(row.hr_id ?? "").trim(),
      name: (row.full_name as string | null) ?? null,
      jobTitle: (row.job_title as string | null) ?? null,
      hireDate: (row.hire_date as string | null) ?? null,
      endDate: (row.last_working_date as string | null) ?? null,
    }))
    .filter((person) => person.hrId.length > 0 && owesAWeeklyPlan(person.jobTitle));
}

/**
 * The weekly plans that were submitted ON TIME for these weeks.
 *
 * `submitted_at` is the test, NOT the status: the employee's own act is submitting, and whether a
 * manager has got round to approving it is not theirs to control. (That is the opposite of the
 * Private Calendar's approved-plan rule, which answers a different question — did the day have
 * signed-off planned work.) A header with no `submitted_at` is a draft and counts as nothing.
 */
async function loadOnTimePlans(weeks: readonly WeeklyPlanWeek[]): Promise<OnTimeWeeklyPlan[]> {
  if (weeks.length === 0) return [];
  // EVERY submission, page by page: a plan cut off by a response ceiling reads as "no plan filed",
  // and that person would be charged for a plan they submitted on time.
  let data: Array<{ employee_hr_id: string; period_key: string; submitted_at: string }>;
  try {
    data = await fetchAllRows<{ employee_hr_id: string; period_key: string; submitted_at: string }>(
      () =>
        getSupabaseAdmin()
          .from("employee_plan_headers")
          .select("employee_hr_id,period_key,submitted_at")
          .eq("plan_kind", "weekly")
          .in("period_key", weeks.map((week) => week.weekKey))
          .not("submitted_at", "is", null),
      "id",
    );
  } catch (error) {
    throw new Error(`Failed to load weekly plan submissions: ${(error as { message?: string } | null)?.message ?? String(error)}`);
  }

  // Keyed by week, but the deadline is computed from the MONDAY the charge lands on — never from
  // the week key (planDeductionGraceDeadlineForMonday's header says why that matters).
  const deadlineByWeek = new Map(weeks.map((week) => [week.weekKey, planDeductionGraceDeadlineForMonday(week.mondayIso).getTime()]));
  const onTime: OnTimeWeeklyPlan[] = [];
  for (const row of data) {
    const deadline = deadlineByWeek.get(row.period_key);
    const submittedAt = Date.parse(row.submitted_at);
    if (deadline == null || !Number.isFinite(submittedAt) || submittedAt > deadline) continue;
    const compactKey = compactDeductionsHrId(row.employee_hr_id);
    if (compactKey) onTime.push({ weekKey: row.period_key, employeeCompactKey: compactKey });
  }

  // DR-02 (owner, 14 Nov 2026): the week sent in Phoenix CRM counts too — the legacy form is closed. Read
  // the same way, fail closed the same way: a plan we could not read must never become a charge.
  const crmRows = await loadPhoenixCrmWeekSubmissions(weeks);
  onTime.push(
    ...onTimePhoenixCrmPlans({
      rows: crmRows,
      weeks,
      deadlineForMonday: (mondayIso) => planDeductionGraceDeadlineForMonday(mondayIso).getTime(),
    }),
  );
  return onTime;
}

/**
 * Every Phoenix CRM manager week that could hold one of these Mondays, through the module's one door for
 * outside screens (manager-plan-readers.ts) — every page, test personas never. A failed read throws.
 */
async function loadPhoenixCrmWeekSubmissions(weeks: readonly WeeklyPlanWeek[]): Promise<PhoenixCrmWeekSubmission[]> {
  const mondays = weeks.map((week) => week.mondayIso).sort();
  try {
    const plans = await loadManagerPlansInRange({ from: mondays[0], to: mondays[mondays.length - 1], isTest: false });
    return plans.map((plan) => ({ hrId: plan.managerHrId, weekStart: plan.weekStart, submittedAt: plan.submittedAt }));
  } catch (error) {
    throw new Error(`Failed to load the Phoenix CRM weekly plans: ${(error as { message?: string } | null)?.message ?? String(error)}`);
  }
}

/** Approved leave re-keyed by the COMPACT hr id the rest of the deductions module uses. */
async function loadApprovedLeaveByCompact(input: {
  dateFromIso: string;
  dateToIso: string;
}): Promise<Map<string, Set<string>>> {
  const byAttendanceKey = await getApprovedLeaveDayMap(input);
  const byCompact = new Map<string, Set<string>>();
  for (const [key, dates] of byAttendanceKey) {
    const compactKey = compactDeductionsHrId(key);
    if (!compactKey) continue;
    const existing = byCompact.get(compactKey);
    if (existing) for (const date of dates) existing.add(date);
    else byCompact.set(compactKey, new Set(dates));
  }
  return byCompact;
}

export async function collectNoWeeklyPlanCandidates(input: {
  month: number;
  year: number;
}): Promise<DeductionsCandidateDraft[]> {
  const weeks = mondaysInMonth(input);
  if (weeks.length === 0) return [];

  const monthKey = `${input.year}-${String(input.month).padStart(2, "0")}`;
  const [roster, onTimePlans, approvedLeaveByCompact, baseSalaryByCompact] = await Promise.all([
    loadHeadOfficeRoster(),
    loadOnTimePlans(weeks),
    loadApprovedLeaveByCompact({
      dateFromIso: `${monthKey}-01`,
      dateToIso: `${monthKey}-${String(lastDayOfMonth(input.year, input.month)).padStart(2, "0")}`,
    }),
    getBaseSalaryMap(),
  ]);
  assertBaseSalaryMapLoaded("No weekly plan connector", baseSalaryByCompact);

  return selectNoWeeklyPlanDrafts({
    roster,
    weeks,
    onTimePlans,
    approvedLeaveByCompact,
    baseSalaryByCompact,
    month: input.month,
    year: input.year,
  });
}
