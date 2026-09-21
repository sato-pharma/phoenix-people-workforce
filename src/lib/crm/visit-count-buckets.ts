// THE AM · PM · PHARMACIES GOLDEN RULE (owner, 2026-09-21) — every count of CRM visits is three
// figures reported apart: AM (accounts), PM (doctors) and Pharmacies. A pharmacy visit is NEVER
// counted inside PM, and never inside AM either.
//
// Why a module of its own: iReports360 tags a pharmacy visit with an AM/PM period like any other —
// measured on production for 2026-08-01 to 2026-09-20, 1,827 regular pharmacy visits carried
// `ampm = 'PM'` and 426 carried 'AM' — so any count that buckets on `ampm` alone silently files
// pharmacies among the doctors.
//
// What makes a visit a pharmacy visit is the SAME test the call-rate board uses (isPharmacyVisit in
// call-rate.ts): the visited contact's own `speciality` ('pharmacy', sent on regular visits), or —
// for the vendor's undocumented -30 code, which carries no contact — the rep's comment, which
// classifyVisit already routes to "Pharmacy Visit". Two helpers, one answer.
//
// Pure — it imports only the two pure CRM vocabularies — so the client components that print a
// count import it as readily as the server reads that build one. It is the ONE place that decides
// the bucket.

import { isPharmacySpeciality } from "@/lib/crm/contact-taxonomy";
import { classifyVisit } from "@/lib/crm/visit-types";

export type VisitCountBucket = "AM" | "PM" | "Pharmacies";

export type VisitCountSplit = { am: number; pm: number; pharmacies: number };

/** The fields a visit row needs to be bucketed. `visit_type` and `comment` matter for -30 only. */
export type VisitCountRow = {
  ampm?: string | null;
  comment?: string | null;
  speciality?: string | null;
  visit_type?: number | null;
  visit_type_description?: string | null;
};

export function isPharmacyVisitRow(row: VisitCountRow): boolean {
  if (isPharmacySpeciality(row.speciality)) return true;
  if (row.visit_type === undefined || row.visit_type === null) return false;
  return classifyVisit(row.visit_type, row.comment ?? null, row.visit_type_description ?? null).label === "Pharmacy Visit";
}

/**
 * The one bucket a visit is counted in. A pharmacy goes to Pharmacies whatever its period says;
 * otherwise an AM tag is AM and anything else — PM or an unmarked period — is PM, so every counted
 * visit lands in exactly one of the three.
 */
export function visitCountBucket(row: VisitCountRow): VisitCountBucket {
  if (isPharmacyVisitRow(row)) return "Pharmacies";
  return String(row.ampm ?? "").trim().toUpperCase().startsWith("A") ? "AM" : "PM";
}

export function emptyVisitCountSplit(): VisitCountSplit {
  return { am: 0, pm: 0, pharmacies: 0 };
}

export function addBucketToSplit(split: VisitCountSplit, bucket: VisitCountBucket, count = 1): VisitCountSplit {
  if (bucket === "AM") split.am += count;
  else if (bucket === "PM") split.pm += count;
  else split.pharmacies += count;
  return split;
}

export function addVisitToSplit(split: VisitCountSplit, row: VisitCountRow, count = 1): VisitCountSplit {
  return addBucketToSplit(split, visitCountBucket(row), count);
}

export function mergeVisitCountSplits(target: VisitCountSplit, source: VisitCountSplit): VisitCountSplit {
  target.am += source.am;
  target.pm += source.pm;
  target.pharmacies += source.pharmacies;
  return target;
}

export function visitCountSplitTotal(split: VisitCountSplit): number {
  return split.am + split.pm + split.pharmacies;
}

/**
 * "AM 3 · PM 9 · Pharmacies 2" — the three figures apart, joined by a middle dot, never a slash
 * and never one combined number. `compact` drops a zero figure (a calendar chip has no room for
 * "AM 0"); the full form always prints all three.
 */
export function formatVisitCountSplit(split: VisitCountSplit, options: { compact?: boolean } = {}): string {
  const parts: Array<[string, number]> = [
    ["AM", split.am],
    ["PM", split.pm],
    ["Pharmacies", split.pharmacies],
  ];
  const shown = options.compact ? parts.filter(([, value]) => value > 0) : parts;
  if (shown.length === 0) return "No visits";
  return shown.map(([label, value]) => `${label} ${value}`).join(" · ");
}
