// The store-split net movements, cached per (line, period) so the on-screen Closing Matrix can
// show the SAME post-split numbers as the export without re-reading every invoice row on every
// page view.
//
// The rule itself lives in store-sales-city-split.ts. This module owns only the caching: computing
// `net` requires the whole month's unpaged detail rows (~7-8s measured in the export route), which
// is fine to pay once per export but too slow to pay on every Matrix load / filter change / portal
// view. unstable_cache stores the small { areaCode|productCode -> {qty, value} } result, never the
// raw rows, so it stays well under Next's data-cache entry size limit.
//
// Invalidated by invalidateClosingStoreSplitCache (src/lib/dashboard/invalidation.ts) after a
// validated monthly import and after publish/unpublish. A 1h TTL is the backstop for anything else
// that can change the split (e.g. a customer_map re-point) without going through those two paths —
// the pre-split numbers stay always-live either way, so a stale split overlay is the only exposure.

import { unstable_cache } from "next/cache.js";

import { systemAccessContext } from "@/lib/auth/permissions";
import { loadMonthlyClosingDetails } from "@/lib/sales/monthly-closing-details";
import {
  isSplitEligibleLine,
  netStoreSplitByAreaProduct,
  splitStoreSalesAcrossCityAreas,
} from "@/lib/sales/store-sales-city-split";

export const CLOSING_STORE_SPLIT_CACHE_TAG = "closing-store-split";

type NetCell = { qty: number; value: number };
type NetEntry = readonly [string, NetCell];

const loadClosingStoreSplitNetEntriesUncached = async (line: string, period: string): Promise<NetEntry[]> => {
  // systemAccessContext reads every line/product, including confidential ones — but the Closing
  // Matrix RPC these numbers get added to already hard-excludes confidential products in SQL, so
  // includeConfidential stays false to compute the split over exactly the population the Matrix
  // shows.
  const details = await loadMonthlyClosingDetails({
    access: systemAccessContext,
    line,
    period,
    availableLines: [line],
    availablePeriods: [period],
    includeConfidential: false,
    unpaged: true,
  });
  const { movements } = splitStoreSalesAcrossCityAreas(details.rows);
  return Array.from(netStoreSplitByAreaProduct(movements).entries());
};

const loadClosingStoreSplitNetEntriesCached = unstable_cache(
  loadClosingStoreSplitNetEntriesUncached,
  ["closing-store-split-net"],
  { revalidate: 3600, tags: [CLOSING_STORE_SPLIT_CACHE_TAG] },
);

/**
 * Net store-split movement per area x product for one line/period. Empty for a line the split
 * never touches (Head Office, or any line outside Pedia / Anti Infective / CNS) — callers can
 * skip applying it entirely when this comes back empty.
 */
export async function loadClosingStoreSplitNet(
  line: string | null | undefined,
  period: string | null | undefined,
): Promise<Map<string, NetCell>> {
  const trimmedLine = String(line ?? "").trim();
  const trimmedPeriod = String(period ?? "").trim();
  if (!trimmedLine || !trimmedPeriod || !isSplitEligibleLine(trimmedLine)) return new Map();
  const entries = await loadClosingStoreSplitNetEntriesCached(trimmedLine, trimmedPeriod);
  return new Map(entries);
}
