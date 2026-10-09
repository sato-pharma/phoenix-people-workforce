// Has the FROZEN wholesaler city split drifted away from what the rule says today?
//
// 🔴 WHY THIS EXISTS, AND WHY NOTHING ELSE COULD SEE IT. A published month's split is frozen:
// `au.monthly_store_split_net` is written once, and `phx_write_monthly_store_split_net` refuses to
// rewrite a period that still holds a live publication row (the freeze of 20260927213000). That is
// correct — a published and announced month is never corrected. But the RULE behind the net keeps
// moving: every owner ruling that adds a key to STORE_OVERRIDE_CUSTOMER_KEYS re-answers "is this
// customer a warehouse" for every period on record at once, and a re-import or a customer-map edit
// changes the rows underneath. So the frozen net is a photograph of the rule on the day it was
// taken, and nothing anywhere said when the photograph stopped matching.
//
// MEASURED, 2026-10-02, which is why this module was built. August 2026's net was written ONCE, at
// 2026-09-13 23:47 Cairo. Ten days later five override keys landed (`IS-S|446433`, `PS|1552831`,
// `PS|1520649`, `RM|7010216`, `IS|386724` — the owner's الفاتح ruling of 2026-09-23). Recomputing
// August's split from today's rows against that frozen net: 8 cells across 6 line×area pairs,
// 9,876.13 EGP sitting on the wrong area. الفاتح alone is 8,592.50 of it — its August Gharbia rows
// are 17,185.00 whole on Mahalla and the rule sends half to Tanta — so ONE ruling made ten days
// after the freeze accounts for 87% of the drift.
//
// 🔴 AND THE REASON THE RECOMPUTE LIVES HERE RATHER THAN IN A SCRIPT. The first pass at this
// measurement built its rows straight off `source_of_sales_fact_rollup` instead of calling
// `loadMonthlyClosingDetails`, and reported 43 drifted pairs instead of 6 — 3.5x the real figure,
// because the closing's own loader resolves an area through brick/master geography, honours the
// even-split registry and keeps merged areas apart, and a hand-built row set does none of that. The
// drift it "found" was mostly its own row build. Every measurement goes through the loaders below,
// which are the same three calls `scripts/backfill-attribution-store-split.ts` makes, in the same
// order — never a second row build.
//
// 🔴 COMPARE BY VALUE, NEVER BY UNITS — this is the whole design constraint, not a preference. The
// split is unit-preserving by construction: `buildStoreSplitNetPayload` returns cells that sum to
// zero per product, and `phx_write_monthly_store_split_net` independently refuses a net that does
// not. So BOTH sides of this comparison total zero units no matter how badly they disagree about
// WHICH area holds them. `lineUnitTotalsAgree` in the report below is true by construction, and it
// is reported precisely so the output says that out loud rather than leaving a reader to assume the
// existing check had it covered.
//
// 🔴 AND WHY THE PUBLICATION DRIFT CHECK CANNOT SEE THIS — THE LAYER, NOT THE GRAIN. An earlier
// note here said that check "compares a line's total units, one scalar". That was wrong in a way
// that sends the next reader at the wrong fix: `phx_closing_publication_drift` compares per
// area × product × is_direct CELL, units AND value. Its real blind spot is that its snapshot is
// built from `source_of_sales_fact_rollup`, which carries the AS-INVOICED geography — the split net
// lives downstream in `au.monthly_store_split_net` and never enters the rollup at all. So adding
// grain or area columns to that check would not surface one EGP of what this module measures. The
// two layers have to be read together, which is `src/lib/sales/closing-publication-drift.ts`.
//
// 🔴 IT REPORTS, IT NEVER REPAIRS. Rebuilding a published month's net restates an announced number,
// which is the owner's decision and his alone (AGENTS.md §4, "a published and announced month is
// never corrected"). This module computes the difference and names the months and areas; the
// backfill script plus his unpublish/republish is the only thing that may act on it.

import { systemAccessContext } from "@/lib/auth/permissions";
import {
  ATTRIBUTION_SPLIT_LINES,
  buildStoreSplitNetPayload,
  type AttributionSplitRow,
} from "@/lib/sales/attribution-store-split-net";
import { loadSplitRegions } from "@/lib/sales/closing-organogram-regions";
import { loadMonthlyClosingDetails } from "@/lib/sales/monthly-closing-details";
import { resolveTargetLineCode } from "@/lib/sales/monthly-targets";
import { loadProductPeriodPrices } from "@/lib/sales/product-period-price";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** One cell of a store-split net, from either side of the comparison. */
export type StoreSplitNetCell = {
  /** `au.sos_official_line_map.line_code` — `anti_infective`, `cns`, `pedia`. */
  lineCode: string;
  areaCode: string;
  productCode: string;
  netQty: number;
  netEffectiveUnits: number;
};

/** One area×product cell where the frozen net and the live recompute disagree. */
export type StoreSplitDriftCell = {
  lineCode: string;
  areaCode: string;
  productCode: string;
  frozenQty: number;
  liveQty: number;
  qtyDelta: number;
  frozenValue: number;
  liveValue: number;
  /** live − frozen. Positive means the rule now puts MORE on this area than the frozen net does. */
  valueDelta: number;
};

/** The drift rolled up to the grain a human reads: one line, one area. */
export type StoreSplitDriftArea = {
  lineCode: string;
  areaCode: string;
  cells: number;
  qtyDelta: number;
  valueDelta: number;
};

export type StoreSplitDriftReport = {
  period: string;
  frozenCells: number;
  liveCells: number;
  /** Only the cells that disagree, biggest absolute value first. */
  cells: StoreSplitDriftCell[];
  /** Only the line×area pairs that disagree, biggest absolute value first. */
  byArea: StoreSplitDriftArea[];
  /** Σ |valueDelta|. Twice the money that changed hands, since every mover has a counterpart. */
  absoluteValueDelta: number;
  /**
   * Σ valueDelta. ~0 whenever both sides are internally balanced, which is the tell that the drift
   * is a REDISTRIBUTION between areas and not money appearing or vanishing. A non-zero sum means
   * one of the two nets does not balance, which is a different and worse fault.
   */
  valueDeltaSum: number;
  /**
   * True when every line's total net units agree across the two sides. TRUE BY CONSTRUCTION — both
   * nets sum to zero per product — and reported anyway, because it is exactly why the existing
   * units-based publication drift check cannot see any of this. See the header.
   */
  lineUnitTotalsAgree: boolean;
  /** Whether anything at all drifted, by value. The one boolean a caller should branch on. */
  drifted: boolean;
};

/** Below this a difference is float noise, not a movement. */
const VALUE_EPSILON = 0.005;
const QTY_EPSILON = 0.0005;

function cellKey(cell: { lineCode: string; areaCode: string; productCode: string }): string {
  return `${cell.lineCode}|${cell.areaCode}|${cell.productCode}`;
}

function index(cells: readonly StoreSplitNetCell[]): Map<string, StoreSplitNetCell> {
  const byKey = new Map<string, StoreSplitNetCell>();
  for (const cell of cells) {
    const key = cellKey(cell);
    const found = byKey.get(key);
    if (!found) {
      byKey.set(key, { ...cell });
      continue;
    }
    found.netQty += cell.netQty;
    found.netEffectiveUnits += cell.netEffectiveUnits;
  }
  return byKey;
}

function unitTotalsByLine(cells: readonly StoreSplitNetCell[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const cell of cells) {
    totals.set(cell.lineCode, (totals.get(cell.lineCode) ?? 0) + cell.netQty);
  }
  return totals;
}

/**
 * The drift between a frozen net and a live recompute. PURE — no database, so the whole report is
 * unit-tested without one, including the units-blindness this module exists to defeat.
 *
 * `priceFor` values a product for the period under comparison. Both sides are valued with the SAME
 * price, deliberately: a price edit moves both and must not read as split drift. (A repriced
 * product is its own restatement — see `a-price-fix-silently-restates-every-published-closing`.)
 */
export function diffStoreSplitNet(input: {
  period: string;
  frozen: readonly StoreSplitNetCell[];
  live: readonly StoreSplitNetCell[];
  priceFor: (productCode: string) => number | null;
}): StoreSplitDriftReport {
  const frozen = index(input.frozen);
  const live = index(input.live);

  const cells: StoreSplitDriftCell[] = [];
  for (const key of new Set([...frozen.keys(), ...live.keys()])) {
    const [lineCode = "", areaCode = "", productCode = ""] = key.split("|");
    const f = frozen.get(key);
    const l = live.get(key);
    const price = input.priceFor(productCode) ?? 0;
    const frozenQty = f?.netQty ?? 0;
    const liveQty = l?.netQty ?? 0;
    const frozenValue = (f?.netEffectiveUnits ?? 0) * price;
    const liveValue = (l?.netEffectiveUnits ?? 0) * price;
    const valueDelta = liveValue - frozenValue;
    const qtyDelta = liveQty - frozenQty;
    if (Math.abs(valueDelta) < VALUE_EPSILON && Math.abs(qtyDelta) < QTY_EPSILON) continue;
    cells.push({ areaCode, frozenQty, frozenValue, lineCode, liveQty, liveValue, productCode, qtyDelta, valueDelta });
  }
  cells.sort((a, b) => Math.abs(b.valueDelta) - Math.abs(a.valueDelta) || a.areaCode.localeCompare(b.areaCode));

  const areas = new Map<string, StoreSplitDriftArea>();
  for (const cell of cells) {
    const key = `${cell.lineCode}|${cell.areaCode}`;
    const found = areas.get(key) ?? { areaCode: cell.areaCode, cells: 0, lineCode: cell.lineCode, qtyDelta: 0, valueDelta: 0 };
    found.cells += 1;
    found.qtyDelta += cell.qtyDelta;
    found.valueDelta += cell.valueDelta;
    areas.set(key, found);
  }
  const byArea = [...areas.values()]
    .filter((area) => Math.abs(area.valueDelta) >= VALUE_EPSILON || Math.abs(area.qtyDelta) >= QTY_EPSILON)
    .sort((a, b) => Math.abs(b.valueDelta) - Math.abs(a.valueDelta) || a.areaCode.localeCompare(b.areaCode));

  const frozenUnits = unitTotalsByLine(input.frozen);
  const liveUnits = unitTotalsByLine(input.live);
  let lineUnitTotalsAgree = true;
  for (const lineCode of new Set([...frozenUnits.keys(), ...liveUnits.keys()])) {
    if (Math.abs((liveUnits.get(lineCode) ?? 0) - (frozenUnits.get(lineCode) ?? 0)) >= QTY_EPSILON) {
      lineUnitTotalsAgree = false;
    }
  }

  const absoluteValueDelta = cells.reduce((sum, cell) => sum + Math.abs(cell.valueDelta), 0);
  const valueDeltaSum = cells.reduce((sum, cell) => sum + cell.valueDelta, 0);

  return {
    absoluteValueDelta,
    byArea,
    cells,
    drifted: byArea.length > 0,
    frozenCells: frozen.size,
    lineUnitTotalsAgree,
    liveCells: live.size,
    period: input.period,
    valueDeltaSum,
  };
}

/** `au.monthly_store_split_net` as the service-role wrapper RPC returns it. */
type FrozenRow = {
  line_code?: unknown;
  area_code?: unknown;
  product_code?: unknown;
  net_qty?: unknown;
  net_effective_units?: unknown;
};

function up(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

/** The frozen net for a period, exactly as the attribution engine reads it. */
export async function loadFrozenStoreSplitNetCells(period: string): Promise<StoreSplitNetCell[]> {
  const { data, error } = await getSupabaseAdmin().rpc("phx_monthly_store_split_net", { p_period: period });
  if (error) throw new Error(`store split drift: cannot read the frozen net for ${period} — ${error.message}`);
  return ((data ?? []) as FrozenRow[]).map((row) => ({
    areaCode: up(row.area_code),
    lineCode: String(row.line_code ?? "").trim(),
    netEffectiveUnits: Number(row.net_effective_units ?? 0),
    netQty: Number(row.net_qty ?? 0),
    productCode: up(row.product_code),
  }));
}

/**
 * What the split WOULD write for this period from today's validated rows — the same three calls the
 * backfill script makes, in the same order, so a drift can never be an artefact of a second
 * implementation. `keepMergedAreasApart` matches it too: the net keys on the REAL area, not the
 * "Fayoum - Beni Suef" display fold.
 */
export async function loadLiveStoreSplitNetCells(period: string): Promise<StoreSplitNetCell[]> {
  const cells: StoreSplitNetCell[] = [];
  for (const line of ATTRIBUTION_SPLIT_LINES) {
    const lineCode = resolveTargetLineCode(line);
    if (!lineCode) continue;
    const details = await loadMonthlyClosingDetails({
      access: systemAccessContext,
      availableLines: [line],
      availablePeriods: [period],
      includeConfidential: false,
      keepMergedAreasApart: true,
      line,
      period,
      unpaged: true,
    });
    const payload = buildStoreSplitNetPayload(
      line,
      details.rows as readonly AttributionSplitRow[],
      period,
      await loadSplitRegions(line, period),
    );
    for (const row of payload) {
      cells.push({
        areaCode: up(row.area_code),
        lineCode,
        netEffectiveUnits: Number(row.net_effective_units),
        netQty: Number(row.net_qty),
        productCode: up(row.product_code),
      });
    }
  }
  return cells;
}

/** The whole report for one period, read from production. */
export async function loadStoreSplitDrift(period: string): Promise<StoreSplitDriftReport> {
  const trimmed = String(period ?? "").trim();
  if (!/^\d{4}-\d{2}$/.test(trimmed)) {
    throw new Error(`store split drift: period must be YYYY-MM, got ${JSON.stringify(period)}`);
  }
  const [frozen, live, prices] = await Promise.all([
    loadFrozenStoreSplitNetCells(trimmed),
    loadLiveStoreSplitNetCells(trimmed),
    loadProductPeriodPrices(),
  ]);
  return diffStoreSplitNet({
    frozen,
    live,
    period: trimmed,
    priceFor: (productCode) => prices.priceFor(productCode, trimmed),
  });
}
