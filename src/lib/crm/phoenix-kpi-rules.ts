/**
 * PHASE 6 — THE PHOENIX KPI RULES, owner-approved 2026-09-13 ("ok next").
 *
 * DORMANT UNTIL THE CRM CUTOVER. Rule 1: the new rules apply only from `crm_cutover.cutover_date`.
 * While that date is null every screen keeps exactly the numbers it shows today; {@link kpiRulesFor}
 * is the single switch every caller asks.
 *
 * The rules, in the owner's order:
 *   2. CALL RATE is the month's rate. PM passes at 10 or more visits per working day, AM at 2 or
 *      more. The 8-12 band is gone. AM and PM are reported apart, never averaged. EVERY submitted
 *      regular visit counts — GPS is evidence, not the gate. Campaign visits get their own line.
 *      AM or PM is decided by the contact's LIST, not by the flag on the visit.
 *   3. DAILY FOLLOW-UP never passes or fails: needed per day =
 *      (target x working days in the month - visits so far) / working days left.
 *   4. WORKING DAYS are Saturday to Wednesday minus public holidays, the same for everyone. Leave
 *      does NOT reduce them. A mid-month joiner or leaver counts only the days he was employed.
 *   5. COVERAGE = planned doctors in the period with at least one visit / planned doctors in it.
 *   6. "80% covered in two weeks" is a way of working, NOT a KPI. Nothing here enforces it.
 *   7. FREQUENCY uses the grade norm (PM A 3, B 2, C 1; AM A 1). Extra visits are fine. Ungraded
 *      doctors are left out. This replaces "exactly as planned".
 *   8. UNPLANNED visits ARE campaign visits (owner, 2026-09-13: "unplanned visit, which is now called
 *      campaign"). A regular visit to a contact on no list of the rep's is counted on the campaign
 *      line, outside call rate, coverage and frequency. The owner will give that line's rule later.
 *   9. The vacation-day block lives in native visit entry, not here.
 *  10. NO-CHECK-IN REGULAR VISITS ARE THEIR OWN LINE (owner, 2026-09-20). Amends rule 2's "GPS is
 *      evidence, not the gate" for credit only — a Regular visit with no matching GPS check-in is
 *      real activity, so it stays OFF the Campaign line, but it earns no call-rate, coverage or
 *      frequency credit either. It must never be blended into either number: it is counted and shown
 *      on its own (`regularNoCheckin`), never folded into a checked-in Regular visit and never
 *      relabelled Campaign. `PhoenixVisit.hasCheckin` carries the flag; a checked-in Regular visit is
 *      unaffected and keeps full credit exactly as rule 2 describes.
 *
 * Pure: no database, no clock. The loader is crm/phoenix-kpi-data.ts.
 */

import { AM_CALL_RATE_TARGET, PM_CALL_RATE_TARGET, countCallRateWorkingDays, isCallRateWorkingDay, normalizeSession, type CallRateHolidays } from "@/lib/crm/call-rate";
import { isPharmacySpeciality } from "@/lib/crm/contact-taxonomy";
import type { CrmListType } from "@/lib/crm/contacts-web-client";
import { isOnOrAfterCrmCutover, type CrmCutoverSetting } from "@/lib/crm/cutover";
import { CATCH_ALL_CONTACT_CRM_ID, DEFAULT_REP_KPI_STANDARDS, kpiGradeTierOf, type RepKpiStandards } from "@/lib/crm/rep-kpi-reports";
import { classifyVisit } from "@/lib/crm/visit-types";

export type KpiRules = "legacy" | "phoenix";

export type KpiRulesDecision = {
  rules: KpiRules;
  /** Shown on the board when the period is split by the cutover and the old rules were kept. */
  note: string | null;
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function isoDay(value: string | null | undefined): string | null {
  const day = (value ?? "").slice(0, 10);
  return ISO_DAY.test(day) ? day : null;
}

/**
 * Which rules score a period.
 *
 * A period that STARTS on or after the cutover date is scored by the Phoenix rules. A period that
 * starts before it keeps the old rules whole, even when it ends after it: half a month judged one
 * way and half the other would be a number that describes neither. The board says so in `note`.
 */
export function kpiRulesFor(setting: CrmCutoverSetting, dateFrom: string, periodEnd: string): KpiRulesDecision {
  if (!setting.cutoverDate) return { rules: "legacy", note: null };
  if (isOnOrAfterCrmCutover(setting, dateFrom)) return { rules: "phoenix", note: null };
  if (periodEnd.slice(0, 10) >= setting.cutoverDate) {
    return {
      rules: "legacy",
      note: `This period starts before Phoenix became the visit record on ${setting.cutoverDate}, so it is scored by the old rules. The new KPI rules apply to periods that start on or after that day.`,
    };
  }
  return { rules: "legacy", note: null };
}

/**
 * Rule 4 — the working days a rep is measured against inside a window.
 *
 * Saturday to Wednesday minus public holidays, clipped to the days he was employed: from his hire
 * date, to his last working date. His own leave is NOT removed — the same calendar for everyone.
 */
export function employedWorkingDays(input: {
  dateFrom: string;
  dateTo: string;
  hireDate?: string | null;
  lastWorkingDate?: string | null;
  holidays?: CallRateHolidays;
}): number {
  const hire = isoDay(input.hireDate);
  const last = isoDay(input.lastWorkingDate);
  const from = hire && hire > input.dateFrom ? hire : input.dateFrom;
  const to = last && last < input.dateTo ? last : input.dateTo;
  return countCallRateWorkingDays(from, to, input.holidays);
}

export type DailyFollowUp = {
  target: number;
  /** The rep's working days in the whole month (rule 4). */
  monthWorkingDays: number;
  /** Visits counted up to yesterday. */
  visitsSoFar: number;
  /** Working days from today to the end of the month, today included. */
  workingDaysLeft: number;
  /** Visits a day still needed to reach the month's target. Null when no working day is left. */
  neededPerDay: number | null;
  /** The month's target is already reached. */
  reached: boolean;
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Rule 3 — tracked, never a pass or a fail. */
export function dailyFollowUp(input: {
  target: number;
  monthWorkingDays: number;
  visitsSoFar: number;
  workingDaysLeft: number;
}): DailyFollowUp {
  const remaining = Math.max(0, input.target * input.monthWorkingDays - input.visitsSoFar);
  return {
    ...input,
    neededPerDay: input.workingDaysLeft > 0 ? round2(remaining / input.workingDaysLeft) : null,
    reached: remaining === 0,
  };
}

export type PhoenixSlice = {
  visits: number;
  /** visits / working days. Null when the rep had no working day in the window. */
  rate: number | null;
  target: number | null;
  /** rate >= target. Null when there is no target or no rate. */
  meets: boolean | null;
  attainmentPct: number | null;
};

export type PhoenixPanelContact = { contactCrmId: number; listType: CrmListType; grade: string | null };

export type PhoenixPlanEntry = {
  contactCrmId: number | null;
  planDate: string | null;
  grade: string | null;
  speciality: string | null;
  /** The doctor's name as the plan carries it. Read only by the Coverage tab's doctor list. */
  contactName?: string | null;
};

/**
 * One doctor in rule 5's population — planned in the period, pharmacies and the catch-all out — as
 * the Coverage tab lists him. Built in the same pass as `PhoenixRepKpis.coverage`, from the same
 * two maps, so the list and the count beside it cannot disagree.
 */
export type PhoenixCoverageDoctor = {
  contactCrmId: number;
  /** Null when no plan entry carried a name. */
  name: string | null;
  speciality: string | null;
  grade: string | null;
  /** Regular visits in the period on his AM or PM list — the visits that decide coverage. */
  visits: number;
  /** The latest of those visits, YYYY-MM-DD. Null exactly when `visits` is 0. */
  lastVisitDate: string | null;
  /** Every day the plan booked him inside the period, earliest first. */
  planDates: string[];
};

export type PhoenixVisit = {
  contact_crm_id: number | null;
  visit_date: string | null;
  visit_type: number | null;
  visit_type_description: string | null;
  comment: string | null;
  ampm: string | null;
  speciality: string | null;
  /** True when a GPS check-in matched this visit (same agent, same real contact, same Cairo day —
   * see checkin-match.ts). Decides rule 10: only a checked-in Regular visit earns call-rate,
   * coverage or frequency credit. Required rather than defaulted, so a caller that has not
   * correlated check-ins yet cannot silently grant credit it never verified. */
  hasCheckin: boolean;
};

export type PhoenixRepKpis = {
  /** Rule 4, inside the window scored so far. */
  workingDays: number;
  am: PhoenixSlice;
  pm: PhoenixSlice;
  /** No target is set for pharmacies yet, so this one never passes or fails. */
  pharmacy: PhoenixSlice;
  /** Campaign visits, including a regular visit to a contact on no list of the rep's (rule 8). */
  campaignVisits: number;
  /** Regular visits with NO matching GPS check-in (rule 10) — real work, kept off the Campaign line,
   * but excluded from am/pm call rate, coverage and frequency. Never blended into either number. */
  regularNoCheckin: number;
  coverage: {
    planned: number;
    visited: number;
    missed: number;
    pct: number | null;
    /** Planned doctors who are not on the rep's own list — counted, never silently dropped. */
    plannedOffList: number;
  };
  frequency: {
    /** Planned doctors with a grade, so a norm to judge. */
    judged: number;
    met: number;
    below: number;
    /** Planned doctors with no grade — left out, per rule 7. */
    ungraded: number;
    pct: number | null;
  };
  /** Rule 3, only while the month is running. */
  followUp: { am: DailyFollowUp; pm: DailyFollowUp } | null;
};

type Session = "am" | "pm";

function slice(visits: number, workingDays: number, target: number | null): PhoenixSlice {
  const rate = workingDays > 0 ? visits / workingDays : null;
  return {
    visits,
    rate,
    target,
    meets: target != null && rate != null ? rate >= target : null,
    attainmentPct: target != null && target > 0 && rate != null ? Math.round((rate / target) * 100) : null,
  };
}

function isPharmacyCall(visit: PhoenixVisit): boolean {
  if (isPharmacySpeciality(visit.speciality)) return true;
  return classifyVisit(visit.visit_type, visit.comment, visit.visit_type_description).label === "Pharmacy Visit";
}

/**
 * Where one REGULAR visit lands. The contact's list decides (rule 2); the AM/PM flag on the visit
 * only settles a contact carried on both lists. A contact on no list of the rep's is unplanned, and
 * an unplanned visit is a campaign visit (rule 8) — including the vendor's catch-all contact, which
 * is not a doctor.
 */
export function phoenixVisitLane(
  visit: PhoenixVisit,
  listsByContact: ReadonlyMap<number, ReadonlySet<CrmListType>>,
): Session | "pharmacy" | "campaign" {
  const contact = visit.contact_crm_id;
  const lists = contact != null && contact !== CATCH_ALL_CONTACT_CRM_ID ? listsByContact.get(contact) : undefined;
  if (!lists || lists.size === 0) return "campaign";
  const onDoctorList = lists.has("AM") || lists.has("PM");
  if (lists.has("Pharmacy") && (!onDoctorList || isPharmacyCall(visit))) return "pharmacy";
  if (lists.has("AM") && lists.has("PM")) return normalizeSession(visit.ampm) === "am" ? "am" : "pm";
  return lists.has("AM") ? "am" : "pm";
}

/**
 * The period one rep is scored over. `dateTo` is the last day whose visits count toward coverage and
 * frequency (today, in a running window); `windowEnd` is the period's own end, which the plan side
 * reads. `callRateTo` is the call rate's own last day — yesterday in a running window (owner ruling
 * C1, 2026-09-21), so the day that is not over yet is in neither the rate's calls nor its working
 * days. Left out, the call rate runs to `dateTo` as it always did.
 */
export type PhoenixKpiWindow = { dateFrom: string; dateTo: string; windowEnd: string; callRateTo?: string };

/** Everything one rep is scored from. See {@link computePhoenixRepKpis} for what each list must cover. */
export type PhoenixRepInput = {
  window: PhoenixKpiWindow;
  month: { start: string; end: string };
  /** Cairo today. */
  today: string;
  hireDate?: string | null;
  lastWorkingDate?: string | null;
  holidays?: CallRateHolidays;
  panel: readonly PhoenixPanelContact[];
  planEntries: readonly PhoenixPlanEntry[];
  visits: readonly PhoenixVisit[];
  standards?: RepKpiStandards;
};

/**
 * Every Phoenix KPI for ONE rep.
 *
 * `visits` must cover the month from its first day to `window.dateTo` (the follow-up needs the
 * month so far); `planEntries` must cover the whole month (frequency is a monthly norm). Visits are
 * expected already collapsed for duplicate submissions, exactly as the old board receives them.
 */
export function computePhoenixRepKpis(input: PhoenixRepInput): PhoenixRepKpis {
  return scorePhoenixRep(input).kpis;
}

/**
 * Rule 5's doctors for ONE rep, one row each: who was planned in the period, how often and when he
 * was last seen in it, and the days the plan booked him.
 *
 * The SAME computation as {@link computePhoenixRepKpis}, not a second reading of the rule: a doctor
 * here is covered exactly when he counts toward `coverage.visited` there, so the Coverage tab's list
 * always adds up to the numbers printed beside it.
 */
export function computePhoenixCoverageDoctors(input: PhoenixRepInput): PhoenixCoverageDoctor[] {
  const { plannedInWindow, windowVisitsByContact, windowLastVisitByContact, panelGrade } = scorePhoenixRep(input);
  return [...plannedInWindow].map(([contactCrmId, doctor]) => {
    const visits = windowVisitsByContact.get(contactCrmId) ?? 0;
    return {
      contactCrmId,
      name: doctor.name,
      speciality: doctor.speciality,
      grade: panelGrade.get(contactCrmId) ?? doctor.grade,
      visits,
      lastVisitDate: visits > 0 ? (windowLastVisitByContact.get(contactCrmId) ?? null) : null,
      planDates: [...doctor.planDates].sort(),
    };
  });
}

/** A doctor planned in the period, while the plan entries are being read. */
type PlannedDoctor = { name: string | null; speciality: string | null; grade: string | null; planDates: Set<string> };

function scorePhoenixRep(input: PhoenixRepInput): {
  kpis: PhoenixRepKpis;
  plannedInWindow: ReadonlyMap<number, PlannedDoctor>;
  windowVisitsByContact: ReadonlyMap<number, number>;
  windowLastVisitByContact: ReadonlyMap<number, string>;
  panelGrade: ReadonlyMap<number, string | null>;
} {
  const { window, month, holidays } = input;
  const standards = input.standards ?? DEFAULT_REP_KPI_STANDARDS;

  const listsByContact = new Map<number, Set<CrmListType>>();
  const panelGrade = new Map<number, string | null>();
  for (const contact of input.panel) {
    const lists = listsByContact.get(contact.contactCrmId) ?? new Set<CrmListType>();
    lists.add(contact.listType);
    listsByContact.set(contact.contactCrmId, lists);
    if (contact.listType !== "Pharmacy" && (panelGrade.get(contact.contactCrmId) ?? null) == null) {
      panelGrade.set(contact.contactCrmId, contact.grade);
    }
  }

  // Ruling C1: the call rate's days and its calls both stop at `callRateTo`, never one without the other.
  const callRateTo = window.callRateTo && window.callRateTo < window.dateTo ? window.callRateTo : window.dateTo;
  const workingDays = employedWorkingDays({ ...input, dateFrom: window.dateFrom, dateTo: callRateTo, holidays });

  const counts = { am: 0, pm: 0, pharmacy: 0, campaign: 0, regularNoCheckin: 0 };
  const monthSoFar = { am: 0, pm: 0 };
  /** Regular visits per contact: in the window (coverage) and in the month so far (frequency). */
  const windowVisitsByContact = new Map<number, number>();
  /** The latest of each contact's window visits — the date the Coverage tab prints. */
  const windowLastVisitByContact = new Map<number, string>();
  const monthVisitsByContact = new Map<number, number>();

  for (const visit of input.visits) {
    const day = isoDay(visit.visit_date);
    if (!day || day < month.start || day > window.dateTo) continue;
    const { bucket } = classifyVisit(visit.visit_type, visit.comment, visit.visit_type_description);
    if (bucket !== "regular" && bucket !== "campaign") continue;
    const inWindow = day >= window.dateFrom;
    const countable = isCallRateWorkingDay(day, holidays);
    /** A call-rate count: in the window, on a working day, and on a day that is over. */
    const callRateDay = inWindow && countable && day <= callRateTo;

    if (bucket === "campaign") {
      if (callRateDay) counts.campaign += 1;
      continue;
    }

    // Rule 10, owner 2026-09-20: a Regular visit with no matching GPS check-in earns no call-rate,
    // coverage or frequency credit. It is counted on its own line, never blended into a credited
    // lane and never relabelled Campaign.
    if (!visit.hasCheckin) {
      if (callRateDay) counts.regularNoCheckin += 1;
      continue;
    }

    const lane = phoenixVisitLane(visit, listsByContact);
    if (lane === "am" || lane === "pm") {
      if (visit.contact_crm_id != null) {
        monthVisitsByContact.set(visit.contact_crm_id, (monthVisitsByContact.get(visit.contact_crm_id) ?? 0) + 1);
        if (inWindow) {
          windowVisitsByContact.set(visit.contact_crm_id, (windowVisitsByContact.get(visit.contact_crm_id) ?? 0) + 1);
          const latest = windowLastVisitByContact.get(visit.contact_crm_id);
          if (!latest || day > latest) windowLastVisitByContact.set(visit.contact_crm_id, day);
        }
      }
      if (countable && day < input.today) monthSoFar[lane] += 1;
    }
    if (callRateDay) counts[lane] += 1;
  }

  // Coverage (rule 5) — the doctors planned in the period, pharmacies out.
  const isPharmacyContact = (contact: number, speciality: string | null): boolean =>
    listsByContact.get(contact)?.has("Pharmacy") === true || isPharmacySpeciality(speciality);
  const plannedInWindow = new Map<number, PlannedDoctor>();
  const plannedInMonth = new Map<number, string | null>();
  for (const entry of input.planEntries) {
    const contact = entry.contactCrmId;
    const day = isoDay(entry.planDate);
    if (contact == null || contact === CATCH_ALL_CONTACT_CRM_ID || !day) continue;
    if (day < month.start || day > month.end || isPharmacyContact(contact, entry.speciality)) continue;
    if (!plannedInMonth.has(contact) || plannedInMonth.get(contact) == null) plannedInMonth.set(contact, entry.grade);
    if (day >= window.dateFrom && day <= window.windowEnd) {
      const doctor = plannedInWindow.get(contact) ?? { name: null, speciality: null, grade: null, planDates: new Set<string>() };
      doctor.name ??= entry.contactName?.trim() || null;
      doctor.speciality ??= entry.speciality;
      doctor.grade ??= entry.grade;
      doctor.planDates.add(day);
      plannedInWindow.set(contact, doctor);
    }
  }
  let visited = 0;
  let plannedOffList = 0;
  for (const contact of plannedInWindow.keys()) {
    if ((windowVisitsByContact.get(contact) ?? 0) > 0) visited += 1;
    if (!listsByContact.has(contact)) plannedOffList += 1;
  }

  // Frequency (rule 7) — the month's planned doctors against their grade norm.
  let met = 0;
  let below = 0;
  let ungraded = 0;
  for (const [contact, planGrade] of plannedInMonth) {
    const lists = listsByContact.get(contact);
    const standard = lists?.has("AM") && !lists.has("PM") ? standards.AM : standards.PM;
    const tier = kpiGradeTierOf(panelGrade.get(contact) ?? planGrade);
    const rawNorm = tier ? standard.frequencyNorms[tier] : null;
    const norm = rawNorm != null && rawNorm > 0 ? rawNorm : null;
    if (norm == null) {
      ungraded += 1;
      continue;
    }
    if ((monthVisitsByContact.get(contact) ?? 0) >= norm) met += 1;
    else below += 1;
  }
  const judged = met + below;

  const amTarget = standards.AM.callRatePerDay ?? AM_CALL_RATE_TARGET;
  const pmTarget = standards.PM.callRatePerDay ?? PM_CALL_RATE_TARGET;

  // Follow-up (rule 3) — only while the month is running.
  let followUp: PhoenixRepKpis["followUp"] = null;
  if (input.today >= month.start && input.today <= month.end) {
    const monthWorkingDays = employedWorkingDays({ ...input, dateFrom: month.start, dateTo: month.end, holidays });
    const workingDaysLeft = employedWorkingDays({ ...input, dateFrom: input.today, dateTo: month.end, holidays });
    followUp = {
      am: dailyFollowUp({ target: amTarget, monthWorkingDays, visitsSoFar: monthSoFar.am, workingDaysLeft }),
      pm: dailyFollowUp({ target: pmTarget, monthWorkingDays, visitsSoFar: monthSoFar.pm, workingDaysLeft }),
    };
  }

  const kpis: PhoenixRepKpis = {
    workingDays,
    am: slice(counts.am, workingDays, amTarget),
    pm: slice(counts.pm, workingDays, pmTarget),
    pharmacy: slice(counts.pharmacy, workingDays, standards.Pharmacy.callRatePerDay),
    campaignVisits: counts.campaign,
    regularNoCheckin: counts.regularNoCheckin,
    coverage: {
      planned: plannedInWindow.size,
      visited,
      missed: plannedInWindow.size - visited,
      pct: plannedInWindow.size > 0 ? Math.round((visited / plannedInWindow.size) * 100) : null,
      plannedOffList,
    },
    frequency: { judged, met, below, ungraded, pct: judged > 0 ? Math.round((met / judged) * 100) : null },
    followUp,
  };
  return { kpis, plannedInWindow, windowVisitsByContact, windowLastVisitByContact, panelGrade };
}
