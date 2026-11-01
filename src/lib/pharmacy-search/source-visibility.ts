/**
 * El Qema leaves Pharmacy Search for everyone but Super Admin, the CEO included (owner, 2026-11-01),
 * the same way it left the Customer Directory and the closing details.
 *
 * A distributor reaches this screen four ways, and each is closed here:
 *
 * - its rows in `source_of_sales_customer_map`, and any code recorded against a registered pharmacy,
 *   go at the query (`visibleDistributorRows`), never after it: every read has a row cap, and rows
 *   dropped after the cap would leave a viewer's results short for no visible reason;
 * - its name in the territory reference (`visibleTerritoryReference`), which is also how typing its
 *   name or code lists its whole book;
 * - its rows in the imported reference list (`withoutHiddenReferenceCodes`), which name a distributor
 *   in free text and carry no code at all.
 *
 * A pharmacy other distributors also carry stays, under them. It is their customer too.
 */

import {
  canRevealClosingSource,
  MASKED_SOURCE_DISTRIBUTORS,
  type SourceMaskViewer,
} from "@/lib/sales/closing-source-mask";
import { quotedInList } from "@/lib/supabase/search-filter";

import type { TerritoryReference } from "./reference";
import type { PharmacyDistributorCode } from "./types";

/** Answers null where a code may be blank: a row with no distributor names nobody, so it stays. */
const HIDDEN_DISTRIBUTOR_FILTER = `distributor_code.is.null,distributor_code.not.in.(${quotedInList([...MASKED_SOURCE_DISTRIBUTORS])})`;

/** Apply to every read of a table with a `distributor_code`, before its limit. */
export function visibleDistributorRows<Q extends { or(filters: string): Q }>(
  query: Q,
  viewer: SourceMaskViewer,
): Q {
  return canRevealClosingSource(viewer) ? query : query.or(HIDDEN_DISTRIBUTOR_FILTER);
}

/** A copy without the hidden names. The shared reference is cached across viewers, so never edit it. */
export function visibleTerritoryReference(
  reference: TerritoryReference,
  viewer: SourceMaskViewer,
): TerritoryReference {
  if (canRevealClosingSource(viewer)) return reference;
  return {
    ...reference,
    distributorNames: new Map(
      [...reference.distributorNames].filter(([code]) => !MASKED_SOURCE_DISTRIBUTORS.has(code.trim().toUpperCase())),
    ),
  };
}

/**
 * The reference list holds a distributor by its name as typed, so `distributorCode` on these entries
 * is that name. Compare without case: the list holds both "Ibn sina" and "ibn sina".
 *
 * Takes the FULL reference, because the visible one no longer knows the name to look for.
 */
export function withoutHiddenReferenceCodes(
  entries: PharmacyDistributorCode[],
  reference: TerritoryReference,
  viewer: SourceMaskViewer,
): PharmacyDistributorCode[] {
  if (canRevealClosingSource(viewer)) return entries;

  const hidden = new Set<string>();
  for (const code of MASKED_SOURCE_DISTRIBUTORS) {
    hidden.add(code.toLowerCase());
    const name = reference.distributorNames.get(code);
    if (name) hidden.add(name.trim().toLowerCase());
  }
  return entries.filter((entry) => !hidden.has(entry.distributorCode.trim().toLowerCase()));
}
