/**
 * Phoenix CRM — what the field heard: the products discussed and the objections the customers raised,
 * by product, by speciality and by area, AM and PM apart. No I/O.
 *
 * Owner, 2026-10-02, one of the five reports he picked that day, for the district managers, the
 * national sales managers, SFE and the Super Admin — and, by his ruling the same day, for the product
 * and marketing managers too, on THEIR OWN products and company-wide (`options.products`).
 *
 * ## 🔴 WHAT THE CUSTOMER SAID — NEVER HOW HONEST THE REP IS
 *
 * The objection is the CUSTOMER's (visit-outcome.ts: "an objection is the DOCTOR's, never a mark
 * against the rep"). The one thing this report may never become is the Super Admin's behaviour check
 * turned into a table: `never_a_negative` in behaviour-integrity.ts reads a rep who answers "No
 * objection" visit after visit, and it is read there, silently, by the Super Admin alone. So:
 *
 *   - "No objection" is never counted, never shown and never a share. It is dropped at the door here,
 *     with the unanswered visits, and no field of this module's output can carry either;
 *   - there is no rate of any kind — not objections per visit, not "no objection" per visit — only
 *     counts of what was heard;
 *   - there is no row per rep and no row per territory. The three grains are a product, a speciality
 *     and an area, and an area is a place, not a person.
 *
 * This report stays exactly that. By the owner's decision of 3 November 2026 the per-customer list the
 * managers read is a separate report, objections-by-customer.ts: counts only, and it never scores a rep.
 *
 * ## An objection belongs to the VISIT
 *
 * A visit records one objection and the products discussed on it. So on the product grain an objection
 * counts against every product discussed on that visit — there is no truer attribution, and the screen
 * says so rather than pretending to know which product the customer meant.
 *
 * ## AM and PM apart, always
 *
 * Every count here is a pair. Nothing adds the two halves, and even the order of the rows is PM first,
 * then AM, rather than a sum.
 */

import { isVisitObjection, VISIT_OBJECTIONS, visitObjectionLabel, type VisitObjection } from "@/lib/phoenix-crm/visit-outcome";
import type { PhoenixCrmListType } from "@/lib/phoenix-crm/types";

/** One countable visit, as this report reads it. */
export type HeardVisit = {
  /** The visit's own id, when the reader needs to match it to something kept beside the visit. Never shown. */
  visitId?: string;
  visitDate: string;
  listType: PhoenixCrmListType;
  /** The product families discussed, as the visit saved them. */
  products: ReadonlyArray<string>;
  /** The raw key the visit saved; anything not one of the objections is treated as unanswered. */
  objection: string | null;
  objectionNote: string | null;
  speciality: string | null;
  /** The territory's area, named — never a code and never the rep. */
  area: string | null;
};

/** An objection a customer actually raised. "No objection" is not one, and is never counted here. */
export type HeardObjection = Exclude<VisitObjection, "none">;

export type HeardTally = { am: number; pm: number };

const COUNT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/**
 * "5 PM" or "1 AM · 3 PM" — only the halves that happened, and still never one figure. The one wording
 * the screen and the workbook both print a pair in.
 */
export function heardTallyText(tally: HeardTally): string {
  const parts = [tally.am > 0 ? `${COUNT.format(tally.am)} AM` : null, tally.pm > 0 ? `${COUNT.format(tally.pm)} PM` : null].filter(
    (part): part is string => part !== null,
  );
  return parts.length > 0 ? parts.join(" · ") : "—";
}

export type HeardObjectionCount = HeardTally & { key: HeardObjection; label: string };

/** What was said, in the rep's words, beside the objection it came with. Never the rep's name. */
export type HeardNote = {
  visitDate: string;
  listType: PhoenixCrmListType;
  objectionLabel: string;
  note: string;
  speciality: string | null;
  /** Null for the product and marketing managers, who read no area. */
  area: string | null;
};

export type HeardRow = {
  key: string;
  label: string;
  /** Visits in the row — on the product grain, the visits the product was discussed on. */
  visits: HeardTally;
  /** Of those, the visits on which the customer raised an objection. */
  objections: HeardTally;
  byObjection: HeardObjectionCount[];
  /** The products discussed on the row's visits (speciality and area grains); empty on the product grain. */
  products: Array<HeardTally & { name: string }>;
  /** What was said, newest first and capped (product grain only). */
  notes: HeardNote[];
};

export type HeardGrain = "product" | "speciality" | "area";

export type FieldHeardOptions = {
  /** Only these products (family names), for a product or marketing manager; null reads every product. */
  products: ReadonlySet<string> | null;
  /** The area grain, and the area on a note. Off for the product and marketing managers. */
  withArea: boolean;
  notesPerProduct?: number;
};

export type FieldHeardResult = {
  byProduct: HeardRow[];
  bySpeciality: HeardRow[];
  /** Null when the reader is not given the area grain at all. */
  byArea: HeardRow[] | null;
  totals: { visits: HeardTally; objections: HeardTally; byObjection: HeardObjectionCount[] };
};

export const HEARD_NOTES_PER_PRODUCT = 20;

// ── Whose products a product or marketing manager reads ─────────────────────────────────────────

/**
 *   assigned  his own product list — the one list per person that Scope & Visibility and the Weekly
 *             Sales product screen both save (src/lib/sales/product-scope-list.ts)
 *   line      no list: the products of the lines the sales side bounds him to — his line override, the
 *             Marketing Manager's three-line oversight, or his own line (`resolveSalesAccessScope`)
 *   every     no list, and a sales scope the size of the whole company
 *   none      nothing to read: an empty list, or no line to read one from
 */
export type HeardProductBasis = "assigned" | "line" | "every" | "none";

/** Where his product list came from, in the words the screen and the workbook both print. */
export const HEARD_BASIS_TEXT: Readonly<Record<HeardProductBasis, string>> = {
  assigned: "from your own product list",
  line: "the products of your lines — you have no product list of your own",
  every: "every product — your sales scope is the whole company",
  none: "no products",
};

/**
 * The products a product or marketing manager reads "What the field heard" for (owner, 2026-10-02:
 * "for their own products").
 *
 * Exactly what the sales side already says his products are, never a second rule: his own product
 * list wins when he has one — exactly those products, and an empty list reads nothing, as it does on
 * the sales side. Without one, the products of the lines his sales scope is bounded to; with no line
 * bound at all, every product. The lists arrive already turned into product FAMILIES, because a visit
 * records the families discussed, never a pack size.
 */
export function heardProductScope(input: {
  /** His own product list as families; null when he has none. */
  assignedFamilies: ReadonlyArray<string> | null;
  /** The families of the lines his sales scope is bounded to; null when it is not bounded to lines. */
  lineFamilies: ReadonlyArray<string> | null;
}): { families: Set<string> | null; basis: HeardProductBasis } {
  if (input.assignedFamilies !== null) {
    const families = new Set(input.assignedFamilies.map((name) => name.trim()).filter(Boolean));
    return { families, basis: families.size > 0 ? "assigned" : "none" };
  }
  if (input.lineFamilies === null) return { families: null, basis: "every" };
  const families = new Set(input.lineFamilies.map((name) => name.trim()).filter(Boolean));
  return { families, basis: families.size > 0 ? "line" : "none" };
}

/** The objections a customer can raise, in the form's own order. */
export const HEARD_OBJECTIONS: ReadonlyArray<{ key: HeardObjection; label: string }> = VISIT_OBJECTIONS.flatMap((entry) =>
  entry.key === "none" ? [] : [{ key: entry.key, label: entry.label }],
);

const NO_SPECIALITY = "No speciality recorded";
const NO_AREA = "No area recorded";

/** The objection the customer raised, or null — "No objection", no answer and an unknown key alike. */
export function raisedObjection(value: unknown): HeardObjection | null {
  if (!isVisitObjection(value) || value === "none") return null;
  return value;
}

function cleanName(value: string | null | undefined): string | null {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text || null;
}

type Building = {
  key: string;
  label: string;
  visits: HeardTally;
  objections: HeardTally;
  byObjection: Map<HeardObjection, HeardTally>;
  products: Map<string, HeardTally>;
  notes: HeardNote[];
};

function building(key: string, label: string): Building {
  return { key, label, visits: { am: 0, pm: 0 }, objections: { am: 0, pm: 0 }, byObjection: new Map(), products: new Map(), notes: [] };
}

function bump(tally: HeardTally, side: "am" | "pm"): void {
  tally[side] += 1;
}

function rowOf(rows: Map<string, Building>, key: string, label: string): Building {
  let row = rows.get(key);
  if (!row) {
    row = building(key, label);
    rows.set(key, row);
  }
  return row;
}

/** PM first, then AM, then the name — never a sum of the two. */
function byPmThenAm<T extends HeardTally>(left: T, right: T): number {
  return right.pm - left.pm || right.am - left.am;
}

function objectionCounts(map: ReadonlyMap<HeardObjection, HeardTally>): HeardObjectionCount[] {
  return HEARD_OBJECTIONS.flatMap((entry) => {
    const tally = map.get(entry.key);
    return tally && (tally.am > 0 || tally.pm > 0) ? [{ key: entry.key, label: entry.label, am: tally.am, pm: tally.pm }] : [];
  }).sort((left, right) => byPmThenAm(left, right));
}

function finish(rows: Map<string, Building>, notesCap: number): HeardRow[] {
  return [...rows.values()]
    .map((row) => ({
      key: row.key,
      label: row.label,
      visits: row.visits,
      objections: row.objections,
      byObjection: objectionCounts(row.byObjection),
      products: [...row.products]
        .map(([name, tally]) => ({ name, am: tally.am, pm: tally.pm }))
        .sort((left, right) => byPmThenAm(left, right) || left.name.localeCompare(right.name)),
      notes: [...row.notes].sort((left, right) => right.visitDate.localeCompare(left.visitDate)).slice(0, notesCap),
    }))
    .sort((left, right) => byPmThenAm(left.visits, right.visits) || left.label.localeCompare(right.label));
}

/**
 * The three groupings in one pass. A visit outside `options.products` is left out entirely for a
 * product or marketing manager — what the field heard about somebody else's product is not his.
 */
export function buildFieldHeard(visits: ReadonlyArray<HeardVisit>, options: FieldHeardOptions): FieldHeardResult {
  const notesCap = Math.max(0, options.notesPerProduct ?? HEARD_NOTES_PER_PRODUCT);
  const byProduct = new Map<string, Building>();
  const bySpeciality = new Map<string, Building>();
  const byArea = new Map<string, Building>();
  const totals = building("total", "Total");

  for (const visit of visits) {
    const discussed = [...new Set(visit.products.map((name) => cleanName(name)).filter((name): name is string => name !== null))];
    const kept = options.products ? discussed.filter((name) => options.products?.has(name)) : discussed;
    if (options.products && kept.length === 0) continue;

    const side = visit.listType === "AM" ? "am" : "pm";
    const objection = raisedObjection(visit.objection);
    const note = objection ? cleanName(visit.objectionNote) : null;
    const speciality = cleanName(visit.speciality);
    const area = options.withArea ? cleanName(visit.area) : null;

    const groups: Building[] = [
      totals,
      rowOf(bySpeciality, speciality ? speciality.toLowerCase() : "", speciality ?? NO_SPECIALITY),
      ...(options.withArea ? [rowOf(byArea, area ? area.toLowerCase() : "", area ?? NO_AREA)] : []),
    ];
    for (const group of groups) {
      bump(group.visits, side);
      if (objection) {
        bump(group.objections, side);
        const tally = group.byObjection.get(objection) ?? { am: 0, pm: 0 };
        bump(tally, side);
        group.byObjection.set(objection, tally);
      }
      if (group === totals) continue;
      for (const name of kept) {
        const tally = group.products.get(name) ?? { am: 0, pm: 0 };
        bump(tally, side);
        group.products.set(name, tally);
      }
    }

    for (const name of kept) {
      const row = rowOf(byProduct, name, name);
      bump(row.visits, side);
      if (!objection) continue;
      bump(row.objections, side);
      const tally = row.byObjection.get(objection) ?? { am: 0, pm: 0 };
      bump(tally, side);
      row.byObjection.set(objection, tally);
      if (note) {
        row.notes.push({ visitDate: visit.visitDate, listType: visit.listType, objectionLabel: visitObjectionLabel(objection), note, speciality, area });
      }
    }
  }

  // The product grain carries the notes and no product list of its own (its row IS a product); the
  // other two carry the products discussed and no notes.
  const products = finish(byProduct, notesCap).map((row) => ({ ...row, products: [] }));
  return {
    byProduct: products,
    bySpeciality: finish(bySpeciality, 0),
    byArea: options.withArea ? finish(byArea, 0) : null,
    totals: { visits: totals.visits, objections: totals.objections, byObjection: objectionCounts(totals.byObjection) },
  };
}
