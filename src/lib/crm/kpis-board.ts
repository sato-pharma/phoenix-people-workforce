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
//
// MANAGER ROWS (owner, 2026-10-20: "add manager row and every dm kpis is
// calculated based on his reps averag and nsm based on dsms av and so on"). The
// rep rows are still medical reps only; each manager gets a row of his own in a
// SEPARATE list, `managers`, whose every figure is the average of the rows
// directly beneath him — see crm/kpis-manager-rows.ts. They are built from the
// finished, scoped rep rows, so they reach no rep the viewer cannot already see,
// and only for managers the viewer may see (himself and his scope down). Nothing
// counted from `reps` — totals, podium, facets, bands — ever reads them.
// ─────────────────────────────────────────────────────────────────────────────

import {
  getDoctorCoverageScope,
  isAgentInScope,
  type DoctorCoverageScope,
} from "@/lib/crm/doctor-coverage-scope";
import {
  applyKpiFilters,
  applyKpiManagerFilters,
  buildKpiFacets,
  COVERAGE_TARGET_FLOOR_PCT,
  EMPTY_KPI_FILTERS,
  KPI_CUSTOM_PERIOD_VALUE,
  type KpiFacets,
  type KpiFilterState,
} from "@/lib/crm/kpis-filters";
import { kpiIndexOf, type KpiIndex } from "@/lib/crm/kpi-index";
import { buildKpiManagerRows, type KpiManagerRow } from "@/lib/crm/kpis-manager-rows";
import { keepMedicalRepsOnly } from "@/lib/crm/medical-rep";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { buildManagersAboveByHrId } from "@/lib/org/manager-filter";
import { canonicalHrIdKey, normalizeHrIdForAccess } from "@/lib/hr-id";
import { loadCallRateReport } from "@/lib/crm/call-rate-service";
import { resolveKpiBoardAgents } from "@/lib/crm/kpi-board-agents";
import { countCallRateWorkingDays } from "@/lib/crm/call-rate";
import { loadCallRateHolidays } from "@/lib/crm/call-rate-holidays";
import {
  getRepDoctorLists,
  monthLabelOf,
  repDoctorListRepKey,
  type RepDoctorListDoctorRow,
  type RepDoctorListRepRow,
} from "@/lib/crm/rep-doctor-lists";
import { loadRepKpiReports } from "@/lib/crm/rep-kpi-reports-data";
import { resolveRepKpiStandards, type RepKpiReports } from "@/lib/crm/rep-kpi-reports";
import { CALL_RATE_THROUGH_YESTERDAY, repsPlansRange, repsPlansWeeks, type RepsPlansRange } from "@/lib/crm/reps-plans";
import {
  AM_CALL_RATE_TARGET,
  hasNoGpsFeed,
  PHARMACY_CALL_RATE_TARGET,
  PM_CALL_RATE_TARGET,
  type CallRateBasis,
  type RepCallRate,
} from "@/lib/crm/call-rate";
import { getCrmCutoverSetting, NO_CRM_CUTOVER } from "@/lib/crm/cutover";
import { loadPhoenixRepKpis } from "@/lib/crm/phoenix-kpi-data";
import {
  kpiRulesFor,
  phoenixRuleRepKeys,
  type DoctorFrequency,
  type DoctorFrequencyStatus,
  type KpiRules,
  type PhoenixRepKpis,
} from "@/lib/crm/phoenix-kpi-rules";
import { loadStartedRepWindows } from "@/lib/crm/phoenix-started-reps";
import type { AccessContext } from "@/lib/auth/permissions";

/** One option in the board's month or period picker. */
export type KpiPeriodOption = { label: string; value: string };

/**
 * The Cairo month the CRM copy in Phoenix begins — plans and visits both start 2026-01-01. A month
 * before this has no CRM data at all, so offering it in the picker only produces a board of empty
 * "No activity" rows that read as failures. The floor stops the picker at it; the 12-month window
 * naturally clears it from mid-2027 on, so this is a safety net, not a permanent clamp.
 */
export const CRM_DATA_FLOOR_MONTH = "2026-01";

/**
 * The months the picker offers, newest first — never earlier than {@link CRM_DATA_FLOOR_MONTH},
 * and never a future month (the loop only ever counts backward from today).
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
    // Stop at the CRM data floor rather than list months that can only show empty rows.
    if (key < CRM_DATA_FLOOR_MONTH) break;
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
  /** Every manager ABOVE `managerName` on the org tree, nearest first — so the "Reports to" filter
   * can find a rep under a Regional or National Sales Manager, not only under his district manager. */
  managersAbove?: string[];
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
   * OWNER'S RULING A1, 2026-09-21 — "use A1 no GPS feed for reps without check-ins", carried to this
   * board the same morning ("apply A1 to the KPIs board too").
   *
   * True when the rep logged real regular visits in the window and his CRM account sent NO GPS
   * check-in at all, so before the cutover not one of those visits could be proved. His proved rates
   * and his AM and PM attainment are then null — "No GPS feed", never a red 0% against a target he
   * had no means to beat — and his calls leave the team's call-rate figures. Coverage and frequency
   * never read GPS, so they still score him. ONE rule for every board: `hasNoGpsFeed` in
   * crm/call-rate.ts, whose narrowness (a LIVE feed that proves nothing keeps its real 0%) is the
   * point. Always false under the Phoenix rules, where GPS decides nothing.
   */
  noGpsFeed: boolean;
  /**
   * Phoenix CRM visits this rep saved that score nothing yet, because the customer is not validated
   * (`awaitingValidation` in crm/call-rate.ts). A manager reading a flat 0 is otherwise given no
   * reason for it, and on a team that has just started there is no other reason to find: 0 of
   * Delta (1)'s 1,551 customers were validated the day before it began. Never a score, never a flag
   * on the rep — the sentence is `awaitingValidationNote`, and the rep's own screens never show it.
   */
  awaitingValidation: number;
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

  /**
   * PHASE 6 — the Phoenix KPI detail: the daily follow-up, the campaign line and graded frequency.
   * Set only when the CRM cutover has made the Phoenix rules score this period (see
   * crm/phoenix-kpi-rules.ts); absent before it, when every field above means what it always meant.
   */
  phoenix?: PhoenixRepKpis | null;

  /**
   * The key the Coverage tab opens this rep's doctor list by — the value of the URL's `rep`. Stamped
   * by `joinKpiRows`, so the view never has to rebuild it (see {@link kpiCoverageRepKey}). Null when
   * the rep has neither a CRM id nor an hr id, and then there is no list to open.
   */
  coverageRepKey?: string | null;
};

/**
 * One doctor on the Coverage tab's two lists. Owner, 2026-09-16: "when i press on coverage tab
 * covered dr appear with the last visit date and not covered appears".
 *
 * A NAME, never an id: `contactCrmId` keys the rendered row and is never printed.
 */
export type KpiCoverageDoctor = {
  contactCrmId: number;
  /** Null when the plan carried no name for him. The view prints a phrase for that, never the id. */
  name: string | null;
  speciality: string | null;
  grade: string | null;
  /** Visits inside the window that count toward coverage. 0 exactly on the not-covered list. */
  visits: number;
  /** The latest of those visits, YYYY-MM-DD. Null exactly on the not-covered list. */
  lastVisitDate: string | null;
  /** Every day the plan booked him inside the window, earliest first. */
  planDates: string[];
  /**
   * The Frequency report's reading of the same doctor — what he should get, what he has had, the
   * verdict (see {@link DoctorFrequency}). Optional so a list built without it still types; every
   * builder in this module fills it, and the Coverage tab never reads it.
   */
  frequency?: DoctorFrequency;
  /**
   * False when every day the plan booked him is still ahead. He counts as not covered all the same —
   * the whole window's list is the denominator (see the header) — but he is not late, and the list
   * says so rather than letting next Tuesday's doctor read like last Tuesday's.
   */
  due: boolean;
};

/**
 * One rep's covered and not-covered doctors, for the Coverage tab.
 *
 * Built for ONE rep per page load, and only on that tab, so a company-wide doctor list never travels
 * to a browser. `covered.length` is the rep's `visitedDoctors` and `notCovered.length` his
 * `missedDoctors`, by construction: both lists come out of the same computation as those counts.
 */
export type KpiCoverageDetail = {
  /** The rep's {@link kpiCoverageRepKey}. */
  repKey: string;
  repName: string;
  covered: KpiCoverageDoctor[];
  notCovered: KpiCoverageDoctor[];
};

/**
 * The key a rep's doctor list is opened by, for a rep the doctor-list builder did not key itself.
 * The builder's OWN rep key rather than the `crm:`/`hr:` join key below, because it is the key that
 * builder stamped on every doctor row — so the rows it selects are exactly the rows this rep's
 * coverage was counted from. `joinKpiRows` copies the builder's key straight off its rep row where
 * there is one, and falls back to this only for a rep it never listed.
 */
export function kpiCoverageRepKey(row: Pick<KpiRepRow, "agentCrmId" | "agentHrId">): string | null {
  return repDoctorListRepKey(row.agentCrmId, row.agentHrId);
}

/**
 * Which rep's doctor list the Coverage tab opens.
 *
 * Only ever one of `reps` — the rows the viewer's scope and filters already let through — so a `rep`
 * typed into the URL for anybody outside that set opens nothing. A board showing ONE rep (a Medical
 * Rep looking at himself, or a filter down to one person) opens his list unasked, because there is
 * nobody else to choose.
 */
export function selectKpiCoverageRep(reps: readonly KpiRepRow[], requested: string | null | undefined): KpiRepRow | null {
  if (reps.length === 1) return reps[0] ?? null;
  if (!requested) return null;
  return reps.find((row) => row.coverageRepKey != null && row.coverageRepKey === requested) ?? null;
}

/**
 * The legacy doctor list's rows for one rep, in the Coverage tab's shape: doctors (SP contacts) on
 * the plan and nothing else — exactly the population `plannedDoctors` counts in
 * buildRepDoctorListsBoard. Off-plan visits and pharmacies are the other columns' business.
 */
export function legacyKpiCoverageDoctors(
  doctors: readonly RepDoctorListDoctorRow[],
  repKey: string,
): Array<Omit<KpiCoverageDoctor, "due">> {
  return doctors
    .filter((doctor) => doctor.repKey === repKey && doctor.kind === "sp" && doctor.status !== "off_plan")
    .map((doctor) => ({
      contactCrmId: doctor.contactCrmId,
      // The builder fills a missing name with "Contact <id>", and the board prints names, never ids.
      name: doctor.contactName === `Contact ${doctor.contactCrmId}` ? null : doctor.contactName,
      speciality: doctor.speciality?.trim() || null,
      grade: doctor.gradeRaw?.trim() || null,
      visits: doctor.status === "seen" ? doctor.visits : 0,
      lastVisitDate: doctor.status === "seen" ? doctor.lastVisitDate : null,
      planDates: doctor.planDates,
      frequency: planFrequency(doctor),
    }));
}

/** The owner's plan-basis words for one doctor, from the status `rep-doctor-lists` already computed. */
const PLAN_FREQUENCY_STATUS: Partial<Record<RepDoctorListDoctorRow["frequencyStatus"], DoctorFrequencyStatus>> = {
  on_plan: "exact",
  under: "below",
  over: "above",
  missed: "not-visited",
  not_due: "not-due",
};

/**
 * Before a team goes live a doctor is judged against the PLAN: how many calls it booked him for, how
 * many of those had come due, and how many he got. Read straight off the doctor row so the report's
 * verdict is the very status the Frequency percentage was counted from.
 */
function planFrequency(doctor: RepDoctorListDoctorRow): DoctorFrequency {
  return {
    basis: "plan",
    required: doctor.plannedCalls,
    dueSoFar: doctor.plannedCallsToDate,
    actual: doctor.visits,
    status: PLAN_FREQUENCY_STATUS[doctor.frequencyStatus] ?? "not-visited",
  };
}

/** Plain code-unit order. YYYY-MM-DD sorts correctly as text, and `localeCompare` may skip the hyphens. */
const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/**
 * Splits one rep's planned doctors into the two lists and orders each.
 *
 * Covered reads newest visit first, like a diary running backwards. Not covered puts the doctors who
 * are already late on top, oldest booking first, and the ones not due yet underneath — so the first
 * name on the list is always the longest-standing miss.
 */
export function buildKpiCoverageDetail(input: {
  repKey: string;
  repName: string;
  doctors: ReadonlyArray<Omit<KpiCoverageDoctor, "due">>;
  todayIso: string;
}): KpiCoverageDetail {
  const covered: KpiCoverageDoctor[] = [];
  const notCovered: KpiCoverageDoctor[] = [];
  for (const doctor of input.doctors) {
    const row: KpiCoverageDoctor = {
      ...doctor,
      planDates: [...doctor.planDates],
      // An undated booking cannot be shown to lie ahead, so it is never excused as one.
      due: doctor.planDates.length === 0 || doctor.planDates.some((day) => day <= input.todayIso),
    };
    if (row.visits > 0) covered.push(row);
    else notCovered.push(row);
  }
  // Unnamed doctors last: a phrase standing in for a name should not sit among the As.
  const byName = (left: KpiCoverageDoctor, right: KpiCoverageDoctor): number =>
    Number(left.name == null) - Number(right.name == null) ||
    (left.name ?? "").localeCompare(right.name ?? "") ||
    left.contactCrmId - right.contactCrmId;
  covered.sort(
    (left, right) => compareText(right.lastVisitDate ?? "", left.lastVisitDate ?? "") || byName(left, right),
  );
  notCovered.sort(
    (left, right) =>
      Number(right.due) - Number(left.due) ||
      compareText(left.planDates[0] ?? "", right.planDates[0] ?? "") ||
      byName(left, right),
  );
  return { repKey: input.repKey, repName: input.repName, covered, notCovered };
}

export type KpisBoard = {
  month: string;
  monthLabel: string;
  /**
   * The call-rate window: whole month, a week, or an explicit range. While it is running it stops at
   * YESTERDAY (ruling C1, `todayLeftOut`); coverage and frequency run to `asOf`, which is today.
   */
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
   * THE MANAGER ROWS (owner, 2026-10-20), after the same filters — a separate list, never mixed
   * into `reps`, so no total, podium, facet or band on this board counts a manager. Each figure is
   * the average of the rows directly beneath him (his medical reps for a District Manager, the
   * managers reporting to him above that), built from the scoped rep rows BEFORE any filter, so a
   * filter changes which managers are shown and never what they average. In tree order. See
   * crm/kpis-manager-rows.ts.
   */
  managers: KpiManagerRow[];
  /**
   * How many reps the viewer's SCOPE contains, before any filter narrowed it.
   *
   * Printed beside the filtered count so "12 of 73" is always on screen. A filtered board that says
   * only "12 reps" is indistinguishable from a district that has twelve people, and a manager who
   * forgot a filter was on would read a partial board as the whole truth.
   */
  scopedReps: number;
  /**
   * How many of `reps` read "No GPS feed" (ruling A1, owner 2026-09-21): listed and marked, but left
   * out of the team's AM, PM and pharmacy call-rate figures. Printed above the tiles, so a call-rate
   * tile that covers fewer reps than the head count beside it is never a mystery.
   */
  noGpsFeedShown: number;
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
  /**
   * THE OVERALL KPI — the four measures above consolidated into one percentage, plus the line that
   * spells out the arithmetic with these numbers in it (owner, 2026-09-17: "you must show in a line
   * how it is calculated").
   *
   * It REPLACES NOTHING. Every figure in `totals` is untouched and every tile, column, band and
   * podium still reads exactly as it did — the owner's instruction was "let them separated as they
   * are and consolidate". Built from `totals` and nothing else, so the one number and the four it
   * came from can never disagree. See `crm/kpi-index.ts` for the cap, the exclusions, and why
   * forming this figure never forms the banned combined call rate.
   */
  kpiIndex: KpiIndex;
  amTarget: number;
  pmTarget: number;
  /** Null — no owner-set pharmacy target exists yet. See KpiRepRow.pharmacyAttainmentPct. */
  pharmacyTarget: number | null;
  /** The owner's coverage floor (2026-09-05). See kpis-filters.ts's COVERAGE_TARGET_FLOOR_PCT. */
  coverageFloorPct: number;
  /** Which rules scored this board: "legacy" until the CRM cutover date. See phoenix-kpi-rules.ts. */
  kpiRules?: KpiRules;
  /** Why a period split by the cutover kept the old rules. */
  kpiRulesNote?: string | null;
  /** Team lines only the Phoenix rules have. Null under the old rules. */
  phoenixTotals?: {
    campaignVisits: number;
    gradedDoctors: number;
    ungradedDoctors: number;
    /** Regular visits with no matching GPS check-in — rule 10, owner 2026-09-20. Counted on its own
     * team line, never folded into campaignVisits or any credited total. */
    regularNoCheckin: number;
  } | null;
  /**
   * The Coverage tab's two doctor lists for the ONE rep it has open. Null when no rep is open, and
   * always null when the board was built for any other tab.
   */
  coverageDetail?: KpiCoverageDetail | null;
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
export function buildKpiPodium(rows: readonly KpiRepRow[], rules: KpiRules = "legacy"): KpiPodium {
  // Under the Phoenix rules every submitted visit counts and frequency is the grade norm, so the
  // captions stop saying "verified" and "exactly on plan".
  const phoenix = rules === "phoenix";
  const callWord = phoenix ? "visits" : "verified";
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
      (row) => (phoenix ? `${row.onPlanDoctors} doctors at their grade norm` : `${row.onPlanDoctors} doctors exactly on plan`),
    ),
    amCallRate: top(
      (row) => row.hasCallRate && row.amAttainmentPct != null,
      (row) => row.amAttainmentPct ?? 0,
      (row) => (phoenix ? `${row.amVerified} AM visits in ${row.workingDays} days` : `${row.amVerified} verified AM calls in ${row.workingDays} days`),
    ),
    pmCallRate: top(
      (row) => row.hasCallRate && row.pmAttainmentPct != null,
      (row) => row.pmAttainmentPct ?? 0,
      (row) => (phoenix ? `${row.pmVerified} PM visits in ${row.workingDays} days` : `${row.pmVerified} verified PM calls in ${row.workingDays} days`),
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
      (row) => `${row.pharmacyVerified} ${callWord} pharmacy calls in ${row.workingDays} days`,
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
  /**
   * The basis the call-rate report counted on. Ruling A1 applies on "verified" only — from the CRM
   * cutover every submitted visit counts, so a missing feed costs a rep nothing and excuses nothing.
   */
  basis?: CallRateBasis;
}): KpiRepRow[] {
  const { callRates, docLists, scope, workingDays } = input;
  const amTarget = input.amTarget ?? AM_CALL_RATE_TARGET;
  const pmTarget = input.pmTarget ?? PM_CALL_RATE_TARGET;
  const pharmacyTarget = input.pharmacyTarget ?? PHARMACY_CALL_RATE_TARGET;
  const basis = input.basis ?? "verified";

  // Keyed on the CANONICAL hr id on both sides. Production hr ids are mixed case and carry legacy
  // aliases, and `canonicalHrIdKey` is the one comparison that handles both — a plain
  // `.trim().toLowerCase()` here would drop a renamed seat, which reads on screen as a rep with no
  // line rather than as a bug.
  const identityByHrId = new Map<string, KpiDirectoryEntry>();
  for (const entry of input.directory ?? []) {
    const key = canonicalHrIdKey(entry.hrId);
    if (key) identityByHrId.set(key, entry);
  }

  // `crm:<id>` for a rep with a CRM id — the join described above, unchanged — and `hr:<canonical>`
  // for a rep hired after the CRM cutover who has none. Those reps carry a NULL `agent_crm_id` on both
  // sources, and a crm-only dedupe gave each of them TWO rows: one holding the call rate with no
  // coverage, one holding the coverage with no call rate — half a rep, twice.
  const byRepKey = new Map<string, KpiRepRow>();
  const rows: KpiRepRow[] = [];
  const repKeyOf = (agentCrmId: number | null, agentHrId: string | null): string | null =>
    agentCrmId != null ? `crm:${agentCrmId}` : agentHrId ? `hr:${agentHrId}` : null;

  const blank = (agentCrmId: number | null, agentHrId: string | null, repName: string): KpiRepRow => ({
    agentCrmId,
    agentHrId,
    repName,
    lineName: null,
    regionName: null,
    areaName: null,
    managerName: null,
    managersAbove: [],
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
    noGpsFeed: false,
    awaitingValidation: 0,
    amAttainmentPct: null,
    pmAttainmentPct: null,
    pharmacyVerified: 0,
    pharmacyRate: null,
    pharmacyReported: 0,
    pharmacyReportedRate: null,
    pharmacyAttainmentPct: null,
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
    // `agentHrId` arrives already canonical (both call sites pass canonicalHrIdKey).
    const repKey = repKeyOf(agentCrmId, agentHrId);
    if (repKey != null) {
      const existing = byRepKey.get(repKey);
      if (existing) {
        // A name resolved on one side but not the other is still the same rep — keep the real one
        // rather than letting a blank overwrite it.
        if (!existing.repName && repName) existing.repName = repName;
        if (existing.agentHrId == null && agentHrId != null) existing.agentHrId = agentHrId;
        return existing;
      }
    }
    const created = blank(agentCrmId, agentHrId, repName);
    if (repKey != null) byRepKey.set(repKey, created);
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
    // Ruling A1: nothing could prove his visits, so the proved rates are ABSENT, not zero — and
    // `attainmentPct` below returns null for him on the same flag. The reported rates stay: they
    // are what he logged, and the gap between the two is still worth seeing.
    row.awaitingValidation = rate.awaitingValidation;
    // The ROW's own basis decides, with the board's as the fallback: a started team is on the Phoenix
    // rules while the rest of this same board is still on iReports360's (owner, 2026-10-07).
    row.noGpsFeed = hasNoGpsFeed(rate, rate.basis ?? basis);
    if (row.noGpsFeed) {
      row.amRate = null;
      row.pmRate = null;
      row.pharmacyRate = null;
    }
  }

  for (const list of docLists) {
    const row = claim(list.agentCrmId, canonicalHrIdKey(list.agentHrId), list.repName);
    // The builder's OWN key, the one stamped on every doctor row it counted this rep's coverage from.
    row.coverageRepKey = list.repKey;
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
      row.managersAbove = [...(identity.managersAbove ?? [])];
      row.jobTitle = identity.jobTitle;
      // The directory's display name is the nickname-aware one and is what the owner's
      // human-readable-names rule asks for; the CRM's agent name is the vendor's spelling. Prefer
      // the directory when it has something, but never blank out a name the CRM did supply.
      if (identity.displayName?.trim()) row.repName = identity.displayName.trim();
    }
    row.amAttainmentPct = attainmentPct(row, row.amVerified, amTarget);
    row.pmAttainmentPct = attainmentPct(row, row.pmVerified, pmTarget);
    row.pharmacyAttainmentPct = attainmentPct(row, row.pharmacyVerified, pharmacyTarget);
    row.meetsCoverageFloor = row.hasMeasurablePlan ? row.coveragePct >= COVERAGE_TARGET_FLOOR_PCT : null;
    // A rep with no doctor-list row (visits only) still gets a key: under the Phoenix rules his plan
    // is read from another source, and his list opens by it all the same.
    row.coverageRepKey ??= kpiCoverageRepKey(row);
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
  /** The managers above `managerName`, nearest first. Optional so a fixture can leave it out. */
  managersAbove?: readonly string[];
  /** His manager's hr id — the link the manager rows climb (crm/kpis-manager-rows.ts). The join
   * itself never reads it. */
  managerHrId?: string | null;
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
 *
 * Exported for the Weekly tab's quarter and semester roll-ups (crm/kpis-trend.ts), so a summed
 * quarter is scored by this formula and no second copy of it.
 */
export function attainmentPct(row: KpiRepRow, verified: number, target: number | null): number | null {
  if (target == null) return null;
  const expected = row.workingDays * target;
  // A rep with no GPS feed (ruling A1) has no proved calls to be a percentage of anything.
  if (!row.hasCallRate || row.noGpsFeed || expected <= 0) return null;
  return Math.round((verified / expected) * 100);
}

/**
 * PHASE 6 — restamps one row with the Phoenix KPI rules, in place.
 *
 * Only called once the CRM cutover makes those rules apply. The row keeps its shape, so the tabs,
 * filters, bands and podium read it unchanged; what the fields MEAN moves with the owner's rules:
 *   - the "verified" and "reported" counts are both every submitted regular visit (GPS is evidence);
 *   - the rep's working days are the days he was employed in the window;
 *   - coverage is the period's planned doctors with a visit;
 *   - `onPlanDoctors` / `underDoctors` are doctors at or below their grade norm, and `overDoctors`
 *     is always zero, because an extra visit is no longer a deviation.
 */
export function applyPhoenixKpis(row: KpiRepRow, kpis: PhoenixRepKpis): KpiRepRow {
  // `totalCalls` is every call the rep logged, campaign included — so a no-check-in Regular visit
  // belongs in it too. It stays OUT of `campaignCalls`/`campaignShare`'s numerator: rule 10 (owner,
  // 2026-09-20) keeps it off the Campaign line, identified on its own via `row.phoenix.regularNoCheckin`.
  const fieldVisits = kpis.am.visits + kpis.pm.visits + kpis.campaignVisits + kpis.regularNoCheckin;
  row.phoenix = kpis;
  // Ruling A1 is a pre-cutover rule: under these rules GPS is evidence only, so a missing feed
  // neither blanks a rate nor takes a rep out of the team figures.
  row.noGpsFeed = false;
  row.workingDays = kpis.workingDays;
  row.amVerified = kpis.am.visits;
  row.pmVerified = kpis.pm.visits;
  row.amRate = kpis.am.rate;
  row.pmRate = kpis.pm.rate;
  row.amReported = kpis.am.visits;
  row.pmReported = kpis.pm.visits;
  row.amReportedRate = kpis.am.rate;
  row.pmReportedRate = kpis.pm.rate;
  row.amAttainmentPct = kpis.am.attainmentPct;
  row.pmAttainmentPct = kpis.pm.attainmentPct;
  row.pharmacyVerified = kpis.pharmacy.visits;
  row.pharmacyReported = kpis.pharmacy.visits;
  row.pharmacyRate = kpis.pharmacy.rate;
  row.pharmacyReportedRate = kpis.pharmacy.rate;
  row.pharmacyAttainmentPct = kpis.pharmacy.attainmentPct;
  row.totalCalls = fieldVisits;
  row.campaignCalls = kpis.campaignVisits;
  row.campaignShare = fieldVisits > 0 ? kpis.campaignVisits / fieldVisits : 0;
  row.hasCallRate = row.hasCallRate || fieldVisits + kpis.pharmacy.visits > 0;
  row.plannedDoctors = kpis.coverage.planned;
  row.visitedDoctors = kpis.coverage.visited;
  row.missedDoctors = kpis.coverage.missed;
  row.coveragePct = kpis.coverage.pct ?? 0;
  row.hasMeasurablePlan = kpis.coverage.planned > 0;
  row.meetsCoverageFloor = row.hasMeasurablePlan ? row.coveragePct >= COVERAGE_TARGET_FLOOR_PCT : null;
  row.onPlanDoctors = kpis.frequency.met;
  row.underDoctors = kpis.frequency.below;
  row.overDoctors = 0;
  row.frequencyPct = kpis.frequency.pct ?? 0;
  return row;
}

/** The KPI standards with the PM 8-12 band removed — rule 2 of phase 6. The shared defaults keep the
 * band, because the old rules still score every period before the cutover. */
function withoutPmBand() {
  const base = resolveRepKpiStandards(null);
  return { ...base, PM: { ...base.PM, callRateBand: null } };
}

/** Builds the whole board for one viewer. */
export async function getKpisBoard(input: {
  access: AccessContext;
  month: string;
  period?: string | null;
  todayIso: string;
  /** The advanced filters from the URL. They can only ever NARROW what the scope gate allowed. */
  filters?: KpiFilterState;
  /**
   * Set by the Coverage tab alone: build `coverageDetail` for the rep the URL's `rep` names (see
   * {@link selectKpiCoverageRep}). Every other tab leaves it out and pays nothing for it.
   */
  coverageDoctors?: { rep: string | null } | null;
  /**
   * False skips the two per-rep KPI reports, and `kpiReports` comes back empty. Only the Weekly tab
   * passes it: it builds one board per week or month and prints neither report. Every other caller
   * leaves it out and gets them exactly as before.
   */
  includeReports?: boolean;
}): Promise<KpisBoard> {
  // TWO WINDOWS, one period (owner ruling C1, 2026-09-21 — "apply C1 to the KPIs board too").
  // `range` runs through TODAY and carries coverage and frequency: a doctor seen this morning is a
  // doctor reached, and neither measure divides by days. `callRange` stops at YESTERDAY and carries
  // every call rate — the rate's numerator AND its working days — so a day that is not over yet is
  // never in the denominator with none of its calls in the numerator. Same period, same start, same
  // window end; only the last day scored differs.
  const range = repsPlansRange(input.month, input.todayIso, input.period);
  const callRange = repsPlansRange(input.month, input.todayIso, input.period, CALL_RATE_THROUGH_YESTERDAY);
  const scope = await getDoctorCoverageScope(input.access);
  const monthLabel = monthLabelOf(input.month);
  const filters = input.filters ?? EMPTY_KPI_FILTERS;

  const empty: KpisBoard = {
    month: input.month,
    monthLabel,
    range: callRange,
    workingDays: 0,
    workingDaysInWindow: 0,
    holidayDays: 0,
    holidaysComplete: true,
    asOf: range.dateTo,
    isCurrentMonth: range.isCurrentMonth,
    scopeLabel: "",
    scopeReason: null,
    reps: [],
    managers: [],
    kpiReports: [],
    scopedReps: 0,
    noGpsFeedShown: 0,
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
    // Nothing to score on an empty board, so the index is null and its own line says so — an
    // absence, never a 0% that would read as "the field force did nothing".
    kpiIndex: kpiIndexOf({
      coveragePct: 0,
      frequencyPct: 0,
      hasMeasurablePlan: false,
      amAttainmentPct: null,
      pmAttainmentPct: null,
      hasCallRate: false,
    }),
    amTarget: AM_CALL_RATE_TARGET,
    pmTarget: PM_CALL_RATE_TARGET,
    pharmacyTarget: PHARMACY_CALL_RATE_TARGET,
    coverageFloorPct: COVERAGE_TARGET_FLOOR_PCT,
    kpiRules: "legacy",
    kpiRulesNote: null,
    phoenixTotals: null,
    coverageDetail: null,
  };

  if (scope.kind === "none") {
    return { ...empty, scopeLabel: "No reach", scopeReason: scope.reason };
  }

  // The directory is fetched INCLUDING inactive people. A rep who left mid-month still has rows in
  // both CRM sources for the days he worked, and dropping his identity here would print those days
  // against a blank line and area — the reads door already decides who is excluded, and this call
  // is only ever putting a name to an id.
  // ONLY THESE REPS' ROWS, when the scope is a few people (2026-10-01): a medical rep's landing tile
  // read the whole company's month for his one row. crm/kpi-board-agents.ts says why the narrowed
  // rows are the same rows; null keeps the company-wide read. The window spans both loaders' reads.
  // NOT FOR THE COVERAGE TAB: its doctor list names an off-plan doctor from ANOTHER rep's plan row
  // (buildRepDoctorListsBoard, "a doctor off THIS rep's plan is usually on another's"), and a read
  // of these reps alone would print that doctor as a bare id. Every other output of the doctor
  // lists the board reads is per rep, so only that tab keeps the company-wide read.
  const agentsRead = input.coverageDoctors
    ? Promise.resolve(null)
    : resolveKpiBoardAgents(scope, {
        from: callRange.dateFrom < range.dateFrom ? callRange.dateFrom : range.dateFrom,
        to: callRange.dateTo > range.windowEnd ? callRange.dateTo : range.windowEnd,
      });
  const [callRate, docList, employees, windowHolidays, cutover, startedWindows] = await Promise.all([
    // Through YESTERDAY (ruling C1): its working days are the denominator every rate on this board
    // divides by, the rep KPI reports below included.
    agentsRead.then((agents) =>
      loadCallRateReport({ dateFrom: callRange.dateFrom, dateTo: callRange.dateTo, ...(agents ? { agents } : {}) }),
    ),
    // THE PERIOD REACHES BOTH KPIs. Until 2026-09-04 this was `{ month: input.month }` and the
    // picker moved the call rate alone, so "Week 1" scored week 1's calls against the whole month's
    // doctor list. `windowEnd`, not `dateTo`: dateTo is capped at today, and capping the plan side
    // is exactly the shrinking denominator this change removed.
    agentsRead.then((agents) =>
      getRepDoctorLists({
        month: input.month,
        window: { from: range.dateFrom, to: range.windowEnd },
        // The Coverage tab picks one rep's doctors out of this list, so it must not be cut at the
        // drill-down cap. The rows are in memory either way; only the chosen rep's leave this file.
        uncapped: Boolean(input.coverageDoctors),
        ...(agents ? { agents } : {}),
      }),
    ),
    getEmployeeDirectoryRows({ includeInactive: true }),
    // The window's OWN end, not today. callRate.workingDays counts the days worked so far; this
    // counts the days the window contains. The pair is what separates "the team is behind" from
    // "it is the 3rd of the month" — see workingDaysInWindow on KpisBoard.
    loadCallRateHolidays(range.dateFrom, range.windowEnd),
    // Phase 6's switch. An unreadable setting is "no cutover": the board then shows exactly what it
    // showed before phase 6, which is never a wrong number, only an old rule.
    getCrmCutoverSetting().catch(() => NO_CRM_CUTOVER),
    // THE SWITCH IS PER GO-LIVE TEAM (owner, 2026-10-07: "switched gradually based on the go live
    // teams"). The global cutover above is still null on production and a team start never sets it, so
    // this board scored Delta (1) by the OLD rules while its reps were logging in Phoenix CRM. Fails
    // OPEN — an unreadable answer is "no started team" and the board shows what it showed before.
    loadStartedRepWindows(),
  ]);
  const rules = kpiRulesFor(cutover, range.dateFrom, range.windowEnd);
  // The reps whose own team had gone live before this period began. A board spanning a go-live
  // Saturday therefore holds BOTH rules at once, each row scored by its own.
  const phoenixRuleReps = phoenixRuleRepKeys(startedWindows, range.dateFrom);

  const workingDaysInWindow = range.notStarted
    ? 0
    : countCallRateWorkingDays(range.dateFrom, range.windowEnd, windowHolidays.dates);

  // The whole reporting chain, walked by HR id over the full directory, so "Reports to" can offer a
  // Regional or National Sales Manager and keep every rep beneath him (owner, 2026-10-20: "when you
  // filter by manager you find no manager").
  const managersAboveByHrId = buildManagersAboveByHrId(employees, canonicalHrIdKey);
  // ONE mapping of the directory, read by the join (identity on each rep row) and by the manager
  // rows (the org links they climb), so the two can never describe a person differently.
  const directory: KpiDirectoryEntry[] = employees.map((employee) => ({
    hrId: employee.hrId,
    displayName: employee.displayName || employee.fullName || null,
    lineName: employee.lineName?.trim() || null,
    regionName: employee.regionName?.trim() || null,
    areaName: employee.areaName?.trim() || null,
    managerName: employee.managerName?.trim() || null,
    managersAbove: managersAboveByHrId.get(canonicalHrIdKey(employee.hrId) ?? "") ?? [],
    managerHrId: employee.managerHrId?.trim() || null,
    jobTitle: employee.jobTitle?.trim() || null,
  }));

  const allInScope = joinKpiRows({
    callRates: callRate.reps,
    docLists: docList.reps,
    scope,
    workingDays: callRate.workingDays,
    amTarget: AM_CALL_RATE_TARGET,
    pmTarget: PM_CALL_RATE_TARGET,
    pharmacyTarget: PHARMACY_CALL_RATE_TARGET,
    basis: callRate.basis ?? "verified",
    directory,
  });

  // MEDICAL REPS ONLY — owner, 2026-09-03 — for the REP rows. This runs BEFORE the facets and the
  // totals, so the whole page describes one population: 63 of the 70 rows in scope that September,
  // with 6 district sales managers and 1 product manager dropped. A manager carries no doctor plan of
  // his own, so as a rep row he scores "No plan" on two of the three measures and pulls the team
  // averages toward a number that describes nobody. ONE rule decides this for every CRM board —
  // crm/medical-rep.ts, which Reps Plans reaches through its seat-aware arm and this board through
  // the title arm, because the seat model never enters here. Managers come back on 2026-10-20 as
  // rows of a different kind — the averages of the rows beneath them, in `managers` below — and
  // never as rep rows, so this narrowing and everything counted from it stand unchanged.
  const scopedReps = keepMedicalRepsOnly(allInScope);

  // PHASE 6. Restamped BEFORE the facets, filters, podium and totals, so every one of them reads the
  // Phoenix numbers. Loaded when the company-wide cutover has passed, OR when ANY team in scope went
  // live before this period — the per-team switch (owner, 2026-10-07). Each row is then stamped only
  // if ITS OWN rep is one of them, so a rep still on iReports360 keeps the old numbers beside him.
  const phoenix =
    rules.rules === "phoenix" || phoenixRuleReps.size > 0
      ? await loadPhoenixRepKpis({
          scope,
          // dateTo through today for the visits coverage and frequency read; callRateTo stops the
          // call-rate lanes and their working days at yesterday (ruling C1).
          window: {
            dateFrom: range.dateFrom,
            dateTo: range.dateTo,
            windowEnd: range.windowEnd,
            callRateTo: callRange.dateTo,
          },
          month: { start: `${input.month}-01`, end: range.monthEnd },
          today: input.todayIso,
          employees,
          // Only the scope's reps when it is a few people, as the doctor-list half above reads —
          // and, like it, the Coverage tab keeps the company-wide read (crm/phoenix-kpi-data.ts).
          narrowToScope: !input.coverageDoctors,
        })
      : null;
  if (phoenix) {
    for (const row of scopedReps) {
      // PER REP. The company-wide cutover stamps everybody; a per-team start stamps only its own
      // people. Stamping a rep still on the vendor would score him against a rule his app does not
      // follow — the mirror image of the defect this change fixes.
      const key = normalizeHrIdForAccess(row.agentHrId);
      if (rules.rules !== "phoenix" && !(key && phoenixRuleReps.has(key))) continue;
      applyPhoenixKpis(row, phoenix.kpisFor(row.agentHrId));
    }
  }

  // THE MANAGER ROWS (owner, 2026-10-20: "add manager row and every dm kpis is calculated based on
  // his reps averag and nsm based on dsms av and so on"). Built HERE, after the medical-reps rule and
  // the Phoenix restamp, so a manager averages the very numbers his reps' rows print — and from
  // `scopedReps`, before any filter, so a filter decides which managers are shown, never what they
  // average. Two gates, both narrowing: only reps the scope already let through are averaged, and a
  // manager gets a row only when the viewer may see him — anyone inside his scope, or himself. The
  // downward rule (owner, 2026-09-04: "you see yourself and your scope down") keeps a viewer's own
  // manager off his board, and that manager's row could only have averaged part of his team anyway.
  const viewerKey = normalizeHrIdForAccess(input.access.hrId);
  const scopedManagers = buildKpiManagerRows({
    reps: scopedReps,
    directory,
    canSee: (hrId) =>
      isAgentInScope(scope, hrId) || (viewerKey != null && normalizeHrIdForAccess(hrId) === viewerKey),
  });

  // Facets are built from the SCOPED rows and the filters applied after, in that order. Building
  // them from the filtered rows instead would make every facet collapse to whatever is already
  // selected — pick "Pedia" and Line would then offer only Pedia, with no way back except editing
  // the URL by hand.
  const facets = buildKpiFacets(scopedReps);
  const reps = applyKpiFilters(scopedReps, filters);
  // The same filter state, read the way a manager row can answer it — see applyKpiManagerFilters.
  const managers = applyKpiManagerFilters(scopedManagers, filters);

  // THE COVERAGE TAB'S DOCTOR LISTS, for one rep. Chosen from `reps` — after the scope gate AND the
  // filters — so a URL can only ever open a rep who is already on screen. Read from whichever rules
  // scored his row, so the two lists always add up to the Covered and Not reached numbers beside them.
  const coverageRep = input.coverageDoctors ? selectKpiCoverageRep(reps, input.coverageDoctors.rep) : null;
  const coverageRepKey = coverageRep?.coverageRepKey ?? null;
  const coverageDetail =
    coverageRep && coverageRepKey
      ? buildKpiCoverageDetail({
          repKey: coverageRepKey,
          repName: coverageRep.repName,
          // Read from whichever rules scored THIS rep's row — a board can hold both at once, and a
          // rep still on the vendor's rules must get the plan-basis list that adds up to his row.
          doctors:
            phoenix && coverageRep.phoenix
              ? phoenix.coverageDoctorsFor(coverageRep.agentHrId)
              : legacyKpiCoverageDoctors(docList.doctors, coverageRepKey),
          todayIso: input.todayIso,
        })
      : null;

  // THE TWO REPORTS RIDE THE SAME POPULATION as the four tabs beside them: the same scope object
  // (never re-resolved — see rep-kpi-reports-data.ts), then narrowed to exactly the rows that
  // survived `keepMedicalRepsOnly` and the advanced filters. Anything else and the strip would show
  // six tabs describing two different sets of people, with nothing on screen saying so.
  //
  // Awaited here rather than in the batch above because it needs `callRate.workingDays` as its
  // denominator, and that is the same number the other tabs divide by. A second round trip is the
  // price of the two boards agreeing; splitting the fetch from the arithmetic to save it would put
  // a second working-day count on the page, which is the disagreement this is avoiding.
  //
  // The Weekly tab opts out (`includeReports: false`): it prints neither report, and builds one
  // board per column, so paying for them there would be a whole wasted read per week.
  const kpiReportRows: { reports: RepKpiReports[] } =
    input.includeReports === false
      ? { reports: [] }
      : await loadRepKpiReports({
          scope,
          dateFrom: range.dateFrom,
          dateTo: range.dateTo,
          // The reports score coverage and frequency off the same visits, so the fetch still runs
          // through today and only the call-rate count stops at yesterday — over the same working days.
          callRateTo: callRange.dateTo,
          workingDays: callRate.workingDays,
          holidays: windowHolidays.dates,
          // Rule 2: the 8-12 PM band is gone under the Phoenix rules — PM passes at 10 or more.
          standards: phoenix ? withoutPmBand() : undefined,
          repNameByHrId: new Map(
            scopedReps.flatMap((row) => (row.agentHrId ? [[row.agentHrId, row.repName] as const] : [])),
          ),
        });
  const visibleRepKeys = new Set(reps.flatMap((row) => (row.agentHrId ? [row.agentHrId] : [])));
  const kpiReports = kpiReportRows.reports.filter((report) => report.repKey != null && visibleRepKeys.has(report.repKey));

  // Totals are summed from the SCOPED rows, never taken from either source's own `totals`. Those
  // cover the whole company, and a District Manager reading a company total beside his own six reps
  // would have no way to tell the two apart.
  const totals = sumKpiTeamTotals(reps);
  const noGpsFeedShown = reps.filter((row) => row.noGpsFeed).length;

  // Hoisted out of the `totals` literal below so the OVERALL KPI averages the very numbers the
  // tiles print. Computed twice — once for the tile, once for the average — is how the one figure
  // and the four beside it would drift the first time either expression changed. The arithmetic is
  // `kpiTeamFigures`, which the Business Review pack reads as well.
  const team = kpiTeamFigures(totals, phoenix ? "phoenix" : "legacy");
  const denominator = totals.repWorkingDays;
  const teamCoveragePct = team.coveragePct;
  const teamFrequencyPct = team.frequencyPct;
  const teamAmAttainmentPct = team.amAttainmentPct;
  const teamPmAttainmentPct = team.pmAttainmentPct;

  return {
    ...empty,
    workingDays: callRate.workingDays,
    workingDaysInWindow,
    holidayDays: callRate.holidayDays,
    holidaysComplete: callRate.holidaysComplete && (phoenix?.holidaysComplete ?? true),
    kpiRules: rules.rules,
    kpiRulesNote: rules.note,
    phoenixTotals: phoenix
      ? {
          campaignVisits: totals.campaignCalls,
          gradedDoctors: totals.gradedDoctors,
          ungradedDoctors: totals.ungradedDoctors,
          regularNoCheckin: totals.regularNoCheckin,
        }
      : null,
    asOf: docList.asOf,
    isCurrentMonth: docList.isCurrentMonth,
    scopeLabel: scope.kind === "company" ? scope.label : scope.label,
    reps,
    managers,
    coverageDetail,
    kpiReports,
    scopedReps: scopedReps.length,
    noGpsFeedShown,
    facets,
    filters,
    // The podium ranks the FILTERED rows on purpose: filter to Pedia and the leaderboard answers
    // "best in Pedia", which is the question the filter just asked. A podium that ignored the
    // filter would show three names the visible table does not even contain.
    podium: buildKpiPodium(reps, rules.rules),
    totals: {
      reps: totals.reps,
      workingDays: callRate.workingDays,
      amVerified: totals.amVerified,
      pmVerified: totals.pmVerified,
      amRate: team.amRate,
      pmRate: team.pmRate,
      amReported: totals.amReported,
      pmReported: totals.pmReported,
      amReportedRate: denominator > 0 ? totals.amReported / denominator : null,
      pmReportedRate: denominator > 0 ? totals.pmReported / denominator : null,
      campaignCalls: totals.campaignCalls,
      totalCalls: totals.totalCalls,
      plannedDoctors: totals.plannedDoctors,
      visitedDoctors: totals.visitedDoctors,
      coveragePct: teamCoveragePct,
      meetsCoverageFloor: team.meetsCoverageFloor,
      onPlanDoctors: totals.onPlanDoctors,
      underDoctors: totals.underDoctors,
      overDoctors: totals.overDoctors,
      // ONE denominator under both plan KPIs — the window's whole list. See the header.
      // Under the Phoenix rules frequency is judged over GRADED doctors only (rule 7).
      frequencyPct: teamFrequencyPct,
      // Two scores, never their blend — the owner's rule. See `attainmentPct`.
      amAttainmentPct: teamAmAttainmentPct,
      pmAttainmentPct: teamPmAttainmentPct,
      pharmacyVerified: totals.pharmacyVerified,
      pharmacyRate: team.pharmacyRate,
      pharmacyReported: totals.pharmacyReported,
      pharmacyReportedRate: denominator > 0 ? totals.pharmacyReported / denominator : null,
    },
    // THE OVERALL KPI (owner, 2026-09-17). The four team figures above, each capped at its own
    // standard and averaged with equal weight — and the printed line that proves it. AM and PM
    // enter as two separate measures, so no combined call rate is formed on the way here.
    kpiIndex: kpiIndexOf({
      coveragePct: teamCoveragePct,
      frequencyPct: teamFrequencyPct,
      hasMeasurablePlan: totals.plannedDoctors > 0,
      amAttainmentPct: teamAmAttainmentPct,
      pmAttainmentPct: teamPmAttainmentPct,
      hasCallRate: totals.reps > 0,
      // Every rep on the board read "No GPS feed", so the team has no proved call to score.
      noGpsFeed: noGpsFeedShown > 0 && noGpsFeedShown === totals.reps,
    }),
  };
}

/**
 * The team's sums over the rows on screen — what every team tile and the overall KPI are built from.
 *
 * Pure, so the one exclusion in it can be tested without a database: a rep with NO GPS FEED (ruling
 * A1, owner 2026-09-21) is counted as a rep and in coverage and frequency, which never read GPS,
 * but his calls and his working days leave the call-rate sums TOGETHER. Leaving only his proved
 * calls out would divide the rest of the team's calls by his days as well, and read the team lower
 * for a feed that failed; leaving only his days out would count calls against no one.
 */
export function sumKpiTeamTotals(reps: readonly KpiRepRow[]) {
  const accumulator = {
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
    repWorkingDays: 0,
    gradedDoctors: 0,
    ungradedDoctors: 0,
    regularNoCheckin: 0,
  };
  for (const row of reps) {
    accumulator.reps += 1;
    if (!row.noGpsFeed) {
      accumulator.amVerified += row.amVerified;
      accumulator.pmVerified += row.pmVerified;
      accumulator.amReported += row.amReported;
      accumulator.pmReported += row.pmReported;
      accumulator.pharmacyVerified += row.pharmacyVerified;
      accumulator.pharmacyReported += row.pharmacyReported;
      accumulator.repWorkingDays += row.workingDays;
    }
    accumulator.campaignCalls += row.campaignCalls;
    accumulator.totalCalls += row.totalCalls;
    accumulator.plannedDoctors += row.plannedDoctors;
    accumulator.visitedDoctors += row.visitedDoctors;
    accumulator.onPlanDoctors += row.onPlanDoctors;
    accumulator.underDoctors += row.underDoctors;
    accumulator.overDoctors += row.overDoctors;
    accumulator.gradedDoctors += row.phoenix?.frequency.judged ?? 0;
    accumulator.ungradedDoctors += row.phoenix?.frequency.ungraded ?? 0;
    accumulator.regularNoCheckin += row.phoenix?.regularNoCheckin ?? 0;
  }
  return accumulator;
}

/**
 * A team's coverage, frequency and call rate, from its summed rows — the ONE copy of the team
 * arithmetic. This board's tiles and overall KPI read it, and so does the Business Review pack
 * (owner, 2026-10-01: "add all three"), so a district's coverage in the pack can never differ from
 * the same district on this board.
 *
 * The team rate is the team's calls over its rep-days — the average rep's rate, never the sum of the
 * rates, which would make a district of six look six times better than any of its reps. Summed per
 * rep rather than working days times head count: under the Phoenix rules a mid-month joiner carries
 * only the days he was employed (rule 4), and multiplying would charge him the rest. AM and PM are
 * each scored against their OWN target and never blended (owner, 2026-09-04). Frequency is judged
 * over GRADED doctors under the Phoenix rules (rule 7), over the planned list before them.
 */
export function kpiTeamFigures(totals: ReturnType<typeof sumKpiTeamTotals>, rules: KpiRules) {
  const denominator = totals.repWorkingDays;
  const coveragePct = pct(totals.visitedDoctors, totals.plannedDoctors);
  return {
    coveragePct,
    meetsCoverageFloor: totals.plannedDoctors > 0 ? coveragePct >= COVERAGE_TARGET_FLOOR_PCT : null,
    frequencyPct:
      rules === "phoenix"
        ? pct(totals.onPlanDoctors, totals.gradedDoctors)
        : pct(totals.onPlanDoctors, totals.plannedDoctors),
    amRate: denominator > 0 ? totals.amVerified / denominator : null,
    pmRate: denominator > 0 ? totals.pmVerified / denominator : null,
    pharmacyRate: denominator > 0 ? totals.pharmacyVerified / denominator : null,
    amAttainmentPct:
      denominator > 0 ? Math.round((totals.amVerified / (denominator * AM_CALL_RATE_TARGET)) * 100) : null,
    pmAttainmentPct:
      denominator > 0 ? Math.round((totals.pmVerified / (denominator * PM_CALL_RATE_TARGET)) * 100) : null,
  };
}
