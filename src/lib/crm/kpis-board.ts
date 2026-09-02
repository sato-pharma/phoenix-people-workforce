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

import { getDoctorCoverageScope, isAgentInScope, type DoctorCoverageScope } from "@/lib/crm/doctor-coverage-scope";
import { loadMedicalRepRoster } from "@/lib/crm/medical-rep-data";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { loadCallRateReport } from "@/lib/crm/call-rate-service";
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

  // ── Call rate (the selected period) ───────────────────────────────────────
  /** Sat–Wed days in the period, national holidays already removed. */
  workingDays: number;
  amVerified: number;
  pmVerified: number;
  /** verified AM calls / working days. Null when the period has no working days. */
  amRate: number | null;
  pmRate: number | null;
  /**
   * EVERY call the rep logged, and its rate - what his number looks like if nobody checks. Carried
   * BESIDE the verified rate, never instead of it.
   *
   * Both boards read one `CallRateSlice`. Reps Plans prints `verifiedRate` and `totalRate` side by
   * side; this board took `verifiedRate` alone and dropped the other, so the same rep in the same
   * month had two different call rates depending on which screen you opened - and the manager on
   * this one had no way to see the gap the other board exists to show. That is the fault Doctor
   * Coverage was retired for: two boards answering one question with disagreeing measures.
   *
   * Nothing about the headline moved. `amRate` is still verified and still THE KPI; this is a
   * second number arriving beside it so the two screens can be read against each other.
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
};

export type KpisBoard = {
  month: string;
  monthLabel: string;
  /** The call-rate window: whole month, a week, or an explicit range. */
  range: RepsPlansRange;
  /** Sat–Wed days in the window after holidays came out. */
  workingDays: number;
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
  reps: KpiRepRow[];
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
    onPlanDoctors: number;
    underDoctors: number;
    overDoctors: number;
    frequencyPct: number;
  };
  amTarget: number;
  pmTarget: number;
};

/* The scope check moved to crm/doctor-coverage-scope.ts as `isAgentInScope` on 2026-09-03, when
 * Reps Plans acquired viewer scoping and needed the same one. It was private here, so that board
 * would have had to write its own comparison — and a second implementation of "is this rep on your
 * team" is precisely the drift that got Doctor Coverage retired. The hr-id canonicalisation notes
 * that used to sit here moved with it. */

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
   * Whether an hr id belongs to a medical rep - see crm/medical-rep.ts for the rule and the
   * production numbers behind it. Optional so the pure join stays testable without a roster; a
   * caller that omits it gets every CRM agent, which is what this board did before 2026-09-03.
   */
  isMedicalRep?: (hrId: string | null) => boolean;
}): KpiRepRow[] {
  const { callRates, docLists, scope, workingDays } = input;
  const isMedicalRep = input.isMedicalRep ?? (() => true);

  const byCrmId = new Map<number, KpiRepRow>();
  const rows: KpiRepRow[] = [];

  const blank = (agentCrmId: number | null, agentHrId: string | null, repName: string): KpiRepRow => ({
    agentCrmId,
    agentHrId,
    repName,
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
    // `total` is verified + unverified + campaign, and `totalRate` is it over the same working
    // days - the exact two fields Reps Plans renders as "Reported". One slice, one arithmetic, so
    // the two boards cannot drift apart again.
    row.amReported = rate.am.total;
    row.pmReported = rate.pm.total;
    row.amReportedRate = rate.am.totalRate;
    row.pmReportedRate = rate.pm.totalRate;
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
  }

  // Scope is applied AFTER the join, never before: a rep whose hr id appears on only one of the two
  // sources would otherwise be judged on the source that happens to be missing it. The medical-rep
  // filter rides in the same pass, for the same reason - it reads the hr id, and the join is where
  // a row's hr id is finally settled.
  //
  // Both totals below are summed from THIS list, so dropping the managers corrects the team average
  // as well as the rows. That is the point: a District Manager's handful of visits was being
  // averaged into a rate that is supposed to describe reps.
  const scoped = rows.filter((row) => isAgentInScope(scope, row.agentHrId) && isMedicalRep(row.agentHrId));
  scoped.sort((left, right) => left.repName.localeCompare(right.repName));
  return scoped;
}

/** Builds the whole board for one viewer. */
export async function getKpisBoard(input: {
  access: AccessContext;
  month: string;
  period?: string | null;
  todayIso: string;
}): Promise<KpisBoard> {
  const range = repsPlansRange(input.month, input.todayIso, input.period);
  const scope = await getDoctorCoverageScope(input.access);
  const monthLabel = monthLabelOf(input.month);

  const empty: KpisBoard = {
    month: input.month,
    monthLabel,
    range,
    workingDays: 0,
    holidayDays: 0,
    holidaysComplete: true,
    asOf: range.dateTo,
    isCurrentMonth: range.isCurrentMonth,
    scopeLabel: "",
    scopeReason: null,
    reps: [],
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
      onPlanDoctors: 0,
      underDoctors: 0,
      overDoctors: 0,
      frequencyPct: 0,
    },
    amTarget: AM_CALL_RATE_TARGET,
    pmTarget: PM_CALL_RATE_TARGET,
  };

  if (scope.kind === "none") {
    return { ...empty, scopeLabel: "No reach", scopeReason: scope.reason };
  }

  const [callRate, docList, roster] = await Promise.all([
    loadCallRateReport({ dateFrom: range.dateFrom, dateTo: range.dateTo }),
    getRepDoctorLists({ month: input.month }),
    loadMedicalRepRoster(),
  ]);

  const reps = joinKpiRows({
    callRates: callRate.reps,
    docLists: docList.reps,
    scope,
    workingDays: callRate.workingDays,
    isMedicalRep: (hrId) => roster.isMedicalRep(hrId),
  });

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
      accumulator.notDue += row.notDueDoctors;
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
    holidayDays: callRate.holidayDays,
    holidaysComplete: callRate.holidaysComplete,
    asOf: docList.asOf,
    isCurrentMonth: docList.isCurrentMonth,
    scopeLabel: scope.kind === "company" ? scope.label : scope.label,
    reps,
    totals: {
      reps: totals.reps,
      workingDays: callRate.workingDays,
      amVerified: totals.amVerified,
      pmVerified: totals.pmVerified,
      amRate: denominator > 0 ? totals.amVerified / denominator : null,
      pmRate: denominator > 0 ? totals.pmVerified / denominator : null,
      // The SAME denominator as the verified team rate above - the average rep's reported rate, not
      // a sum. Dividing the pair by different things would make the two halves incomparable, which
      // is the whole reason for printing them together.
      amReported: totals.amReported,
      pmReported: totals.pmReported,
      amReportedRate: denominator > 0 ? totals.amReported / denominator : null,
      pmReportedRate: denominator > 0 ? totals.pmReported / denominator : null,
      campaignCalls: totals.campaignCalls,
      totalCalls: totals.totalCalls,
      plannedDoctors: totals.plannedDoctors,
      visitedDoctors: totals.visitedDoctors,
      coveragePct: pct(totals.visitedDoctors, totals.plannedDoctors),
      onPlanDoctors: totals.onPlanDoctors,
      underDoctors: totals.underDoctors,
      overDoctors: totals.overDoctors,
      frequencyPct: pct(totals.onPlanDoctors, frequencyBase),
    },
  };
}
