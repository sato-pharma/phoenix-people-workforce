// Business Review — the field work laid beside the money it was meant to bring.
//
// Owner, 2026-10-01: "every brick contain how many class A doctors and I visit how many vs this
// area or brick sales … if DM over-focused MRs in DV and forgotten reps … link them together to do
// a real professional business review yet simple to understand … a medical rep's BR must show all
// data but simple and easy for him to understand."
//
// THIS MODULE IS PURE. It takes facts the caller has already loaded AND SCOPED — the rep lists,
// visits and rides from sources/field-link.ts, and the Monthly Closing's customer-grain rows that
// the concentration loader has already masked — and returns plain rows. It reads no database, so
// every rule below is pinned on fixtures in tests/business-review-field-link.test.ts. How a row is
// WORDED for a medical rep or for a manager is pack/link-sections.ts's job, never this file's.
//
// THE RULES IT DOES NOT GET TO BEND:
//
//   1. AM · PM · PHARMACIES STAY APART (owner, 2026-09-21). A rep's list already says which is which:
//      the PM list is doctors, the AM list is hospitals and accounts, the Pharmacy list is pharmacies
//      (measured on production 2026-10-01: 4,563 of the 4,572 open PM grade-A rows are doctors, 839
//      of the 860 open AM grade-A rows are hospitals, contracts or insurers). A pharmacy speciality
//      is a pharmacy whatever list carries it, exactly as `visitCountBucket` decides for a visit.
//   2. "CLASS A DOCTORS" MEANS THE PM LIST AT GRADE A. Only the PM list may be called doctors.
//   3. REACHED MEANS AT LEAST ONE REGULAR VISIT IN THE PERIOD. Campaign visits carry no contact at
//      all (every one names contact 0), so they cannot reach a named doctor — they are counted beside
//      the list, never inside it. This is deliberately NOT called "coverage": coverage is scored
//      against the month's PLAN on the CRM KPIs board, and this is scored against the LIST.
//   4. A LIST IS THE ONE PHOENIX RECORDED FOR THE PERIOD. The contact register keeps each rep's list
//      with dates from 28 Aug 2026 (its first sweep); a month before that has no list of its own, so
//      the first recorded one stands in and the pack says so.
//   5. A CUSTOMER IS COUNTED ONCE. Two reps can hold the same contact across a period (a list passed
//      from one to the other), so every count of listed or reached customers is a UNION of contact
//      ids, never a sum. Visits and ride days belong to one person and DO add.
//   6. BRICK SALES ARE THE CLOSING'S OWN CUSTOMER ROWS and do not add up exactly to an area's
//      achievement (the store split and the direct-order allocation are applied at area level). The
//      section says so; this module never pretends a brick carries a target, because none does.

import { isPharmacySpeciality } from "@/lib/crm/contact-taxonomy";
import {
  emptyVisitCountSplit,
  mergeVisitCountSplits,
  type VisitCountBucket,
  type VisitCountSplit,
} from "@/lib/crm/visit-count-buckets";

import type { ReviewSalesDetail } from "./concentration";

// ─────────────────────────────────────────────────────────────── facts, as loaded ──

/** The date the contact register's list history starts. A list before it is not known. */
export const LIST_HISTORY_FROM = "2026-08-28";

/** One customer on a rep's CRM list during the period. */
export type ListedContact = {
  contactId: number;
  /** The rep whose list carried him, upper-cased. */
  repHrId: string;
  /** Which of the three he is — from the list itself, a pharmacy speciality always a pharmacy. */
  bucket: VisitCountBucket;
  /** "A", "B" or "C"; "" when the CRM carries none. A+ is already folded into A upstream. */
  grade: string;
  name: string;
  speciality: string;
  /** The contact register's brick (the doctor map first, then the region map). Null when neither. */
  brickId: string | null;
  /** The last regular visit the register knows of, EVER — so a missed doctor can say how long. */
  lastVisitedOn: string | null;
};

/**
 * Regular visits one contact received in the period, after the duplicate collapse — for EVERY
 * contact the reps in the pack visited, on their list or not, so a brick's work is complete.
 */
export type ContactVisitTally = {
  visits: number;
  /** The same visits AM · PM · Pharmacies, each bucketed by `visitCountBucket` on its own row. */
  split: VisitCountSplit;
  lastVisit: string | null;
  /** The contact register's brick for him. Null when neither map places him. */
  brickId: string | null;
};

/** One rep's own field work in one month. */
export type RepDayFact = {
  repHrId: string;
  period: string;
  /** Distinct days with at least one field visit (regular or campaign). */
  fieldDays: number;
  fieldVisits: number;
  /** Those visits, AM · PM · Pharmacies. Sums to `fieldVisits`. */
  split: VisitCountSplit;
};

/** One manager riding with one rep in one month, counted in DAYS and in accompanied visits. */
export type RideFact = { managerHrId: string; repHrId: string; period: string; days: number; visits: number };

export type DirectOrderFact = {
  requestId: string;
  /** The month Finance booked it — null when it is approved and not booked yet, so it counts nowhere. */
  salesMonth: string | null;
  value: number;
  pharmacyName: string;
  doctorName: string | null;
  brickId: string | null;
  areaCode: string;
  line: string;
  requesterName: string;
};

export type MarketingRequestFact = {
  requestId: string;
  code: string;
  /** The month the money is paid — the month every marketing aggregate in Phoenix keys on. */
  period: string;
  status: string;
  bucket: "committed" | "pending" | null;
  cost: number;
  /** What the request must bring back — ten times its cost, the ROI engine's own generated column. */
  requiredReturn: number;
  /** Sales the Marketing ROI engine has matched to it so far. Null when not read (not committed). */
  returnSoFar: number | null;
  customerName: string;
  typeName: string;
  requesterHrId: string;
  requesterName: string;
  areaCode: string | null;
  line: string | null;
};

export type AwarenessFact = {
  activityId: string;
  title: string;
  typeName: string;
  status: string;
  bucket: "committed" | "pending" | null;
  startDate: string;
  cost: number;
  expectedAttendees: number | null;
  areaCode: string;
  line: string | null;
  brickIds: string[];
  repHrId: string | null;
};

/** Everything the linked sections read. Plain JSON — no Set, no Map. */
export type FieldLinkFacts = {
  /** The FIGURE months, in order. */
  months: string[];
  /** The reps these facts were read for, upper-cased — the pack's own reps and nobody else. */
  repHrIds: string[];
  /** True when some month of the period predates the list history, so its list is the first recorded. */
  listBeforeHistory: boolean;
  contacts: ListedContact[];
  /** Keyed by contact id as a string. A contact with no entry received no regular visit. */
  visitsByContact: Record<string, ContactVisitTally>;
  repDays: RepDayFact[];
  rides: RideFact[];
  /** Days each manager rode with people who are NOT among the reps in this pack. */
  ridesOutside: { managerHrId: string; period: string; days: number }[];
  /** The district seats in the pack and who holds them today. */
  managers: { dmSeatId: string; hrId: string; name: string }[];
  /** HR id (upper) → display name, for everyone the facts mention. */
  names: Record<string, string>;
  brickNames: Record<string, string>;
  /** Null means "not read" — a section is then dropped, never drawn as zero. */
  directOrders: DirectOrderFact[] | null;
  marketing: MarketingRequestFact[] | null;
  awareness: AwarenessFact[] | null;
};

// ─────────────────────────────────────────────────────────────── shared helpers ──

const num = (value: number | null | undefined) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** The one bucket a listed contact sits in — the list type, but a pharmacy is always a pharmacy. */
export function listBucketOf(listType: string | null | undefined, speciality: string | null | undefined): VisitCountBucket {
  if (isPharmacySpeciality(speciality)) return "Pharmacies";
  const type = String(listType ?? "").trim().toLowerCase();
  if (type === "pharmacy") return "Pharmacies";
  if (type === "am") return "AM";
  return "PM";
}

/** "A", "B", "C" or "" — A+ reads as A. */
export function normaliseGrade(grade: string | null | undefined): string {
  const first = String(grade ?? "").trim().toUpperCase().charAt(0);
  return first === "A" || first === "B" || first === "C" ? first : "";
}

/** A class A doctor: the PM list at grade A — the only list that may be called doctors. */
export function isClassADoctor(contact: Pick<ListedContact, "bucket" | "grade">): boolean {
  return contact.bucket === "PM" && contact.grade === "A";
}

function reached(contact: ListedContact, visits: Readonly<Record<string, ContactVisitTally>>): boolean {
  return num(visits[String(contact.contactId)]?.visits) > 0;
}

/** Listed and reached, both as UNIONS of contact ids. */
export type ReachCount = { listed: number; reached: number };

function reachOf(
  contacts: readonly ListedContact[],
  visits: Readonly<Record<string, ContactVisitTally>>,
  keep: (contact: ListedContact) => boolean,
): ReachCount {
  const listed = new Set<number>();
  const hit = new Set<number>();
  for (const contact of contacts) {
    if (!keep(contact)) continue;
    listed.add(contact.contactId);
    if (reached(contact, visits)) hit.add(contact.contactId);
  }
  return { listed: listed.size, reached: hit.size };
}

/** Share as a 0–100 figure, or null when there is nothing to divide by. */
export function sharePct(part: number, whole: number): number | null {
  return whole > 0 ? (part / whole) * 100 : null;
}

/** Everything a set of listed contacts adds up to — four counts, never merged into one. */
export type ListReach = {
  classA: ReachCount;
  otherDoctors: ReachCount;
  am: ReachCount;
  pharmacies: ReachCount;
};

export function listReach(
  contacts: readonly ListedContact[],
  visits: Readonly<Record<string, ContactVisitTally>>,
): ListReach {
  return {
    am: reachOf(contacts, visits, (c) => c.bucket === "AM"),
    classA: reachOf(contacts, visits, isClassADoctor),
    otherDoctors: reachOf(contacts, visits, (c) => c.bucket === "PM" && c.grade !== "A"),
    pharmacies: reachOf(contacts, visits, (c) => c.bucket === "Pharmacies"),
  };
}

export function listedCount(reach: ListReach): number {
  return reach.classA.listed + reach.otherDoctors.listed + reach.am.listed + reach.pharmacies.listed;
}

export const splitTotal = (split: VisitCountSplit) => num(split.am) + num(split.pm) + num(split.pharmacies);

/** Regular visits to every contact placed in `brickId` (or, with null, to every contact at all). */
function visitsIn(visits: Readonly<Record<string, ContactVisitTally>>, brickId: string | null | undefined): VisitCountSplit {
  const split = emptyVisitCountSplit();
  for (const tally of Object.values(visits)) {
    if (brickId !== undefined && tally.brickId !== brickId) continue;
    mergeVisitCountSplits(split, tally.split);
  }
  return split;
}

// ─────────────────────────────────────────────────────────────── bricks ──

/**
 * What a brick says, in the words a rep reads. One reading per brick, the most urgent first, so the
 * column can be scanned top to bottom without a legend.
 */
export type BrickReading =
  | "no-list"
  | "money-little-work"
  | "class-a-missed"
  | "work-little-money"
  | "balanced";

export const BRICK_READING_LABEL: Record<BrickReading, string> = {
  balanced: "In balance",
  "class-a-missed": "Class A doctors missed",
  "money-little-work": "Big sales, few visits",
  "no-list": "Sales here, nobody on the list",
  "work-little-money": "Many visits, small sales",
};

/** The thresholds the readings use, in one place so the note can quote them. */
export const BRICK_READING_RULES = {
  /** A brick carrying at least this share of the sales (or of the visits) is big enough to read. */
  bigShare: 10,
  /** "Few" / "small" means under half of the other share. */
  underHalf: 0.5,
  /** Class A doctors missed: at least this many listed, and fewer than half reached. */
  classAFloor: 3,
  /**
   * A brick whose class A doctors are at least this share reached is COVERED, whatever its share of
   * the visits: a big city brick carries a big wholesaler's sales and will always take a smaller
   * share of the visits than of the money. Measured on production 2026-10-01 — Pedia's Mahalla brick,
   * 39% of its district's August sales with all 45 class A doctors reached, read "big sales, few
   * visits" on the visit shares alone.
   */
  coveredAt: 80,
} as const;

export type BrickWorkRow = {
  brickId: string;
  brickName: string;
  sales: number;
  /** The direct-order part of `sales`, from the same closing rows. */
  directSales: number;
  /** Share of the bricks' total sales, 0–100, or null when nothing sold. */
  salesShare: number | null;
  /** Share of the scope's regular visits that went to customers in this brick, 0–100. */
  visitShare: number | null;
  reach: ListReach;
  /** Regular visits to every customer placed in this brick — on the list or not. */
  visits: VisitCountSplit;
  reading: BrickReading;
};

export type BrickWork = {
  rows: BrickWorkRow[];
  /** The whole scope, the same measures — unions for customers, sums for money and visits. */
  total: Omit<BrickWorkRow, "brickId" | "brickName" | "reading" | "salesShare" | "visitShare">;
  /** Listed contacts the register could place on no brick. Counted in `total`, in no brick. */
  unplacedContacts: number;
};

export const NO_BRICK_ID = "(no brick)";
/**
 * What a brick the master has no name for is CALLED — never its code (owner, 2026-10-01: "NEVER SHOW
 * CODES ALWAYS SHOW NAMES", restating the standing rule). A brick id such as "B201-3" means nothing
 * to the rep reading the pack; the words say plainly that the name is missing.
 */
export const UNNAMED_BRICK = "Brick not named";

function readingOf(row: Omit<BrickWorkRow, "reading">): BrickReading {
  const { bigShare, underHalf, classAFloor, coveredAt } = BRICK_READING_RULES;
  if (row.sales > 0 && listedCount(row.reach) === 0) return "no-list";
  const sales = row.salesShare ?? 0;
  const work = row.visitShare ?? 0;
  const classAReached = sharePct(row.reach.classA.reached, row.reach.classA.listed);
  const covered = classAReached != null && classAReached >= coveredAt;
  if (sales >= bigShare && work < sales * underHalf && !covered) return "money-little-work";
  if (row.reach.classA.listed >= classAFloor && row.reach.classA.reached < row.reach.classA.listed * 0.5) {
    return "class-a-missed";
  }
  if (work >= bigShare && sales < work * underHalf) return "work-little-money";
  return "balanced";
}

/**
 * Every brick the scope either SOLD in or holds a LISTED customer in, with both halves side by side.
 *
 * `sales` must already be the scope's own closing rows — its lines, its areas, masked. A brick with
 * sales and no listed customer is kept (that is a finding); a brick with neither never appears.
 */
export function buildBrickWork(input: {
  contacts: readonly ListedContact[];
  visitsByContact: Readonly<Record<string, ContactVisitTally>>;
  sales: readonly Pick<ReviewSalesDetail, "brickId" | "brickName" | "channel" | "value">[];
  brickNames: Readonly<Record<string, string>>;
}): BrickWork {
  const salesByBrick = new Map<string, { value: number; direct: number; name: string }>();
  for (const row of input.sales) {
    const id = row.brickId || NO_BRICK_ID;
    const named = row.brickName && row.brickName !== id ? row.brickName : input.brickNames[id];
    const entry = salesByBrick.get(id) ?? { direct: 0, name: named || (id === NO_BRICK_ID ? "No brick recorded" : UNNAMED_BRICK), value: 0 };
    entry.value += num(row.value);
    if (row.channel === "direct") entry.direct += num(row.value);
    salesByBrick.set(id, entry);
  }

  const contactsByBrick = new Map<string, ListedContact[]>();
  let unplaced = 0;
  for (const contact of input.contacts) {
    if (!contact.brickId) {
      unplaced += 1;
      continue;
    }
    const list = contactsByBrick.get(contact.brickId) ?? [];
    list.push(contact);
    contactsByBrick.set(contact.brickId, list);
  }

  const totalSales = [...salesByBrick.values()].reduce((sum, entry) => sum + entry.value, 0);
  const everyone = listReach(input.contacts, input.visitsByContact);
  const allVisits = visitsIn(input.visitsByContact, undefined);
  const totalVisits = splitTotal(allVisits);
  const visitedBricks = new Set(
    Object.values(input.visitsByContact)
      .filter((tally) => tally.brickId)
      .map((tally) => tally.brickId as string),
  );

  const ids = new Set<string>([...salesByBrick.keys(), ...contactsByBrick.keys(), ...visitedBricks]);
  const rows: BrickWorkRow[] = [];
  for (const id of ids) {
    const sale = salesByBrick.get(id);
    const reach = listReach(contactsByBrick.get(id) ?? [], input.visitsByContact);
    const visits = visitsIn(input.visitsByContact, id);
    const base = {
      brickId: id,
      brickName: sale?.name || input.brickNames[id] || (id === NO_BRICK_ID ? "No brick recorded" : UNNAMED_BRICK),
      directSales: sale?.direct ?? 0,
      reach,
      sales: sale?.value ?? 0,
      salesShare: sharePct(sale?.value ?? 0, totalSales),
      visitShare: sharePct(splitTotal(visits), totalVisits),
      visits,
    };
    rows.push({ ...base, reading: readingOf(base) });
  }
  // Money first — the brick that pays for the territory is the one a review starts on — then the
  // bricks holding the most class A doctors, then by name so a tie cannot reshuffle between exports.
  rows.sort(
    (a, b) =>
      b.sales - a.sales ||
      b.reach.classA.listed - a.reach.classA.listed ||
      a.brickName.localeCompare(b.brickName),
  );

  return {
    rows,
    total: {
      directSales: [...salesByBrick.values()].reduce((sum, entry) => sum + entry.direct, 0),
      reach: everyone,
      sales: totalSales,
      visits: allVisits,
    },
    unplacedContacts: unplaced,
  };
}

// ─────────────────────────────────────────────────────────────── the class A to-do list ──

export type MissedContactRow = {
  repHrId: string;
  brickId: string | null;
  brickName: string;
  name: string;
  speciality: string;
  bucket: VisitCountBucket;
  lastVisitedOn: string | null;
};

/**
 * The class A doctors (PM) and class A accounts (AM) on the list that got NO regular visit in the
 * period — the rep's to-do list (owner, 2026-10-01: "yes, by name, per brick"). Pharmacies are not
 * in it: he asked about doctors, and a pharmacy is never one.
 *
 * Ordered by what the brick SELLS, most first, so the list opens where a missed doctor costs most.
 */
export function buildMissedClassA(input: {
  contacts: readonly ListedContact[];
  visitsByContact: Readonly<Record<string, ContactVisitTally>>;
  brickOrder: readonly string[];
  brickNames: Readonly<Record<string, string>>;
}): MissedContactRow[] {
  const rank = new Map(input.brickOrder.map((id, i) => [id, i]));
  const seen = new Set<number>();
  const rows: MissedContactRow[] = [];
  for (const contact of input.contacts) {
    if (contact.grade !== "A" || contact.bucket === "Pharmacies") continue;
    if (reached(contact, input.visitsByContact) || seen.has(contact.contactId)) continue;
    seen.add(contact.contactId);
    rows.push({
      brickId: contact.brickId,
      brickName: contact.brickId ? input.brickNames[contact.brickId] || UNNAMED_BRICK : "Brick not known",
      bucket: contact.bucket,
      lastVisitedOn: contact.lastVisitedOn,
      name: contact.name,
      repHrId: contact.repHrId,
      speciality: contact.speciality,
    });
  }
  const order = (row: MissedContactRow) => (row.brickId != null ? rank.get(row.brickId) ?? rank.size : rank.size + 1);
  rows.sort(
    (a, b) =>
      order(a) - order(b) ||
      a.brickName.localeCompare(b.brickName) ||
      (a.bucket === b.bucket ? 0 : a.bucket === "PM" ? -1 : 1) ||
      a.name.localeCompare(b.name),
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────── double visits: who gets the manager ──

/**
 * The owner's rule, 2026-10-01, in his words: "if a DM has 5 in the team and he always goes with 3
 * and never or rarely with the other 2". Counted in RIDE DAYS — a day the manager spent in the field
 * with that rep — against the rep's FAIR SHARE, which is the manager's ride days in each month the
 * rep was working, divided evenly over the team members working that month.
 *
 *   never   — no ride day at all in the months he was working;
 *   rarely  — under half his fair share;
 *   most    — over one and a half times his fair share (the "always goes with" reps);
 *   fair    — anything between.
 *
 * A rep with no field day in a month was not working that month (leave, a joiner, a leaver) and is
 * left out of that month's fair share entirely, so a new hire is never marked forgotten for the
 * weeks before he started.
 */
export const DV_FOCUS_RULES = { rarelyBelow: 0.5, mostAbove: 1.5 } as const;

export type DvFocusStatus = "never" | "rarely" | "fair" | "most" | "not-working";

export const DV_FOCUS_LABEL: Record<DvFocusStatus, string> = {
  fair: "Fair share",
  most: "Gets most of the rides",
  never: "Never ridden",
  "not-working": "No field days in the period",
  rarely: "Rarely ridden",
};

export type DvFocusRep = {
  repHrId: string;
  name: string;
  /** Months of the period in which he had at least one field day. */
  workingMonths: number;
  rideDays: number;
  rideDaysByMonth: Record<string, number>;
  /** His fair share of the manager's ride days, over the months he was working. */
  fairDays: number;
  /** rideDays ÷ fairDays; null when no fair share exists. */
  ratio: number | null;
  /** Share of the manager's ride days with the team, 0–100. */
  share: number | null;
  status: DvFocusStatus;
};

export type DvFocusManager = {
  dmSeatId: string;
  managerHrId: string;
  managerName: string;
  teamSize: number;
  /** Ride days with his own team. */
  teamRideDays: number;
  /** Ride days with anybody else — another district's rep, a vacant area's cover. */
  outsideRideDays: number;
  reps: DvFocusRep[];
  never: number;
  rarely: number;
  most: number;
};

export function buildDvFocus(input: {
  months: readonly string[];
  teams: readonly { dmSeatId: string; managerHrId: string; managerName: string; repHrIds: readonly string[] }[];
  rides: readonly RideFact[];
  ridesOutside: readonly { managerHrId: string; period: string; days: number }[];
  repDays: readonly RepDayFact[];
  names: Readonly<Record<string, string>>;
}): DvFocusManager[] {
  const working = new Set(
    input.repDays.filter((fact) => num(fact.fieldDays) > 0).map((fact) => `${fact.repHrId}|${fact.period}`),
  );
  const out: DvFocusManager[] = [];

  for (const team of input.teams) {
    const managerKey = team.managerHrId.toUpperCase();
    // A manager is never his own team member, even where a seat model lists him on an area.
    const reps = [...new Set(team.repHrIds.map((id) => id.toUpperCase()))].filter((id) => id && id !== managerKey);
    if (reps.length === 0) continue;
    const repSet = new Set(reps);

    const days = new Map<string, number>(); // `${rep}|${period}` → ride days
    for (const ride of input.rides) {
      if (ride.managerHrId.toUpperCase() !== managerKey) continue;
      const rep = ride.repHrId.toUpperCase();
      if (!repSet.has(rep)) continue;
      const key = `${rep}|${ride.period}`;
      days.set(key, (days.get(key) ?? 0) + num(ride.days));
    }

    // Fair share, month by month, over the reps actually working that month.
    const fair = new Map<string, number>();
    for (const month of input.months) {
      const workingReps = reps.filter((rep) => working.has(`${rep}|${month}`));
      if (workingReps.length === 0) continue;
      const monthDays = workingReps.reduce((sum, rep) => sum + (days.get(`${rep}|${month}`) ?? 0), 0);
      for (const rep of workingReps) fair.set(rep, (fair.get(rep) ?? 0) + monthDays / workingReps.length);
    }

    const teamRideDays = [...days.values()].reduce((sum, value) => sum + value, 0);
    const rows: DvFocusRep[] = reps.map((rep) => {
      const byMonth: Record<string, number> = {};
      let rideDays = 0;
      let workingMonths = 0;
      for (const month of input.months) {
        const value = days.get(`${rep}|${month}`) ?? 0;
        byMonth[month] = value;
        rideDays += value;
        if (working.has(`${rep}|${month}`)) workingMonths += 1;
      }
      const fairDays = fair.get(rep) ?? 0;
      const ratio = fairDays > 0 ? rideDays / fairDays : null;
      let status: DvFocusStatus;
      if (workingMonths === 0) status = "not-working";
      else if (rideDays === 0) status = "never";
      else if (ratio != null && ratio < DV_FOCUS_RULES.rarelyBelow) status = "rarely";
      else if (ratio != null && ratio > DV_FOCUS_RULES.mostAbove) status = "most";
      else status = "fair";
      return {
        fairDays,
        name: input.names[rep] ?? "Unnamed employee",
        rideDays,
        rideDaysByMonth: byMonth,
        ratio,
        repHrId: rep,
        share: sharePct(rideDays, teamRideDays),
        status,
        workingMonths,
      };
    });
    const order: Record<DvFocusStatus, number> = { most: 0, fair: 1, rarely: 2, never: 3, "not-working": 4 };
    rows.sort((a, b) => b.rideDays - a.rideDays || order[a.status] - order[b.status] || a.name.localeCompare(b.name));

    out.push({
      dmSeatId: team.dmSeatId,
      managerHrId: managerKey,
      managerName: team.managerName,
      most: rows.filter((row) => row.status === "most").length,
      never: rows.filter((row) => row.status === "never").length,
      outsideRideDays: input.ridesOutside
        .filter((ride) => ride.managerHrId.toUpperCase() === managerKey && input.months.includes(ride.period))
        .reduce((sum, ride) => sum + num(ride.days), 0),
      rarely: rows.filter((row) => row.status === "rarely").length,
      reps: rows,
      teamRideDays,
      teamSize: reps.length,
    });
  }

  // The managers whose teams were left most alone come first — that is the question being asked.
  out.sort(
    (a, b) =>
      b.never + b.rarely - (a.never + a.rarely) ||
      b.most - a.most ||
      a.managerName.localeCompare(b.managerName),
  );
  return out;
}

/** One plain sentence about a manager's pattern — what the district review would say out loud. */
export function dvPatternSentence(manager: DvFocusManager): string {
  if (manager.teamRideDays === 0) return "No ride day with the team in the period.";
  const left = manager.never + manager.rarely;
  if (left === 0 && manager.most === 0) return "Ride days spread fairly across the team.";
  const parts: string[] = [];
  if (manager.most > 0) parts.push(`${manager.most} ${manager.most === 1 ? "rep gets" : "reps get"} most of the rides`);
  if (manager.never > 0) parts.push(`${manager.never} never ridden`);
  if (manager.rarely > 0) parts.push(`${manager.rarely} rarely ridden`);
  return `${parts.join("; ")}.`;
}

// ─────────────────────────────────────────────────────────────── a rep's own field month ──

export type RepFieldSummary = {
  fieldDays: number;
  fieldVisits: number;
  split: VisitCountSplit;
  /** Ride days received from ANY manager, and from his own district manager. */
  rideDays: number;
  rideDaysFromOwnManager: number;
};

export function repFieldSummary(input: {
  repHrId: string;
  months: readonly string[];
  repDays: readonly RepDayFact[];
  rides: readonly RideFact[];
  ownManagerHrId: string | null;
}): RepFieldSummary {
  const rep = input.repHrId.toUpperCase();
  const own = input.ownManagerHrId?.toUpperCase() ?? null;
  const inWindow = new Set(input.months);
  const split = emptyVisitCountSplit();
  let fieldDays = 0;
  let fieldVisits = 0;
  for (const fact of input.repDays) {
    if (fact.repHrId.toUpperCase() !== rep || !inWindow.has(fact.period)) continue;
    fieldDays += num(fact.fieldDays);
    fieldVisits += num(fact.fieldVisits);
    mergeVisitCountSplits(split, fact.split);
  }
  let rideDays = 0;
  let rideDaysFromOwnManager = 0;
  for (const ride of input.rides) {
    if (ride.repHrId.toUpperCase() !== rep || !inWindow.has(ride.period)) continue;
    rideDays += num(ride.days);
    if (own && ride.managerHrId.toUpperCase() === own) rideDaysFromOwnManager += num(ride.days);
  }
  return { fieldDays, fieldVisits, rideDays, rideDaysFromOwnManager, split };
}

/**
 * Ride days a rep received, counted as DAYS across every manager — a day two managers rode along is
 * still two ride days, one each, because each of them spent it with him.
 */
export function rideDaysReceived(rides: readonly RideFact[], repHrId: string, months: readonly string[]): number {
  const rep = repHrId.toUpperCase();
  const inWindow = new Set(months);
  return rides
    .filter((ride) => ride.repHrId.toUpperCase() === rep && inWindow.has(ride.period))
    .reduce((sum, ride) => sum + num(ride.days), 0);
}

// ─────────────────────────────────────────────────────────────── money beside the work ──

export type CostPerWork = {
  /** Outstation claimed ÷ field days, or null when there were none. */
  perFieldDay: number | null;
  perVisit: number | null;
};

export function costPerWork(claimed: number, field: Pick<RepFieldSummary, "fieldDays" | "fieldVisits">): CostPerWork {
  return {
    perFieldDay: field.fieldDays > 0 ? claimed / field.fieldDays : null,
    perVisit: field.fieldVisits > 0 ? claimed / field.fieldVisits : null,
  };
}

/** Spend per 1,000 EGP of sales — the plainest efficiency figure there is. Null with no sales. */
export function spendPerThousand(spend: number, sales: number): number | null {
  return sales > 0 ? (spend / sales) * 1000 : null;
}

/** Direct orders, grouped the way a manager reads them: booked per month, and waiting to be booked. */
export function directOrderTotals(orders: readonly DirectOrderFact[], months: readonly string[]): {
  booked: { orders: number; value: number; pharmacies: number };
  notBooked: { orders: number; value: number };
} {
  const inWindow = new Set(months);
  const booked = orders.filter((order) => order.salesMonth != null && inWindow.has(order.salesMonth));
  const waiting = orders.filter((order) => order.salesMonth == null);
  return {
    booked: {
      orders: booked.length,
      pharmacies: new Set(booked.map((order) => order.pharmacyName)).size,
      value: booked.reduce((sum, order) => sum + num(order.value), 0),
    },
    notBooked: {
      orders: waiting.length,
      value: waiting.reduce((sum, order) => sum + num(order.value), 0),
    },
  };
}
