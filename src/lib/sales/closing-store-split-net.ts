// The store city split, computed ONCE per (line, period) and cached, so the on-screen Closing
// Matrix and the downloaded workbook read the SAME movements rather than deriving them separately.
//
// The rule itself lives in store-sales-city-split.ts. This module owns only the sharing and the
// caching.
//
// WHY IT CARRIES ALL THREE RESULTS, not just `net`. Until 2026-08-11 this module cached `net` for
// the screen while the export route ran splitStoreSalesAcrossCityAreas again over its own freshly
// read rows. Two derivations of one rule, and the export's was always live while the screen's could
// be up to an hour stale — so a cross-city customer re-point moved the workbook's area rows and left
// the screen's alone, which reads exactly like the bug the owner had already been chasing for weeks
// (see the note above writeMatrixSheet in monthly-closing-export.ts). Whenever the two are
// describing the same population they must now come from one computation, so they cannot disagree.
//
// `movements` and `exemptStoreValueByBrick` ride along because the export's Channel Breakdown
// write-back needs them at area and brick grain. They are small — movements is bounded by
// areas x products (~525 for CNS's 35 areas x 15 products) and the exempt map holds only
// hand-apportioned customers — so the cached entry stays well under Next's data-cache size limit.
// The raw rows are still never cached.
//
// STALENESS IS A SEPARATE, STILL-OPEN DEFECT. Invalidated by invalidateClosingStoreSplitCache
// (src/lib/dashboard/invalidation.ts) after a validated monthly import and after publish/unpublish,
// with a 1h TTL as the backstop. That does NOT cover every input: fifteen modules write
// source_of_sales_customer_map, and a geography re-stamp is a direct SQL UPDATE across four tables
// including source_of_sales_import_rows, which has no updated_at column and no trigger. So the
// cache can serve a stale split, and both surfaces will now be stale TOGETHER rather than
// disagreeing. Closing that properly needs a statement-level trigger stamping a version row (a
// migration), because no timestamp on these tables is trustworthy enough to key on — do not "fix"
// it by adding invalidate calls to write paths, which is the same hand-maintained list that let
// this class of bug through twice already.

import { unstable_cache } from "next/cache.js";

import { systemAccessContext } from "@/lib/auth/permissions";
import { loadMonthlyClosingDetails } from "@/lib/sales/monthly-closing-details";
import {
  isSplitEligibleLine,
  netStoreSplitByAreaProduct,
  splitStoreSalesAcrossCityAreas,
  STORE_CITY_SPLIT_ENABLED,
  type StoreSplitAreaMovement,
} from "@/lib/sales/store-sales-city-split";

export const CLOSING_STORE_SPLIT_CACHE_TAG = "closing-store-split";

type NetCell = { qty: number; value: number };

/** The cached shape. Maps do not survive serialization, so they travel as entry arrays. */
type CachedSplit = {
  exempt: (readonly [string, number])[];
  movements: StoreSplitAreaMovement[];
  net: (readonly [string, NetCell])[];
};

/** Everything one (line, period)'s city split produces. One computation, shared by both surfaces. */
export type ClosingStoreSplit = {
  /** Per brick|area, store money belonging to a customer the split deliberately did NOT move. */
  exemptStoreValueByBrick: ReadonlyMap<string, number>;
  /** Per area, line and product — what left and what arrived. The Channel Breakdown reads this. */
  movements: StoreSplitAreaMovement[];
  /** Per area x product, the net delta the Closing Matrix write-back applies. */
  net: Map<string, NetCell>;
};

const loadClosingStoreSplitUncached = async (line: string, period: string): Promise<CachedSplit> => {
  // systemAccessContext reads every line/product, including confidential ones — but the Closing
  // Matrix RPC these numbers get added to already hard-excludes confidential products in SQL, so
  // includeConfidential stays false to compute the split over exactly the population the Matrix
  // shows. It is also what makes this result safe to share with the export: the population is the
  // whole month for everyone, never the caller's own scope.
  const details = await loadMonthlyClosingDetails({
    access: systemAccessContext,
    line,
    period,
    availableLines: [line],
    availablePeriods: [period],
    includeConfidential: false,
    unpaged: true,
  });
  const { exemptStoreValueByBrick, movements } = splitStoreSalesAcrossCityAreas(details.rows);
  return {
    exempt: Array.from(exemptStoreValueByBrick.entries()),
    movements,
    net: Array.from(netStoreSplitByAreaProduct(movements).entries()),
  };
};

// Cache key deliberately renamed from the old "closing-store-split-net": the payload shape changed,
// and a new key means an entry written by the previous deploy can never be read back as this shape.
const loadClosingStoreSplitCached = unstable_cache(
  loadClosingStoreSplitUncached,
  ["closing-store-split"],
  { revalidate: 3600, tags: [CLOSING_STORE_SPLIT_CACHE_TAG] },
);

/** A fresh empty result. Never a shared constant — callers hold these maps and may narrow them. */
const emptySplit = (): ClosingStoreSplit => ({
  exemptStoreValueByBrick: new Map(),
  movements: [],
  net: new Map(),
});

/**
 * The whole month's city split for one line/period. Empty for a line the split never touches
 * (Head Office, or any line outside Pedia / Anti Infective / CNS) — callers can skip applying it
 * entirely when `net` comes back empty.
 */
export async function loadClosingStoreSplit(
  line: string | null | undefined,
  period: string | null | undefined,
): Promise<ClosingStoreSplit> {
  // The owner turned the wholesaler city split OFF (2026-08-10, re-applied 2026-08-12 after the
  // first disable was lost in a squash merge). Gated here — the one loader both the screen and the
  // export read — so neither surface can apply it while the other does not.
  if (!STORE_CITY_SPLIT_ENABLED) return emptySplit();
  const trimmedLine = String(line ?? "").trim();
  const trimmedPeriod = String(period ?? "").trim();
  if (!trimmedLine || !trimmedPeriod || !isSplitEligibleLine(trimmedLine)) return emptySplit();
  const cached = await loadClosingStoreSplitCached(trimmedLine, trimmedPeriod);
  return {
    exemptStoreValueByBrick: new Map(cached.exempt),
    movements: cached.movements,
    net: new Map(cached.net),
  };
}

/**
 * Net store-split movement per area x product. The Closing Matrix write-back's input, and all the
 * on-screen path needs.
 */
export async function loadClosingStoreSplitNet(
  line: string | null | undefined,
  period: string | null | undefined,
): Promise<Map<string, NetCell>> {
  return (await loadClosingStoreSplit(line, period)).net;
}
