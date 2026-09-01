/**
 * Reps Weekly Plans — tab two of the Reps List board.
 *
 * The owner's specification, 2026-09-01: "another tab called Reps Weekly Plans... I can filter by
 * medical rep name, and then I can choose the week, either historical or in the future. If
 * historical, I see the status of this plan — was it verified or no. And if it will be not yet, I
 * have a verify button that every district manager can verify his medical reps plan."
 *
 * ## Why this exists when /admin/plan-verification already verifies plans
 *
 * Because a district manager cannot open that page. It lives in the ADMIN shell, and
 * `portalNavigationRoles` puts District Manager and Regional Manager in the EMPLOYEE PORTAL:
 * `app/(admin)/layout.tsx` redirects every portal-mode viewer out of `/admin/**`, no twin is
 * registered for it in `portal-twins.ts`, and the portal builds its own sidebar so the row never
 * appears either. The two seats that hold `crm_plans:approve` were the two that could not reach the
 * only screen that uses it — leaving Super Admin as the sole account able to press Verify, on a
 * feature specified as "the plans a district manager verifies". Nothing was broken, which is why
 * green CI and a clean deploy never showed it.
 *
 * So this is not a second door onto the same data. It is the first door for the seat the feature
 * was written for. The period-first board keeps its place as the company-wide view.
 *
 * ## The scope here is the PLAN scope, never the Reps List one
 *
 * `getDoctorListScope` admits National Sales Manager and SFE Manager company-wide;
 * `getPlanVerificationScope` deliberately admits neither, because reading a rep's list and signing
 * his plan are not the same authority (`plan-verification-access.ts`). This module therefore builds
 * even the rep PICKER from the plan scope: a cascade built from the wider one would offer a rep
 * whose plans the viewer may not see, and a picker is never wider than its viewer.
 */

import {
  getPlanEntries,
  getWeeklyPlansForWeek,
  type PlanEntryRow,
  type PlanSummary,
} from "@/lib/crm/plan-board";
import { PLAN_STATUS_NEW } from "@/lib/crm/plan-verification";
import { cairoTodayIso, listPlanWeeks, resolvePlanWeek, weekEndFor, type PlanWeek } from "@/lib/crm/plan-week";
import { buildRepsCascade, type RepsListRep } from "@/lib/crm/reps-list-board";
import type { CoverageFilterOptions, CoverageFilterSelection } from "@/lib/crm/coverage-filters";
import type { CrmManagerScope } from "@/lib/crm/manager-scope";

/** A rep card on this tab: the Reps List card plus what he filed for the chosen week. */
export type RepsWeeklyPlanRep = RepsListRep & {
  /**
   * The plan's CRM status for the chosen week, or null when he filed nothing.
   *
   * Null is NOT folded into "pending". A rep who filed nothing and a rep who filed and awaits his
   * manager are different facts, and the second is the only one the Verify button applies to.
   */
  planStatus: number | null;
  /** How many weekly plans he filed for this week. Almost always 0 or 1; more is worth seeing. */
  plansFiled: number;
};

export type RepsWeeklyPlansBoard = {
  /** The doctors on the plan on screen. Empty when no plan is selected. */
  entries: PlanEntryRow[];
  options: CoverageFilterOptions;
  /** Every plan the selected rep filed for this week, newest-status-first. */
  plans: PlanSummary[];
  reps: RepsWeeklyPlanRep[];
  scopeLabel: string;
  scopeReason: string | null;
  selected: RepsWeeklyPlanRep | null;
  /** The plan whose doctors are listed, when one is in scope. */
  selectedPlan: PlanSummary | null;
  selection: CoverageFilterSelection;
  syncedAt: string | null;
  /** The chosen week. */
  week: PlanWeek;
  /** What the picker offers, newest first — future weeks at the top. */
  weeks: PlanWeek[];
};

export type RepsWeeklyPlansParams = {
  area?: string;
  line?: string;
  plan?: string;
  region?: string;
  rep?: string;
  week?: string;
};

/**
 * The one status that stands for a rep’s whole week.
 *
 * THE LOWEST WINS. A rep with one pending plan is pending whatever else he filed, because pending
 * is the state that needs the manager and therefore the one that must surface — a rep whose second
 * plan is signed would otherwise read as done while the first still waits.
 *
 * Null is returned ONLY for a rep who filed nothing, and is never folded into pending. Those are
 * different facts: one is a rep who did not plan his week, the other is a manager who has not
 * signed it, and printing them the same way points the blame at the wrong person.
 *
 * A plan carrying no status at all counts as New — that is what the vendor sends on a fresh plan,
 * and reading it as verified would sign something nobody signed.
 */
export function foldRepPlanStatus(plans: readonly { status: number | null }[]): number | null {
  if (plans.length === 0) return null;
  return plans.reduce<number>(
    (lowest, plan) => Math.min(lowest, plan.status ?? PLAN_STATUS_NEW),
    Number.POSITIVE_INFINITY,
  );
}
export async function getRepsWeeklyPlansBoard(input: {
  params: RepsWeeklyPlansParams;
  scope: CrmManagerScope;
  /** Injectable so a test can pin a week without waiting for the calendar. */
  todayIso?: string;
}): Promise<RepsWeeklyPlansBoard> {
  const todayIso = input.todayIso ?? cairoTodayIso();
  const weeks = listPlanWeeks({ todayIso });
  const weekStart = resolvePlanWeek(input.params.week, todayIso);
  const week: PlanWeek = weeks.find((option) => option.key === weekStart) ?? {
    // A hand-typed week outside the offered range still resolves to a real week rather than an
    // error — the same falls-back-never-throws posture every other filter on these boards has.
    end: weekEndFor(weekStart),
    key: weekStart,
    label: weekStart,
    offset: 0,
    start: weekStart,
  };

  const cascade = await buildRepsCascade({ params: input.params, scope: input.scope });

  const base = {
    entries: [] as PlanEntryRow[],
    options: cascade.options,
    plans: [] as PlanSummary[],
    scopeLabel: cascade.scopeLabel,
    scopeReason: cascade.scopeReason,
    selectedPlan: null,
    selection: cascade.selection,
    syncedAt: cascade.syncedAt,
    week,
    weeks,
  };

  if (input.scope.kind === "none") {
    return { ...base, reps: [], selected: null };
  }

  // ONE read for the whole week across the viewer's reach, then matched in memory on the NUMERIC
  // agent id. Never on `agent_hr_id`: hr ids are mixed case in this database, and an under-returning
  // join here would tell a district manager his rep filed nothing — an accusation, and the worst
  // direction for this particular error to fall in.
  const weekPlans = await getWeeklyPlansForWeek({ scope: input.scope, weekEnd: week.end, weekStart: week.start });

  const plansByAgent = new Map<number, PlanSummary[]>();
  for (const plan of weekPlans) {
    const bucket = plansByAgent.get(plan.agentCrmId);
    if (bucket) bucket.push(plan);
    else plansByAgent.set(plan.agentCrmId, [plan]);
  }

  const reps: RepsWeeklyPlanRep[] = cascade.reps.map((rep) => {
    const filed = rep.agentCrmId == null ? [] : (plansByAgent.get(rep.agentCrmId) ?? []);
    return {
      ...rep,
      planStatus: foldRepPlanStatus(filed),
      plansFiled: filed.length,
    };
  });

  const selected = cascade.selected ? (reps.find((rep) => rep.repKey === cascade.selected?.repKey) ?? null) : null;

  const plans =
    selected?.agentCrmId == null
      ? []
      : [...(plansByAgent.get(selected.agentCrmId) ?? [])]
          .map((plan) => ({ ...plan, repName: selected.name }))
          .sort((left, right) => {
            // Pending first — this tab exists to clear a backlog, and the owner's standing rule is
            // that a screen answers its own question without the reader sorting it.
            const leftPending = (left.status ?? PLAN_STATUS_NEW) === PLAN_STATUS_NEW ? 0 : 1;
            const rightPending = (right.status ?? PLAN_STATUS_NEW) === PLAN_STATUS_NEW ? 0 : 1;
            if (leftPending !== rightPending) return leftPending - rightPending;
            return (left.firstDate ?? "").localeCompare(right.firstDate ?? "");
          });

  // A hand-typed plan id the rep does not own resolves to nothing, exactly as if it did not exist.
  // `plans` is already both scope-restricted and rep-restricted, so membership of it IS the check.
  const requestedPlanId = Number.parseInt(input.params.plan ?? "", 10);
  const selectedPlan =
    (Number.isFinite(requestedPlanId) && requestedPlanId > 0
      ? plans.find((plan) => plan.crmPlanId === requestedPlanId)
      : plans[0]) ?? null;

  // The agent id is passed so the doctors carry their addresses: the plan rows hold none, and the
  // address lives on the rep's own assigned list, which is keyed by agent.
  const entries = selectedPlan ? await getPlanEntries(selectedPlan.crmPlanId, selectedPlan.agentCrmId) : [];

  return { ...base, entries, plans, reps, selected, selectedPlan };
}
