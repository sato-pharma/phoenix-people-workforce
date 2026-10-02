// THE AM · PM · PHARMACIES GOLDEN RULE, applied to Double Visit Analytics and the Double Visit
// Report. The rule itself — and the one test of what a pharmacy visit is — lives in
// src/lib/crm/visit-count-buckets.ts; this module only adapts it to a double-visit row, whose period
// arrives already normalised to AM / PM / UNKNOWN.
//
// Two differences from the general helper, both deliberate:
// - a row with no period at all stays out of the three figures, as it always has on these screens
//   (the general helper files it under PM, which suits a calendar chip but would move a number here);
// - a row that was bucketed on the server carries `countBucket`, and a payload built before that
//   field existed falls back to its period, so a cached dashboard never reads as all zeros.
//
// Pure: the client workspaces import it as readily as the server service does.

import {
  addBucketToSplit,
  emptyVisitCountSplit,
  isPharmacyVisitRow,
  type VisitCountBucket,
  type VisitCountSplit,
} from "@/lib/crm/visit-count-buckets";
import type { DoubleVisitPeriod } from "@/lib/double-visit-analytics/types";

type BucketSource = {
  period: DoubleVisitPeriod;
  speciality?: string | null;
  visit_type?: number | null;
  visit_type_description?: string | null;
};

/** The one figure a double visit is counted in, or null when the CRM recorded no period for it. */
export function doubleVisitCountBucket(row: BucketSource): VisitCountBucket | null {
  if (
    isPharmacyVisitRow({
      speciality: row.speciality,
      visit_type: row.visit_type,
      visit_type_description: row.visit_type_description,
    })
  ) {
    return "Pharmacies";
  }
  if (row.period === "AM" || row.period === "PM") return row.period;
  return null;
}

type BucketedEntry = { countBucket?: VisitCountBucket | null; period: DoubleVisitPeriod };

/** The bucket a log or report row is counted under — the server's answer when it sent one. */
export function entryCountBucket(entry: BucketedEntry): VisitCountBucket | null {
  if (entry.countBucket !== undefined) return entry.countBucket;
  return entry.period === "UNKNOWN" ? null : entry.period;
}

/** What a row shows, and is filtered by, in a Period column: a pharmacy reads "Pharmacies". */
export function entryPeriodLabel(entry: BucketedEntry): VisitCountBucket | "UNKNOWN" {
  return entryCountBucket(entry) ?? "UNKNOWN";
}

/**
 * AM · PM · Pharmacies totals over rows, each weighted by its own visit count. `fromPhoenixOf` marks a
 * Phoenix CRM row, which logs no pharmacy visit — the split then says its pharmacy figure was never
 * recorded rather than print 0 (src/lib/crm/visit-count-buckets.ts).
 */
export function sumDoubleVisitSplit<T>(
  rows: readonly T[],
  bucketOf: (row: T) => VisitCountBucket | null,
  countOf: (row: T) => number,
  fromPhoenixOf?: (row: T) => boolean,
): VisitCountSplit {
  const split = emptyVisitCountSplit();
  for (const row of rows) {
    const bucket = bucketOf(row);
    if (bucket) addBucketToSplit(split, bucket, countOf(row), fromPhoenixOf?.(row) === true);
  }
  return split;
}
