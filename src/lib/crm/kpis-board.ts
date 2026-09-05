// ─────────────────────────────────────────────────────────────────────────────
// KPIs — the owner's three field measures on one board, one row per rep.
//
// This is the REBUILD ordered on 2026-08-28, when Doctor Coverage and Rep Doctor
// Lists were retired with the instruction to "rebuild from the beginning". Their
// fault was that two boards answered the same question with disagreeing measures
// — Doctor Coverage scored each doctor against the GRADE norm (A=2/B=1/C=1)
// instead of against the calls the rep's own plan asked for, wrong on 6,307 of
// 8,635 graded doctors. So this module assembles ONE row per rep from the sources
// that were already correct, and adds no fourth measure of its own.
//
// THE THREE KPIs (owner, restated 2026-09-02 and matching what already shipped):
//
//   CALL RATE  calls / working days, where a working day is Sat–Wed MINUS national
//              holidays. "If we have a national vacation in this week, then the
//              week will be four." Split AM (target 2) / PM (target 10) and by
//              proof, because a campaign call names no doctor and cannot be
//              checked by anybody — see crm/call-rate.ts.
//
//   COVERAGE   visitedDoctors / plannedDoctors, over the SCORED WINDOW. "I have a
//              hundred contacts in my list; how much did I cover from them?" One
//              visit is enough — grade and count are the other KPI's business.
//
//   FREQUENCY  onPlanDoctors / plannedDoctors, over the same window. "If he tell
//              three times and he visited three times, this is correct." Exact is
//              the ONLY pass: two is `under`, four is `over`, both deviations.
//
// THE WINDOW IS THE ONLY LEVER, and that is the 2026-09-04 change. Both plan KPIs
// divide by the WHOLE window's list — not by the part of it that has come due.
// Owner, that day: "you can show that until now, she covered twenty of hundred
// doctors ... so her coverage is twenty percent. Also, make an option to filter by
// period and choose, for example, one week, two weeks." So a rep two days into
// September reads 20% of his month, which is what 20% of a month looks like on the
// 4th; if that is not the question being asked, the Period picker answers the
// other one.
//
// It replaces a to-date denominator that shrank the divisor instead. That was
// arithmetically fair and unreadable: nobody could say what number it was out of,
// and the board printed "20 of 22 due so far" beside a list of a hundred. The
// owner asked for the plain fraction plus a period control, and the two together
// do the same job in a form a manager can see and steer. For a COMPLETE month the
// two bases are identical, so no closed month's number moved.
//
// COVERAGE AND FREQUENCY NOW HONOUR THE PERIOD PICKER, which until this change
// only narrowed the call rate: getRepDoctorLists was called with the month and
// nothing else, so picking week 1 left both plan KPIs on the whole month.
//
// WHY THE THREE DISAGREE, which is the first thing a manager asks. They measure
// different things on purpose: coverage asks whether the doctor was touched at
// all, frequency asks whether he was touched the right number of times, and call
// rate asks how much work was done per day regardless of who it was done on.
// Production has run 68% coverage against 39% frequency in the same month. The
// board prints all three side by side precisely so that gap is visible rather
// than being discovered as an apparent contradiction between two screens.
//
// SCOPE IS THE SECURITY BOUNDARY. Every row is filtered through
// getDoctorCoverageScope before it is returned — a District Manager sees his own
// reps and nobody else's. The nav config hiding a link is UX only.
// ─────────────────────────────────────────────────────────────────────────────

import {
  getDoctorCoverageScope,
  isAgentInScope,
  type DoctorCoverageScope,
} from "@/lib/crm/doctor-coverage-scope";
import {
  applyKpiFilters,
  buildKpiFacets,
  COVERAGE_TARGET_FLOOR_PCT,
  EMPTY_KPI_FILTERS,
  KPI_CUSTOM_PERIOD_VALUE,
  type KpiFacets,
  type KpiFilterState,
} from "@/lib/crm/kpis-filters";
import { keepMedicalRepsOnly } from "@/lib/crm/medical-rep";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { loadCallRateReport } from "@/lib/crm/call-rate-service";
import { countCallRateWorkingDays } from "@/lib/crm/call-rate";
import { loadCallRateHolidays } from "@/lib/crm/call-rate-holidays";
import { getRepDoctorLists, monthLabelOf, type RepDoctorListRepRow } from "@/lib/crm/rep-doctor-lists";
import { loadRepKpiReports } from "@/lib/crm/rep-kpi-reports-data";
import type { RepKpiReports } from "@/lib/crm/rep-kpi-reports";
import { repsPlansRange, repsPlansWeeks, type RepsPlansRange } from "@/lib/crm/reps-plans";
import {
  AM_CALL_RATE_TARGET,
  DAILY_VISIT_RATE_MAX,
  DAILY_VISIT_RATE_MIN,
  DAILY_VISIT_RATE_TARGET,
  PHARMACY_CALL_RATE_TARGET,
  PM_CALL_RATE_TARGET,
  dailyVisitBandOf,
  verifiedVisitsPerDay,
  type DailyVisitBand,
  type RepCallRate,
} from "@/lib/crm/call-rate";
import type { AccessContext } from "@/lib/auth/permissions";

/** One option in the board's month or period picker. */
export type KpiPeriodOption = { label: string; value: string };

/**
 * The months the picker offers, newest first.
 *
 * String arithmetic on the date, never Date parsing — a `new Date(todayIso)` here would be UTC
 * midnight and could land in the previous month for a Cairo caller just after midnight, which is
 * exactly when this app is often being used.
 */
export function kpiMonthOptions(todayIso: string, count = 12): KpiPeriodOption[] {
  const options: KpiPeriodOption[] = [];
  let year = Number(todayIso.slice(0, 4));
  let month = Number(todayIso.slice(5, 7));
  if (!Number.isFinite(year) || !Number.isFinite(month)) return options;
  for (let index = 0; index < count; index += 1) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    options.push({ label: monthLabelOf(key), value: key });
    month -= 1;
    if (month < 1) {
      month = 12;
      year -= 1;
    }
  }
  return options;
}

/**
 * The periods the picker offers: the whole month, each of its weeks, then a free date range.
 *
 * Future weeks are deliberately KEPT. Picking one is answered honestly — `notStarted` makes every
 * rate null and the board says the period has not begun — which is more useful than hiding the
 * option and leaving a manager wondering why week 4 vanished on the 10th.
 *
 * CUSTOM RANGE carries no dates of its own. It is a mode the picker switches into, and the dates
 * come back as a `from..to` period key that `repsPlansRange` already parses; the owner chose the
 * free pair over a fixed list of two-week blocks on 2026-09-04.
 */
export function kpiPeriodOptions(month: string, todayIso: string): KpiPeriodOption[] {
  return [
    { label: "Whole month", value: "month" },
    ...repsPlansWeeks(month, todayIso).map((week) => ({ label: week.label, value: week.key })),
    { label: "Custom range", value: KPI_CUSTOM_PERIOD_VALUE },
  ];
}

/** One rep, all three KPIs. Every field is already scoped to the viewer. */
export type KpiRepRow = {
  agentCrmId: number | null;
  /** Canonical LOWER-cased hr id, or null when neither source resolved one. */
  agentHrId: string | null;
  repName: string;

  // ── Who this rep is, for the advanced filters ─────────────────────────────
  // Stamped from the employee directory, never from the CRM: the mirror carries a name and an id
  // and no organisational identity at all. Null throughout when the hr id did not resolve — which
  // is a real population, gets its own "Not recorded" facet bucket, and must never be quietly
  // filed under somebody's line.
  lineName: string | null;
  regionName: string | null;
  areaName: string | null;
  managerName: string | null;
  jobTitle: string | null;

  // ── Call rate (the selected period) ───────────────────────────────────────
  /** Sat–Wed days in the period, national holidays already removed. */
  workingDays: number;
  amVerified: number;
  pmVerified: number;
  /** verified AM calls / working days. Null when the period has no working days. */
  amRate: number | null;
  pmRate: number | null;
  /**
   * What the rep REPORTED, verified or not — the same two numbers Reps Plans prints as "Reported".
   *
   * Carried beside the verified pair rather than instead of it, because the GAP between them is the
   * thing this board exists to show: a rep at 10 reported and 4 verified is a different conversation
   * from one at 4 and 4, and until now a manager had to open a second screen to tell them apart.
   */
  amReported: number;
  pmReported: number;
  amReportedRate: number | null;
  pmReportedRate: number | null;
  /** Every call the rep logged, including the unverifiable campaign ones. */
  totalCalls: number;
  campaignCalls: number;
  /** Share of this rep's calls that took the campaign route, 0–1. */
  campaignShare: number;
  /** Days with campaign calls and not one verified visit. */
  campaignOnlyDays: number;
  /** False when the rep logged nothing at all in the period — distinct from a real zero rate. */
  hasCallRate: boolean;
  /**
   * AM against ITS target, PM against ITS target — two numbers, never one.
   *
   * THE OWNER'S RULE, 2026-09-04: "this two and this ten. Don't never get average." Until that day
   * the board carried a single `callRateAttainmentPct` = (AM + PM) / (days x 12), and its own
   * comment defended the blend. He overruled it, and he is right about what it hides: two standards
   * measured as one let a surplus on either side pay for a shortfall on the other, and the board's
   * job is to show the shortfall. A rep who does his 2 AM and only 3 of 10 PM read 42% — a passable
   * looking number for an afternoon that barely happened. He now reads 100% AM and 30% PM.
   *
   * Each is verified calls over what THAT target asked for across the same working days. Null when
   * the window has no working days to divide by. Nothing anywhere may add or average the pair.
   */
  amAttainmentPct: number | null;
  pmAttainmentPct: number | null;
  /**
   * Verified AM + PM visits per working day — the ONE place the split is deliberately summed. See
   * call-rate.ts's DAILY_VISIT_RATE_TARGET for why this is allowed and what it must never become.
   * Null exactly when `hasCallRate` is false, matching `amRate`/`pmRate`.
   */
  visitsPerDay: number | null;
  /** Where `visitsPerDay` sits against the owner's 8-12 band (2026-09-05). Null iff `visitsPerDay`
   * is null. `"above"` is a volume flag, never a win — see dailyVisitBandOf. */
  dailyVisitBand: DailyVisitBand | null;

  // ── Pharmacy (separate from AM/PM entirely — owner, 2026-09-05) ───────────
  /**
   * "am/pm coverage and call rate are separate from pharmacies coverage and call rate" / "a rep
   * must have am/pm but not must have pharmacies." A pharmacy call never counts toward amVerified
   * or pmVerified above, whatever AM/PM flag the CRM row happens to carry — see crm/call-rate.ts.
   * A rep with zero pharmacy visits is NORMAL (measured production: 43 of 76 reps), never a gap to
   * flag the way a rep with zero AM/PM calls would be.
   */
  pharmacyVerified: number;
  /** verified pharmacy calls / working days. Null when the period has no working days. */
  pharmacyRate: number | null;
  pharmacyReported: number;
  pharmacyReportedRate: number | null;
  /**
   * Always null today — THE OWNER HAS NOT SET A PHARMACY TARGET (parked question, 2026-09-05: "what
   * is the pharmacy call-rate target per working day?"). Carried on the row so the day he answers,
   * only PHARMACY_CALL_RATE_TARGET needs to change — nothing here may invent a number meanwhile.
   */
  pharmacyAttainmentPct: number | null;

  // ── Coverage and frequency (the scored window) ────────────────────────────
  /** Every doctor the plan names inside the window, due or not — and THE DENOMINATOR OF BOTH plan
   * KPIs. One number under both percentages, so "20 of 100" and "20%" can never disagree. */
  plannedDoctors: number;
  visitedDoctors: number;
  missedDoctors: number;
  coveragePct: number;
  /** Whether `coveragePct` clears the owner's 95% floor (2026-09-05). Null exactly when
   * `hasMeasurablePlan` is false. */
  meetsCoverageFloor: boolean | null;
  onPlanDoctors: number;
  underDoctors: number;
  overDoctors: number;
  frequencyPct: number;
  /** False when the rep has no planned doctors — he is NOT a 0% performer and must not rank as one. */
  hasMeasurablePlan: boolean;

  // ── Plan shape, already computed by rep-doctor-lists and previously discarded ──────────────
  /** Plan ENTRIES, i.e. planned calls — higher than plannedDoctors when a doctor is planned twice. */
  plannedCalls: number;
  /** Planned calls falling on days that have already happened — the fair mid-month denominator. */
  plannedCallsToDate: number;
  /** Collapsed type-0 calls to doctors that are ON the plan. */
  actualCalls: number;
  /** Doctors visited this month who are NOT on this rep's plan. */
  offPlanDoctors: number;
  /** Distinct HCP accounts (pharmacies, hospitals, contracts) on the plan. */
  plannedAccounts: number;
  gradeA: number;
  gradeB: number;
  gradeC: number;
  /** Doctors whose PLAN asks for fewer calls than the grade norm — plan quality, never a KPI. */
  underPlannedVsGrade: number;
};

export type KpisBoard = {
  month: string;
  monthLabel: string;
  /** The call-rate window: whole month, a week, or an explicit range. */
  range: RepsPlansRange;
  /** Sat–Wed days in the window after holidays came out. */
  workingDays: number;
  /**
   * HOW MUCH OF THE WINDOW HAS ACTUALLY BEEN WORKED, and the reason it is on the board at all.
   *
   * Coverage divides doctors reached by doctors planned. On the last day of a month that is a
   * verdict; on the second it is arithmetic with most of its numerator still in the future, and it
   * reads as an accusation either way. Measured on production 2026-09-03, two working days into
   * September: the team read 39% coverage, and the same query over the first two working days of
   * AUGUST read 40.1% against a closed-month 71.4%. The reps were performing identically to the
   * month before; only the elapsed time differed. Without this number the board could not tell
   * those two situations apart, and neither could the person reading it.
   */
  workingDaysInWindow: number;
  /** How many Sat–Wed days were removed as national holidays. */
  holidayDays: number;
  /**
   * False when a holiday calendar could not be read. The denominator may then be too generous, so
   * every call rate on the board reads LOW — the UI must say so rather than print a bare number.
   */
  holidaysComplete: boolean;
  /** The month's last scored day — today for the live month. Coverage and frequency are to here. */
  asOf: string;
  isCurrentMonth: boolean;
  scopeLabel: string;
  /** Set when the viewer may see nothing; the page renders this instead of an empty table. */
  scopeReason: string | null;
  /** The rows AFTER the advanced filters. Every total and podium below is computed from these. */
  reps: KpiRepRow[];
  /**
   * How many reps the viewer's SCOPE contains, before any filter narrowed it.
   *
   * Printed beside the filtered count so "12 of 73" is always on screen. A filtered board that says
   * only "12 reps" is indistinguishable from a district that has twelve people, and a manager who
   * forgot a filter was on would read a partial board as the whole truth.
   */
  scopedReps: number;
  /**
   * The owner's two KPI reports per rep — AM/PM, and pharmacies — for the SAME rows as `reps`.
   *
   * Kept beside the four KPI tabs rather than folded into `KpiRepRow` because they answer against a
   * different denominator: the four tabs score a rep against his PLAN, these score him against the
   * whole list the CRM assigned him ("whole panel visisted one is the coverage", owner 2026-09-05).
   * One row per rep, keyed by the same canonical hr id `KpiRepRow.agentHrId` carries.
   */
  kpiReports: RepKpiReports[];
  /** Facet options and counts, built from the SCOPED rows so a choice never returns an empty board. */
  facets: KpiFacets;
  /** The filter state actually applied, echoed back so the UI can render and clear it. */
  filters: KpiFilterState;
  /** Best three reps on each leaderboard — coverage, frequency, AM and PM. Never a blended rank,
   * and since 2026-09-04 never a combined call-rate one either. See kpis-filters.ts. */
  podium: KpiPodium;
  totals: {
    reps: number;
    workingDays: number;
    amVerified: number;
    pmVerified: number;
    amRate: number | null;
    pmRate: number | null;
    amReported: number;
    pmReported: number;
    amReportedRate: number | null;
    pmReportedRate: number | null;
    campaignCalls: number;
    totalCalls: number;
    /** Team verified AM + PM visits per working day — see visitsPerDay on KpiRepRow. */
    visitsPerDay: number | null;
    dailyVisitBand: DailyVisitBand | null;
    plannedDoctors: number;
    visitedDoctors: number;
    coveragePct: number;
    /** Whether the team's own coveragePct clears the owner's 95% floor. Null with no reps. */
    meetsCoverageFloor: boolean | null;
    onPlanDoctors: number;
    underDoctors: number;
    overDoctors: number;
    frequencyPct: number;
    /** Team AM calls against the AM target, and PM against the PM target. Never summed — see the
     * per-rep fields above for why the owner banned the blended figure. */
    amAttainmentPct: number | null;
    pmAttainmentPct: number | null;
    /** Team pharmacy calls, separate from AM/PM entirely — see KpiRepRow.pharmacyVerified. */
    pharmacyVerified: number;
    pharmacyRate: number | null;
    pharmacyReported: number;
    pharmacyReportedRate: number | null;
  };
  amTarget: number;
  pmTarget: number;
  /** Null — no owner-set pharmacy target exists yet. See KpiRepRow.pharmacyAttainmentPct. */
  pharmacyTarget: number | null;
  /** The owner's 8-12 visits/day band (2026-09-05) — target is the midpoint. See call-rate.ts's
   * DAILY_VISIT_RATE_TARGET for why AM and PM are summed here and nowhere else on this board. */
  visitsPerDayTarget: number;
  visitsPerDayMin: number;
  visitsPerDayMax: number;
  /** The owner's coverage floor (2026-09-05). See kpis-filters.ts's COVERAGE_TARGET_FLOOR_PCT. */
  coverageFloorPct: number;
};

/** One place on a podium. `value` is already the percentage the caption prints. */
export type KpiPodiumEntry = { repName: string; value: number; caption: string };

/**
 * The three leaderboards, one per measure.
 *
 * FOUR, not one. A single "best rep" list would need a blended score, and kpis-board's whole
 * premise is that it adds no fifth measure — the measures disagree on purpose (production has run
 * 68% coverage against 39% frequency in the same month), and a blend would hide exactly the gap
 * the board exists to show. So these are separate answers, and often different people.
 *
 * The call rate is TWO boards, not one, since 2026-09-04: the owner ranks AM against 2 and PM
 * against 10 and forbids a combined figure, so the best morning and the best afternoon are asked
 * and answered as the different questions they are.
 *
 * Pharmacy is a FIFTH board, since 2026-09-05, ranked on raw verified calls per working day rather
 * than attainment — there is no target to score attainment against yet (see
 * PHARMACY_CALL_RATE_TARGET), and ranking by the rate itself is still honest without one.
 */
export type KpiPodium = {
  coverage: KpiPodiumEntry[];
  frequency: KpiPodiumEntry[];
  amCallRate: KpiPodiumEntry[];
  pmCallRate: KpiPodiumEntry[];
  pharmacyCallRate: KpiPodiumEntry[];
};

/**
 * Top three on each measure, from rows that can honestly BE ranked on it.
 *
 * A rep with no measurable plan is excluded from coverage and frequency, and a rep who logged
 * nothing is excluded from call rate — not because they did badly, but because they have no value
 * on that axis at all. Ranking them would put "0%" on a podium, which is both wrong and cruel.
 */
export function buildKpiPodium(rows: readonly KpiRepRow[]): KpiPodium {
  const top = (
    eligible: (row: KpiRepRow) => boolean,
    score: (row: KpiRepRow) => number,
    caption: (row: KpiRepRow) => string,
  ): KpiPodiumEntry[] =>
    rows
      .filter(eligible)
      .slice()
      .sort((left, right) => score(right) - score(left) || left.repName.localeCompare(right.repName))
      .slice(0, 3)
      .map((row) => ({ repName: row.repName || "Unnamed rep", value: score(row), caption: caption(row) }));

  return {
    coverage: top(
      (row) => row.hasMeasurablePlan,
      (row) => row.coveragePct,
      (row) => `${row.visitedDoctors} of ${row.plannedDoctors} doctors reached`,
    ),
    frequency: top(
      (row) => row.hasMeasurablePlan,
      (row) => row.frequencyPct,
      (row) => `${row.onPlanDoctors} doctors exactly on plan`,
    ),
    amCallRate: top(
      (row) => row.hasCallRate && row.amAttainmentPct != null,
      (row) => row.amAttainmentPct ?? 0,
      (row) => `${row.amVerified} verified AM calls in ${row.workingDays} days`,
    ),
    pmCallRate: top(
      (row) => row.hasCallRate && row.pmAttainmentPct != null,
      (row) => row.pmAttainmentPct ?? 0,
      (row) => `${row.pmVerified} verified PM calls in ${row.workingDays} days`,
    ),
    // Scored on the RATE, not an attainment percentage — no pharmacy target exists to score
    // against (see PHARMACY_CALL_RATE_TARGET). A rep with zero pharmacy calls is excluded here for
    // the same reason a rep with no plan is excluded from coverage: he has no value on this axis,
    // not a bad one, and 43 of 76 reps fall in that bucket in a typical month (see the header).
    // Rounded to 2dp, the same precision `rate()` prints everywhere else on this board — the raw
    // ratio otherwise carries a long decimal tail that a `KpiPodiumEntry.value: number` would print
    // verbatim (KpiPodiumCard renders it with NO formatting, unlike every other reader of a rate).
    pharmacyCallRate: top(
      (row) => row.hasCallRate && row.pharmacyVerified > 0,
      (row) => Math.round((row.pharmacyRate ?? 0) * 100) / 100,
      (row) => `${row.pharmacyVerified} verified pharmacy calls in ${row.workingDays} days`,
    ),
  };
}

/* Canonical hr id for comparison — `canonicalHrIdKey` from @/lib/hr-id, never a local copy.
 *
 * Production hr ids are MIXED CASE, and a case-sensitive comparison silently under-returns rather
 * than erroring: one `.eq` once hid 28% of reps' own orders, and on `au.occupancy_history` the loss
 * was total. A row that matches nobody reads here as "this rep is not on your team", which is the
 * most convincing possible way to be wrong.
 *
 * Writing `.trim().toLowerCase()` inline here would have been that comparison MINUS the legacy alias
 * table (`aaa` -> `aa`), so a renamed seat would drop out of its own manager's scope. That is what
 * tests/hrid-normalizer-ratchet.test.ts exists to stop, and it caught this file. */

/* The scope check moved to crm/doctor-coverage-roles.ts as `isAgentInScope` on 2026-09-03, when
 * Reps Plans acquired viewer scoping and needed exactly the same one. It was private here, so that
 * board would otherwise have had to write its own "is this rep on your team" comparison — and a
 * second implementation of that is precisely the drift that got Doctor Coverage retired. The
 * fails-closed reasoning and the hr-id canonicalisation notes moved with it. */

const pct = (numerator: number, denominator: number): number =>
  denominator > 0 ? Math.round((numerator / denominator) * 100) : 0;

/**
 * Joins the call-rate report to the doctor-list board, ONE row per rep.
 *
 * THE JOIN KEY IS `agent_crm_id`, the vendor's own id, present on both sides. It is deliberately
 * not the hr id: the plan mirror leaves `agent_hr_id` null on a large and VARYING share of rows —
 * 791 of 18,645 August rows but 5,795 of 20,778 May rows — so an hr-id join would silently drop a
 * quarter of a month's reps. The hr id is still carried, because scope is enforced on it.
 *
 * A rep present on only ONE side is kept, not dropped. Both cases are real and both are worth
 * seeing: a rep with visits and no plan (nothing to be a percentage of), and a rep with a plan and
 * no visits at all (the single most important row on the board).
 *
 * Pure, so the join can be tested with fixtures and without a database.
 */
export function joinKpiRows(input: {
  callRates: readonly RepCallRate[];
  docLists: readonly RepDoctorListRepRow[];
  scope: DoctorCoverageScope;
  workingDays: number;
  /**
   * The employee directory, for the organisational identity the CRM does not carry. Optional so the
   * join stays testable without one; a rep whose hr id is absent keeps null identity and lands in
   * the "Not recorded" facet bucket rather than being silently attached to somebody's line.
   */
  directory?: readonly KpiDirectoryEntry[];
  /** AM/PM targets, for the call-rate attainment the bands and sorts read. */
  amTarget?: number;
  pmTarget?: number;
  /** Null until the owner sets one — see PHARMACY_CALL_RATE_TARGET. */
  pharmacyTarget?: number | null;
}): KpiRepRow[] {
  const { callRates, docLists, scope, workingDays } = input;
  const amTarget = input.amTarget ?? AM_CALL_RATE_TARGET;
  const pmTarget = input.pmTarget ?? PM_CALL_RATE_TARGET;
  const pharmacyTarget = input.pharmacyTarget ?? PHARMACY_CALL_RATE_TARGET;

  // Keyed on the CANONICAL hr id on both sides. Production hr ids are mixed case and carry legacy
  // aliases, and `canonicalHrIdKey` is the one comparison that handles both — a plain
  // `.trim().toLowerCase()` here would drop a renamed seat, which reads on screen as a rep with no
  // line rather than as a bug.
  const identityByHrId = new Map<string, KpiDirectoryEntry>();
  for (const entry of input.directory ?? []) {
    const key = canonicalHrIdKey(entry.hrId);
    if (key) identityByHrId.set(key, entry);
  }

  const byCrmId = new Map<number, KpiRepRow>();
  const rows: KpiRepRow[] = [];

  const blank = (agentCrmId: number | null, agentHrId: string | null, repName: string): KpiRepRow => ({
    agentCrmId,
    agentHrId,
    repName,
    lineName: null,
    regionName: null,
    areaName: null,
    managerName: null,
    jobTitle: null,
    workingDays,
    amVerified: 0,
    pmVerified: 0,
    amRate: null,
    pmRate: null,
    amReported: 0,
    pmReported: 0,
    amReportedRate: null,
    pmReportedRate: null,
    totalCalls: 0,
    campaignCalls: 0,
    campaignShare: 0,
    campaignOnlyDays: 0,
    hasCallRate: false,
    amAttainmentPct: null,
    pmAttainmentPct: null,
    pharmacyVerified: 0,
    pharmacyRate: null,
    pharmacyReported: 0,
    pharmacyReportedRate: null,
    pharmacyAttainmentPct: null,
    visitsPerDay: null,
    dailyVisitBand: null,
    plannedDoctors: 0,
    visitedDoctors: 0,
    missedDoctors: 0,
    coveragePct: 0,
    meetsCoverageFloor: null,
    onPlanDoctors: 0,
    underDoctors: 0,
    overDoctors: 0,
    frequencyPct: 0,
    hasMeasurablePlan: false,
    plannedCalls: 0,
    plannedCallsToDate: 0,
    actualCalls: 0,
    offPlanDoctors: 0,
    plannedAccounts: 0,
    gradeA: 0,
    gradeB: 0,
    gradeC: 0,
    underPlannedVsGrade: 0,
  });

  const claim = (agentCrmId: number | null, agentHrId: string | null, repName: string): KpiRepRow => {
    if (agentCrmId != null) {
      const existing = byCrmId.get(agentCrmId);
      if (existing) {
        // A name resolved on one side but not the other is still the same rep — keep the real one
        // rather than letting a blank overwrite it.
        if (!existing.repName && repName) existing.repName = repName;
        if (existing.agentHrId == null && agentHrId != null) existing.agentHrId = agentHrId;
        return existing;
      }
    }
    const created = blank(agentCrmId, agentHrId, repName);
    if (agentCrmId != null) byCrmId.set(agentCrmId, created);
    rows.push(created);
    return created;
  };

  for (const rate of callRates) {
    const row = claim(rate.agentCrmId, canonicalHrIdKey(rate.agentHrId), rate.agentName);
    row.workingDays = rate.workingDays;
    row.amVerified = rate.am.verified;
    row.pmVerified = rate.pm.verified;
    row.amRate = rate.am.verifiedRate;
    row.pmRate = rate.pm.verifiedRate;
    row.amReported = rate.am.total;
    row.pmReported = rate.pm.total;
    row.amReportedRate = rate.am.totalRate;
    row.pmReportedRate = rate.pm.totalRate;
    row.totalCalls = rate.am.total + rate.pm.total + rate.unspecified;
    row.campaignCalls = rate.am.campaign + rate.pm.campaign;
    row.campaignShare = rate.campaignShare;
    row.campaignOnlyDays = rate.campaignOnlyDays;
    row.hasCallRate = true;
    row.pharmacyVerified = rate.pharmacy.verified;
    row.pharmacyRate = rate.pharmacy.verifiedRate;
    row.pharmacyReported = rate.pharmacy.total;
    row.pharmacyReportedRate = rate.pharmacy.totalRate;
  }

  for (const list of docLists) {
    const row = claim(list.agentCrmId, canonicalHrIdKey(list.agentHrId), list.repName);
    row.plannedDoctors = list.plannedDoctors;
    row.visitedDoctors = list.visitedDoctors;
    row.missedDoctors = list.missedDoctors;
    row.coveragePct = list.coveragePct;
    row.onPlanDoctors = list.onPlanDoctors;
    row.underDoctors = list.underDoctors;
    row.overDoctors = list.overDoctors;
    row.frequencyPct = list.frequencyPct;
    row.hasMeasurablePlan = list.hasMeasurablePlan;
    row.plannedCalls = list.plannedCalls;
    row.plannedCallsToDate = list.plannedCallsToDate;
    row.actualCalls = list.actualCalls;
    row.offPlanDoctors = list.offPlanDoctors;
    row.plannedAccounts = list.plannedAccounts;
    row.gradeA = list.gradeA;
    row.gradeB = list.gradeB;
    row.gradeC = list.gradeC;
    row.underPlannedVsGrade = list.underPlannedVsGrade;
  }

  // Identity and attainment are stamped LAST, over whichever source claimed the row — a rep present
  // on only one side still gets a line and an area, which is the whole point of filtering by them.
  for (const row of rows) {
    const identity = row.agentHrId ? identityByHrId.get(row.agentHrId) : undefined;
    if (identity) {
      row.lineName = identity.lineName;
      row.regionName = identity.regionName;
      row.areaName = identity.areaName;
      row.managerName = identity.managerName;
      row.jobTitle = identity.jobTitle;
      // The directory's display name is the nickname-aware one and is what the owner's
      // human-readable-names rule asks for; the CRM's agent name is the vendor's spelling. Prefer
      // the directory when it has something, but never blank out a name the CRM did supply.
      if (identity.displayName?.trim()) row.repName = identity.displayName.trim();
    }
    row.amAttainmentPct = attainmentPct(row, row.amVerified, amTarget);
    row.pmAttainmentPct = attainmentPct(row, row.pmVerified, pmTarget);
    row.pharmacyAttainmentPct = attainmentPct(row, row.pharmacyVerified, pharmacyTarget);
    // AM/PM only, never + pharmacy — owner's decision, 2026-09-06, asked directly once this split
    // existed: "the band stays AM/PM only. Pharmacy is scored on its own coverage/call-rate over
    // there, never folded back into this figure." row.amVerified/pmVerified never include pharmacy
    // (it is its own field above), so this is already correct by construction.
    row.visitsPerDay = row.hasCallRate ? verifiedVisitsPerDay(row.amVerified, row.pmVerified, row.workingDays) : null;
    row.dailyVisitBand = dailyVisitBandOf(row.visitsPerDay);
    row.meetsCoverageFloor = row.hasMeasurablePlan ? row.coveragePct >= COVERAGE_TARGET_FLOOR_PCT : null;
  }

  // Scope is applied AFTER the join, never before: a rep whose hr id appears on only one of the two
  // sources would otherwise be judged on the source that happens to be missing it.
  const scoped = rows.filter((row) => isAgentInScope(scope, row.agentHrId));
  scoped.sort((left, right) => left.repName.localeCompare(right.repName));
  return scoped;
}

/** The employee-directory fields the board stamps onto a rep, and nothing else. */
export type KpiDirectoryEntry = {
  hrId: string;
  displayName: string | null;
  lineName: string | null;
  regionName: string | null;
  areaName: string | null;
  managerName: string | null;
  jobTitle: string | null;
};

/**
 * ONE slice's verified calls against ONE target, over the working days in the window.
 *
 * Called twice and never summed. The earlier version of this function put AM and PM over a single
 * combined denominator; the owner banned that on 2026-09-04 ("this two and this ten. Don't never
 * get average"). The argument the old comment made for blending — that averaging two percentages
 * weights a 2-call target equally with a 10-call one — was an argument against ONE particular way
 * of combining them, and it was answered by combining them a different way rather than by not
 * combining them. Two standards, two scores, is the answer he wanted.
 *
 * `target` is nullable so this same function serves pharmacy, which has no owner-set standard yet
 * (see PHARMACY_CALL_RATE_TARGET) — a null target returns null rather than dividing by nothing.
 */
function attainmentPct(row: KpiRepRow, verified: number, target: number | null): number | null {
  if (target == null) return null;
  const expected = row.workingDays * target;
  if (!row.hasCallRate || expected <= 0) return null;
  return Math.round((verified / expected) * 100);
}

/** Builds the whole board for one viewer. */
export async function getKpisBoard(input: {
  access: AccessContext;
  month: string;
  period?: string | null;
  todayIso: string;
  /** The advanced filters from the URL. They can only ever NARROW what the scope gate allowed. */
  filters?: KpiFilterState;
}): Promise<KpisBoard> {
  const range = repsPlansRange(input.month, input.todayIso, input.period);
  const scope = await getDoctorCoverageScope(input.access);
  const monthLabel = monthLabelOf(input.month);
  const filters = input.filters ?? EMPTY_KPI_FILTERS;

  const empty: KpisBoard = {
    month: input.month,
    monthLabel,
    range,
    workingDays: 0,
    workingDaysInWindow: 0,
    holidayDays: 0,
    holidaysComplete: true,
    asOf: range.dateTo,
    isCurrentMonth: range.isCurrentMonth,
    scopeLabel: "",
    scopeReason: null,
    reps: [],
    kpiReports: [],
    scopedReps: 0,
    facets: buildKpiFacets([]),
    filters,
    podium: buildKpiPodium([]),
    totals: {
      reps: 0,
      workingDays: 0,
      amVerified: 0,
      pmVerified: 0,
      amRate: null,
      pmRate: null,
      amReported: 0,
      pmReported: 0,
      amReportedRate: null,
      pmReportedRate: null,
      campaignCalls: 0,
      totalCalls: 0,
      visitsPerDay: null,
      dailyVisitBand: null,
      plannedDoctors: 0,
      visitedDoctors: 0,
      coveragePct: 0,
      meetsCoverageFloor: null,
      onPlanDoctors: 0,
      underDoctors: 0,
      overDoctors: 0,
      frequencyPct: 0,
      amAttainmentPct: null,
      pmAttainmentPct: null,
      pharmacyVerified: 0,
      pharmacyRate: null,
      pharmacyReported: 0,
      pharmacyReportedRate: null,
    },
    amTarget: AM_CALL_RATE_TARGET,
    pmTarget: PM_CALL_RATE_TARGET,
    pharmacyTarget: PHARMACY_CALL_RATE_TARGET,
    visitsPerDayTarget: DAILY_VISIT_RATE_TARGET,
    visitsPerDayMin: DAILY_VISIT_RATE_MIN,
    visitsPerDayMax: DAILY_VISIT_RATE_MAX,
    coverageFloorPct: COVERAGE_TARGET_FLOOR_PCT,
  };

  if (scope.kind === "none") {
    return { ...empty, scopeLabel: "No reach", scopeReason: scope.reason };
  }

  // The directory is fetched INCLUDING inactive people. A rep who left mid-month still has rows in
  // both CRM sources for the days he worked, and dropping his identity here would print those days
  // against a blank line and area — the reads door already decides who is excluded, and this call
  // is only ever putting a name to an id.
  const [callRate, docList, employees, windowHolidays] = await Promise.all([
    loadCallRateReport({ dateFrom: range.dateFrom, dateTo: range.dateTo }),
    // THE PERIOD REACHES BOTH KPIs. Until 2026-09-04 this was `{ month: input.month }` and the
    // picker moved the call rate alone, so "Week 1" scored week 1's calls against the whole month's
    // doctor list. `windowEnd`, not `dateTo`: dateTo is capped at today, and capping the plan side
    // is exactly the shrinking denominator this change removed.
    getRepDoctorLists({
      month: input.month,
      window: { from: range.dateFrom, to: range.windowEnd },
    }),
    getEmployeeDirectoryRows({ includeInactive: true }),
    // The window's OWN end, not today. callRate.workingDays counts the days worked so far; this
    // counts the days the window contains. The pair is what separates "the team is behind" from
    // "it is the 3rd of the month" — see workingDaysInWindow on KpisBoard.
    loadCallRateHolidays(range.dateFrom, range.windowEnd),
  ]);

  const workingDaysInWindow = range.notStarted
    ? 0
    : countCallRateWorkingDays(range.dateFrom, range.windowEnd, windowHolidays.dates);

  const allInScope = joinKpiRows({
    callRates: callRate.reps,
    docLists: docList.reps,
    scope,
    workingDays: callRate.workingDays,
    amTarget: AM_CALL_RATE_TARGET,
    pmTarget: PM_CALL_RATE_TARGET,
    pharmacyTarget: PHARMACY_CALL_RATE_TARGET,
    directory: employees.map((employee) => ({
      hrId: employee.hrId,
      displayName: employee.displayName || employee.fullName || null,
      lineName: employee.lineName?.trim() || null,
      regionName: employee.regionName?.trim() || null,
      areaName: employee.areaName?.trim() || null,
      managerName: employee.managerName?.trim() || null,
      jobTitle: employee.jobTitle?.trim() || null,
    })),
  });

  // MEDICAL REPS ONLY — owner, 2026-09-03. This runs BEFORE the facets and the totals, so the
  // whole page describes one population: 63 of the 70 rows in scope that September, with 6 district
  // sales managers and 1 product manager dropped. A manager carries no doctor plan of his own, so
  // he scores "No plan" on two of the three measures and pulls the team averages toward a number
  // that describes nobody. ONE rule decides this for every CRM board — crm/medical-rep.ts, which
  // Reps Plans reaches through its seat-aware arm and this board through the title arm, because the
  // seat model never enters here.
  const scopedReps = keepMedicalRepsOnly(allInScope);

  // Facets are built from the SCOPED rows and the filters applied after, in that order. Building
  // them from the filtered rows instead would make every facet collapse to whatever is already
  // selected — pick "Pedia" and Line would then offer only Pedia, with no way back except editing
  // the URL by hand.
  const facets = buildKpiFacets(scopedReps);
  const reps = applyKpiFilters(scopedReps, filters);

  // THE TWO REPORTS RIDE THE SAME POPULATION as the four tabs beside them: the same scope object
  // (never re-resolved — see rep-kpi-reports-data.ts), then narrowed to exactly the rows that
  // survived `keepMedicalRepsOnly` and the advanced filters. Anything else and the strip would show
  // six tabs describing two different sets of people, with nothing on screen saying so.
  //
  // Awaited here rather than in the batch above because it needs `callRate.workingDays` as its
  // denominator, and that is the same number the other tabs divide by. A second round trip is the
  // price of the two boards agreeing; splitting the fetch from the arithmetic to save it would put
  // a second working-day count on the page, which is the disagreement this is avoiding.
  const kpiReportRows = await loadRepKpiReports({
    scope,
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
    workingDays: callRate.workingDays,
    holidays: windowHolidays.dates,
    repNameByHrId: new Map(
      scopedReps.flatMap((row) => (row.agentHrId ? [[row.agentHrId, row.repName] as const] : [])),
    ),
  });
  const visibleRepKeys = new Set(reps.flatMap((row) => (row.agentHrId ? [row.agentHrId] : [])));
  const kpiReports = kpiReportRows.reports.filter((report) => report.repKey != null && visibleRepKeys.has(report.repKey));

  // Totals are summed from the SCOPED rows, never taken from either source's own `totals`. Those
  // cover the whole company, and a District Manager reading a company total beside his own six reps
  // would have no way to tell the two apart.
  const totals = reps.reduce(
    (accumulator, row) => {
      accumulator.reps += 1;
      accumulator.amVerified += row.amVerified;
      accumulator.pmVerified += row.pmVerified;
      accumulator.amReported += row.amReported;
      accumulator.pmReported += row.pmReported;
      accumulator.campaignCalls += row.campaignCalls;
      accumulator.totalCalls += row.totalCalls;
      accumulator.plannedDoctors += row.plannedDoctors;
      accumulator.visitedDoctors += row.visitedDoctors;
      accumulator.onPlanDoctors += row.onPlanDoctors;
      accumulator.underDoctors += row.underDoctors;
      accumulator.overDoctors += row.overDoctors;
      accumulator.pharmacyVerified += row.pharmacyVerified;
      accumulator.pharmacyReported += row.pharmacyReported;
      return accumulator;
    },
    {
      reps: 0,
      amVerified: 0,
      pmVerified: 0,
      amReported: 0,
      pmReported: 0,
      campaignCalls: 0,
      totalCalls: 0,
      plannedDoctors: 0,
      visitedDoctors: 0,
      onPlanDoctors: 0,
      underDoctors: 0,
      overDoctors: 0,
      pharmacyVerified: 0,
      pharmacyReported: 0,
    },
  );

  // The team rate is the team's calls over ONE rep-equivalent's working days times the head count —
  // i.e. the average rep's rate, not the sum. Summing the rates instead would make a district of six
  // look six times better than any of its reps.
  const denominator = callRate.workingDays * totals.reps;
  const teamVisitsPerDay =
    denominator > 0 ? verifiedVisitsPerDay(totals.amVerified, totals.pmVerified, denominator) : null;
  const teamCoveragePct = pct(totals.visitedDoctors, totals.plannedDoctors);

  return {
    ...empty,
    workingDays: callRate.workingDays,
    workingDaysInWindow,
    holidayDays: callRate.holidayDays,
    holidaysComplete: callRate.holidaysComplete,
    asOf: docList.asOf,
    isCurrentMonth: docList.isCurrentMonth,
    scopeLabel: scope.kind === "company" ? scope.label : scope.label,
    reps,
    kpiReports,
    scopedReps: scopedReps.length,
    facets,
    filters,
    // The podium ranks the FILTERED rows on purpose: filter to Pedia and the leaderboard answers
    // "best in Pedia", which is the question the filter just asked. A podium that ignored the
    // filter would show three names the visible table does not even contain.
    podium: buildKpiPodium(reps),
    totals: {
      reps: totals.reps,
      workingDays: callRate.workingDays,
      amVerified: totals.amVerified,
      pmVerified: totals.pmVerified,
      amRate: denominator > 0 ? totals.amVerified / denominator : null,
      pmRate: denominator > 0 ? totals.pmVerified / denominator : null,
      amReported: totals.amReported,
      pmReported: totals.pmReported,
      amReportedRate: denominator > 0 ? totals.amReported / denominator : null,
      pmReportedRate: denominator > 0 ? totals.pmReported / denominator : null,
      campaignCalls: totals.campaignCalls,
      totalCalls: totals.totalCalls,
      visitsPerDay: teamVisitsPerDay,
      dailyVisitBand: dailyVisitBandOf(teamVisitsPerDay),
      plannedDoctors: totals.plannedDoctors,
      visitedDoctors: totals.visitedDoctors,
      coveragePct: teamCoveragePct,
      meetsCoverageFloor: totals.plannedDoctors > 0 ? teamCoveragePct >= COVERAGE_TARGET_FLOOR_PCT : null,
      onPlanDoctors: totals.onPlanDoctors,
      underDoctors: totals.underDoctors,
      overDoctors: totals.overDoctors,
      // ONE denominator under both plan KPIs — the window's whole list. See the header.
      frequencyPct: pct(totals.onPlanDoctors, totals.plannedDoctors),
      // Two scores, never their blend — the owner's rule. See `attainmentPct`.
      amAttainmentPct:
        denominator > 0 ? Math.round((totals.amVerified / (denominator * AM_CALL_RATE_TARGET)) * 100) : null,
      pmAttainmentPct:
        denominator > 0 ? Math.round((totals.pmVerified / (denominator * PM_CALL_RATE_TARGET)) * 100) : null,
      pharmacyVerified: totals.pharmacyVerified,
      pharmacyRate: denominator > 0 ? totals.pharmacyVerified / denominator : null,
      pharmacyReported: totals.pharmacyReported,
      pharmacyReportedRate: denominator > 0 ? totals.pharmacyReported / denominator : null,
    },
  };
}
