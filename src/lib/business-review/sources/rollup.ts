// Business Review — folding the four live sources onto areas, districts, lines and the company.
//
// Everything here hangs off ONE decision, made in attribution.ts: a person is placed by the
// month's own sales attribution, not by today's seat tree. So a marketing request, an outstation
// claim and a CRM visit made by the same rep in the same month land on exactly the same area, the
// same district and the same line as that rep's sales. The two halves of the review cannot
// disagree about who owns what.
//
// TWO COUNTING RULES THAT ARE EASY TO GET WRONG AND EXPENSIVE TO GET WRONG:
//
//   CUSTOMERS ARE UNIONED, NEVER SUMMED. Two reps in the same area visiting the same doctor is
//   one customer, not two. Every level keeps a Set and unions upward, so the company total is
//   below the sum of the lines by exactly the number of doctors more than one line covers — which
//   is itself reported, because "8,959 minus 125 overlaps" is the interesting sentence, not 8,834.
//
//   DOUBLE VISITS ARE COUNTED WHERE THE REP STOOD, NOT WHERE THE MANAGER DID. A ride has two
//   people on it. Counting it under the manager's own placement would put a Training Manager's
//   404 rides on whichever line the live tree happens to seat them, and the line totals would
//   then not add up to the company total. Counting it under the REP makes every level additive
//   and complete. The manager's own tally — rides delivered — is the per-role table's job, and is
//   carried here as `ridesLed` for the district that manager runs.
//
// Anything that reaches no unit at all is accumulated into `unplaced` and reported. It is never
// folded into a total and never dropped.

import type { AchievementRow } from "@/lib/sales/monthly-targets";

import type { AttributionMap, Placement } from "./attribution";
import { hrKey } from "./attribution";
import type { MarketingLoad } from "./marketing";
import type { OutstationLoad } from "./outstation";
import type { VisitsLoad } from "./visits";
import type { ReviewWindow } from "../period";

/** Every non-sales figure a unit carries, already reduced to plain numbers. */
export type ReviewOverlay = {
  marketingCommitted: number;
  marketingPending: number;
  marketingRequests: number;
  marketingMonths: number;
  marketingByMonth: Record<string, number>;

  /** Claimed excluding rejected — what the field force asked for. */
  outstationClaimed: number;
  /** HR-signed-off only — the gate payroll pays on. Materially smaller before July 2026. */
  outstationApproved: number;
  outstationRows: number;
  outstationMonths: number;
  outstationByMonth: Record<string, number>;
  outstationApprovedByMonth: Record<string, number>;
  outstationComponents: { travel: number; meeting: number; allowance: number; other: number };

  /** Field visits — regular, campaign and unlabelled field calls. */
  visits: number;
  regularVisits: number;
  campaignVisits: number;
  /** Meetings, leave, admin, BRM. Recorded, but not customer visits. */
  adminRows: number;
  visitsMonths: number;
  visitsByMonth: Record<string, number>;
  /** Rides RECEIVED by the reps here. Additive across every level. */
  doubleVisits: number;
  /** Rides DELIVERED by the manager who runs this unit. District level only; 0 elsewhere. */
  ridesLed: number;
  /** Distinct reps who logged at least one field visit here. */
  visitingReps: number;
  visitsAvgPerRepPerMonth: number;

  /** Distinct doctors reached by a regular visit, unioned across the whole window. */
  customersTotal: number;
  customersByMonth: Record<string, number>;
};

export type UnplacedTotals = {
  marketingRequests: number;
  marketingCommitted: number;
  outstationRows: number;
  outstationClaimed: number;
  visitRows: number;
  visitAgents: number;
  /** Facts placed from TODAY's seat tree because the month's own attribution never mentioned the
   *  person — a current answer applied to a historical month, named rather than blended in. */
  liveTreePlacedFacts: number;
};

export type ReviewOverlays = {
  area: (lineCode: string | null, areaCode: string | null) => ReviewOverlay;
  dm: (dmSeatId: string | null) => ReviewOverlay;
  line: (lineCode: string | null) => ReviewOverlay;
  company: ReviewOverlay;
  unplaced: UnplacedTotals;
};

// ── Accumulator ──────────────────────────────────────────────────────────────

type Acc = {
  marketingCommitted: number;
  marketingPending: number;
  marketingRequests: number;
  marketingByMonth: Map<string, number>;
  outstationClaimed: number;
  outstationApproved: number;
  outstationRows: number;
  outstationByMonth: Map<string, number>;
  outstationApprovedByMonth: Map<string, number>;
  travel: number;
  meeting: number;
  allowance: number;
  other: number;
  visits: number;
  regularVisits: number;
  campaignVisits: number;
  adminRows: number;
  visitsByMonth: Map<string, number>;
  doubleVisits: number;
  ridesLed: number;
  visitingReps: Set<string>;
  customersAll: Set<number>;
  customersByMonth: Map<string, Set<number>>;
};

function newAcc(): Acc {
  return {
    marketingCommitted: 0, marketingPending: 0, marketingRequests: 0, marketingByMonth: new Map(),
    outstationClaimed: 0, outstationApproved: 0, outstationRows: 0,
    outstationByMonth: new Map(), outstationApprovedByMonth: new Map(),
    travel: 0, meeting: 0, allowance: 0, other: 0,
    visits: 0, regularVisits: 0, campaignVisits: 0, adminRows: 0, visitsByMonth: new Map(),
    doubleVisits: 0, ridesLed: 0, visitingReps: new Set(),
    customersAll: new Set(), customersByMonth: new Map(),
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function bump(map: Map<string, number>, key: string, by: number): void {
  if (by === 0) return;
  map.set(key, (map.get(key) ?? 0) + by);
}

function unionInto(map: Map<string, Set<number>>, period: string, ids: ReadonlySet<number>): void {
  if (ids.size === 0) return;
  let set = map.get(period);
  if (!set) {
    set = new Set<number>();
    map.set(period, set);
  }
  for (const id of ids) set.add(id);
}

/** Number-keyed record over the window, with an explicit 0 for every month so a client can
 *  iterate `meta.months` and never hit `undefined`. A 0 here is safe: the coverage layer is what
 *  distinguishes "this month had none" from "this source has no data at all". */
function fill(periods: readonly string[], map: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const period of periods) out[period] = round2(map.get(period) ?? 0);
  return out;
}

function fillCounts(periods: readonly string[], map: Map<string, Set<number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const period of periods) out[period] = map.get(period)?.size ?? 0;
  return out;
}

function finalize(acc: Acc, periods: readonly string[]): ReviewOverlay {
  const visitsMonths = [...acc.visitsByMonth.values()].filter((v) => v > 0).length;
  const reps = acc.visitingReps.size;
  return {
    marketingCommitted: round2(acc.marketingCommitted),
    marketingPending: round2(acc.marketingPending),
    marketingRequests: acc.marketingRequests,
    marketingMonths: [...acc.marketingByMonth.values()].filter((v) => v !== 0).length,
    marketingByMonth: fill(periods, acc.marketingByMonth),
    outstationClaimed: round2(acc.outstationClaimed),
    outstationApproved: round2(acc.outstationApproved),
    outstationRows: acc.outstationRows,
    outstationMonths: [...acc.outstationByMonth.values()].filter((v) => v !== 0).length,
    outstationByMonth: fill(periods, acc.outstationByMonth),
    outstationApprovedByMonth: fill(periods, acc.outstationApprovedByMonth),
    outstationComponents: {
      travel: round2(acc.travel), meeting: round2(acc.meeting),
      allowance: round2(acc.allowance), other: round2(acc.other),
    },
    visits: acc.visits,
    regularVisits: acc.regularVisits,
    campaignVisits: acc.campaignVisits,
    adminRows: acc.adminRows,
    visitsMonths,
    visitsByMonth: fill(periods, acc.visitsByMonth),
    doubleVisits: acc.doubleVisits,
    ridesLed: acc.ridesLed,
    visitingReps: reps,
    // Per rep per ACTIVE month, not per window month: a line that only reported visits in three of
    // six months is not doing half the calls, it has three months of data.
    visitsAvgPerRepPerMonth:
      reps > 0 && visitsMonths > 0 ? round2(acc.visits / reps / visitsMonths) : 0,
    customersTotal: acc.customersAll.size,
    customersByMonth: fillCounts(periods, acc.customersByMonth),
  };
}

export const EMPTY_OVERLAY: ReviewOverlay = finalize(newAcc(), []);

/** A fresh empty overlay shaped for this window, so an absent unit still renders its month keys. */
function emptyFor(periods: readonly string[]): ReviewOverlay {
  return finalize(newAcc(), periods);
}

// ── The fold ─────────────────────────────────────────────────────────────────

const areaKey = (lineCode: string | null, areaCode: string | null) =>
  `${lineCode ?? ""}|${areaCode ?? ""}`;

export function buildOverlays(input: {
  window: ReviewWindow;
  rows: readonly AchievementRow[];
  attribution: AttributionMap;
  marketing: MarketingLoad;
  outstation: OutstationLoad;
  visits: VisitsLoad;
}): ReviewOverlays {
  const { window, attribution } = input;
  const periods = window.periods;

  const areas = new Map<string, Acc>();
  const dms = new Map<string, Acc>();
  const lines = new Map<string, Acc>();
  const company = newAcc();
  const unplaced: UnplacedTotals = {
    marketingRequests: 0, marketingCommitted: 0,
    outstationRows: 0, outstationClaimed: 0,
    visitRows: 0, visitAgents: 0,
    liveTreePlacedFacts: 0,
  };

  const of = (map: Map<string, Acc>, key: string): Acc => {
    let acc = map.get(key);
    if (!acc) {
      acc = newAcc();
      map.set(key, acc);
    }
    return acc;
  };

  /** The chain a fact touches: its area, its district, its line, and the company. A district
   *  manager's own fact has no area, so it reaches three of the four — which is correct, and is
   *  why an area total plus a district total is never a valid sum. */
  const chainOf = (placement: Placement | null): Acc[] => {
    if (!placement) return [company];
    if (placement.placedFromLiveTree) unplaced.liveTreePlacedFacts += 1;
    const chain: Acc[] = [company];
    if (placement.lineCode) chain.push(of(lines, placement.lineCode));
    if (placement.dmSeatId) chain.push(of(dms, placement.dmSeatId));
    if (placement.areaCode) chain.push(of(areas, areaKey(placement.lineCode, placement.areaCode)));
    return chain;
  };

  // ── Marketing ──
  for (const fact of input.marketing.facts) {
    const placement = attribution.place(fact.requesterHrId, fact.period);
    if (!placement) {
      unplaced.marketingRequests += 1;
      if (fact.bucket === "committed") unplaced.marketingCommitted += fact.cost;
    }
    for (const acc of chainOf(placement)) {
      acc.marketingRequests += 1;
      if (fact.bucket === "committed") {
        acc.marketingCommitted += fact.cost;
        bump(acc.marketingByMonth, fact.period, fact.cost);
      } else if (fact.bucket === "pending") {
        acc.marketingPending += fact.cost;
      }
    }
  }

  // ── Outstation ──
  for (const fact of input.outstation.facts) {
    const placement = attribution.place(fact.hrId, fact.period);
    if (!placement) {
      unplaced.outstationRows += 1;
      unplaced.outstationClaimed += fact.claimed;
    }
    for (const acc of chainOf(placement)) {
      acc.outstationRows += 1;
      acc.outstationClaimed += fact.claimed;
      acc.outstationApproved += fact.approved;
      bump(acc.outstationByMonth, fact.period, fact.claimed);
      bump(acc.outstationApprovedByMonth, fact.period, fact.approved);
      acc.travel += fact.travel;
      acc.meeting += fact.meeting;
      acc.allowance += fact.allowance;
      acc.other += fact.other;
    }
  }

  // ── Visits, and the customers inside them ──
  for (const fact of input.visits.agents) {
    const placement = fact.agentHrId ? attribution.place(fact.agentHrId, fact.period) : null;
    if (!placement) {
      unplaced.visitRows += fact.fieldVisits + fact.adminRows;
      unplaced.visitAgents += 1;
    }
    for (const acc of chainOf(placement)) {
      acc.visits += fact.fieldVisits;
      acc.regularVisits += fact.regularVisits;
      acc.campaignVisits += fact.campaignVisits;
      acc.adminRows += fact.adminRows;
      acc.doubleVisits += fact.accompaniedVisits;
      bump(acc.visitsByMonth, fact.period, fact.fieldVisits);
      if (fact.fieldVisits > 0 && fact.agentHrId) acc.visitingReps.add(fact.agentHrId);
      for (const id of fact.customers) acc.customersAll.add(id);
      unionInto(acc.customersByMonth, fact.period, fact.customers);
    }
  }

  // ── Rides delivered, credited to the district the manager runs ──
  // Only the district level carries this: it is the DM's own coaching output. Rolling it up would
  // double-count against `doubleVisits`, which already counts the same rides where the rep stood.
  const dmSeatByHrId = new Map<string, string>();
  for (const row of input.rows) {
    const key = hrKey(row.dmHrId);
    if (key && row.dmSeatId && !dmSeatByHrId.has(key)) dmSeatByHrId.set(key, row.dmSeatId);
  }
  for (const fact of input.visits.managers) {
    const seat = dmSeatByHrId.get(fact.managerHrId);
    if (seat) of(dms, seat).ridesLed += fact.rides;
  }

  const empty = emptyFor(periods);
  const finalizedAreas = new Map<string, ReviewOverlay>();
  for (const [key, acc] of areas) finalizedAreas.set(key, finalize(acc, periods));
  const finalizedDms = new Map<string, ReviewOverlay>();
  for (const [key, acc] of dms) finalizedDms.set(key, finalize(acc, periods));
  const finalizedLines = new Map<string, ReviewOverlay>();
  for (const [key, acc] of lines) finalizedLines.set(key, finalize(acc, periods));

  return {
    area: (lineCode, areaCode) => finalizedAreas.get(areaKey(lineCode, areaCode)) ?? empty,
    dm: (dmSeatId) => (dmSeatId ? finalizedDms.get(dmSeatId) ?? empty : empty),
    line: (lineCode) => (lineCode ? finalizedLines.get(lineCode) ?? empty : empty),
    company: finalize(company, periods),
    unplaced,
  };
}
