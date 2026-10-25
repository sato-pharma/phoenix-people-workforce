// Business Review — activity by ROLE, and by the individual behind it.
//
// "Visits per rep, per DM, per product manager, per training manager, per every role" is a
// question the sales engine cannot answer on its own: it knows seats, not job titles. So the
// directory is read once and every person carrying activity in the window is classified through
// `resolveJobFunctionRole` — the repo's existing job-function classifier, not a second one grown
// here. That classifier is explicitly a BUSINESS-RULE mapping and never a permission decision,
// which is exactly the use this is.
//
// EACH ROLE IS MEASURED BY WHAT IT ACTUALLY DOES, AND THE GAPS ARE NAMED RATHER THAN FILLED:
//
//   Medical Rep        own field visits, customers reached, outstation claims.
//   District Manager   rides delivered, reps ridden with, own district's sales (from the sales half).
//   Regional / National Sales Manager   rides delivered across districts.
//   Training Manager   rides delivered. Nothing else — see COACHING, below.
//   Product Manager    rides delivered, and their line's sales. VISITS PER PRODUCT DO NOT EXIST —
//                      `ireports360_visits` has no product column at all. Inventing one from the
//                      rep's line would be a guess wearing a metric's clothes, so the row carries
//                      an explicit note instead.
//
// A person with no activity at all in the window still appears in `headcount` but not in `people`:
// the difference between "12 DMs employed" and "9 DMs with recorded activity" is one of the more
// useful numbers on the page, and collapsing them would hide it.
//
// COACHING IS NOT READ HERE, AND MUST NOT COME BACK. Owner ruling 2026-09-26: "leave him out and
// remove the coaching from this module." `coaching_reports` was a source of this module until that
// day; it is not any more, and the Training Manager keeps no access to the page either. `repsCoached`
// survives and is NOT coaching — it is the distinct reps a manager rode along with, from the visit
// feed. Coaching analytics live in their own module.
//
// EVERY FIGURE IS PLACED ON A LINE. The tables are built once for the company and once for each
// line, and a line's tables hold only the people the month's own sales attribution places there.
// Until 2026-09-26 the company-wide rows were rendered under a line heading with no caption, so
// "Pedia Line — Deep Analysis" ended with every rep, manager and Head-Office person in the
// business and nothing on the page saying so.

import {
  emptyVisitCountSplit,
  mergeVisitCountSplits,
  type VisitCountSplit,
} from "@/lib/crm/visit-count-buckets";
import { markDegraded } from "@/lib/cache/serve-uncached";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import {
  loadReferenceEmployees,
  loadReferenceLines,
  type ReferenceEmployee,
} from "@/lib/reference/reference-lists";

import { hrKey, type AttributionMap } from "./attribution";
import { isResignedStatus } from "../employment-status";
import type { MarketingLoad } from "./marketing";
import type { OutstationLoad } from "./outstation";
import type { VisitsLoad } from "./visits";
import type { ReviewWindow } from "../period";

export type ReviewDirectoryEntry = {
  hrId: string;
  name: string;
  jobTitle: string;
  role: string;
  lineId: number | null;
  employmentStatus: string;
  hireDate: string | null;
  /** His last day. What the pack prints beside a leaver's name, so a document never reads as current. */
  lastWorkingDate: string | null;
};

export type ReviewDirectory = Map<string, ReviewDirectoryEntry>;

export type ReviewRoleRow = {
  role: string;
  /** People holding this title in the directory today, whatever they did in the window. */
  headcount: number;
  /** People of this role with at least one recorded action inside the window. */
  people: number;
  fieldVisits: number;
  /** The same visits AM · PM · Pharmacies (owner golden rule). The three sum to `fieldVisits`. */
  visitSplit: VisitCountSplit;
  regularVisits: number;
  campaignVisits: number;
  /** Double visits this role DELIVERED (rode along on). */
  ridesLed: number;
  /** Distinct reps ridden with. NOT coaching — that source was removed on 2026-09-26. */
  repsCoached: number;
  /** Distinct customers reached — a union across the role's people, never a sum. */
  customersReached: number;
  /** The same customers, three ways. Only `customersPm` may be called doctors. */
  customersAm: number;
  customersPm: number;
  customersPharmacy: number;
  /**
   * The visits the customers above were counted from — the field visits AND the rides led — so their
   * pharmacy figure is judged by them: Phoenix CRM logs no pharmacy visit, and a customer split built
   * from its visits prints "not recorded in Phoenix", never 0 (src/lib/crm/visit-count-buckets.ts,
   * `fromVisits`). Optional: a payload from before it existed judges by `visitSplit`.
   */
  customerVisitSplit?: VisitCountSplit;
  outstationClaimed: number;
  outstationApproved: number;
  marketingRequests: number;
  marketingCommitted: number;
  fieldVisitsByMonth: Record<string, number>;
  ridesLedByMonth: Record<string, number>;
  /** What this role's footprint deliberately does NOT measure. Rendered verbatim. */
  note: string | null;
};

export type ReviewPersonRow = {
  hrId: string;
  name: string;
  role: string;
  jobTitle: string;
  employmentStatus: string;
  hireDate: string | null;
  /** His last day, so a PACK can mark a leaver's name. The screen reads the status instead (#4609). */
  lastWorkingDate: string | null;
  fieldVisits: number;
  /** AM · PM · Pharmacies for this person's own field visits. */
  visitSplit: VisitCountSplit;
  regularVisits: number;
  campaignVisits: number;
  ridesLed: number;
  repsCoached: number;
  customers: number;
  customersAm: number;
  customersPm: number;
  customersPharmacy: number;
  /**
   * The visits the customers above were counted from — the field visits AND the rides led — so their
   * pharmacy figure is judged by them: Phoenix CRM logs no pharmacy visit, and a customer split built
   * from its visits prints "not recorded in Phoenix", never 0 (src/lib/crm/visit-count-buckets.ts,
   * `fromVisits`). Optional: a payload from before it existed judges by `visitSplit`.
   */
  customerVisitSplit?: VisitCountSplit;
  outstationClaimed: number;
  marketingRequests: number;
  /** Months inside the window in which this person recorded anything. */
  activeMonths: number;
  /** Field visits per active month — never per window month, which would punish a March joiner. */
  avgPerActiveMonth: number;
  /**
   * DISTINCT customers reached in each month of the window — the owner's "in July this person got
   * 200 unique customers, in August 250" (2026-09-26).
   *
   * A UNION PER MONTH, and the months must never be added together: the same doctor seen in July
   * and again in August is one customer in each and one customer in the window. The plain
   * "customers" field above is the window's own union and is the only honest total.
   */
  customersByMonth: Record<string, number>;
  /**
   * The district this person's own month-by-month attribution placed them in most often, and its
   * area — so a rep can be shown beside the territory he actually stood in.
   *
   * MOST OFTEN, not last: a rep who moved districts mid-window belongs to the one he did the work
   * in, and taking the latest would move his whole window's activity onto a district he joined in
   * the final month. Null for anyone the attribution never placed.
   */
  dmSeatId: string | null;
  areaCode: string | null;
  /**
   * The rides he LED, by the district seat the rep he rode with stood in that month — and the same
   * by area. `dmSeatId` above comes from his OWN field visits, so it is null for a manager who logs
   * rides and no visits of his own, and that left every National Sales Manager, the Regional
   * Manager, the Product Managers, the SFE Manager and a riding-only District Manager out of every
   * district and area view (owner, 2026-10-20). `people-view.ts` reads these to find him there.
   *
   * Absent when he rode with nobody, which is every rep. A payload from before this existed finds a
   * person by his own seat alone, exactly as it did then.
   */
  ridesBySeat?: Record<string, ReviewRideTally>;
  ridesByArea?: Record<string, ReviewRideTally>;
};

/** Rides led in one seat or area, and the distinct reps ridden with there. */
export type ReviewRideTally = { rides: number; reps: number };

/** One scope's tables: the company's, or one line's. */
export type RoleFacts = {
  roles: ReviewRoleRow[];
  people: ReviewPersonRow[];
  /** People carrying activity whose HR id matches nobody in the directory. */
  unknownPeople: number;
};

export type RolesLoad = RoleFacts & {
  /** The same tables, scoped to each line's own people. Keyed on the canonical `line_code`. */
  byLine: Record<string, RoleFacts>;
};

const ROLE_NOTES: Record<string, string> = {
  "Product Manager":
    "Visits per product cannot be measured — the CRM visit feed carries no product column. A " +
    "Product Manager's recorded footprint is the double visits they rode on, beside their line's sales.",
  "Group Product Manager":
    "Visits per product cannot be measured — the CRM visit feed carries no product column. A " +
    "Group Product Manager's recorded footprint is the double visits they rode on, beside their line's sales.",
  "Training Manager":
    "Measured through the double visits they rode on rather than owned territory. Coaching reports " +
    "are not part of this module (owner ruling, 2026-09-26) — they are counted in their own.",
};

/** Role display order: field first, then the roles that ride along, then everyone else. */
const ROLE_ORDER = [
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Training Manager",
  "Product Manager",
  "Group Product Manager",
];

export async function loadReviewDirectory(): Promise<ReviewDirectory> {
  const directory: ReviewDirectory = new Map();
  let rows: ReferenceEmployee[] = [];
  try {
    // The whole employee list from the shared one-minute copy (src/lib/reference/reference-lists.ts):
    // every pack in the review reads this directory, and the copy is read once for all of them. The
    // superset carries no compensation column, and nothing here ever wanted one.
    rows = await loadReferenceEmployees();
  } catch {
    // No names for this render; marked so the bundle cache never keeps a review with nobody in it.
    return markDegraded(directory);
  }
  for (const row of rows) {
    const hrId = String(row.hr_id ?? "").trim();
    if (!hrId) continue;
    const jobTitle = String(row.job_title ?? "").trim();
    directory.set(hrKey(hrId), {
      hrId,
      name: String(row.full_name ?? "").trim() || String(row.nickname ?? "").trim() || hrId,
      jobTitle,
      role: resolveJobFunctionRole(jobTitle),
      lineId: row.line_id == null ? null : Number(row.line_id),
      employmentStatus: String(row.employment_status ?? "").trim(),
      hireDate: row.hire_date == null ? null : String(row.hire_date).slice(0, 10),
      lastWorkingDate: row.last_working_date == null ? null : String(row.last_working_date).slice(0, 10),
    });
  }
  return directory;
}

/** `lines.name` as production spells it → the canonical `line_code`. The same vocabulary
 *  portal-scope.ts uses; both spellings of Anti Infective are in production. */
const LINE_CODE_BY_DB_NAME: Record<string, string> = {
  Pedia: "pedia",
  CNS: "cns",
  "Anti Infective": "anti_infective",
  "Anti-Infective": "anti_infective",
};

/**
 * `employees.line_id` per canonical line code, read from the `lines` table.
 *
 * Read, never hardcoded. A line scope's HEADCOUNT is "people employed on this line today", which
 * only the HR record can answer — the sales attribution cannot, because somebody with no activity
 * in the window has no attribution at all. An unknown line reports NO headcount rather than a
 * guessed one: a wrong headcount is worse than an absent one, because "visits per head" divides by it.
 */
export async function loadLineIdByCode(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  try {
    for (const row of await loadReferenceLines()) {
      const code = LINE_CODE_BY_DB_NAME[String(row.name ?? "").trim()];
      if (code && row.id != null) out[code] = Number(row.id);
    }
  } catch {
    return markDegraded(out);
  }
  return out;
}

type PersonAcc = {
  hrId: string;
  visitSplit: VisitCountSplit;
  /** Own field visits AND rides led — what the customer sets were counted from. */
  customerVisits: VisitCountSplit;
  customersAm: Set<number>;
  customersPm: Set<number>;
  customersPharmacy: Set<number>;
  fieldVisits: number;
  regularVisits: number;
  campaignVisits: number;
  ridesLed: number;
  reps: Set<string>;
  customers: Set<number>;
  outstationClaimed: number;
  marketingRequests: number;
  months: Set<string>;
  customersByMonth: Map<string, Set<number>>;
  /** How many field visits this person made while placed in each district seat / area. */
  seatVisits: Map<string, number>;
  areaVisits: Map<string, number>;
  /** The rides he led, by the seat / area of the rep ridden with — see `ridesBySeat` on the row. */
  rideSeats: Map<string, RideAcc>;
  rideAreas: Map<string, RideAcc>;
};

type RideAcc = { rides: number; reps: Set<string> };

function tallyRide(into: Map<string, RideAcc>, key: string, rep: string, rides: number) {
  let acc = into.get(key);
  if (!acc) {
    acc = { rides: 0, reps: new Set() };
    into.set(key, acc);
  }
  acc.rides += rides;
  acc.reps.add(rep);
}

/** Plain JSON for the cached bundle, and nothing at all for somebody who rode with nobody. */
function rideTallies(from: Map<string, RideAcc>): Record<string, ReviewRideTally> | undefined {
  if (from.size === 0) return undefined;
  const out: Record<string, ReviewRideTally> = {};
  for (const [key, acc] of from) out[key] = { rides: acc.rides, reps: acc.reps.size };
  return out;
}

type RoleAcc = {
  role: string;
  headcount: number;
  people: Set<string>;
  visitSplit: VisitCountSplit;
  /** Own field visits AND rides led — what the customer sets were counted from. */
  customerVisits: VisitCountSplit;
  customersAm: Set<number>;
  customersPm: Set<number>;
  customersPharmacy: Set<number>;
  fieldVisits: number;
  regularVisits: number;
  campaignVisits: number;
  ridesLed: number;
  reps: Set<string>;
  customers: Set<number>;
  outstationClaimed: number;
  outstationApproved: number;
  marketingRequests: number;
  marketingCommitted: number;
  fieldVisitsByMonth: Map<string, number>;
  ridesLedByMonth: Map<string, number>;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export type RoleFactsInput = {
  window: ReviewWindow;
  visits: VisitsLoad;
  outstation: OutstationLoad;
  marketing: MarketingLoad;
  directory: ReviewDirectory;
  lineIdByCode: Record<string, number>;
  /**
   * Where each person stood, month by month. The same map the sales overlays use, so a line's role
   * table and a line's sales table can never disagree about who belongs to it.
   */
  attribution: AttributionMap;
  /** The one span every figure answers — see SharedBuildContext.figureLabel in canonical.ts. */
  figurePeriods: ReadonlySet<string>;
};

/**
 * Build the role and people tables — company-wide, and once more for each line.
 *
 * Synchronous: with coaching gone this function has no I/O of its own, so it runs AFTER the
 * attribution map rather than racing it, and the directory is loaded in the caller's own
 * Promise.all. That is one round trip fewer than the arrangement it replaces, not one more.
 */
export function buildRoleFacts(input: RoleFactsInput): RolesLoad {
  const company = collect(input, null);
  const lineCodes = new Set<string>();
  for (const fact of input.visits.agents) {
    if (!input.figurePeriods.has(fact.period) || !fact.agentHrId) continue;
    const line = input.attribution.place(fact.agentHrId, fact.period)?.lineCode;
    if (line) lineCodes.add(line);
  }
  for (const code of Object.keys(input.lineIdByCode)) lineCodes.add(code);
  const byLine: Record<string, RoleFacts> = {};
  for (const lineCode of lineCodes) byLine[lineCode] = collect(input, lineCode);
  return { ...company, byLine };
}

/**
 * One scope's tables. `lineCode` null is the company; otherwise only the work the month's own
 * attribution places on that line is counted.
 */
function collect(input: RoleFactsInput, lineCode: string | null): RoleFacts {
  const { directory, attribution, figurePeriods } = input;

  /** True when this person's work in this month belongs to the scope being built. */
  const inScope = (hrId: string, period: string): boolean => {
    if (!figurePeriods.has(period)) return false;
    if (lineCode == null) return true;
    return attribution.place(hrId, period)?.lineCode === lineCode;
  };

  /**
   * A manager's rides, split by THE LINE THE REP STOOD ON — never the manager's own seat.
   *
   * The same rule the overlays follow, and the reason `VisitManagerFact` carries `ridesByRep`
   * rather than a bare count: a Training Manager who rode with a CNS rep and a Pedia rep in one
   * month belongs in both lines' tables, with the right split in each, and a total alone cannot be
   * attributed to a line without guessing.
   */
  const ridesInScope = (fact: VisitsLoad["managers"][number]): { rides: number; reps: string[] } => {
    if (lineCode == null) return { rides: fact.rides, reps: [...fact.ridesByRep.keys()] };
    let rides = 0;
    const reps: string[] = [];
    for (const [repHrId, count] of fact.ridesByRep) {
      if (attribution.place(repHrId, fact.period)?.lineCode !== lineCode) continue;
      rides += count;
      reps.push(repHrId);
    }
    return { rides, reps };
  };

  const people = new Map<string, PersonAcc>();
  const of = (key: string): PersonAcc => {
    let acc = people.get(key);
    if (!acc) {
      acc = {
        hrId: key,
        visitSplit: emptyVisitCountSplit(),
        customerVisits: emptyVisitCountSplit(),
        customersAm: new Set(), customersPm: new Set(), customersPharmacy: new Set(),
        fieldVisits: 0, regularVisits: 0, campaignVisits: 0,
        ridesLed: 0, reps: new Set(), customers: new Set(),
        outstationClaimed: 0, marketingRequests: 0,
        months: new Set(),
        customersByMonth: new Map(), seatVisits: new Map(), areaVisits: new Map(),
        rideSeats: new Map(), rideAreas: new Map(),
      };
      people.set(key, acc);
    }
    return acc;
  };

  const roles = new Map<string, RoleAcc>();
  const roleOf = (role: string): RoleAcc => {
    let acc = roles.get(role);
    if (!acc) {
      acc = {
        role, headcount: 0, people: new Set(),
        visitSplit: emptyVisitCountSplit(),
        customerVisits: emptyVisitCountSplit(),
        customersAm: new Set(), customersPm: new Set(), customersPharmacy: new Set(),
        fieldVisits: 0, regularVisits: 0, campaignVisits: 0, ridesLed: 0,
        reps: new Set(), customers: new Set(),
        outstationClaimed: 0, outstationApproved: 0,
        marketingRequests: 0, marketingCommitted: 0,
        fieldVisitsByMonth: new Map(), ridesLedByMonth: new Map(),
      };
      roles.set(role, acc);
    }
    return acc;
  };
  const roleFor = (hrIdKey: string) => directory.get(hrIdKey)?.role ?? "Employee";

  // ── Field visits ──
  for (const fact of input.visits.agents) {
    if (!fact.agentHrId || !inScope(fact.agentHrId, fact.period)) continue;
    const person = of(fact.agentHrId);
    const role = roleOf(roleFor(fact.agentHrId));
    role.people.add(fact.agentHrId);
    for (const acc of [person, role] as { visitSplit: VisitCountSplit; customerVisits: VisitCountSplit; fieldVisits: number; regularVisits: number; campaignVisits: number; customers: Set<number>; customersAm: Set<number>; customersPm: Set<number>; customersPharmacy: Set<number> }[]) {
      acc.fieldVisits += fact.fieldVisits;
      mergeVisitCountSplits(acc.visitSplit, fact.visitSplit);
      mergeVisitCountSplits(acc.customerVisits, fact.visitSplit);
      acc.regularVisits += fact.regularVisits;
      acc.campaignVisits += fact.campaignVisits;
      for (const id of fact.customers) acc.customers.add(id);
      for (const id of fact.customersAm) acc.customersAm.add(id);
      for (const id of fact.customersPm) acc.customersPm.add(id);
      for (const id of fact.customersPharmacy) acc.customersPharmacy.add(id);
    }
    if (fact.fieldVisits > 0 || fact.adminRows > 0) person.months.add(fact.period);

    // The month's own customers, as a SET: this is the one figure that must not be added across
    // months, so it is never stored as a count until the very end.
    if (fact.customers.size > 0) {
      let month = person.customersByMonth.get(fact.period);
      if (!month) {
        month = new Set<number>();
        person.customersByMonth.set(fact.period, month);
      }
      for (const id of fact.customers) month.add(id);
    }

    // Where he stood, weighted by the work he did there — see `dmSeatId` on the row.
    const placed = attribution.place(fact.agentHrId, fact.period);
    if (placed?.dmSeatId) {
      person.seatVisits.set(placed.dmSeatId, (person.seatVisits.get(placed.dmSeatId) ?? 0) + fact.fieldVisits);
    }
    if (placed?.areaCode) {
      person.areaVisits.set(placed.areaCode, (person.areaVisits.get(placed.areaCode) ?? 0) + fact.fieldVisits);
    }
    if (fact.fieldVisits > 0) {
      role.fieldVisitsByMonth.set(fact.period, (role.fieldVisitsByMonth.get(fact.period) ?? 0) + fact.fieldVisits);
    }
  }

  // ── Rides delivered ──
  for (const fact of input.visits.managers) {
    if (!figurePeriods.has(fact.period)) continue;
    const { rides, reps } = ridesInScope(fact);
    if (rides === 0 && reps.length === 0) continue;
    const person = of(fact.managerHrId);
    const role = roleOf(roleFor(fact.managerHrId));
    role.people.add(fact.managerHrId);
    person.ridesLed += rides;
    role.ridesLed += rides;
    for (const rep of reps) {
      person.reps.add(rep);
      role.reps.add(rep);
      // Where the ride happened: the seat and area THE REP stood in that month, never the manager's
      // own — the same rule `ridesInScope` splits the lines by.
      const count = fact.ridesByRep.get(rep) ?? 0;
      if (count <= 0) continue;
      const placed = attribution.place(rep, fact.period);
      if (placed?.dmSeatId) tallyRide(person.rideSeats, placed.dmSeatId, rep, count);
      if (placed?.areaCode) tallyRide(person.rideAreas, placed.areaCode, rep, count);
    }
    for (const acc of [person, role]) {
      // The rides' visits judge the customers they add — a Phoenix CRM ride logs no pharmacy visit.
      mergeVisitCountSplits(acc.customerVisits, fact.rideSplit);
      for (const id of fact.customers) acc.customers.add(id);
      for (const id of fact.customersAm) acc.customersAm.add(id);
      for (const id of fact.customersPm) acc.customersPm.add(id);
      for (const id of fact.customersPharmacy) acc.customersPharmacy.add(id);
    }
    if (rides > 0) {
      person.months.add(fact.period);
      role.ridesLedByMonth.set(fact.period, (role.ridesLedByMonth.get(fact.period) ?? 0) + rides);
    }
  }

  // ── Outstation ──
  for (const fact of input.outstation.facts) {
    if (!fact.hrId) continue;
    const key = hrKey(fact.hrId);
    if (!inScope(key, fact.period)) continue;
    const person = of(key);
    const role = roleOf(roleFor(key));
    role.people.add(key);
    person.outstationClaimed += fact.claimed;
    role.outstationClaimed += fact.claimed;
    role.outstationApproved += fact.approved;
    if (fact.claimed !== 0) person.months.add(fact.period);
  }

  // ── Marketing ──
  for (const fact of input.marketing.facts) {
    if (!fact.requesterHrId) continue;
    const key = hrKey(fact.requesterHrId);
    if (!inScope(key, fact.period)) continue;
    const person = of(key);
    const role = roleOf(roleFor(key));
    role.people.add(key);
    person.marketingRequests += 1;
    role.marketingRequests += 1;
    if (fact.bucket === "committed") role.marketingCommitted += fact.cost;
    person.months.add(fact.period);
  }

  // Headcount is the directory's live answer, restricted to people who are actually employed —
  // a resigned rep is counted in the activity above (they worked those months) but is not a seat
  // the business holds today, and mixing the two makes "visits per head" nonsense. A LINE scope
  // follows the employee record's own line, the only line an HR record states.
  const scopeLineId = lineCode == null ? null : input.lineIdByCode[lineCode] ?? null;
  const headcountResolvable = lineCode == null || scopeLineId != null;
  if (headcountResolvable) {
    for (const entry of directory.values()) {
      if (isResignedStatus(entry.employmentStatus)) continue;
      if (scopeLineId != null && entry.lineId !== scopeLineId) continue;
      roleOf(entry.role).headcount += 1;
    }
  }

  /**
   * The key this person did the most field work under. Ties break on the key itself so the answer
   * is stable across renders rather than depending on Map insertion order.
   */
  const busiest = (counts: Map<string, number>): string | null => {
    let best: string | null = null;
    let bestCount = -1;
    for (const [key, count] of counts) {
      if (count > bestCount || (count === bestCount && best != null && key < best)) {
        best = key;
        bestCount = count;
      }
    }
    return best;
  };

  // ── Person rows ──
  let unknownPeople = 0;
  const personRows: ReviewPersonRow[] = [...people.values()].map((acc) => {
    const entry = directory.get(acc.hrId);
    if (!entry) unknownPeople += 1;
    const activeMonths = acc.months.size;
    return {
      hrId: entry?.hrId ?? acc.hrId,
      name: entry?.name ?? `Unmapped HR id ${acc.hrId}`,
      role: entry?.role ?? "Employee",
      jobTitle: entry?.jobTitle ?? "",
      employmentStatus: entry?.employmentStatus ?? "",
      hireDate: entry?.hireDate ?? null,
      lastWorkingDate: entry?.lastWorkingDate ?? null,
      fieldVisits: acc.fieldVisits,
      visitSplit: { ...acc.visitSplit },
      regularVisits: acc.regularVisits,
      campaignVisits: acc.campaignVisits,
      ridesLed: acc.ridesLed,
      repsCoached: acc.reps.size,
      customers: acc.customers.size,
      customersAm: acc.customersAm.size,
      customersPm: acc.customersPm.size,
      customersPharmacy: acc.customersPharmacy.size,
      customerVisitSplit: { ...acc.customerVisits },
      outstationClaimed: round2(acc.outstationClaimed),
      marketingRequests: acc.marketingRequests,
      activeMonths,
      avgPerActiveMonth: activeMonths > 0 ? round2(acc.fieldVisits / activeMonths) : 0,
      customersByMonth: Object.fromEntries(
        input.window.periods.map((period) => [period, acc.customersByMonth.get(period)?.size ?? 0]),
      ),
      dmSeatId: busiest(acc.seatVisits),
      areaCode: busiest(acc.areaVisits),
      ridesBySeat: rideTallies(acc.rideSeats),
      ridesByArea: rideTallies(acc.rideAreas),
    };
  });
  personRows.sort((a, b) => b.fieldVisits + b.ridesLed - (a.fieldVisits + a.ridesLed));

  const fill = (map: Map<string, number>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const period of input.window.periods) out[period] = map.get(period) ?? 0;
    return out;
  };

  const roleRows: ReviewRoleRow[] = [...roles.values()]
    .map((acc) => ({
      role: acc.role,
      headcount: acc.headcount,
      people: acc.people.size,
      fieldVisits: acc.fieldVisits,
      visitSplit: { ...acc.visitSplit },
      regularVisits: acc.regularVisits,
      campaignVisits: acc.campaignVisits,
      ridesLed: acc.ridesLed,
      repsCoached: acc.reps.size,
      customersReached: acc.customers.size,
      customersAm: acc.customersAm.size,
      customersPm: acc.customersPm.size,
      customersPharmacy: acc.customersPharmacy.size,
      customerVisitSplit: { ...acc.customerVisits },
      outstationClaimed: round2(acc.outstationClaimed),
      outstationApproved: round2(acc.outstationApproved),
      marketingRequests: acc.marketingRequests,
      marketingCommitted: round2(acc.marketingCommitted),
      fieldVisitsByMonth: fill(acc.fieldVisitsByMonth),
      ridesLedByMonth: fill(acc.ridesLedByMonth),
      note: ROLE_NOTES[acc.role] ?? null,
    }))
    // Roles that did nothing AND employ nobody are noise; every other role stays visible, at zero
    // if that is the truth, because "the Training Manager rode along 0 times" is a finding.
    .filter((row) => row.headcount > 0 || row.people > 0)
    .sort((a, b) => {
      const ai = ROLE_ORDER.indexOf(a.role);
      const bi = ROLE_ORDER.indexOf(b.role);
      if (ai !== bi) return (ai < 0 ? ROLE_ORDER.length : ai) - (bi < 0 ? ROLE_ORDER.length : bi);
      return a.role < b.role ? -1 : 1;
    });

  return { roles: roleRows, people: personRows, unknownPeople };
}

export const ROLES_ORIGIN = "public.employees job titles, via the shared job-function classifier";
