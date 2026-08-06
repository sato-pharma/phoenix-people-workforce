// July 2026's hand-mapped direct orders, applied to the Channel Breakdown grids.
//
// WHY THIS EXISTS. Direct orders normally carry no area and no rep, so the Area and Rep grids give
// them a named bucket row — that is correct and stays correct for every month but one. July 2026 is
// the exception: the owner hand-mapped that month's direct orders to areas and reps on 2026-08-03,
// and the CLOSING MATRIX uses that mapping (resolveJulyDirectByArea, in monthly-distributor-import).
// The Channel Breakdown did not, so one workbook published two different figures for the same area:
//
//   Anti Infective 2026-07 — Matrix CA4 21,632.00 vs Area x Channel grid 11,052.00, and five more
//   areas, 93,554.00 EGP in total at the time. Pedia 2026-07 — eleven areas, 534,713.65 EGP.
//   CNS has no direct orders at all and never disagreed, which is why this hid behind the other
//   defects: the line used to check the sheets was the one line it could not show up on.
//
// ANTI INFECTIVE'S FIGURE WAS RESTATED THE SAME DAY. #1857 replaced that line's 14 region-only rows
// with the owner's 16-row area distribution — 1,150 units / 93,554.00 becomes 2,120 units /
// 149,288.50 — and he ruled it "accurate 100%" on 2026-08-06. Both sides moved together (the mapping
// table AND the production rows), which is the only reason the reconciliation below still passes.
// 149,288.50, not 93,554.00, is this line's July direct total everywhere today.
//
// The database cannot fix this: those rows genuinely have no area_code (verified in production
// 2026-08-06 — 46 direct rows across the two lines, 0 with an area). The mapping exists only as the
// owner-approved table in july-2026-direct-orders.ts, so the re-attribution belongs here, in
// TypeScript, next to the sheet — and it can be tested without a database.
//
// THE SAFETY PROPERTY IS THE SAME ONE THE MATRIX USES. The mapping and the RPC are two descriptions
// of one month at different grains. If they disagree by more than a piastre this returns the grids
// UNTOUCHED and says so, and the sheet prints the disagreement rather than a merged number nobody
// can reconcile. A visible bucket row is always recoverable; a moved total is not.

import { JULY_2026_DIRECT_PERIOD, JULY_2026_DIRECT_ROWS } from "@/lib/sales/july-2026-direct-orders";
import {
  type ChannelBreakdown,
  type ChannelBreakdownRow,
  emptyBreakdownRow,
} from "@/lib/sales/monthly-closing-channel-comparison";

/** The RPC's key for money that reached no area, rep or brick because it is a direct order. */
const DIRECT_KEY = "__DIRECT__";

export type JulyDirectAttribution = {
  /** Uppercase area code → the direct money the owner's mapping put there. */
  valueByArea: ReadonlyMap<string, number>;
  /** Rep HR id → the same money by seat. */
  valueByRep: ReadonlyMap<string, number>;
  /** Every mapped row of this line, area or not — the figure the RPC is reconciled against. */
  mappedTotal: number;
  /** The part that actually names an area. The rest stays in the Direct row, as on the Matrix. */
  areaTotal: number;
  /** The part that names a rep. Tracked separately: a row can have one and not the other. */
  repTotal: number;
};

function bump(map: Map<string, number>, key: string, delta: number): void {
  map.set(key, (map.get(key) ?? 0) + delta);
}

/**
 * The owner's July mapping for one line, restricted to the products this workbook actually shows.
 *
 * Products are narrowed on purpose: the closing drops LA003 / LA004 / SS001, so counting a mapped
 * row for a product that has no column would guarantee a mismatch against the RPC and permanently
 * disable the merge. Same rule, and the same reason, as resolveJulyDirectByArea.
 */
export function resolveJulyDirectAttribution(
  line: string | null,
  period: string | null,
  productCodes: ReadonlySet<string>,
): JulyDirectAttribution | null {
  if (period !== JULY_2026_DIRECT_PERIOD) return null;
  const wanted = (line ?? "").trim().toLowerCase();
  if (!wanted) return null;

  const mapped = JULY_2026_DIRECT_ROWS.filter(
    (row) => row.line.trim().toLowerCase() === wanted
      && productCodes.has(row.productCode.trim().toUpperCase()),
  );
  if (mapped.length === 0) return null;

  // A row with no area is NOT a broken mapping — it is the National Sales Manager's own order,
  // which belongs to no area by nature. The Closing Matrix keeps exactly those in its area-less
  // bucket (see resolveJulyDirectByArea's `areaLessByProduct`), so they stay in the Direct row here.
  // Rejecting the whole line because one row has no area is what left all eleven Pedia areas out of
  // step on the first attempt.
  const valueByArea = new Map<string, number>();
  const valueByRep = new Map<string, number>();
  let mappedTotal = 0;
  let areaTotal = 0;
  let repTotal = 0;
  for (const row of mapped) {
    const area = row.areaCode.trim().toUpperCase();
    const rep = row.repHrId.trim();
    mappedTotal += row.value;
    if (area) {
      bump(valueByArea, area, row.value);
      areaTotal += row.value;
    }
    if (rep) {
      bump(valueByRep, rep, row.value);
      repTotal += row.value;
    }
  }
  return {
    areaTotal: Number(areaTotal.toFixed(6)),
    mappedTotal: Number(mappedTotal.toFixed(6)),
    repTotal: Number(repTotal.toFixed(6)),
    valueByArea,
    valueByRep,
  };
}

/**
 * Spread one bucket row's channel columns across real keys, in proportion to `weights`.
 *
 * Every column is shared on the SAME proportions and the last share absorbs each column's
 * remainder, so the grid's total is preserved to the piastre — which is the only thing that must
 * survive this, and the thing that would be silently lost by rounding each share independently.
 */
function spread(
  rows: readonly ChannelBreakdownRow[],
  bucket: ChannelBreakdownRow,
  weights: ReadonlyMap<string, number>,
  /** The mapped money that names a key — may be less than `mappedTotal`. */
  attributed: number,
  /** Every mapped row, area-less ones included. `attributed / mappedTotal` is what moves. */
  mappedTotal: number,
): ChannelBreakdownRow[] {
  const columns = ["hospital", "store", "pharmacy", "unidentifiedNoCode", "unidentifiedNoName", "directUnnamed", "total"] as const;
  const keys = [...weights.keys()];
  if (keys.length === 0 || mappedTotal <= 0 || attributed <= 0) return rows.map((row) => ({ ...row }));

  const moved = attributed / mappedTotal;
  const out = rows.map((row) => ({ ...row }));
  const bucketIndex = out.findIndex((row) => row.key === bucket.key);
  const indexByKey = new Map(out.map((row, index) => [row.key.trim().toUpperCase(), index]));

  // Per column: what leaves the Direct row, split by each key's share of the mapped money. The last
  // key absorbs that column's remainder, so the column sums back to exactly what was taken and the
  // grid's total cannot drift by a piastre.
  const sharesByColumn = new Map<(typeof columns)[number], number[]>();
  const takenByColumn = new Map<(typeof columns)[number], number>();
  for (const column of columns) {
    const take = bucket[column] * moved;
    const amounts = keys.map((key) => (take * (weights.get(key) ?? 0)) / attributed);
    const assigned = amounts.slice(0, -1).reduce((sum, value) => sum + value, 0);
    amounts[amounts.length - 1] = take - assigned;
    sharesByColumn.set(column, amounts);
    takenByColumn.set(column, take);
  }

  keys.forEach((key, index) => {
    const found = indexByKey.get(key);
    const base = found === undefined ? emptyBreakdownRow(key, "") : out[found];
    const merged: ChannelBreakdownRow = { ...base };
    for (const column of columns) {
      merged[column] = Number((base[column] + (sharesByColumn.get(column)?.[index] ?? 0)).toFixed(6));
    }
    if (found === undefined) {
      out.push(merged);
      indexByKey.set(key, out.length - 1);
    } else {
      out[found] = merged;
    }
  });

  // What is left on the Direct row: the area-less part of the mapping — the National Sales
  // Manager's own orders, which have no area by nature. Dropped entirely when nothing remains, so a
  // fully mapped line shows no empty Direct row.
  if (bucketIndex >= 0) {
    const remainder: ChannelBreakdownRow = { ...out[bucketIndex] };
    for (const column of columns) {
      remainder[column] = Number((bucket[column] - (takenByColumn.get(column) ?? 0)).toFixed(6));
    }
    if (Math.abs(remainder.total) < 0.005) out.splice(bucketIndex, 1);
    else out[bucketIndex] = remainder;
  }
  return out;
}

export type JulyDirectMergeResult = {
  breakdown: ChannelBreakdown;
  /** True when the Area and Rep grids now carry July's direct money on real areas and reps. */
  applied: boolean;
  /** Why not, when not — printed on the sheet so the two sheets never disagree in silence. */
  reason: string | null;
  value: number;
};

/**
 * Move July 2026's direct money out of the `__DIRECT__` buckets of the Area and Rep grids and onto
 * the areas and reps the owner mapped it to — the same places the Closing Matrix puts it.
 *
 * THE BRICK GRID IS LEFT ALONE, deliberately. The mapping resolves an area and a rep; it resolves no
 * brick, because a direct order was never placed on one. Inventing a brick to make a fourth grid
 * look symmetrical would be the only made-up number on the sheet.
 */
export function applyJulyDirectAreasToBreakdown(breakdown: ChannelBreakdown): JulyDirectMergeResult {
  const unchanged = (reason: string | null, value = 0): JulyDirectMergeResult =>
    ({ applied: false, breakdown, reason, value });

  if (breakdown.period !== JULY_2026_DIRECT_PERIOD) return unchanged(null);

  const areaBucket = breakdown.byDimension.area.find((row) => row.key === DIRECT_KEY);
  const repBucket = breakdown.byDimension.rep.find((row) => row.key === DIRECT_KEY);
  if (!areaBucket || !repBucket) return unchanged(null);

  const productCodes = new Set(
    breakdown.byDimension.product.map((row) => row.key.trim().toUpperCase()),
  );
  const attribution = resolveJulyDirectAttribution(breakdown.line, breakdown.period, productCodes);
  if (!attribution) {
    return unchanged(
      "July 2026's direct orders have no area mapping for this line, so they stay in their own row here "
      + "while the Closing Matrix may place them differently.",
      areaBucket.total,
    );
  }
  // The reconciliation that makes this safe: the owner's mapping and the RPC must describe the same
  // money. A piastre of tolerance for float, nothing more.
  if (Math.abs(attribution.mappedTotal - areaBucket.total) > 0.01) {
    return unchanged(
      `July 2026's direct mapping totals ${attribution.mappedTotal.toFixed(2)} EGP but this month's direct `
      + `sales are ${areaBucket.total.toFixed(2)} EGP. They are not the same money, so the mapping was NOT `
      + "applied and the direct orders keep their own row. The Closing Matrix may show these areas "
      + "differently — reconcile the mapping before trusting either.",
      areaBucket.total,
    );
  }
  if (attribution.areaTotal === 0 && attribution.repTotal === 0) return unchanged(null);

  return {
    applied: true,
    breakdown: {
      ...breakdown,
      byDimension: {
        area: spread(
          breakdown.byDimension.area, areaBucket, attribution.valueByArea,
          attribution.areaTotal, attribution.mappedTotal,
        ),
        brick: breakdown.byDimension.brick,
        product: breakdown.byDimension.product,
        rep: spread(
          breakdown.byDimension.rep, repBucket, attribution.valueByRep,
          attribution.repTotal, attribution.mappedTotal,
        ),
      },
      julyDirect: { applied: true, value: attribution.areaTotal },
    },
    reason: null,
    value: attribution.areaTotal,
  };
}
