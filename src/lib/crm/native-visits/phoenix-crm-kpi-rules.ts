/**
 * Phoenix CRM — the KPIs, as pure rules (the owner, 2026-09-14).
 *
 * WHAT IS COUNTED. Only what a pilot rep entered in Phoenix: their native visits, their native plans and their
 * open AM and PM doctor lists. iReports360 data is kept but never read here — "start clean from scratch,
 * then later merge the data". So these numbers are NOT the KPIs board's, and must never be joined to it.
 *
 * THE FOUR MEASURES, each on the definitions the company boards already use:
 *   · CALL RATE — doctor visits per working day, AM against 2 and PM against 10, REPORTED APART and never
 *     averaged or summed. Working days are Saturday to Wednesday less national holidays (call-rate.ts).
 *     It stops at YESTERDAY while the month runs (the owner's ruling C1, 2026-09-21, as on Reps List and
 *     the KPIs board): today is not scored until it is over, its calls and its day together. The three
 *     measures below keep counting today — none divides by days.
 *   · COVERAGE — of the doctors on a list, how many the rep visited at least once in the period.
 *   · FREQUENCY — of the doctors on a list whose grade carries a norm, how many the rep visited at least as
 *     often as the norm asks (rep-kpi-reports.ts). A grade with no norm is left out, never scored as 0.
 *   · PLAN ACHIEVED — of the doctors planned on a day already reached in a verified week plan, how many
 *     the rep visited on that very day.
 *
 * Only a doctor visit counts ("regular" — a campaign, a meeting, a leave day never does). The CRM's
 * catch-all contact 100000 is not a doctor. A pharmacy is not a contact: the lists are AM and PM only.
 *
 * Pure: no database, no clock. The service is native-visits/phoenix-crm.ts.
 */

import { AM_CALL_RATE_TARGET, PM_CALL_RATE_TARGET } from "@/lib/crm/call-rate";
import { addDaysIso } from "@/lib/crm/dates";
import type { DoctorCoverageGradeTier } from "@/lib/crm/doctor-coverage-config";
import { CATCH_ALL_CONTACT_CRM_ID, DEFAULT_REP_KPI_STANDARDS, kpiGradeTierOf } from "@/lib/crm/rep-kpi-reports";
import type { NativeVisitShift } from "@/lib/crm/native-visits/rules";

export const PHOENIX_CRM_SHIFTS = ["AM", "PM"] as const satisfies readonly NativeVisitShift[];

export const PHOENIX_CRM_CALL_RATE_TARGETS: Readonly<Record<NativeVisitShift, number>> = {
  AM: AM_CALL_RATE_TARGET,
  PM: PM_CALL_RATE_TARGET,
};

export type PhoenixCrmFrequencyNorms = Readonly<Record<NativeVisitShift, Readonly<Record<DoctorCoverageGradeTier, number | null>>>>;

export const PHOENIX_CRM_FREQUENCY_NORMS: PhoenixCrmFrequencyNorms = {
  AM: DEFAULT_REP_KPI_STANDARDS.AM.frequencyNorms,
  PM: DEFAULT_REP_KPI_STANDARDS.PM.frequencyNorms,
};

export type PhoenixCrmListedContact = {
  contactCrmId: number;
  lists: readonly NativeVisitShift[];
  grade: string | null;
};

export type PhoenixCrmVisitFact = {
  contactCrmId: number | null;
  shift: NativeVisitShift;
  visitDate: string;
  /** The native visit type key; only "regular" is a doctor visit. */
  visitType: string;
};

export type PhoenixCrmPlannedFact = {
  contactCrmId: number;
  planDate: string;
};

export type PhoenixCrmKpiInput = {
  /** Working days the call rate divides by — those of `callRateWindow` — national holidays already removed. */
  workingDays: number;
  panel: readonly PhoenixCrmListedContact[];
  /** Saved, not deleted, inside the window. */
  visits: readonly PhoenixCrmVisitFact[];
  /**
   * The days whose calls the call rate counts (`phoenixCrmCallRateWindow`: the window less a running
   * today). Null: no day is over yet, so no call counts. Left out: every visit given counts.
   * Coverage, frequency and plan achieved always read every visit given.
   */
  callRateWindow?: { from: string; to: string } | null;
  /** Live items of VERIFIED week plans, inside the window. */
  planned: readonly PhoenixCrmPlannedFact[];
  cairoToday: string;
  norms?: PhoenixCrmFrequencyNorms;
};

export type PhoenixCrmCallRate = {
  calls: number;
  perDay: number | null;
  target: number;
  attainmentPct: number | null;
};

export type PhoenixCrmShare = {
  /** The denominator: doctors listed (coverage), doctors with a norm (frequency), planned calls reached (plan). */
  of: number;
  /** The numerator: visited, met the norm, kept. */
  hit: number;
  pct: number | null;
};

export type PhoenixCrmKpiResult = {
  workingDays: number;
  callRate: Readonly<Record<NativeVisitShift, PhoenixCrmCallRate>>;
  coverage: Readonly<Record<NativeVisitShift, PhoenixCrmShare>>;
  frequency: Readonly<Record<NativeVisitShift, PhoenixCrmShare>>;
  planAchieved: PhoenixCrmShare;
};

function pct(hit: number, of: number): number | null {
  return of > 0 ? Math.round((hit / of) * 100) : null;
}

function isDoctorVisit(visit: PhoenixCrmVisitFact): visit is PhoenixCrmVisitFact & { contactCrmId: number } {
  return (
    visit.visitType === "regular" &&
    visit.contactCrmId != null &&
    Number.isInteger(visit.contactCrmId) &&
    visit.contactCrmId > 0 &&
    visit.contactCrmId !== CATCH_ALL_CONTACT_CRM_ID
  );
}

export function computePhoenixCrmKpis(input: PhoenixCrmKpiInput): PhoenixCrmKpiResult {
  const norms = input.norms ?? PHOENIX_CRM_FREQUENCY_NORMS;
  const doctorVisits = input.visits.filter(isDoctorVisit);
  const callWindow = input.callRateWindow;
  const callVisits =
    callWindow === undefined
      ? doctorVisits
      : doctorVisits.filter((visit) => callWindow !== null && visit.visitDate >= callWindow.from && visit.visitDate <= callWindow.to);

  // Visits per doctor, per half-day list.
  const visitsByShift: Record<NativeVisitShift, Map<number, number>> = { AM: new Map(), PM: new Map() };
  const visitedOnDay = new Set<string>();
  for (const visit of doctorVisits) {
    const counts = visitsByShift[visit.shift];
    if (!counts) continue;
    counts.set(visit.contactCrmId, (counts.get(visit.contactCrmId) ?? 0) + 1);
    visitedOnDay.add(`${visit.visitDate}|${visit.contactCrmId}`);
  }

  const callRate = {} as Record<NativeVisitShift, PhoenixCrmCallRate>;
  const coverage = {} as Record<NativeVisitShift, PhoenixCrmShare>;
  const frequency = {} as Record<NativeVisitShift, PhoenixCrmShare>;
  for (const shift of PHOENIX_CRM_SHIFTS) {
    const calls = callVisits.filter((visit) => visit.shift === shift).length;
    const target = PHOENIX_CRM_CALL_RATE_TARGETS[shift];
    const perDay = input.workingDays > 0 ? Math.round((calls / input.workingDays) * 10) / 10 : null;
    callRate[shift] = {
      calls,
      perDay,
      target,
      attainmentPct: input.workingDays > 0 ? Math.round((calls / input.workingDays / target) * 100) : null,
    };

    const listed = new Map<number, string | null>();
    for (const contact of input.panel) {
      if (contact.contactCrmId === CATCH_ALL_CONTACT_CRM_ID || !contact.lists.includes(shift)) continue;
      if (!listed.has(contact.contactCrmId)) listed.set(contact.contactCrmId, contact.grade);
    }
    const counts = visitsByShift[shift];
    let visited = 0;
    let scored = 0;
    let met = 0;
    for (const [contactCrmId, grade] of listed) {
      const seen = counts.get(contactCrmId) ?? 0;
      if (seen > 0) visited += 1;
      const tier = kpiGradeTierOf(grade);
      const norm = tier ? norms[shift][tier] : null;
      if (norm == null) continue;
      scored += 1;
      if (seen >= norm) met += 1;
    }
    coverage[shift] = { of: listed.size, hit: visited, pct: pct(visited, listed.size) };
    frequency[shift] = { of: scored, hit: met, pct: pct(met, scored) };
  }

  // A planned call is due once its day has passed; today's counts only once it is kept.
  let due = 0;
  let kept = 0;
  const seenPlanned = new Set<string>();
  for (const item of input.planned) {
    const key = `${item.planDate}|${item.contactCrmId}`;
    if (seenPlanned.has(key) || item.contactCrmId === CATCH_ALL_CONTACT_CRM_ID) continue;
    seenPlanned.add(key);
    const visitedThatDay = visitedOnDay.has(key);
    if (item.planDate < input.cairoToday || (item.planDate === input.cairoToday && visitedThatDay)) {
      due += 1;
      if (visitedThatDay) kept += 1;
    }
  }

  return {
    workingDays: input.workingDays,
    callRate,
    coverage,
    frequency,
    planAchieved: { of: due, hit: kept, pct: pct(kept, due) },
  };
}

/** `YYYY-MM` of a Cairo day. */
export function phoenixCrmMonthOf(isoDay: string): string {
  return isoDay.slice(0, 7);
}

/** The first and last day of a `YYYY-MM` month, or null when the value is not one. */
export function phoenixCrmMonthBounds(month: string): { from: string; to: string } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]);
  if (monthIndex < 1 || monthIndex > 12) return null;
  const lastDay = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, "0")}` };
}

/**
 * The days a rep's KPIs cover inside a month: from the later of the month's first day and the day the rep
 * joined the pilot, to the earlier of its last day and today. Null when that leaves no day at all.
 */
export function phoenixCrmRepWindow(
  month: { from: string; to: string },
  startsOn: string,
  cairoToday: string,
): { from: string; to: string } | null {
  const from = startsOn > month.from ? startsOn : month.from;
  const to = cairoToday < month.to ? cairoToday : month.to;
  return from <= to ? { from, to } : null;
}

/**
 * The days a rep's CALL RATE covers (the owner's ruling C1, 2026-09-21): the KPI window less today while
 * today is still running — a day is not scored until it is over. A window already over is kept whole.
 * Null when no day of it is over yet: the rep joined the pilot today, or the month began today.
 */
export function phoenixCrmCallRateWindow(
  window: { from: string; to: string } | null,
  cairoToday: string,
): { from: string; to: string } | null {
  if (!window) return null;
  const to = window.to < cairoToday ? window.to : addDaysIso(cairoToday, -1);
  return window.from <= to ? { from: window.from, to } : null;
}

/** "1.5 AM · 8.2 PM" — the pair side by side, never joined by a slash and never averaged. */
export function phoenixCrmCallRateText(callRate: PhoenixCrmKpiResult["callRate"]): string {
  const value = (rate: PhoenixCrmCallRate) => (rate.perDay == null ? "—" : rate.perDay.toFixed(1));
  return `${value(callRate.AM)} AM · ${value(callRate.PM)} PM`;
}
