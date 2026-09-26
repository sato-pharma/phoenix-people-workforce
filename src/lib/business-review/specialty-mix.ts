// Business Review — what a list is actually made of.
//
// Owner, 2026-09-26: "the breakdown of the list — how many specialties per every rep list, per the
// district manager list ... his list is his total list of his team, and the national sales manager
// list is his list of the total line." One rollup, used at every level, because a district's list
// IS its reps' lists unioned and a line's IS its districts'.
//
// 🔴 A CUSTOMER IS COUNTED ONCE, WHATEVER THE LEVEL. The counts here are UNIONS over distinct
// contact ids, never sums: a doctor visited by two reps in one district is one doctor in that
// district's list, and a doctor visited in July and August is one doctor in the window. Summing
// would inflate every level above the rep and inflate the window over the month — the same rule
// the module's customer counts already follow.
//
// THE CLASSIFIER IS `src/lib/crm/contact-taxonomy.ts` AND THERE IS NO SECOND ONE. The vendor ships
// one free-text `speciality` column holding three different kinds of thing — a doctor's medical
// specialty, a place (pharmacy, hospital, polyclinic) and a commercial account (Contract, Health
// Insurance) — and measured on production 2026-08-08, a fifth of the "doctor panel" was never a
// doctor. That module already decides this for Doctor Coverage and the call rate, and growing a
// second opinion here is precisely how the two would drift.
//
// AN UNKNOWN VALUE IS SURFACED, NEVER FOLDED. The vendor adds values without notice — that is how
// "Contract" and "Health Insurance" came to be scored as doctors in the first place — so anything
// the taxonomy has not seen lands in `unclassified` and is shown. Guessing is what produced the
// defect it exists to prevent.
//
// THE CATCH-ALL CONTACT IS THE CALLER'S JOB. `CATCH_ALL_CONTACT_CRM_ID` (100000) is a bucket, not
// a person, and it poisons every per-contact figure. The visit source already excludes it before
// these rows are built; this module never sees it and must not be given a second opinion about it.

import {
  CRM_CONTACT_KIND_LABELS,
  classifyCrmContactSpeciality,
  type CrmContactKind,
} from "@/lib/crm/contact-taxonomy";

/** One visited contact, as the mix needs it. */
export type SpecialtyVisitRow = {
  /** The contact's own id. Two rows with the same id are ONE customer. */
  contactCrmId: number | null;
  /** The vendor's free-text value, verbatim — classified here, never upstream. */
  speciality: string | null;
  /** How many visits this row represents. */
  visits: number;
};

export type SpecialtyCount = {
  /** The vendor's value, trimmed. Empty string for a contact carrying none. */
  speciality: string;
  /** What to print: the value itself, or "No speciality recorded" when it is blank. */
  label: string;
  kind: CrmContactKind;
  /** DISTINCT contacts, a union. */
  customers: number;
  visits: number;
};

export type SpecialtyMix = {
  /** Distinct customers per kind. The three sum to `customersTotal`. */
  byKind: Record<CrmContactKind, number>;
  /** Visits per kind. The three sum to `visitsTotal`. */
  visitsByKind: Record<CrmContactKind, number>;
  /** Every speciality present, most customers first. */
  specialities: SpecialtyCount[];
  customersTotal: number;
  visitsTotal: number;
};

const BLANK_LABEL = "No speciality recorded";

function emptyByKind(): Record<CrmContactKind, number> {
  return { hcp: 0, sp: 0, unclassified: 0 };
}

/**
 * Roll a scope's visited contacts up into its specialty mix.
 *
 * A contact whose speciality is recorded differently on two rows is counted under EACH value it
 * carries but once in `customersTotal`, because the vendor's field is the only authority for what
 * the contact is and picking a winner would be this module inventing one. That is why the per-
 * speciality customer counts may add up to more than the total — and the total is the honest one,
 * so it is computed from the distinct id set rather than by summing the rows above it.
 */
export function buildSpecialtyMix(rows: readonly SpecialtyVisitRow[]): SpecialtyMix {
  const perSpeciality = new Map<string, { contacts: Set<number>; kind: CrmContactKind; visits: number }>();
  const allContacts = new Set<number>();
  const contactsByKind: Record<CrmContactKind, Set<number>> = { hcp: new Set(), sp: new Set(), unclassified: new Set() };
  const visitsByKind = emptyByKind();
  let visitsTotal = 0;

  for (const row of rows) {
    const visits = Number.isFinite(row.visits) ? row.visits : 0;
    const speciality = String(row.speciality ?? "").trim();
    const kind = classifyCrmContactSpeciality(speciality);

    visitsTotal += visits;
    visitsByKind[kind] += visits;

    let bucket = perSpeciality.get(speciality);
    if (!bucket) {
      bucket = { contacts: new Set<number>(), kind, visits: 0 };
      perSpeciality.set(speciality, bucket);
    }
    bucket.visits += visits;

    // A row with no contact id is real fieldwork that cannot be attributed to a person — its VISITS
    // count and its customer does not, rather than the row being dropped whole.
    if (row.contactCrmId == null || !Number.isFinite(row.contactCrmId)) continue;
    bucket.contacts.add(row.contactCrmId);
    allContacts.add(row.contactCrmId);
    contactsByKind[kind].add(row.contactCrmId);
  }

  const specialities: SpecialtyCount[] = [...perSpeciality.entries()]
    .map(([speciality, bucket]) => ({
      customers: bucket.contacts.size,
      kind: bucket.kind,
      label: speciality === "" ? BLANK_LABEL : speciality,
      speciality,
      visits: bucket.visits,
    }))
    .sort((a, b) => b.customers - a.customers || b.visits - a.visits || a.label.localeCompare(b.label));

  return {
    byKind: { hcp: contactsByKind.hcp.size, sp: contactsByKind.sp.size, unclassified: contactsByKind.unclassified.size },
    customersTotal: allContacts.size,
    specialities,
    visitsByKind,
    visitsTotal,
  };
}

/**
 * The same mix, from TALLIES rather than rows.
 *
 * The overlays accumulate per speciality as they merge a district's reps — a set of contact ids
 * and a visit count each — because carrying every visit row up to the district would be the same
 * data an order of magnitude larger. This builds the identical shape from those tallies, so there
 * is still one `SpecialtyMix` and one classifier however it was accumulated.
 *
 * `customersTotal` and the per-kind counts are unions across the SETS, never sums of the per-
 * speciality counts: a contact recorded under two spellings is one customer, and adding the
 * buckets would count them twice.
 */
export function specialtyMixFromTallies(
  contacts: ReadonlyMap<string, ReadonlySet<number>>,
  visits: ReadonlyMap<string, number>,
): SpecialtyMix {
  const allContacts = new Set<number>();
  const contactsByKind: Record<CrmContactKind, Set<number>> = { hcp: new Set(), sp: new Set(), unclassified: new Set() };
  const visitsByKind = emptyByKind();
  let visitsTotal = 0;

  const specialities: SpecialtyCount[] = [];
  const names = new Set<string>([...contacts.keys(), ...visits.keys()]);
  for (const speciality of names) {
    const kind = classifyCrmContactSpeciality(speciality);
    const ids = contacts.get(speciality) ?? new Set<number>();
    const count = visits.get(speciality) ?? 0;
    visitsTotal += count;
    visitsByKind[kind] += count;
    for (const id of ids) {
      allContacts.add(id);
      contactsByKind[kind].add(id);
    }
    specialities.push({
      customers: ids.size,
      kind,
      label: speciality === "" ? BLANK_LABEL : speciality,
      speciality,
      visits: count,
    });
  }

  specialities.sort((a, b) => b.customers - a.customers || b.visits - a.visits || a.label.localeCompare(b.label));

  return {
    byKind: { hcp: contactsByKind.hcp.size, sp: contactsByKind.sp.size, unclassified: contactsByKind.unclassified.size },
    customersTotal: allContacts.size,
    specialities,
    visitsByKind,
    visitsTotal,
  };
}

/**
 * The one line a manager reads above the table: how much of this list is actually doctors.
 *
 * Deliberately states the SHARE rather than a verdict. There is no right proportion — a rep whose
 * list is half pharmacies may be covering a pharmacy-heavy brick correctly — and inventing a band
 * here would be this page telling him his list is wrong on evidence it does not have.
 */
export function describeSpecialtyMix(mix: SpecialtyMix): string {
  if (mix.customersTotal === 0) return "No customers were visited in this window.";
  const share = (mix.byKind.sp / mix.customersTotal) * 100;
  const parts = [
    `${mix.customersTotal.toLocaleString("en-US")} customers`,
    `${mix.byKind.sp.toLocaleString("en-US")} doctors (${share.toFixed(0)}%)`,
    `${mix.byKind.hcp.toLocaleString("en-US")} pharmacies, hospitals and accounts`,
  ];
  if (mix.byKind.unclassified > 0) {
    parts.push(`${mix.byKind.unclassified.toLocaleString("en-US")} the vendor has not classified`);
  }
  return `${parts.join(" · ")}.`;
}

/** Display labels for the three kinds — the taxonomy's own, never a second wording. */
export const SPECIALTY_KIND_LABELS = CRM_CONTACT_KIND_LABELS;
