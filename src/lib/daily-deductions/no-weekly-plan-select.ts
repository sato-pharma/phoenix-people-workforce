// Daily Deductions module: the PURE half of the No-weekly-plan connector. No DB, no I/O —
// the loaders live in no-weekly-plan.ts so this decision can be pinned by a test.
//
// Owner, 2026-10-12: "add a no weekly plans deduction of one day in the daily connectors if not
// submitted a weekly plan till monday of this week a 1 day deduction but never fired automatic
// always under the approval of system admin", narrowed minutes later to "this rule for head
// office employees only for now".
//
// ONE day per week, charged on that week's MONDAY — the day the obligation was breached, which is
// also what makes the daily module's clip-to-range meaningful.
//
// 🔴 NEVER AUTOMATIC. This connector is registered in the DAILY module only, never in
// `DEDUCTION_COLLECTORS`, so it cannot write the month ledger on a scan; the daily module's output
// is a tally the Super Admin publishes by hand, and the category row carries requires_approval =
// true. A test pins its absence from DEDUCTION_COLLECTORS.
//
// FOUR things never produce a charge:
//   1. A week before the policy started. Without this floor a run over an earlier month would
//      invent months of back-charges for a rule that did not exist yet.
//   2. Approved leave on the Monday — nobody owes a plan from their annual leave.
//   3. A person not yet hired (or already gone) on that Monday.
//   4. A person with no base salary: a day rate is Base Salary / days in month, so there is
//      nothing to take a fraction of.

import { calculateDeductionAmountFromBaseSalary } from "@/lib/deductions/calculations.ts";
import { compactDeductionsHrId } from "@/lib/deductions/candidate-key.ts";
import type { DeductionsCandidateDraft } from "@/lib/deductions/types.ts";

/**
 * 🔴 WHO OWES A WEEKLY PLAN — head office only, by his instruction, and an ALLOW-LIST on purpose.
 *
 * Measured on production 2026-10-12: of 17 active head-office employees, exactly three have
 * submitted a weekly plan since 1 August — the two Product Managers and the Group Product Manager.
 * The other fourteen (CEO, HR, Finance, R&D, QPPV, Regulatory, Talent Acquisition, Admin
 * Assistants, Buffet, Marketing Manager, SFE Manager) have never submitted one, so a rule phrased
 * as "every head-office employee" would charge each of them a day every week for an obligation
 * they do not have.
 *
 * The field force is out of scope twice over: it is not head office, and reps and district
 * managers plan in Phoenix CRM (`phoenix_crm_plans`, which carries its own due_on /
 * submitted_late), not in `employee_plan_headers` at all.
 *
 * 🔴 SINCE 14 NOV 2026 A PRODUCT MANAGER'S PLAN IS FOUND IN PHOENIX CRM TOO (owner, DR-02: Phoenix CRM is
 * the one plan store; the legacy form is closed — weekly-planning/legacy-closed.ts). They had planned
 * their weeks there since 17 Oct 2026 (`phoenix_crm_manager_plans`, planner kind `pm`) and stopped
 * filing the legacy form after 24 Oct, so a rule reading the legacy form alone would charge a day for a
 * week they did plan. A week counts when EITHER store holds a plan sent on time
 * (`onTimePhoenixCrmPlans`); who owes one, the deadline and the first Monday are unchanged.
 *
 * Widening this list is a one-line change — and it must stay a deliberate one.
 */
export const WEEKLY_PLAN_REQUIRED_TITLES: readonly string[] = [
  "product manager",
  "group product manager",
];

/**
 * The first Monday this rule can charge. The policy is new, so it is NOT retroactive: a run over
 * September must find nothing rather than back-charge every week the rule did not exist for.
 * 2026-10-12 is the Monday of the week he asked for it (2026-W41).
 */
export const WEEKLY_PLAN_POLICY_FIRST_MONDAY = "2026-10-12";

export function owesAWeeklyPlan(jobTitle: string | null | undefined): boolean {
  const normalized = String(jobTitle ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return normalized.length > 0 && WEEKLY_PLAN_REQUIRED_TITLES.includes(normalized);
}

/** One in-scope person, as the loader reads them. */
export type WeeklyPlanRosterEntry = {
  hrId: string;
  name: string | null;
  jobTitle: string | null;
  hireDate: string | null;
  /** Null while still employed. */
  endDate: string | null;
};

/** One week the range touches: its key and the Monday the charge lands on. */
export type WeeklyPlanWeek = {
  weekKey: string;
  mondayIso: string;
};

/** A weekly plan that was submitted ON TIME for (employee, week) — the loader resolves the deadline. */
export type OnTimeWeeklyPlan = {
  weekKey: string;
  /** Compact HR id (hyphens stripped). */
  employeeCompactKey: string;
};

/** One Phoenix CRM manager week, as the loader reads it (`phoenix_crm_manager_plans`). */
export type PhoenixCrmWeekSubmission = {
  hrId: string;
  /** The field week's first day, ISO date — a Saturday in Phoenix CRM. */
  weekStart: string;
  submittedAt: string | null;
};

function isoDayPlus(dateIso: string, days: number): string {
  const [year, month, day] = dateIso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** The one Monday inside a seven-day week that starts on `weekStartIso`; null for a malformed date. */
export function mondayInsideWeek(weekStartIso: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStartIso)) return null;
  for (let offset = 0; offset < 7; offset += 1) {
    const day = isoDayPlus(weekStartIso, offset);
    if (new Date(`${day}T00:00:00Z`).getUTCDay() === 1) return day;
  }
  return null;
}

/**
 * The Phoenix CRM weeks that count as a plan filed ON TIME for these weeks (DR-02, header above).
 *
 * A Phoenix CRM week runs seven days, so it holds exactly one Monday — the Monday this rule charges — and
 * it is judged by that Monday's deadline, exactly as a legacy plan is. `submitted_at` is the test here
 * too: sending the week is the employee's own act, approval is not. A week never sent counts as nothing.
 */
export function onTimePhoenixCrmPlans(input: {
  rows: readonly PhoenixCrmWeekSubmission[];
  weeks: readonly WeeklyPlanWeek[];
  /** The deadline instant (ms) for the Monday a charge lands on. */
  deadlineForMonday: (mondayIso: string) => number;
}): OnTimeWeeklyPlan[] {
  const weekByMonday = new Map(input.weeks.map((week) => [week.mondayIso, week]));
  const onTime: OnTimeWeeklyPlan[] = [];
  for (const row of input.rows) {
    if (!row.submittedAt) continue;
    const monday = mondayInsideWeek(row.weekStart);
    const week = monday ? weekByMonday.get(monday) : undefined;
    if (!monday || !week) continue;
    const submittedAt = Date.parse(row.submittedAt);
    if (!Number.isFinite(submittedAt) || submittedAt > input.deadlineForMonday(monday)) continue;
    const compactKey = compactDeductionsHrId(row.hrId);
    if (compactKey) onTime.push({ weekKey: week.weekKey, employeeCompactKey: compactKey });
  }
  return onTime;
}

export function selectNoWeeklyPlanDrafts(input: {
  roster: readonly WeeklyPlanRosterEntry[];
  weeks: readonly WeeklyPlanWeek[];
  /** Plans submitted by the Monday deadline — anything later is not a submission for this rule. */
  onTimePlans: readonly OnTimeWeeklyPlan[];
  /** Approved-leave dates per employee, keyed by the COMPACT hr-id. */
  approvedLeaveByCompact: ReadonlyMap<string, ReadonlySet<string>>;
  /** Base salary per employee, keyed by the COMPACT hr-id. */
  baseSalaryByCompact: ReadonlyMap<string, number | null>;
  month: number;
  year: number;
  /** Overridable only so a test can pin the floor; production always uses the constant. */
  policyFirstMonday?: string;
}): DeductionsCandidateDraft[] {
  const monthKey = `${input.year}-${String(input.month).padStart(2, "0")}`;
  const firstMonday = input.policyFirstMonday ?? WEEKLY_PLAN_POLICY_FIRST_MONDAY;
  const onTime = new Set(input.onTimePlans.map((plan) => `${plan.employeeCompactKey}\u0000${plan.weekKey}`));
  const drafts: DeductionsCandidateDraft[] = [];

  for (const person of input.roster) {
    if (!owesAWeeklyPlan(person.jobTitle)) continue;
    const compactKey = compactDeductionsHrId(person.hrId);
    if (!compactKey) continue;

    for (const week of input.weeks) {
      // 1. Never before the policy started.
      if (week.mondayIso < firstMonday) continue;
      // 2. Not yet hired, or already gone, on that Monday.
      if (person.hireDate && week.mondayIso < person.hireDate) continue;
      if (person.endDate && week.mondayIso > person.endDate) continue;
      // 3. Approved leave on the Monday.
      if (input.approvedLeaveByCompact.get(compactKey)?.has(week.mondayIso)) continue;
      // 4. The plan was in on time.
      if (onTime.has(`${compactKey}\u0000${week.weekKey}`)) continue;

      const estimatedAmount = calculateDeductionAmountFromBaseSalary({
        baseSalary: input.baseSalaryByCompact.get(compactKey) ?? null,
        deductionDays: 1,
        month: input.month,
        year: input.year,
      });
      // 5. No salary basis, no salary-based deduction.
      if (estimatedAmount == null) continue;

      drafts.push({
        category: "no_weekly_plan",
        sourceSystem: "weekly_plan_submission",
        sourceRecordId: `${person.hrId}:${week.weekKey}`,
        employeeHrId: person.hrId,
        employeeName: person.name,
        monthKey,
        month: input.month,
        year: input.year,
        unit: "days",
        rawValue: 1,
        estimatedAmount,
        calculationStatus: "calculated" as const,
        reason: `No weekly plan submitted for ${week.weekKey} by Monday ${week.mondayIso} (23:59 Cairo)`,
        evidence: { weekKey: week.weekKey, deadlineDate: week.mondayIso },
        dates: [week.mondayIso],
      } satisfies DeductionsCandidateDraft);
    }
  }

  return drafts;
}
