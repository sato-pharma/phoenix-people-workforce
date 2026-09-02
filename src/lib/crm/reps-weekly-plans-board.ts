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
import { loadPlanActuals } from "@/lib/crm/plan-actuals-data";
import { buildPlanDoctorDays, indexContactList, type PlanDoctorDay } from "@/lib/crm/plan-doctors";
import {
  countRepPlanStatuses,
  repMatchesPlanStatusFilter,
  resolvePlanStatusFilter,
  type PlanStatusCounts,
  type PlanStatusFilter,
} from "@/lib/crm/plan-status-filter";
import { PLAN_STATUS_NEW } from "@/lib/crm/plan-verification";
import { cairoTodayIso, listPlanWeeks, resolvePlanWeek, weekEndFor, type PlanWeek } from "@/lib/crm/plan-week";
import { getRepsListForAgent } from "@/lib/crm/reps-list";
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
  /**
   * The week's four totals, counted over the viewer's WHOLE reach and BEFORE the status filter.
   *
   * The tiles read these rather than counting `reps`, which is filtered. A tile that recounted the
   * filtered list would show 0 for every group the manager is not currently looking at — including
   * the one he needs to click to get back — so the filter would be a door that locks behind him.
   */
  counts: PlanStatusCounts;
  /**
   * The plan on screen, GROUPED BY DAY and joined to the rep's contact list — what the table
   * renders. The owner, 2026-09-01: "differentiate day by day, group day by day", and make the
   * table "exactly as in the contact list". Empty when no plan is selected.
   */
  days: PlanDoctorDay[];
  /**
   * The same doctors, flat and unjoined. Kept beside `days` because the tiles count over them and
   * because it is the honest record of what the PLAN says, before anything the contact list adds.
   */
  entries: PlanEntryRow[];
  options: CoverageFilterOptions;
  /** Every plan the selected rep filed for this week, newest-status-first. */
  plans: PlanSummary[];
  /** The reps the grid offers, AFTER the status filter. */
  reps: RepsWeeklyPlanRep[];
  scopeLabel: string;
  scopeReason: string | null;
  selected: RepsWeeklyPlanRep | null;
  /** The plan whose doctors are listed, when one is in scope. */
  selectedPlan: PlanSummary | null;
  selection: CoverageFilterSelection;
  /** Which slice of the week the grid is showing. `"all"` when the manager has not narrowed it. */
  statusFilter: PlanStatusFilter;
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
  status?: string;
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
    days: [] as PlanDoctorDay[],
    entries: [] as PlanEntryRow[],
    options: cascade.options,
    plans: [] as PlanSummary[],
    scopeLabel: cascade.scopeLabel,
    scopeReason: cascade.scopeReason,
    selectedPlan: null,
    selection: cascade.selection,
    statusFilter: resolvePlanStatusFilter(input.params.status),
    syncedAt: cascade.syncedAt,
    week,
    weeks,
  };

  if (input.scope.kind === "none") {
    return { ...base, counts: countRepPlanStatuses([]), reps: [], selected: null };
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

  const withPlanStatus = (rep: RepsListRep): RepsWeeklyPlanRep => {
    const filed = rep.agentCrmId == null ? [] : (plansByAgent.get(rep.agentCrmId) ?? []);
    return {
      ...rep,
      planStatus: foldRepPlanStatus(filed),
      plansFiled: filed.length,
    };
  };

  const allReps: RepsWeeklyPlanRep[] = cascade.reps.map(withPlanStatus);

  // COUNTED OVER `repsIgnoringRep`, NOT OVER `allReps`, and the difference only shows once a rep is
  // open: the cascade narrows `reps` to that one person, so counting it made the status picker read
  // "All reps (1) · Awaiting verification (1) · Verified (0) · No plan filed (0)" on a board whose
  // real week is 70 · 3 · 61 · 6. Every option then described the rep the manager was already
  // looking at, while the place it navigates to — the picker drops the rep — held the other numbers.
  // Counted here, the control says what it will show.
  const counts = countRepPlanStatuses(cascade.repsIgnoringRep.map(withPlanStatus));
  const reps = allReps.filter((rep) => repMatchesPlanStatusFilter(rep, base.statusFilter));

  // THE SELECTED REP IS LOOKED UP IN THE UNFILTERED LIST, on purpose. The status filter narrows what
  // the grid offers to browse; it must not be able to hide a rep the manager has already opened.
  // Searching `reps` instead would make a shared link carrying both `?rep=` and a `?status=` he does
  // not match render "filed no weekly plan" for a rep who filed one — the board accusing him of
  // something the URL did, with nothing on screen to say so.
  const selected = cascade.selected
    ? (allReps.find((rep) => rep.repKey === cascade.selected?.repKey) ?? null)
    : null;

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
  //
  // THE CONTACT LIST IS READ ALONGSIDE IT, and that is the second half of the owner's instruction
  // to make this table "exactly as in the contact list". The plan mirror holds a name, a grade, a
  // speciality and a CRM region; the brick, the observed address with its check-in date, the
  // confidence, the neighbours, the list type and the phone all live on the contact row. Copying
  // the contact list's column headings without this read would produce six columns with nothing to
  // put in four of them.
  //
  // The two reads run TOGETHER rather than in sequence. They are independent — one is keyed by plan,
  // the other by agent — and the contact read is the slower of the pair, so serialising them would
  // add its whole latency to the page for nothing.
  //
  // `getRepsListForAgent` NEVER THROWS OUT OF HERE. It is annotation on a plan the manager came to
  // sign; a contact mirror that was briefly unreachable must not be able to hide the plan itself.
  // The table then renders every row as "not on his list", which is what an empty index means.
  //
  // THE ACTUALS ARE THE THIRD READ, and the reason this tab now answers its own question. A manager
  // verifying last week's plan could read every doctor on it and had nothing here to say which of
  // them the rep reached; the answer lived on a different board behind a different filter.
  //
  // It rides in the same Promise.all for the same reason as the contact list — independent, keyed
  // differently, and serialising it would add its whole latency for nothing — and it NEVER throws
  // out of here either. `loadPlanActuals` answers null on a failed read AND on a departed agent,
  // and null renders as NO MARKS. A visits mirror that was briefly unreachable must not be able to
  // accuse a rep of a week he may well have worked, and the two states are indistinguishable to
  // anyone who is only ever shown red.
  //
  // WINDOWED ON THE PLAN'S OWN DAYS. `firstDate`/`lastDate` are derived from the plan's rows, so a
  // doctor seen the day after the plan ends cannot be credited to it — "seen another day" means
  // another day OF THIS PLAN.
  const [entries, contactList, actuals] = selectedPlan
    ? await Promise.all([
        getPlanEntries(selectedPlan.crmPlanId, selectedPlan.agentCrmId),
        getRepsListForAgent(selectedPlan.agentCrmId, cascade.repNameByAgentId).catch(() => null),
        selectedPlan.agentCrmId != null && selectedPlan.firstDate && selectedPlan.lastDate
          ? loadPlanActuals({
              agentCrmId: selectedPlan.agentCrmId,
              dateFrom: selectedPlan.firstDate,
              dateTo: selectedPlan.lastDate,
              // The board's OWN today, which a test can pin — never a second clock read. Two reads of
              // the wall clock in one assembly can straddle midnight, and the day a plan is judged
              // against would then differ from the week the board says it is showing.
              today: todayIso,
            })
          : null,
      ])
    : [[] as PlanEntryRow[], null, null];

  const days = buildPlanDoctorDays(entries, indexContactList(contactList), actuals);

  return { ...base, counts, days, entries, plans, reps, selected, selectedPlan };
}
