// Phoenix Ranks — one window's facts from Phoenix CRM's raw rows. PURE: no database, no clock.
//
// Owner, 2026-10-05: "all data in phoenix crm not ever any data from old crm". So the inputs are
// Phoenix CRM's own: countable visits, the AM/PM lists with their grades, the plan against actual
// rows, the rep's "I started working" presses, and HR's approved leave. The one outside rule is the
// working-day calendar (`isCallRateWorkingDay`, Saturday to Wednesday with holidays out) — Phoenix
// CRM's exceptions board and digest use that exact rule, never a second one.
//
// COVERAGE AND FREQUENCY OVER ANY DURATION. Phoenix CRM defines both per calendar month; the owner
// asked for them on every board ("it's monthly now, but we can measure it by weekly … it thinks
// monthly"). Each window is cut into its month slices; in each slice the month's expectation is
// prorated by the share of the month's working days the rep owed in that slice, and the slices are
// weighted by those owed days. A whole month at full attendance is exactly Phoenix CRM's own figure
// for coverage; a week asks for a week's share of it.

import { isCallRateWorkingDay } from "@/lib/crm/call-rate";
import { qualityFacts, type RankFieldSave, type RankPlaceCase } from "@/lib/rep-ranks/field-quality";
import { startScore, type RankRepFacts } from "@/lib/rep-ranks/scoring";
import { daysBetween, monthSegments } from "@/lib/rep-ranks/windows";

export type RankListType = "AM" | "PM";

export type RankRawVisit = {
  repKey: string;
  seatId: string;
  customerId: string;
  listType: RankListType;
  /** The visit day (02:00 Cairo cut-off), as Phoenix CRM files it. */
  day: string;
  /** Measured against the customer's place (`location_flag` ok, far or weak_gps) by the rep's own save. */
  located: boolean;
  atPlace: boolean;
};

export type RankRawCustomer = {
  id: string;
  seatId: string;
  listType: RankListType;
  grade: string | null;
  active: boolean;
  /** The Cairo day the status last changed, or null. */
  statusChangedDay: string | null;
};

export type RankPlanDay = { seatId: string; day: string; planned: number; kept: number };

export type RankRosterRep = {
  hrIdKey: string;
  repName: string;
  lineName: string | null;
  areaName: string | null;
  regionName: string | null;
  seatIds: readonly string[];
  /**
   * The seats in `seatIds` that another person sits on too (a handover: the rep serving notice and the
   * new hire). Coverage and frequency read only THIS rep's visits there — never the seat's — so neither
   * is credited with the other's saves. Absent means no seat is shared. A seat's PLAN is not split (the
   * plan report is per seat), so both occupants read the seat's plan.
   */
  sharedSeatIds?: readonly string[];
  /** The first day the rep owes Phoenix CRM work: the team's start, or the first visit, never before hiring. */
  startDay: string;
};

export type RankRawData = {
  roster: readonly RankRosterRep[];
  visits: readonly RankRawVisit[];
  /** Every save the rep made in the field, any list, for the deeper measures (field-quality.ts). */
  saves: readonly RankFieldSave[];
  /**
   * Strong integrity cases filed against a PLACE the rep validated — the signboard and capture-trust
   * detectors, which never file against a visit and so reached no score at all until 2026-10-12.
   */
  placeCases: readonly RankPlaceCase[];
  customers: readonly RankRawCustomer[];
  /** Plan against actual per seat per day, leave days already taken out. */
  planDays: readonly RankPlanDay[];
  /** repKey → day → minutes past midnight, Cairo, of the "I started working" press. */
  starts: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** `${repKey}|${day}` for every FULL day of approved leave. */
  leave: ReadonlySet<string>;
  holidays: ReadonlySet<string>;
  gradeTargets: Record<RankListType, Record<string, number | null>>;
  callRateTargets: { am: number; pm: number };
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

function monthWorkingDays(month: string, holidays: ReadonlySet<string>): number {
  const [year, monthNumber] = month.split("-").map(Number);
  const last = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return daysBetween(`${month}-01`, `${month}-${String(last).padStart(2, "0")}`).filter((day) => isCallRateWorkingDay(day, holidays)).length;
}

/** Phoenix CRM's list rule for a month (phoenix_crm_report_coverage): active, or changed status inside it. */
function listedInMonth(customer: RankRawCustomer, month: string): boolean {
  return customer.active || (customer.statusChangedDay !== null && customer.statusChangedDay >= `${month}-01`);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

type Indexed = {
  visitsByRep: Map<string, RankRawVisit[]>;
  savesByRep: Map<string, RankFieldSave[]>;
  placeCasesByRep: Map<string, RankPlaceCase[]>;
  visitsBySeat: Map<string, RankRawVisit[]>;
  customersBySeat: Map<string, RankRawCustomer[]>;
  planBySeat: Map<string, RankPlanDay[]>;
};

export function indexRankData(data: RankRawData): Indexed {
  const push = <T>(map: Map<string, T[]>, key: string, value: T) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  const indexed: Indexed = {
    visitsByRep: new Map(),
    savesByRep: new Map(),
    placeCasesByRep: new Map(),
    visitsBySeat: new Map(),
    customersBySeat: new Map(),
    planBySeat: new Map(),
  };
  for (const visit of data.visits) {
    push(indexed.visitsByRep, visit.repKey, visit);
    push(indexed.visitsBySeat, visit.seatId, visit);
  }
  for (const save of data.saves) push(indexed.savesByRep, save.repKey, save);
  for (const place of data.placeCases) push(indexed.placeCasesByRep, place.repKey, place);
  for (const customer of data.customers) push(indexed.customersBySeat, customer.seatId, customer);
  for (const day of data.planDays) push(indexed.planBySeat, day.seatId, day);
  return indexed;
}

/** One rep's facts for [from, to]. `to` is never after yesterday — the caller clips it. */
export function repFactsForWindow(
  rep: RankRosterRep,
  data: RankRawData,
  indexed: Indexed,
  window: { from: string; to: string },
): RankRepFacts {
  const from = window.from > rep.startDay ? window.from : rep.startDay;
  const owed = new Set(
    from > window.to
      ? []
      : daysBetween(from, window.to).filter((day) => isCallRateWorkingDay(day, data.holidays) && !data.leave.has(`${rep.hrIdKey}|${day}`)),
  );

  const ownVisits = (indexed.visitsByRep.get(rep.hrIdKey) ?? []).filter((visit) => visit.day >= from && visit.day <= window.to);
  let amVisits = 0;
  let pmVisits = 0;
  const fieldDays = new Set<string>();
  let located = 0;
  let atPlace = 0;
  for (const visit of ownVisits) {
    if (visit.located) {
      located += 1;
      if (visit.atPlace) atPlace += 1;
    }
    if (!owed.has(visit.day)) continue;
    if (visit.listType === "AM") amVisits += 1;
    else pmVisits += 1;
    fieldDays.add(visit.day);
  }

  // Coverage and frequency, month slice by month slice, prorated and weighted by owed days.
  const seats = new Set(rep.seatIds);
  const customers = rep.seatIds.flatMap((seatId) => indexed.customersBySeat.get(seatId) ?? []);
  const sharedSeats = new Set(rep.sharedSeatIds ?? []);
  const seatVisits = rep.seatIds
    .flatMap((seatId) => indexed.visitsBySeat.get(seatId) ?? [])
    .filter((visit) => !sharedSeats.has(visit.seatId) || visit.repKey === rep.hrIdKey);
  let coverageWeighted = 0;
  let frequencyWeighted = 0;
  let frequencyWeight = 0;
  let weight = 0;
  let listedLast = 0;
  let coveredTotal = 0;
  let required = 0;
  let met = 0;
  for (const segment of from > window.to ? [] : monthSegments(from, window.to)) {
    const owedHere = [...owed].filter((day) => day >= segment.from && day <= segment.to).length;
    if (owedHere === 0) continue;
    const monthDays = monthWorkingDays(segment.month, data.holidays);
    const pace = monthDays > 0 ? Math.min(1, owedHere / monthDays) : 1;
    const listed = customers.filter((customer) => listedInMonth(customer, segment.month));
    const counts = new Map<string, number>();
    for (const visit of seatVisits) {
      if (visit.day < segment.from || visit.day > segment.to || !seats.has(visit.seatId)) continue;
      counts.set(visit.customerId, (counts.get(visit.customerId) ?? 0) + 1);
    }
    const covered = listed.filter((customer) => (counts.get(customer.id) ?? 0) > 0).length;
    const coverageShare = listed.length > 0 ? Math.min(1, covered / listed.length / pace) : 0;
    coverageWeighted += coverageShare * owedHere;
    weight += owedHere;
    listedLast = listed.length;
    coveredTotal += covered;

    let segmentRequired = 0;
    let segmentMet = 0;
    for (const customer of listed) {
      const target = customer.grade ? data.gradeTargets[customer.listType]?.[customer.grade] ?? null : null;
      if (!target || target <= 0) continue;
      const expected = target * pace;
      segmentRequired += expected;
      segmentMet += Math.min(counts.get(customer.id) ?? 0, expected);
    }
    if (segmentRequired > 0) {
      frequencyWeighted += (segmentMet / segmentRequired) * owedHere;
      frequencyWeight += owedHere;
      required += segmentRequired;
      met += segmentMet;
    }
  }

  let planned = 0;
  let kept = 0;
  for (const seatId of rep.seatIds) {
    for (const day of indexed.planBySeat.get(seatId) ?? []) {
      if (day.day < from || day.day > window.to) continue;
      planned += day.planned;
      kept += day.kept;
    }
  }

  const presses = data.starts.get(rep.hrIdKey);
  // Only a press on an owed day earns bonus; a press on a Thursday or a leave day is not counted.
  const startMinutes = presses ? [...presses].filter(([day]) => owed.has(day)).map(([, minutes]) => minutes) : [];

  return {
    hrIdKey: rep.hrIdKey,
    repName: rep.repName,
    lineName: rep.lineName,
    areaName: rep.areaName,
    regionName: rep.regionName,
    owedDays: owed.size,
    targets: data.callRateTargets,
    amVisits,
    pmVisits,
    fieldDays: fieldDays.size,
    coverage: weight > 0 ? { pct: round2((coverageWeighted / weight) * 100), listed: listedLast, covered: coveredTotal } : null,
    frequency: frequencyWeight > 0 ? { pct: round2((frequencyWeighted / frequencyWeight) * 100), required: round2(required), met: round2(met) } : null,
    plan: { planned, kept },
    start: {
      medianMinutes: median(startMinutes),
      days: startMinutes.length,
      scoreSum: startMinutes.reduce((sum, minutes) => sum + startScore(minutes), 0),
    },
    accuracy: { located, atPlace },
    quality: qualityFacts(
      (indexed.savesByRep.get(rep.hrIdKey) ?? []).filter((save) => save.day >= from && save.day <= window.to),
      // The same window, on the same `visit_date` the place filers write — so a case follows the day
      // it was filed against, exactly as a visit case does.
      (indexed.placeCasesByRep.get(rep.hrIdKey) ?? []).filter((place) => place.day >= from && place.day <= window.to),
    ),
  };
}

/** Every rostered rep's facts for one window. */
export function factsForWindow(data: RankRawData, window: { from: string; to: string }, indexed = indexRankData(data)): RankRepFacts[] {
  return data.roster.filter((rep) => rep.startDay <= window.to).map((rep) => repFactsForWindow(rep, data, indexed, window));
}
