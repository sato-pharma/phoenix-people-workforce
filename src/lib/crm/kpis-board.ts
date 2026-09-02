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
//   COVERAGE   visitedDoctors / plannedDoctors, month to date. "I have a hundred
//              contacts in my list; how much did I cover from them?" One visit is
//              enough — grade and count are the other KPI's business.
//
//   FREQUENCY  onPlanDoctors / (plannedDoctors - notDue). "If he tell three times
//              and he visited three times, this is correct." Exact is the ONLY
//              pass: two is `under`, four is `over`, and both are deviations.
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

import { getDoctorCoverageScope, type DoctorCoverageScope } from "@/lib/crm/doctor-coverage-scope";
import {
  applyKpiFilters,
  buildKpiFacets,
  EMPTY_KPI_FILTERS,
  keepMedicalRepsOnly,
  type KpiFacets,
  type KpiFilterState,
} from "@/lib/crm/kpis-filters";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { loadCallRateReport } from "@/lib/crm/call-rate-service";
import { countCallRateWorkingDays } from "@/lib/crm/call-rate";
import { loadCallRateHolidays } from "@/lib/crm/call-rate-holidays";
import { getRepDoctorLists, monthLabelOf, type RepDoctorListRepRow } from "@/lib/crm/rep-doctor-lists";
import { repsPlansRange, repsPlansWeeks, type RepsPlansRange } from "@/lib/crm/reps-plans";
import { AM_CALL_RATE_TARGET, PM_CALL_RATE_TARGET, type RepCallRate } from "@/lib/crm/call-rate";
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
 * The periods the picker offers: the whole month, then each of its weeks.
 *
 * Future weeks are deliberately KEPT. Picking one is answered honestly — `notStarted` makes every
 * rate null and the board says the period has not begun — which is more useful than hiding the
 * option and leaving a manager wondering why week 4 vanished on the 10th.
 */
export function kpiPeriodOptions(month: string, todayIso: string): KpiPeriodOption[] {
  return [
    { label: "Whole month", value: "month" },
    ...repsPlansWeeks(month, todayIso).map((week) => ({ label: week.label, value: week.key })),
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
   * Verified AM+PM calls as a percentage of what the two targets asked for over the same days.
   *
   * NOT a fourth KPI. `attainmentPct` is already a field on CallRateSlice in call-rate.ts; this is
   * the same arithmetic over both slices at once, so the board can band and sort the call rate the
   * way it bands coverage and frequency. Null when the window has no working days to divide by.
   */
  callRateAttainmentPct: number | null;

  // ── Coverage and frequency (the whole month) ──────────────────────────────
  plannedDoctors: number;
  visitedDoctors: number;
  missedDoctors: number;
  coveragePct: number;
  onPlanDoctors: number;
  underDoctors: number;
  overDoctors: number;
  notDueDoctors: number;
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
  /** Facet options and counts, built from the SCOPED rows so a choice never returns an empty board. */
  facets: KpiFacets;
  /** The filter state actually applied, echoed back so the UI can render and clear it. */
  filters: KpiFilterState;
  /** Best three reps on each of the three measures. Never a blended rank — see kpis-filters.ts. */
  podium: KpiPodium;
  totals: {
    reps: number;
    workingDays: number;
    amVerified: number;
    pmVerified: number;
    amRate: number | null;
    pmRate: number | null;
    campaignCalls: number;
    totalCalls: number;
    plannedDoctors: number;
    visitedDoctors: number;
    coveragePct: number;
    onPlanDoctors: number;
    underDoctors: number;
    overDoctors: number;
    frequencyPct: number;
    /** Team verified calls against the team's own AM+PM target. Null with no working days. */
    callRateAttainmentPct: number | null;
  };
  amTarget: number;
  pmTarget: number;
};

/** One place on a podium. `value` is already the percentage the caption prints. */
export type KpiPodiumEntry = { repName: string; value: number; caption: string };

/**
 * The three leaderboards, one per measure.
 *
 * THREE, not one. A single "best rep" list would need a blended score, and kpis-board's whole
 * premise is that it adds no fourth measure — the three disagree on purpose (production has run
 * 68% coverage against 39% frequency in the same month), and a blend would hide exactly the gap
 * the board exists to show. So the best coverage, the best frequency and the best call rate are
 * three separate answers, and often three different people.
 */
export type KpiPodium = {
  coverage: KpiPodiumEntry[];
  frequency: KpiPodiumEntry[];
  callRate: KpiPodiumEntry[];
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
    callRate: top(
      (row) => row.hasCallRate && row.callRateAttainmentPct != null,
      (row) => row.callRateAttainmentPct ?? 0,
      (row) => `${row.amVerified + row.pmVerified} verified calls in ${row.workingDays} days`,
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

/**
 * Whether this rep is inside the viewer's reach.
 *
 * FAILS CLOSED on a missing hr id. A row whose identity did not resolve cannot be PROVEN to belong
 * to this manager's team, and the cost of the two mistakes is not symmetric: hiding a rep from his
 * own manager is a visible gap he will report, while showing him somebody else's rep is a silent
 * confidentiality breach nobody notices. Company scope short-circuits and keeps everything.
 */
function isInScope(scope: DoctorCoverageScope, agentHrId: string | null): boolean {
  if (scope.kind === "company") return true;
  if (scope.kind === "none") return false;
  if (agentHrId == null) return false;
  return scope.agentHrIds.some((allowed) => canonicalHrIdKey(allowed) === agentHrId);
}

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
}): KpiRepRow[] {
  const { callRates, docLists, scope, workingDays } = input;
  const amTarget = input.amTarget ?? AM_CALL_RATE_TARGET;
  const pmTarget = input.pmTarget ?? PM_CALL_RATE_TARGET;

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
    totalCalls: 0,
    campaignCalls: 0,
    campaignShare: 0,
    campaignOnlyDays: 0,
    hasCallRate: false,
    callRateAttainmentPct: null,
    plannedDoctors: 0,
    visitedDoctors: 0,
    missedDoctors: 0,
    coveragePct: 0,
    onPlanDoctors: 0,
    underDoctors: 0,
    overDoctors: 0,
    notDueDoctors: 0,
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
    row.totalCalls = rate.am.total + rate.pm.total + rate.unspecified;
    row.campaignCalls = rate.am.campaign + rate.pm.campaign;
    row.campaignShare = rate.campaignShare;
    row.campaignOnlyDays = rate.campaignOnlyDays;
    row.hasCallRate = true;
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
    row.notDueDoctors = list.notDueDoctors;
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
    row.callRateAttainmentPct = callRateAttainment(row, amTarget, pmTarget);
  }

  // Scope is applied AFTER the join, never before: a rep whose hr id appears on only one of the two
  // sources would otherwise be judged on the source that happens to be missing it.
  const scoped = rows.filter((row) => isInScope(scope, row.agentHrId));
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
 * Verified calls against what the AM and PM targets asked for over the same days.
 *
 * Both slices are put over ONE denominator rather than averaging two percentages. Averaging would
 * weight the AM target (2 calls) equally with the PM target (10), so a rep who hit AM and did
 * nothing all afternoon would read 50% — half of a day's work — when he in fact delivered 2 of the
 * 12 calls the targets asked for, which is 17%.
 */
function callRateAttainment(row: KpiRepRow, amTarget: number, pmTarget: number): number | null {
  const expected = row.workingDays * (amTarget + pmTarget);
  if (!row.hasCallRate || expected <= 0) return null;
  return Math.round(((row.amVerified + row.pmVerified) / expected) * 100);
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
      campaignCalls: 0,
      totalCalls: 0,
      plannedDoctors: 0,
      visitedDoctors: 0,
      coveragePct: 0,
      onPlanDoctors: 0,
      underDoctors: 0,
      overDoctors: 0,
      frequencyPct: 0,
      callRateAttainmentPct: null,
    },
    amTarget: AM_CALL_RATE_TARGET,
    pmTarget: PM_CALL_RATE_TARGET,
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
    getRepDoctorLists({ month: input.month }),
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
  // that describes nobody. See keepMedicalRepsOnly in kpis-filters.ts for why an unrecorded title
  // is kept rather than dropped.
  const scopedReps = keepMedicalRepsOnly(allInScope);

  // Facets are built from the SCOPED rows and the filters applied after, in that order. Building
  // them from the filtered rows instead would make every facet collapse to whatever is already
  // selected — pick "Pedia" and Line would then offer only Pedia, with no way back except editing
  // the URL by hand.
  const facets = buildKpiFacets(scopedReps);
  const reps = applyKpiFilters(scopedReps, filters);

  // Totals are summed from the SCOPED rows, never taken from either source's own `totals`. Those
  // cover the whole company, and a District Manager reading a company total beside his own six reps
  // would have no way to tell the two apart.
  const totals = reps.reduce(
    (accumulator, row) => {
      accumulator.reps += 1;
      accumulator.amVerified += row.amVerified;
      accumulator.pmVerified += row.pmVerified;
      accumulator.campaignCalls += row.campaignCalls;
      accumulator.totalCalls += row.totalCalls;
      accumulator.plannedDoctors += row.plannedDoctors;
      accumulator.visitedDoctors += row.visitedDoctors;
      accumulator.onPlanDoctors += row.onPlanDoctors;
      accumulator.underDoctors += row.underDoctors;
      accumulator.overDoctors += row.overDoctors;
      accumulator.notDue += row.notDueDoctors;
      return accumulator;
    },
    {
      reps: 0,
      amVerified: 0,
      pmVerified: 0,
      campaignCalls: 0,
      totalCalls: 0,
      plannedDoctors: 0,
      visitedDoctors: 0,
      onPlanDoctors: 0,
      underDoctors: 0,
      overDoctors: 0,
      notDue: 0,
    },
  );

  // The team rate is the team's calls over ONE rep-equivalent's working days times the head count —
  // i.e. the average rep's rate, not the sum. Summing the rates instead would make a district of six
  // look six times better than any of its reps.
  const denominator = callRate.workingDays * totals.reps;
  // notDue doctors are held OUT of the frequency denominator for the same reason they are per rep:
  // a call the plan schedules for next week is not late, and counting it either way is a lie.
  const frequencyBase = totals.plannedDoctors - totals.notDue;

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
      campaignCalls: totals.campaignCalls,
      totalCalls: totals.totalCalls,
      plannedDoctors: totals.plannedDoctors,
      visitedDoctors: totals.visitedDoctors,
      coveragePct: pct(totals.visitedDoctors, totals.plannedDoctors),
      onPlanDoctors: totals.onPlanDoctors,
      underDoctors: totals.underDoctors,
      overDoctors: totals.overDoctors,
      frequencyPct: pct(totals.onPlanDoctors, frequencyBase),
      // Same single-denominator rule as the per-rep figure — see `callRateAttainment`.
      callRateAttainmentPct:
        denominator > 0
          ? Math.round(
              ((totals.amVerified + totals.pmVerified) / (denominator * (AM_CALL_RATE_TARGET + PM_CALL_RATE_TARGET))) *
                100,
            )
          : null,
    },
  };
}
