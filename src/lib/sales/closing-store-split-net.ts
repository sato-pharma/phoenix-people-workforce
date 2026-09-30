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

import { loadSplitRegions } from "@/lib/sales/closing-organogram-regions";
import type { SplitRegions } from "@/lib/sales/store-sales-city-split";
import { systemAccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { loadMonthlyClosingDetails } from "@/lib/sales/monthly-closing-details";
import { loadProductPeriodPrices } from "@/lib/sales/product-period-price";
import { resolveTargetLineCode } from "@/lib/sales/monthly-targets";
import {
  areaProductKey,
  isSplitEligibleLine,
  netStoreSplitByAreaProduct,
  splitStoreSalesAcrossCityAreas,
  isStoreCitySplitActive,
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
  // The period decides which warehouse rule answers "is this a store" — the owner's 2026-09-06
  // rulings from September on, the six words alone before that. Passed explicitly here because this
  // loader is the ONE place both the screen and the export read, so neither can use a different
  // rule from the other, and neither can restate a month the owner froze.
  // The organogram parks some areas in Others, and those take no share of an El Qema split —
  // owner, 2026-09-08. Resolved here, from the same line and month the rows were loaded for.
  const regions = await loadSplitRegions(line, period);
  const { exemptStoreValueByBrick, movements } = splitStoreSalesAcrossCityAreas(
    details.rows,
    period,
    regions,
  );
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
  // The owner turned the wholesaler city split ON for every city (2026-09-04), from August 2026
  // forward — July and earlier keep the numbers they were published with. Gated here — the one
  // loader both the screen and the export read — so neither surface can apply it while the other
  // does not, and neither can apply it to a month the owner froze.
  const trimmedLine = String(line ?? "").trim();
  const trimmedPeriod = String(period ?? "").trim();
  if (!isStoreCitySplitActive(trimmedPeriod)) return emptySplit();
  if (!trimmedLine || !isSplitEligibleLine(trimmedLine)) return emptySplit();
  const cached = await loadClosingStoreSplitCached(trimmedLine, trimmedPeriod);
  return {
    exemptStoreValueByBrick: new Map(cached.exempt),
    movements: cached.movements,
    net: new Map(cached.net),
  };
}

/**
 * The FROZEN store-split net for a month that is currently PUBLISHED — else null.
 *
 * 🔴 A PUBLISHED AND ANNOUNCED MONTH IS NEVER CORRECTED (owner, 2026-09-27, pinned by
 * 20260927213000_freeze_attribution_for_published_months.sql). That migration froze the ATTRIBUTION
 * engine — au.monthly_store_split_net and the rollup stop recomputing once a month is published — so
 * the keycard, boards, Employee 360 and incentive all read the announced number. But THIS live
 * splitter was never gated: it recomputes the split from current validated imports and the current
 * customer map (whose writes its own header warns are not invalidated), so the Closing tab drifted
 * off the announced closing while every attribution surface stayed frozen. Measured 2026-08 Anti
 * Infective / Menoufia 2 (D13) / Saginko: the tab read 85.5% where the announced closing (and the
 * keycard) read 84%.
 *
 * So for a published month, read the SAME frozen net the attribution engine reads
 * (au.monthly_store_split_net, via the service-role wrapper phx_monthly_store_split_net), valued at
 * the period factory price exactly as au.f_monthly_attribution values it. The Closing tab then equals
 * the keycard = the announced number. [Owner, 2026-09-30: show the frozen published number.]
 *
 * FAIL TO LIVE, NEVER TO EMPTY: on any read error return null so the caller recomputes live — an
 * empty map would wrongly zero the split on the tab. An UNPUBLISHED month also returns null and
 * recomputes live, exactly as before.
 */
async function loadFrozenStoreSplitNetIfPublished(
  line: string | null | undefined,
  period: string | null | undefined,
): Promise<Map<string, NetCell> | null> {
  const trimmedLine = String(line ?? "").trim();
  const trimmedPeriod = String(period ?? "").trim();
  if (!trimmedLine || !trimmedPeriod) return null;
  if (!isStoreCitySplitActive(trimmedPeriod) || !isSplitEligibleLine(trimmedLine)) return null;
  const lineCode = resolveTargetLineCode(trimmedLine);
  if (!lineCode) return null;

  const supabase = getSupabaseAdmin();

  // Frozen? The freeze in 20260927213000 is PER-PERIOD: publishing ANY line freezes
  // au.monthly_store_split_net and the attribution rollup for the WHOLE period, so every line's keycard
  // is then frozen. Match that predicate here (any publication row for the period with unpublished_at
  // IS NULL), not the specific line — otherwise an unpublished line in a partially-published period
  // keeps recomputing its tab live while its keycard is already frozen, reopening the very drift this
  // closes. A period with no live publication row recomputes live, as before.
  const { data: published, error: publishedError } = await supabase
    .from("monthly_closing_publications")
    .select("id")
    .eq("period", trimmedPeriod)
    .is("unpublished_at", null)
    .limit(1);
  if (publishedError || !published || published.length === 0) return null;

  const { data, error } = await supabase.rpc("phx_monthly_store_split_net", { p_period: trimmedPeriod });
  if (error || !data) return null;

  const prices = await loadProductPeriodPrices();
  const net = buildFrozenNetFromRows(data as FrozenNetRow[], lineCode, trimmedPeriod, (product) =>
    prices.priceFor(product, trimmedPeriod),
  );
  // FAIL TO LIVE, NEVER TO EMPTY. A frozen month's split-eligible line should have net rows; an empty
  // result means none matched (a line_code space that drifted from resolveTargetLineCode, an empty
  // table) — returning it would make the caller drop the split entirely and show the raw, un-split
  // closing. Fall through to the live recompute instead, which is at worst the pre-fix behaviour.
  return net.size > 0 ? net : null;
}

/** One row of au.monthly_store_split_net, as the wrapper RPC returns it. */
export type FrozenNetRow = {
  line_code?: unknown;
  area_code?: unknown;
  product_code?: unknown;
  net_qty?: unknown;
  net_effective_units?: unknown;
};

/**
 * Turn the frozen materialized-net rows into the {qty, value} map the matrix write-back applies.
 * PURE, so the value basis is unit-tested without a database.
 *
 * Value is `net_effective_units × factory_price(product, period)` — the PERIOD price, exactly how
 * au.f_monthly_attribution values the same net, so the frozen closing tab lands on the same EGP the
 * keycard does even for a period-repriced product (Saginko SA001: 111.15 through 2026-09, 170.52 from
 * 2026-10). Units carry net_qty (bonus included). Only the requested line's rows contribute.
 */
export function buildFrozenNetFromRows(
  rows: readonly FrozenNetRow[],
  lineCode: string,
  _period: string,
  priceFor: (productCode: string) => number | null,
): Map<string, NetCell> {
  const net = new Map<string, NetCell>();
  for (const raw of rows) {
    if (String(raw.line_code ?? "").trim() !== lineCode) continue;
    const product = String(raw.product_code ?? "");
    const effectiveUnits = Number(raw.net_effective_units ?? 0);
    const price = priceFor(product) ?? 0;
    net.set(areaProductKey(String(raw.area_code ?? ""), product), {
      qty: Number(raw.net_qty ?? 0),
      value: effectiveUnits * price,
    });
  }
  return net;
}

/**
 * Net store-split movement per area x product. The Closing Matrix write-back's input, and all the
 * on-screen path needs.
 *
 * For a PUBLISHED month this returns the FROZEN net (loadFrozenStoreSplitNetIfPublished) so the
 * Closing tab equals the announced number and the attribution surfaces, never a live recompute that
 * drifted after publish. Unpublished months recompute live.
 */
export async function loadClosingStoreSplitNet(
  line: string | null | undefined,
  period: string | null | undefined,
): Promise<Map<string, NetCell>> {
  const frozen = await loadFrozenStoreSplitNetIfPublished(line, period);
  if (frozen) return frozen;
  return (await loadClosingStoreSplit(line, period)).net;
}
