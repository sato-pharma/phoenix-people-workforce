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
// STALENESS IS CLOSED BY A VERSION STAMP, NOT BY INVALIDATE CALLS. Invalidated by
// invalidateClosingStoreSplitCache (src/lib/dashboard/invalidation.ts) after a validated monthly
// import and after publish/unpublish, with a 1h TTL as the backstop. That list does NOT cover every
// input: fifteen modules write source_of_sales_customer_map, and a geography re-stamp is a direct SQL
// UPDATE across four tables including source_of_sales_import_rows, which has no updated_at column
// and no trigger. So the cache key also carries phx_sos_geography_version() — a sequence bumped by a
// statement-level trigger on every table the split reads for geography
// (20261010160000_sos_geography_version.sql). Any write to those tables, from any path, changes the
// key and the next read recomputes. Do NOT "fix" a stale split by adding invalidate calls to write
// paths — that hand-maintained list is what let this class of bug through twice already.
//
// The stamp read FAILS TO THE OLD BEHAVIOUR, never to an error: if the function is missing (the
// migration not applied yet) or the call fails, the key falls back to the current hour, which is
// exactly the 1h TTL this module had before.

import { unstable_cache } from "next/cache.js";

import { CLOSING_STORE_SPLIT_CACHE_TAG } from "@/lib/dashboard/invalidation";
import {
  isBulkAllocationActive,
  isBulkAllocationLine,
  isEpdaContributionActive,
} from "@/lib/sales/bulk-allocation-channel";
import { buildBulkAllocation, epdaUnitsLanded, mergeBulkAllocationIntoSplit } from "@/lib/sales/closing-bulk-allocation";
import { buildOfficeRespread, mergeOfficeRespreadIntoSplit } from "@/lib/sales/closing-office-respread";
import { loadSplitRegions } from "@/lib/sales/closing-organogram-regions";
import { isOfficeRespreadPair } from "@/lib/sales/office-distributor";
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

// Declared as a bare string in dashboard/invalidation.ts (its comment says why) and re-exported here.
export { CLOSING_STORE_SPLIT_CACHE_TAG };

type NetCell = { qty: number; value: number };

/** The cached shape. Maps do not survive serialization, so they travel as entry arrays. */
type CachedSplit = {
  exempt: (readonly [string, number])[];
  movements: StoreSplitAreaMovement[];
  net: (readonly [string, NetCell])[];
  officeNet: (readonly [string, NetCell])[];
  epdaUnits?: (readonly [string, number])[];
};

/** Everything one (line, period)'s city split produces. One computation, shared by both surfaces. */
export type ClosingStoreSplit = {
  /** Per brick|area, store money belonging to a customer the split deliberately did NOT move. */
  exemptStoreValueByBrick: ReadonlyMap<string, number>;
  /** Per area, line and product — what left and what arrived. The Channel Breakdown reads this. */
  movements: StoreSplitAreaMovement[];
  /** Per area x product, the net delta the Closing Matrix write-back applies. */
  net: Map<string, NetCell>;
  /**
   * The OFFICE CHANNEL's own slice of `net` — already added into it, reported separately because the
   * `office` grid takes that part and nothing else (closing-office-respread.ts's header says why:
   * the Closing Matrix (No Office) tab is `matrix − office` cell by cell, so the two grids have to
   * agree about which area holds an Office unit or that subtraction prints negative sales).
   *
   * Empty on every line but CNS, every month before 2026-09, and every month whose Office rows did
   * not move.
   */
  officeNet: Map<string, NetCell>;
  /**
   * Per area|product, the EPDA units rule 2 landed on that area (owner, 2026-11-04), for the EPDA tab
   * of the three closing downloads (closing-epda-sheet.ts). Already inside `net`; reported on its own
   * because nothing else can pick the EPDA legs back out of the merged movements.
   *
   * Empty before October 2026 and on every line but Pedia and Anti Infective.
   */
  epdaUnits?: Map<string, number>;
};

// The cache-key stamp. Passed as an ARGUMENT of the cached function, which unstable_cache folds into
// the key, so a different stamp is a different entry. Never used inside the computation itself.
const readGeographyStamp = async (): Promise<string> => {
  try {
    const { data, error } = await getSupabaseAdmin().rpc("phx_sos_geography_version");
    if (!error && data !== null && data !== undefined) return `v${String(data)}`;
  } catch {
    // fall through to the hour bucket
  }
  return `hour-${Math.floor(Date.now() / 3_600_000)}`;
};

const loadClosingStoreSplitUncached = async (
  line: string,
  period: string,
  _geographyStamp: string,
): Promise<CachedSplit> => {
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
  // The city split is NOT run for a month or line it does not cover, even when the EPDA-BULK
  // allocation below is what brought us here: the city rule's period gate lives in its CALLERS
  // rather than in isSplitEligible, so calling the splitter anyway would split a month the owner
  // froze. Today every bulk month is a city-split month too; this keeps that a fact rather than a
  // dependency.
  const cityApplies = isStoreCitySplitActive(period) && isSplitEligibleLine(line);
  // The organogram parks some areas in Others, and those take no share of an El Qema split —
  // owner, 2026-09-08. Resolved here, from the same line and month the rows were loaded for.
  const regions = cityApplies ? await loadSplitRegions(line, period) : undefined;
  // The period decides which warehouse rule answers "is this a store" — the owner's 2026-09-06
  // rulings from September on, the six words alone before that. Passed explicitly here because this
  // loader is the ONE place both the screen and the export read, so neither can use a different
  // rule from the other, and neither can restate a month the owner froze.
  const { exemptStoreValueByBrick, movements } = cityApplies
    ? splitStoreSalesAcrossCityAreas(details.rows, period, regions)
    : { exemptStoreValueByBrick: new Map<string, number>(), movements: [] as StoreSplitAreaMovement[] };
  // THE EPDA-BULK ALLOCATION RIDES THE SAME NET (owner, 2026-10-09, from the September closing).
  // Folded in here, in the one loader both the screen and the export read, for the same reason the
  // city split is: two surfaces deriving one redistribution separately is the defect this module was
  // written to end. The two nets are added — both are zero-sum per product, so their sum is — and
  // the bulk rows are already refused by `isSplitEligible`, so nothing moves twice.
  const bulk = buildBulkAllocation(details.rows, period, line);
  const withBulk = mergeBulkAllocationIntoSplit(
    { exemptStoreValueByBrick, movements, net: netStoreSplitByAreaProduct(movements) },
    bulk,
  );
  // THE OFFICE CHANNEL'S READ-TIME RESPREAD RIDES THE SAME NET (owner, 2026-10-09: "fix the Office
  // allocation to read-time shares"), from the September 2026 closing, CNS only. Folded in here for the
  // third time for the same reason as the other two: this is the ONE loader both the screen and the
  // export read, so neither can respread while the other does not. Its OUT legs cancel the spread the
  // upload stamped on the stored rows and its IN legs are today's, so a month whose batches have not
  // moved since the Office file landed nets to exactly zero — see closing-office-respread.ts.
  const merged = mergeOfficeRespreadIntoSplit(withBulk, buildOfficeRespread(details.rows, period, line));
  return {
    exempt: Array.from(merged.exemptStoreValueByBrick.entries()),
    movements: merged.movements,
    net: Array.from(merged.net.entries()),
    officeNet: Array.from(merged.officeNet.entries()),
    epdaUnits: Array.from(epdaUnitsLanded(bulk, period, details.rows).entries()),
  };
};

// Cache key deliberately renamed from the old "closing-store-split-net": the payload shape changed,
// and a new key means an entry written by the previous deploy can never be read back as this shape.
// Renamed AGAIN for the EPDA-BULK allocation above: the shape is identical this time but the numbers
// are not, and an hour of entries written by the previous deploy would otherwise serve a September
// Pedia closing with the bulk book still sitting on its invoiced areas.
// Renamed a THIRD time for the Office read-time respread: the payload grew `officeNet`, and an entry
// from the previous deploy read back as this shape would hand the Office grid an UNDEFINED net —
// which is the one failure mode that prints a negative Closing Matrix (No Office) cell.
const loadClosingStoreSplitCached = unstable_cache(
  loadClosingStoreSplitUncached,
  ["closing-store-split-with-bulk-office-respread-and-epda-rule-2"],
  { revalidate: 3600, tags: [CLOSING_STORE_SPLIT_CACHE_TAG] },
);

/** A fresh empty result. Never a shared constant — callers hold these maps and may narrow them. */
const emptySplit = (): ClosingStoreSplit => ({
  exemptStoreValueByBrick: new Map(),
  movements: [],
  net: new Map(),
  officeNet: new Map(),
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
  // The EPDA-BULK allocation is a SECOND reason this result is not empty, and it has its own line
  // and start month (Pedia, 2026-09). Today it is a strict subset of the city split's gate — Pedia
  // is split-eligible and September is after the split's August start — so the two tests can only
  // disagree if one of those dates is ever moved. Asked separately anyway: a gate that is correct by
  // coincidence silently drops a whole rule the day the coincidence ends.
  const bulkApplies = isBulkAllocationActive(trimmedPeriod) && isBulkAllocationLine(trimmedLine, trimmedPeriod);
  // The Office read-time respread is a THIRD independent reason this result is not empty, with its
  // own line and start month (CNS, 2026-09). Asked separately for the same reason the bulk rule is:
  // today it is a subset of the city split's gate — CNS is split-eligible and September is after the
  // split's August start — and a gate that is correct by coincidence silently drops a whole rule the
  // day one of those dates moves.
  const officeApplies = isOfficeRespreadPair(trimmedLine, trimmedPeriod);
  if (!isStoreCitySplitActive(trimmedPeriod) && !bulkApplies && !officeApplies) return emptySplit();
  if (!trimmedLine) return emptySplit();
  if (!isSplitEligibleLine(trimmedLine) && !bulkApplies && !officeApplies) return emptySplit();
  // 🔴 A PUBLISHED month is FROZEN — the tab AND the export read the frozen net, not a live recompute
  // that drifted after publish. See loadFrozenStoreSplitIfPublished. Unpublished months fall through
  // to the live cache below, unchanged. Gated HERE (the one loader both surfaces read) rather than in
  // each caller, so the Closing tab, its reconciliation and the downloaded workbook cannot disagree.
  const frozen = await loadFrozenStoreSplitIfPublished(trimmedLine, trimmedPeriod);
  if (frozen) {
    // 🔴 THE FROZEN TABLE CANNOT SAY WHICH PART OF ITS NET WAS THE OFFICE CHANNEL'S.
    // au.monthly_store_split_net stores line, area, product and two measures — no channel — so a
    // published month's frozen net carries the Office respread mixed in with the city split's and
    // the bulk book's. The MATRIX is right either way: it applies the whole frozen net, which is the
    // announced number. The `office` GRID is the one that needs the Office slice on its own, or
    // `matrix − office` (the Closing Matrix (No Office) tab) stops describing distributor sell-out.
    //
    // So that slice is recomputed live, and ONLY for a pair that can carry one (CNS, 2026-09 on) —
    // which also keeps a published month before the rule from paying for a detail-row read it has no
    // use for. The residual this leaves is named rather than hidden: if a batch was re-mapped AFTER
    // the month was published, the live Office slice is today's and the frozen matrix is the
    // announced one, so the no-Office tab is out by that post-publish drift. That is strictly better
    // than the alternative — an Office grid carrying none of the respread is out by the WHOLE of it —
    // and it is exactly zero whenever the rows have not changed since publication, which is what a
    // published month is supposed to mean.
    //
    // 🔴 THE ONE CASE WHERE THAT WOULD BE THE WRONG WAY ROUND, AND WHY THE RULE STOPS AT SEPTEMBER.
    // `isFrozenStoreSplitPeriod` matches `monthly_closing_publications` by PERIOD with NO line
    // predicate (deliberately — PR 4848), so publishing ONE line freezes EVERY line's net for that
    // month. A frozen net stamped BEFORE this rule existed carries no respread at all, and a live
    // Office slice against it would be out by the WHOLE respread rather than by a post-publish
    // drift. That is reachable only for a month frozen before the rule. Since his 2026-10-13 ruling
    // the window starts 2026-01, and on that day no 2026 month held a live publication row, so no
    // frozen pre-rule net exists inside the window — a month published from now on freezes WITH it.
    //
    // 🔴 SEPTEMBER WAS EXACTLY THAT CASE UNTIL 9 OCTOBER 2026 19:12:21.58 CAIRO, WHEN HE UNPUBLISHED
    // September Anti Infective. While that row stood, 2026-09 was frozen for CNS too against a
    // pre-rule net, which is why he first ruled "leave the Office respread at October". With it
    // withdrawn, no `2026-09` row has `unpublished_at IS NULL`, this whole frozen branch is
    // unreachable for September, and the month recomputes live — which is what made his second
    // ruling ("make September's Office split recalculate like October", same day) a one-constant
    // change. If he re-publishes September, the net stamped then is computed by the live path and
    // therefore already carries the respread, so it freezes WITH it and this branch stays correct.
    // The EPDA tab's figures are recomputed live for a published month the same way, and for the same
    // reason: the frozen table carries no channel, so it cannot say which part of its net was EPDA's.
    const epdaApplies = isEpdaContributionActive(trimmedPeriod) && isBulkAllocationLine(trimmedLine, trimmedPeriod);
    if (!officeApplies && !epdaApplies) return frozen;
    const live = await readGeographyStamp()
      .then((stamp) => loadClosingStoreSplitCached(trimmedLine, trimmedPeriod, stamp))
      .catch(() => null);
    return { ...frozen, officeNet: new Map(live?.officeNet ?? []), epdaUnits: new Map(live?.epdaUnits ?? []) };
  }
  const cached = await loadClosingStoreSplitCached(trimmedLine, trimmedPeriod, await readGeographyStamp());
  return {
    exemptStoreValueByBrick: new Map(cached.exempt),
    movements: cached.movements,
    net: new Map(cached.net),
    officeNet: new Map(cached.officeNet ?? []),
    epdaUnits: new Map(cached.epdaUnits ?? []),
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
/**
 * Whether a (line, period)'s store split is FROZEN — split-active, split-eligible, and the PERIOD is
 * published. The freeze in 20260927213000 is PER-PERIOD: publishing ANY line freezes
 * au.monthly_store_split_net and the attribution rollup for the WHOLE period, so match that (any
 * publication row for the period with unpublished_at IS NULL), never the specific line — an unpublished
 * line in a partially-published period is frozen too.
 *
 * The ONE predicate both the frozen split (loadFrozenStoreSplitIfPublished) and the export's frozen
 * banner (route.ts) read, so the sheet's numbers and the banner explaining them cannot disagree about
 * whether the month is frozen. Fails to FALSE (recompute live) on any read error.
 */
export async function isFrozenStoreSplitPeriod(
  line: string | null | undefined,
  period: string | null | undefined,
): Promise<boolean> {
  const trimmedLine = String(line ?? "").trim();
  const trimmedPeriod = String(period ?? "").trim();
  if (!trimmedLine || !trimmedPeriod) return false;
  if (!isStoreCitySplitActive(trimmedPeriod) || !isSplitEligibleLine(trimmedLine)) return false;
  const { data, error } = await getSupabaseAdmin()
    .from("monthly_closing_publications")
    .select("id")
    .eq("period", trimmedPeriod)
    .is("unpublished_at", null)
    .limit(1);
  return !error && Array.isArray(data) && data.length > 0;
}

async function loadFrozenStoreSplitIfPublished(
  line: string | null | undefined,
  period: string | null | undefined,
): Promise<ClosingStoreSplit | null> {
  if (!(await isFrozenStoreSplitPeriod(line, period))) return null;
  const trimmedLine = String(line ?? "").trim();
  const trimmedPeriod = String(period ?? "").trim();
  const lineCode = resolveTargetLineCode(trimmedLine);
  if (!lineCode) return null;

  const supabase = getSupabaseAdmin();
  // READ TOGETHER (2026-10-01, "slow to transfer between page and page"): the period prices do not
  // depend on the frozen rows, so they are fetched beside them instead of after. They are still only
  // CONSULTED once the rows have answered: a failed rows read falls back to live exactly as before,
  // and the prices' own failure is then ignored — as it was when they were never fetched at all.
  const pricesLoad = loadProductPeriodPrices();
  pricesLoad.catch(() => {});
  const { data, error } = await supabase.rpc("phx_monthly_store_split_net", { p_period: trimmedPeriod });
  if (error || !data) return null;

  const prices = await pricesLoad;
  const net = buildFrozenNetFromRows(data as FrozenNetRow[], lineCode, trimmedPeriod, (product) =>
    prices.priceFor(product, trimmedPeriod),
  );
  // FAIL TO LIVE, NEVER TO EMPTY. A frozen month's split-eligible line should have net rows; an empty
  // result means none matched (a line_code space that drifted from resolveTargetLineCode, an empty
  // table) — returning it would make the caller drop the split entirely and show the raw, un-split
  // closing. Fall through to the live recompute instead, which is at worst the pre-fix behaviour.
  if (net.size === 0) return null;

  // Movements SYNTHESIZED to reproduce the frozen net exactly. The export's Channel Breakdown folds
  // `netByArea` from these movements (store-split-channel-breakdown.ts) while the Matrix uses `net`,
  // so the two sheets must describe the SAME movement or one workbook prints two numbers for an area.
  // The frozen table stores only the net (no in/out legs), so collapse each cell to a single leg:
  // netStoreSplitByAreaProduct(these) === net by construction (see synthesizeFrozenMovements). The
  // per-brick exempt map is not frozen and is not needed by the frozen path — the Matrix and the
  // area/rep grids read `net`/`movements`, and the brick grid reads its own live figures either way.
  // `officeNet` is EMPTY here and filled by the caller when the pair can carry one — see the long
  // note in loadClosingStoreSplit. It cannot be derived from these rows: the frozen table has no
  // channel column, so the Office slice is not recoverable from the net it is mixed into.
  return {
    net,
    movements: synthesizeFrozenMovements(net, trimmedLine),
    exemptStoreValueByBrick: new Map(),
    officeNet: new Map(),
  };
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
 * Movements that reproduce a frozen net exactly, so the export's Channel Breakdown (which folds
 * netByArea from movements) and the Matrix (which reads net) describe the SAME movement.
 *
 * The frozen table (au.monthly_store_split_net) stores only the net per area×product — no in/out legs
 * — so each cell collapses to a single leg: a positive net is all "in", a negative net all "out".
 * INVARIANT (pinned in closing-frozen-split-net.test.ts): netStoreSplitByAreaProduct(result) === net.
 * `city` is left blank — the breakdown folds by AREA, not city, and the Matrix write-back reads net,
 * not movements — and `line` is the exported line. PURE.
 */
export function synthesizeFrozenMovements(
  net: ReadonlyMap<string, NetCell>,
  line: string,
): StoreSplitAreaMovement[] {
  const movements: StoreSplitAreaMovement[] = [];
  for (const [key, cell] of net) {
    const sep = key.indexOf("|");
    const areaCode = sep >= 0 ? key.slice(0, sep) : key;
    const productCode = sep >= 0 ? key.slice(sep + 1) : "";
    movements.push({
      areaCode,
      city: "",
      line,
      productCode,
      inQty: Math.max(cell.qty, 0),
      inValue: Math.max(cell.value, 0),
      outQty: Math.max(-cell.qty, 0),
      outValue: Math.max(-cell.value, 0),
    });
  }
  return movements;
}

/**
 * Net store-split movement per area x product. The Closing Matrix write-back's input, and all the
 * on-screen path needs.
 *
 * For a PUBLISHED month loadClosingStoreSplit returns the FROZEN split, so this returns the frozen
 * net — the Closing tab equals the announced number and the attribution surfaces, never a live
 * recompute that drifted after publish. Unpublished months recompute live.
 */
export async function loadClosingStoreSplitNet(
  line: string | null | undefined,
  period: string | null | undefined,
): Promise<Map<string, NetCell>> {
  return (await loadClosingStoreSplit(line, period)).net;
}
